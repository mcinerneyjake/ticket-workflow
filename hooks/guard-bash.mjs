#!/usr/bin/env node
// PreToolUse(Bash) guardrail — wired in .claude/settings.json.
//
// Blocks git commands that violate the CLAUDE.md "Branch, commit & PR workflow"
// BEFORE they run, instead of relying on the model to remember the rules every
// time:
//
//   1. Whole-tree staging — git add/stage -A | --all | . | * | :/  → forces
//      explicit, per-ticket file staging.
//   2. git commit -a / -am  → also stages the whole working tree, so it's
//      blocked on the same grounds as (1), regardless of branch.
//   3. git commit  while effectively on main → never commit directly to main.
//   4. git push    that targets main, or a bare push while on main → never
//      push to main (explicit non-main targets, deletes, and --tags are fine).
//
// SCOPE: this is a best-effort guard against the assistant's own predictable
// commands, NOT an adversarial sandbox. It does NOT defend against deliberately
// obscure forms — e.g. `git --git-dir <path> ...` global-option spoofing, env
// prefixes other than simple VAR=val, or hiding a branch change behind a plain
// `git checkout <branch>` (only `switch` / `checkout -b` are tracked). Defending
// those would mean reimplementing a shell parser; GitHub branch protection is the
// real backstop. An unknown `cd` target is NO LONGER on that list: it used to
// poison the unresolvable-dir slot (`cd $A && git switch -c x && cd $B && git
// commit`), and now refuses the commit instead (tkt-a4c21bf57492). A
// SEGMENT-INITIAL `pushd`/`popd` still is on it — cdTarget matches only `cd`,
// so `pushd $D && git commit` reads as no move at all (tkt-b62f7e93bb63).
// See CLAUDE.md → Branch, commit & PR workflow.
//
// Protocol: read the hook payload as JSON on stdin, inspect
// `tool_input.command`. Exit 0 to allow; exit 2 to block (stderr is surfaced to
// Claude so it can self-correct). An unparseable PAYLOAD → BLOCK (fail closed,
// tkt-92360b0e2079: a command this hook cannot read is one it cannot judge, and
// answering "I do not know" with "yes" is the one thing a guard must never do).
// Individual rules go the same way wherever an unknown would silently disable
// the rule it guards: the current BRANCH (tkt-fbc74a3252fe), which branch this repo
// PROTECTS, a DIRECTORY move this parser could not name — hidden behind a
// pipeline (tkt-3006d09810f7) or written explicitly (tkt-a4c21bf57492) — and
// `git switch -`, whose destination is unknowable and is
// therefore assumed protected. Do NOT restate that as a count — the README said
// one, then three, and review found each an undercount. The decision logic
// (parseGit / decide) is exported and pure so it can be unit-tested without
// spawning a subprocess; the stdin/exit wiring runs only when this file is
// executed directly as the hook entrypoint.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';
import { hasRemote, protectedBranches } from './lib/default-branch.mjs';
import { cdTarget, dequote, endsInsideQuote, hiddenDirTarget, quotedTokens, resolveDir, SHELL_KEYWORDS, splitSegments, subshellParens, WRAPPERS } from './lib/shell.mjs';

// The VALUE of a token: the token with single/double quote characters removed wherever they sit —
// the reading resolveDir has always applied to a `-C` path. Every rule comparing an arg against a
// known string — a blanket staging token, a protected branch, a destructive flag — must read this
// and not the raw token: `git add "."`, `git push origin "main"` and `git switch "main"` are
// spellings an assistant writes by habit, and each matched NOTHING while its unquoted twin blocked
// (tkt-6d1ae448e3b3).
//
// NOT "whatever a shell would hand git", and do not build a rule on the stronger claim: dequote is
// not backslash-aware (nor is quotedTokens), so `git add \.` still reads `\.`; and it strips nested
// quotes a shell would keep, so `"'main'"` reads `main`. Both are known residuals.
//
// An unterminated quote keeps the RAW token rather than dequote's null — "names nothing" and "is the
// empty string" must not compare equal. This is NOT backed by the truncated-quote refusal: that
// fires only when the unterminated span swallows the SUBCOMMAND slot, so `git push origin "main`
// parses cleanly and reaches here, and is allowed. The shell rejects such a command anyway.
const argValue = (token) => dequote(token) ?? token;

// Pull the git subcommand + its args out of a single shell segment. The command
// WORD must be `git` (after stripping leading subshell/group punctuation and
// simple VAR=val env prefixes) — so data that merely mentions git, e.g.
// `echo "git add -A"`, is not treated as a git invocation. `-C <path>` is
// captured, not skipped: it names the repo the command acts on.
//
// Tokenized quote-aware, not on whitespace: a split put every token after a quoted
// span one slot off, and both directions were guard failures. `git -C "/a/my repo"
// commit` read as the subcommand `repo"`, and `EDITOR="code -w" git commit` failed
// the env-prefix test and returned null — neither reached the never-commit-to-main
// rule at all. The other way, `git commit -m "fix -a bug"` handed commitStagesAll a
// bare `-a` nobody wrote, refusing an ordinary commit on any branch
// (tkt-8f2e1f9894e2). Quoting stays in the REPO-DIR token: resolveDir owns its removal and accepts
// it wherever it sits, so `-C "/a/my repo"/sub` names one dir. `sub` and `args` come back DEQUOTED
// instead (see argValue).
export function parseGit(segment) {
  const stripped = segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = quotedTokens(stripped);
  let cmd = 0;
  // Grouping punctuation is stripped PER TOKEN, not just at offset 0: the segment-level strip above
  // runs once, so after a keyword is skipped a following `(` was never removed and `then (git commit`
  // hid the invocation from every rule exactly as `then git commit` had (review, tkt-e70ae972476e).
  const bareAt = (n) => tokens[n].replace(/^[({]+/, '');
  // Env prefixes, reserved words and wrappers, interleaved in any order: `then VAR=x time git …` is
  // as valid a spelling as `VAR=x git …`. Only this LEADING run is skipped, so a keyword sitting in
  // data (`echo then git commit`) never promotes a deeper token into the command slot.
  let sawWrapper = false;
  while (cmd < tokens.length) {
    const word = bareAt(cmd);
    if (word === '' || SHELL_KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { cmd++; continue; }
    if (WRAPPERS.has(word)) { sawWrapper = true; cmd++; continue; }
    if (sawWrapper && word.startsWith('-')) { cmd++; continue; }
    break;
  }
  if (cmd >= tokens.length || bareAt(cmd) !== 'git') return null;
  let i = cmd + 1;
  let repoDir = null;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C') { repoDir = tokens[i + 1] ?? null; i += 2; }
    else if (tokens[i] === '-c') { i += 2; } // -c takes a value we don't care about
    else i += 1;
  }
  // No token left where the subcommand belongs. When an unterminated quote is why — it fuses the
  // rest of the line into one token, and `git -C "/a/b commit -m x` leaves nothing after `-C` —
  // returning null would hide the invocation from EVERY rule. The whitespace split still recovered
  // `commit` here, so silence would be a regression, and this module refuses an unterminated quote
  // everywhere else (resolveDir, UNRESOLVABLE_MOVE). Report it and let the caller refuse: such a
  // command is a shell syntax error, so nothing legitimate is wedged (tkt-8f2e1f9894e2).
  if (i >= tokens.length)
    return endsInsideQuote(stripped) ? { sub: null, args: [], repoDir, truncated: true } : null;
  return { sub: argValue(tokens[i]), args: tokens.slice(i + 1).map(argValue), repoDir, truncated: false };
}


// resolveDir/cdTarget/splitSegments live in lib/shell.mjs — track-steps needs the same parsing to
// decide which repo a milestone belongs to. Re-exported so this hook's public surface is unchanged
// (guard-subagent-gates.mjs imports splitSegments from here).
export { cdTarget, splitSegments };

// Options whose VALUE git takes from the rest of the cluster or the next token (`optional`: attached
// only). A wrong entry here admits; a missing one only over-blocks — so never add a guess.
const VALUE_OPTIONS = {
  commit: {
    short: 'mFCct', optional: 'Su',
    long: ['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash',
      '--author', '--date', '--template', '--cleanup', '--trailer', '--pathspec-from-file'],
  },
  push: { short: 'o', optional: '', long: ['--push-option', '--repo', '--receive-pack', '--exec'] },
  clean: { short: 'e', optional: '', long: ['--exclude'] },
  branch: { short: 'u', optional: 't', long: ['--set-upstream-to'] },
  checkout: { short: 'bB', optional: 't', long: ['--orphan'] },
};

// Short-flag letters git reads as switches, off the DEQUOTED args (tkt-a3bf9e90d073). No stop at
// `--`: an unlisted long option can take `--` as its value, and git keeps parsing flags after it.
function shortFlagLetters(sub, args) {
  const { short = '', optional = '', long = [] } = VALUE_OPTIONS[sub] ?? {};
  let letters = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (long.includes(a)) { i++; continue; }
    if (!a.startsWith('-') || a.startsWith('--')) continue;
    for (let j = 1; j < a.length; j++) {
      if (optional.includes(a[j])) break;
      if (short.includes(a[j])) { if (j === a.length - 1) i++; break; }
      letters += a[j];
    }
  }
  return letters;
}

// Args that stage the whole working tree rather than named paths.
function stagesEverything(args) {
  const blanket = new Set(['-A', '--all', '.', '*', ':/', './']);
  return args.some((a) => blanket.has(a));
}

// `git commit -a` / `-am` (a single-dash cluster containing 'a') or `--all`
// stages all tracked files, bypassing the add guard entirely.
function commitStagesAll(args) {
  return args.some((a) => a === '--all') || shortFlagLetters('commit', args).includes('a');
}

// True when a push would land on main: an explicit main refspec/target, or a
// bare push while on main (no explicit non-main target and not a delete/tags op).
function pushesMain(args, branch, protectedBranches) {
  // Strip a leading `+` (force-refspec syntax) so `+main` is still seen as main.
  const positionals = args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/^\+/, ''));
  const flags = args.filter((a) => a.startsWith('-'));
  const onProtected = protectedBranches.includes(branch);
  const targetsMain = positionals.some((a) =>
    protectedBranches.some((p) => a === p || a.endsWith(`:${p}`) || a.endsWith(`/${p}`)),
  );
  if (targetsMain) return true;
  // `HEAD` / `@` resolve to the current branch, so on main they push main —
  // `git push origin HEAD` while on main must not read as an explicit non-main
  // target.
  if (onProtected && positionals.some((a) => a === 'HEAD' || a === '@')) return true;
  // `--mirror` is deliberately NOT here: it pushes every ref, main included, so exempting it puts a
  // hole in the rule this function exists to enforce. Dequoting args made quoted flags parse as
  // flags for the first time, which put `git push "--mirror"` in reach of this exemption — the
  // unquoted spelling had been walking through it all along (tkt-6d1ae448e3b3, review).
  const safeFlag = flags.some((f) => ['--delete', '-d', '--tags', '--prune'].includes(f));
  const explicitTarget = positionals.length >= 2; // remote + refspec → not the current branch implicitly
  return onProtected && !safeFlag && !explicitTarget;
}

// The branch a `switch`/`checkout -b` moves to, so a chain that creates the
// branch first isn't judged against the pre-switch branch. Plain
// `git checkout <x>` is intentionally not tracked (path-vs-branch ambiguous).
function switchTarget(sub, args, protectedBranches) {
  if (sub !== 'switch' && sub !== 'checkout') return null;
  // `switch -` / `checkout -` jumps to the PREVIOUS branch, which the hook can't
  // resolve. Assume it could be the protected branch so a commit/push later in the
  // SAME chain stays guarded (else `git switch - && git commit` would sneak onto it).
  if (args.includes('-')) return protectedBranches[0] ?? null;
  if (sub === 'switch' || args.includes('-b') || args.includes('-B')) {
    const positionals = args.filter((a) => !a.startsWith('-'));
    return positionals[0] ?? null;
  }
  return null; // plain `git checkout <x>` — path-vs-branch ambiguous, not tracked
}

// Destructive git flags that no part of the ticket workflow needs, blocked on
// ANY branch. The broad `git …` allow-rules in .claude/settings.json are only
// safe because this hook rejects the dangerous shapes they would otherwise admit
// (force-push, force-add over .gitignore, force branch-delete, hard reset,
// untracked-file deletion, force checkout). Returns a reason or null.
export function destructiveGitReason(sub, args) {
  const has = (...flags) => args.some((a) => flags.includes(a));
  // Clustered flags (`-uf`, `-df`) can't slip past an exact-token check.
  let letters;
  const hasShort = (ch) => (letters ??= shortFlagLetters(sub, args)).includes(ch);
  switch (sub) {
    case 'push':
      // Force by flag (-f / -uf / --force / --force-with-lease) OR by the
      // `+refspec` force syntax (`git push origin +main`, `+feat/x`).
      if (has('--force') || hasShort('f') ||
          args.some((a) => a === '--force-with-lease' || a.startsWith('--force-with-lease=')) ||
          args.some((a) => a.startsWith('+')))
        return 'git push force (--force / -f / +refspec) rewrites remote history. Force-push is never part of the workflow — push normally and open a PR.';
      return null;
    case 'add':
    case 'stage':
      if (has('--force') || hasShort('f'))
        return 'git add -f overrides .gitignore and can stage ignored files (e.g. secrets / build artifacts). Stage only intended, non-ignored paths.';
      return null;
    case 'branch':
      // Force-delete = -D, or (--delete/-d) combined with (--force/-f), or a
      // single cluster carrying both (e.g. -Df / -df).
      if (hasShort('D') || ((has('--delete') || hasShort('d')) && (has('--force') || hasShort('f'))))
        return 'git branch force-delete (-D / --delete --force) discards unmerged commits. Use -d (safe delete) instead.';
      return null;
    case 'reset':
      if (has('--hard'))
        return 'git reset --hard irreversibly discards working-tree changes. Not part of the workflow.';
      return null;
    case 'clean':
      if (has('--force') || hasShort('f'))
        return 'git clean -f / --force permanently deletes untracked files. Not part of the workflow.';
      return null;
    case 'checkout':
      if (has('--force') || hasShort('f'))
        return 'git checkout -f discards local changes. Use git switch / git restore explicitly instead.';
      return null;
    default:
      return null;
  }
}

// `getBranch(dir)` is injected so the logic stays pure and testable. Branch state is
// keyed by directory: a chain can `cd` between repos, and a switch in one must not
// change what we believe another is on (tkt-74bc8f9b6ba5).
// `getRepo(dir) -> { hasRemote, protectedBranch }` is injectable like `getBranch`, and defaults to
// the pre-2.1 behaviour (every repo has a remote, `main` is protected) so a caller that does not
// supply it gets today's semantics rather than a silently relaxed guard. main() injects the real one.
const DEFAULT_REPO = () => ({ hasRemote: true, protectedBranches: ['main'] });

const UNRESOLVABLE_MOVE =
  'A `cd` in this command moves somewhere this guard cannot name — a variable, a bare `cd`, `cd -` (OLDPWD), a `~user` path, an unterminated quote, a `popd`, or a move hidden behind a pipeline or compound statement — so the commit/push after it cannot be checked against the never-commit-to-main rule. Refusing rather than guessing: a move it cannot follow would otherwise be judged against the session repo, which is a feature branch while a ticket is being worked — i.e. allowed. Re-run it as a plain `cd <dir> && git …` chain naming the directory literally. A path containing spaces is fine if you quote it: `cd "/a/my repo"` is read correctly.';

const TRUNCATED_QUOTE =
  'An unterminated quote in this command swallowed the git subcommand, so it cannot be checked against the never-commit-to-main rule. Refusing rather than guessing: the subcommand could be `commit` or `push`, and a shell would reject the command anyway. Close the quote and retry.';

export function decide(command, getBranch, startDir, getRepo = DEFAULT_REPO) {
  if (typeof command !== 'string' || !command.trim()) return { blocked: false };

  // Quote/substitution-aware split so each git invocation is checked
  // independently without mis-splitting quoted data (see splitSegments). Single
  // `|` is intentionally not a split point.
  const segments = splitSegments(command);

  let dir = startDir ?? null;
  // Tracked separately from `dir`, never inferred from it: a null `dir` alone falls back to the
  // SESSION repo, which while a ticket is being worked is a feature branch — the permissive answer.
  // So "moved somewhere I cannot name" and "never moved" must not compare equal (tkt-3006d09810f7).
  let unknownDir = false;
  const outer = []; // [dir, unknownDir] saved at `(` — a real shell restores cwd when the subshell exits
  const branches = new Map(); // dir -> effective branch; memoized, so one lookup per repo
  const branchFor = (d) => {
    if (!branches.has(d)) branches.set(d, getBranch(d));
    return branches.get(d);
  };
  const repos = new Map(); // dir -> repo shape; memoized, so one pair of execs per repo
  const repoFor = (d) => {
    if (!repos.has(d)) repos.set(d, getRepo(d));
    return repos.get(d);
  };

  for (const segment of segments) {
    // Counted quote- and substitution-aware, never regex-matched: splitSegments keeps a `$( … )`
    // intact, so a segment can END in a `)` that closes no subshell (`export SHA=$(date)`). Popping
    // on it restored the pre-`cd` directory, and the commit after it was judged against the session.
    const parens = subshellParens(segment);
    for (let i = parens.open; i > 0; i--) outer.push([dir, unknownDir]);

    const moved = cdTarget(segment, dir);
    if (moved !== undefined) {
      // An explicit cd latches too: "moved somewhere I cannot name" must not compare equal to
      // "never moved", since a null `dir` alone falls back to the SESSION repo — a feature branch
      // while a ticket is being worked, i.e. the permissive answer. This half was written and
      // reverted in tkt-3006d09810f7 because `cd "<path with a space>"` reached this slot as well,
      // and refusing it refused a nameable directory with a remedy that had no valid spelling. It
      // is safe now only because quotedTokens keeps that span together, so it resolves above rather
      // than arriving here (tkt-a4c21bf57492).
      dir = moved;
      unknownDir = moved === null;
    } else {
      const git = parseGit(segment);
      if (git) {
        if (git.truncated) return { blocked: true, reason: TRUNCATED_QUOTE };
        const { sub, args, repoDir } = git;
        const gitDir = repoDir ? resolveDir(dir, repoDir) : dir; // -C acts on that repo, whatever the cwd
        // Scoped to commit/push and checked before the rules, like the branch===null refusal they
        // share a reason with: an unknown directory must not wedge `git status`, but it must never
        // buy a commit an exemption. An absolute `-C` still names its repo, so it is unaffected.
        if (unknownDir && gitDir === null && (sub === 'commit' || sub === 'push'))
          return { blocked: true, reason: UNRESOLVABLE_MOVE };
        const verdict = ruleFor(sub, args, branchFor(gitDir), () => repoFor(gitDir));
        if (verdict) return { blocked: true, reason: verdict };
        // Only switch/checkout needs the repo shape here; computing it for every segment would put
        // the git subprocesses back on `git status`/`log`/`diff`, which is what the thunk avoids.
        const switched = (sub === 'switch' || sub === 'checkout')
          ? switchTarget(sub, args, repoFor(gitDir).protectedBranches ?? ['main'])
          : null;
        if (switched) branches.set(gitDir, switched);
      }
    }

    // A `cd` that is not the segment's first word — behind a pipeline, a `do`/`then`, or a command
    // word like `time (cd …`. Runs for EVERY segment, outside both branches above: an `else` on the
    // git branch hid it behind a `git`-led segment, and an `else` on the cd branch hid it behind a
    // leading one (`cd /tmp | (cd <repo-on-main> && git commit)`). Applied after the rules, never
    // instead of them — it follows that first word's command, so `git commit -m x | (cd /elsewhere)`
    // is still judged where it commits.
    const hidden = hiddenDirTarget(segment, dir);
    if (hidden !== undefined) {
      dir = hidden;
      unknownDir = hidden === null;
    }

    for (let i = parens.close; i > 0 && outer.length; i--) [dir, unknownDir] = outer.pop();
  }

  return { blocked: false };
}

// `branch` is the branch of the repo THIS command acts on, not the hook's.
// `getRepo()` is a THUNK returning { hasRemote, protectedBranches } — called only by the rules that
// need it, so `git status`/`log`/`diff` never pay for the git subprocesses it costs.
function ruleFor(sub, args, branch, getRepo) {
  const destructive = destructiveGitReason(sub, args);
  if (destructive) return destructive;

  if ((sub === 'add' || sub === 'stage') && stagesEverything(args))
    return "git add/stage of the whole tree (-A / --all / . / *) stages everything. Stage only this ticket's files explicitly (git add <path> ...). See CLAUDE.md → Branch, commit & PR workflow.";

  if (sub === 'commit' && commitStagesAll(args))
    return "git commit -a / -am stages every tracked change, bypassing per-ticket staging. Stage this ticket's files explicitly, then commit without -a. See CLAUDE.md.";

  // Everything above is repo-shape-independent. The two protected-branch rules below are NOT: the
  // policy they enforce ("land it on a branch and open a PR") is meaningless in a repo with nowhere
  // to push, where committing on the default branch is the normal thing to do (tkt-f32915b3e858).
  //
  // Order matters. The remote gate comes FIRST so the fail-closed resolution below can never fire in
  // a local-only repo — that combination is precisely the false block this exempts.
  if (sub !== 'commit' && sub !== 'push') return null;

  const { hasRemote, protectedBranches } = getRepo();

  // The COMMIT rule is gated on a remote: "land it on a branch and open a PR" is meaningless in a
  // repo with nowhere to push, where committing on the default branch is the normal thing to do.
  //
  // The PUSH rule is NOT gated. "No configured remote" is not "nowhere to push" — `git push <url>
  // main` works with zero remotes configured, so the remote gate has no information about it, and
  // gating it turned an explicit push to a protected branch into an allow.
  const gated = sub === 'commit' && !hasRemote;
  if (gated) return null;

  if (protectedBranches !== null && sub === 'commit' && protectedBranches.includes(branch))
    return `Direct commits to ${branch} are not allowed — every ticket lands on its own branch via a squash-merged PR. Cut a <type>/<id>-<slug> branch first. See CLAUDE.md.`;

  if (protectedBranches !== null && sub === 'push' && pushesMain(args, branch, protectedBranches))
    return `Direct pushes to ${protectedBranches.join('/')} are not allowed — push your ticket branch and open a PR. See CLAUDE.md → Branch, commit & PR workflow.`;

  // An unresolved branch is NOT a safe branch. Every failure that breaks `git rev-parse` — a bogus
  // GIT_CONFIG_PARAMETERS, GIT_CEILING_DIRECTORIES over the repo, a safe.directory refusal, git off
  // PATH — otherwise lands here as a SILENT allow, which is the sink that makes each of those a
  // main-commit bypass (tkt-fbc74a3252fe). Scoped to commit/push so an unresolvable branch still
  // can't wedge ordinary work, and last so explicit violations keep their precise message.
  if ((sub === 'commit' || sub === 'push') && branch === null)
    return 'Could not determine the current branch, so this commit/push cannot be checked against the never-commit-to-main rule. Refusing rather than guessing — check for a stale GIT_DIR/GIT_CONFIG_PARAMETERS in the environment, or a git safe.directory refusal, then retry. See CLAUDE.md → Branch, commit & PR workflow.';

  // Same reasoning one level up: if the repo HAS a remote but its default branch cannot be resolved,
  // we cannot tell whether this commit is landing on it. "Cannot check" must not be the permissive
  // answer. Set TICKET_WORKFLOW_PROTECTED_BRANCH to state it explicitly.
  if (protectedBranches === null)
    return 'Could not determine which branch this repository protects — origin/HEAD is unset and both origin/main and origin/master exist, or TICKET_WORKFLOW_PROTECTED_BRANCH names a branch that is not in this repo. Refusing rather than guessing, because picking the wrong one leaves the real default unguarded. Fetch the remote so origin/HEAD resolves, or set TICKET_WORKFLOW_PROTECTED_BRANCH to a branch that exists here.';

  return null;
}

function branchIn(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd ? { cwd } : {}),
    }).trim();
  } catch {
    return null;
  }
}

// An unusable dir falls back to `fallbackDir`, not null: a null branch never blocks,
// so without this `cd /typo; git commit` on main would slip through.
function currentBranch(dir, fallbackDir) {
  return (dir ? branchIn(dir) : null) ?? branchIn(fallbackDir);
}

export function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch (err) {
    // Fail CLOSED (tkt-92360b0e2079): stdin we cannot READ or PARSE yields a command we cannot judge.
    // Deliberately narrow — a payload that PARSES but carries no command still allows, because the
    // Bash matcher also fires for BashOutput, whose events legitimately have none.
    const how = err instanceof SyntaxError ? 'parse it as JSON' : `read it (${err?.code ?? err?.message ?? 'unknown error'})`;
    process.stderr.write(
      `[guard-bash] BLOCKED — unusable hook payload: could not ${how}. This is NOT a rule violation: ` +
        'the guard refuses rather than guess at a command it cannot see. Re-run the command; if it repeats, ' +
        'check the PreToolUse wiring in .claude/settings.json from a plain terminal.\n',
    );
    process.exit(2);
  }

  // payload.cwd is the project dir, not the Bash tool's cwd (verified 2026-07-15).
  const startDir = payload?.cwd ?? process.cwd();
  const getBranch = (dir) => currentBranch(dir, startDir);
  // An unusable dir falls back to the session repo, so a bogus `cd` cannot report "no remote" and
  // exempt itself. Note this covers a null dir only; a resolvable-but-nonexistent path still reports
  // that path's shape, which fails closed (unresolvable → refuse) rather than open.
  const getRepo = (dir) => {
    const d = dir ?? startDir;
    return { hasRemote: hasRemote(d), protectedBranches: protectedBranches(d) };
  };
  const { blocked, reason } = decide(payload?.tool_input?.command, getBranch, startDir, getRepo);
  if (blocked) {
    process.stderr.write(`[guard-bash] Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported
// by the test).
if (isMain(import.meta.url)) {
  main();
}
