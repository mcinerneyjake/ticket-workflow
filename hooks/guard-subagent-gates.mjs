#!/usr/bin/env node
// PreToolUse(Bash) guardrail: a SUBAGENT may not merge (tkt-8e291b058706, narrowed by tkt-e8b257fc8cc4).
//
// On 2026-08-16 a subagent spawned by a `/code-review` run committed and pushed three files, opened a
// PR and MERGED it to main — none of it approved, and none of it in the review's own report. The
// reviewer's tamper check saw the local commit and its reversal but not the push, the PR or the
// merge, because every local check (HEAD, reflog, file hashes) was genuinely clean. It surfaced from
// a CI run listed against `main`.
//
// THE RULE: merge is the one human gate left (docs/specs/workflow-rewrite.md), so commit and PR-open are
// allowed. Push stays blocked until guard-bash can judge every push shape for main (tkt-e8b257fc8cc4).
//
// WHY NOT `agent_type` — the obvious design is "block writes when the agent is a review agent", and
// it is the wrong one. The review agents' `agent_type` values are undocumented and observable only by
// running a review, so a guessed list that never matches yields a guard that silently never fires:
// the exact fail-open shape this exists to close. `agent_id` is documented as present only inside a
// subagent, so keying on it cannot silently miss.
//
// SCOPE, stated plainly: this covers the Bash half of the incident. A review subagent EDITING a file
// under review is not covered, because blocking Edit/Write for every subagent would break coding
// subagents, and separating the two genuinely does need the review `agent_type`.
//
// FAIL DIRECTION — closed on the decision, open on the harness:
//   - `agent_id` present but unreadable/ambiguous → treated as a subagent (restrict).
//   - payload unparseable → exit 1: non-blocking but SURFACED. Nearly every Bash call is main-thread,
//     where this rule does not apply at all, so blocking on an unreadable payload would wedge the
//     machine over a case the rule was never about. Exit 1 is the loud "I could not check" — it is
//     not silent, which is what the tenet actually forbids. Exit 0 here would be the fail-open.

import { readFileSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { splitSegments, parseGit } from './guard-bash.mjs';

// `gh <group> <verb>` pairs a subagent may not run. PR-open verbs (create/edit/ready), read verbs and
// the REPORTING verbs (`pr comment`, `issue comment`) are absent on purpose. `alias`, `workflow run`,
// `run rerun` and `extension install` are here because each can reach a merge indirectly.
const GATED_GH = new Map([
  ['pr merge', 'merge a pull request'],
  ['pr close', 'close a pull request'],
  ['pr reopen', 'reopen a pull request'],
  ['pr review', 'submit a pull-request review'],
  ['release create', 'publish a release'],
  ['release edit', 'edit a release'],
  ['release upload', 'upload release assets'],
  ['release delete', 'delete a release'],
  ['repo delete', 'delete a repository'],
  ['repo edit', 'edit repository settings'],
  ['repo archive', 'archive a repository'],
  ['repo rename', 'rename a repository'],
  ['repo sync', 'sync a remote branch'],
  ['issue delete', 'delete an issue'],
  ['secret set', 'set a secret'],
  ['secret delete', 'delete a secret'],
  ['variable set', 'set a variable'],
  ['variable delete', 'delete a variable'],
  ['workflow run', 'dispatch a workflow'],
  ['workflow enable', 'enable a workflow'],
  ['workflow disable', 'disable a workflow'],
  ['run rerun', 're-run a workflow'],
  ['alias set', 'define a gh alias'],
  ['alias import', 'import gh aliases'],
  ['extension install', 'install a gh extension'],
]);

// gh's built-in command aliases (gh 2.95.0 `--help` → ALIASES), folded before the lookup.
const GH_GROUP_ALIASES = new Map([['ext', 'extension'], ['extensions', 'extension']]);
const GH_VERB_ALIASES = new Map([['release new', 'release create'], ['secret remove', 'secret delete'], ['variable remove', 'variable delete']]);

// `gh api`'s value-taking short flags; `-i` is its only boolean one, so a cluster like `-iXPOST` or
// `-if` reaches the value flag after skipping `i`s.
const API_VALUE_SHORT = new Set(['X', 'f', 'F', 'H', 'p', 'q', 't']);

// gh global flags that consume the NEXT token. Dropping only tokens starting with `-` is not enough:
// `gh -R owner/repo pr merge` would then read `owner/repo` as the command group and the gate would
// not be recognised — a real bypass, caught by this file's own parse test.
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

// Backstop for a value-taking flag not in the set above (a future gh release). A command group is a
// bare word; a flag VALUE characteristically is not. Skipping value-shaped leading positionals keeps
// an unknown flag from hiding the group, rather than failing open on it.
const VALUE_SHAPED = /[/:.=@]/;

// Same shape as guard-bash's parseGit: the command WORD must be `gh` after stripping subshell
// punctuation and `VAR=val` prefixes, so `echo "gh pr merge"` is data, not an invocation.
export function parseGh(segment) {
  const stripped = segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = stripped.split(/\s+/);
  let cmd = 0;
  while (cmd < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmd])) cmd++;
  if (tokens[cmd] !== 'gh') return null;
  const flags = tokens.slice(cmd + 1);
  const rest = [];
  for (let i = 0; i < flags.length; i++) {
    const t = flags[i];
    if (GH_VALUE_FLAGS.has(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    if (rest.length === 0 && VALUE_SHAPED.test(t)) continue; // stray flag value, not the group
    rest.push(t);
  }
  if (rest.length === 0) return null;
  return { group: rest[0], verb: rest[1] ?? null, flags };
}

// Any parameter makes it a write, even beside `-X GET`: tokens are whitespace-split, so a `-X GET`
// inside a quoted value is indistinguishable from a real one (tkt-098db663af30).
export function apiMethod(flags) {
  let method = 'GET';
  let sawParam = false;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    let letter = null;
    let value = null;
    if (f === '--method') [letter, value] = ['X', flags[i + 1] ?? ''];
    else if (f.startsWith('--method=')) [letter, value] = ['X', f.slice('--method='.length)];
    else if (/^--(raw-)?field(=|$)|^--input(=|$)/.test(f)) letter = 'f';
    else if (/^-[A-Za-z]/.test(f)) {
      const body = f.slice(1).replace(/^i+/, '');
      if (API_VALUE_SHORT.has(body[0])) [letter, value] = [body[0], body.slice(1) || (flags[i + 1] ?? '')];
    }
    if (letter === 'f' || letter === 'F') sawParam = true;
    if (letter === 'X' && value !== null && value.toUpperCase() !== 'GET') method = value.toUpperCase();
  }
  // A non-GET method we cannot name (empty, HEAD, a typo) is not proven a read, so it blocks too.
  if (method !== 'GET') return method || 'UNKNOWN';
  return sawParam ? 'POST' : 'GET';
}

function ghReason({ group, verb, flags }) {
  if (group === 'api') {
    const method = apiMethod(flags);
    return method === 'GET' ? null : `call the GitHub API with ${method}`;
  }
  if (!verb) return null;
  const key = `${GH_GROUP_ALIASES.get(group) ?? group} ${verb}`;
  return GATED_GH.get(GH_VERB_ALIASES.get(key) ?? key) ?? null;
}

/**
 * @param {unknown} payload  the PreToolUse JSON
 * @returns {{blocked: boolean, reason?: string}}
 */
export function decide(payload) {
  // Documented semantics: `agent_id` is present ONLY inside a subagent. Absent → main thread, where
  // the human gates in CLAUDE.md already apply and this rule has nothing to say.
  const agentId = payload?.agent_id;
  if (agentId === undefined || agentId === null) return { blocked: false };

  const command = payload?.tool_input?.command;
  // In a subagent with a command we cannot read: refuse. Unlike an unparseable payload (handled in
  // main, where we cannot even tell it is a subagent), here we KNOW the rule applies and only the
  // input is missing — the one unknown that would silently disable it.
  if (typeof command !== 'string') {
    return { blocked: true, reason: 'this subagent issued a Bash call with no readable command, so it could not be checked against the gate rule' };
  }

  for (const segment of splitSegments(command)) {
    const git = parseGit(segment);
    if (git?.truncated) return { blocked: true, reason: describe(payload, 'run a git command whose subcommand an unterminated quote swallowed') };
    // guard-bash misses --mirror/--all/wildcards/-c/--git-dir/other remotes (two review rounds), so a
    // subagent push cannot yet be proven not to land on main.
    if (git?.sub === 'push') return { blocked: true, reason: describe(payload, 'git push') };

    const gh = parseGh(segment);
    const ghGate = gh && ghReason(gh);
    if (ghGate) return { blocked: true, reason: describe(payload, ghGate) };
  }
  return { blocked: false };
}

function describe(payload, action) {
  // agent_type is echoed rather than matched on — it is what makes the follow-up (blocking a review
  // agent's FILE edits) answerable from a real run instead of another investigation.
  const type = typeof payload?.agent_type === 'string' && payload.agent_type ? payload.agent_type : 'unknown';
  return (
    `a subagent (agent_type: ${type}) tried to ${action}. Merge is a human approval gate, and ` +
    'pushing, closing, releasing, deleting or writing through `gh api` could cross it; a subagent ' +
    'has no way to obtain that approval. Return to the main thread and let it ask. Commit, ' +
    'gh pr create/edit/ready, parameterless gh api reads, and gh pr comment are unaffected.'
  );
}

export function main() {
  let payload;
  try {
    const raw = readFileSync(0, 'utf8');
    // A lost stdin returns '' rather than throwing, so the length check is what catches it.
    if (!raw.trim()) throw new Error('empty payload on stdin');
    payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[guard-subagent-gates] NOT CHECKED: could not read the hook payload (${err?.message ?? err}). ` +
        'This command was NOT verified against the subagent gate rule. Non-blocking on purpose: the ' +
        'rule only applies inside a subagent, and an unreadable payload cannot establish that.\n',
    );
    process.exit(1); // visible, non-blocking — see FAIL DIRECTION above
  }
  const { blocked, reason } = decide(payload);
  if (blocked) {
    process.stderr.write(`[guard-subagent-gates] Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) {
  main();
}
