#!/usr/bin/env node
// PreToolUse(Bash) guardrail: a SUBAGENT may not cross a human-approval gate (tkt-8e291b058706).
//
// On 2026-08-16 a subagent spawned by a `/code-review` run committed and pushed three files, opened a
// PR and MERGED it to main — none of it approved, and none of it in the review's own report. The
// reviewer's tamper check saw the local commit and its reversal but not the push, the PR or the
// merge, because every local check (HEAD, reflog, file hashes) was genuinely clean. It surfaced from
// a CI run listed against `main`.
//
// THE RULE: commit / push / open-PR / merge are the workflow's three human gates. A subagent has no
// channel to ask for that approval, so it may never cross one — whatever it was spawned to do.
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
// STILL ALLOWED, deliberately: everything a reviewer needs. Reading (`git log`, `git diff`,
// `gh pr view`/`diff`/`list`), and REPORTING — `gh pr comment` and `gh issue comment` are how a
// review returns its findings, so they are not gates and are not blocked.
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

// git subcommands that cross a gate. `merge` is absent on purpose: merging the default branch INTO a
// feature branch is routine local work this project's own instructions prescribe, and it reaches
// nothing outside the machine.
const GATED_GIT = new Map([
  ['commit', 'commit'],
  ['push', 'push'],
]);

// `gh <group> <verb>` pairs that publish or land work. Read verbs (view/diff/list/checks/status) and
// the REPORTING verbs (`pr comment`, `issue comment`) are absent on purpose — a review must still be
// able to read its target and post its findings.
const GATED_GH = new Map([
  ['pr create', 'open a pull request'],
  ['pr merge', 'merge a pull request'],
  ['pr close', 'close a pull request'],
  ['pr reopen', 'reopen a pull request'],
  ['pr edit', 'edit a pull request'],
  ['pr ready', 'mark a pull request ready'],
  ['pr review', 'submit a pull-request review'],
  ['release create', 'publish a release'],
  ['release delete', 'delete a release'],
  ['repo delete', 'delete a repository'],
]);

// HTTP methods that make `gh api` a write. `gh api` with no -X is a GET, which is a read.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

function ghReason({ group, verb, flags }) {
  if (group === 'api') {
    const i = flags.findIndex((f) => f === '-X' || f === '--method');
    const method = (i >= 0 ? flags[i + 1] : flags.find((f) => f.startsWith('--method='))?.split('=')[1]) ?? 'GET';
    return WRITE_METHODS.has(method.toUpperCase()) ? `call the GitHub API with ${method.toUpperCase()}` : null;
  }
  return verb ? (GATED_GH.get(`${group} ${verb}`) ?? null) : null;
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
    const gitGate = git && GATED_GIT.get(git.sub);
    if (gitGate) return { blocked: true, reason: describe(payload, `git ${gitGate}`) };

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
    `a subagent (agent_type: ${type}) tried to ${action}. Commit, push, open-PR and merge are human ` +
    'approval gates; a subagent has no way to obtain that approval, so it may never cross one. ' +
    'Return the change to the main thread and let it ask. Reading and posting findings ' +
    '(git log/diff, gh pr view/diff/list, gh pr comment) are unaffected.'
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
