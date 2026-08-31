import { describe, it, expect, vi, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGit, cdTarget, decide } from './guard-bash.mjs';
import { splitSegments } from './lib/shell.mjs';
import { protectedBranches } from './lib/default-branch.mjs';

// Git's repo context is exported into hook environments and inherited by `npm test` — absolute in a
// worktree, so it would silently redirect the temp-repo commands below at the REAL repo, and this
// suite would grade the wrong branch (tkt-cf1e0c0b3dda).
const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];
function hermeticEnv() {
  const env = { ...process.env };
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  return env;
}

// A branch resolver stub — most cases pin the branch explicitly, ignoring dir.
const onBranch = (name) => () => name;
const blocked = (cmd, branch) => decide(cmd, onBranch(branch)).blocked;

// Two repos, so a command's target actually matters (tkt-74bc8f9b6ba5).
const KANBAN = '/repos/kanban';
const OTHER = '/repos/other';
const byDir = (map) => (dir) => map[dir] ?? null;
const twoRepos = byDir({ [KANBAN]: 'main', [OTHER]: 'feat/x' });

describe('parseGit', () => {
  it('extracts the subcommand and args', () => {
    expect(parseGit('git add -A')).toEqual({ sub: 'add', args: ['-A'], rawArgs: ['-A'], repoDir: null, truncated: false });
    expect(parseGit('git commit -m "x"'))
      .toEqual({ sub: 'commit', args: ['-m', 'x'], rawArgs: ['-m', '"x"'], repoDir: null, truncated: false });
  });

  it('captures -C as repoDir, skips -c, skips env prefixes', () => {
    expect(parseGit('git -C /repo add foo'))
      .toEqual({ sub: 'add', args: ['foo'], rawArgs: ['foo'], repoDir: '/repo', truncated: false });
    expect(parseGit('git -c user.name=x commit'))
      .toEqual({ sub: 'commit', args: [], rawArgs: [], repoDir: null, truncated: false });
    expect(parseGit('FOO=bar git add foo'))
      .toEqual({ sub: 'add', args: ['foo'], rawArgs: ['foo'], repoDir: null, truncated: false });
  });

  it('requires the command word to be git (not just a mention)', () => {
    expect(parseGit('echo "git add -A"')).toBeNull();
    expect(parseGit('npm test')).toBeNull();
    expect(parseGit('git')).toBeNull();
  });

  it('sees through subshell/group punctuation', () => {
    expect(parseGit('(git add -A)')).toEqual({ sub: 'add', args: ['-A'], rawArgs: ['-A'], repoDir: null, truncated: false });
  });

  // A quoted span is ONE token. repoDir keeps its quoting — resolveDir owns removal there, and
  // hiddenDirTarget needs the raw text (tkt-8f2e1f9894e2) — while sub/args come back dequoted and
  // rawArgs preserves the spelling for the short-flag scan (tkt-6d1ae448e3b3).
  it('keeps a quoted span carrying a space in one token', () => {
    expect(parseGit('git -C "/repos/my repo" commit -m x'))
      .toEqual({ sub: 'commit', args: ['-m', 'x'], rawArgs: ['-m', 'x'], repoDir: '"/repos/my repo"', truncated: false });
    expect(parseGit("git -C '/repos/my repo' commit -m x"))
      .toEqual({ sub: 'commit', args: ['-m', 'x'], rawArgs: ['-m', 'x'], repoDir: "'/repos/my repo'", truncated: false });
    expect(parseGit('git commit -m "fix -a bug"'))
      .toEqual({ sub: 'commit', args: ['-m', 'fix -a bug'], rawArgs: ['-m', '"fix -a bug"'], repoDir: null, truncated: false });
  });

  it('skips an env prefix whose quoted value contains a space', () => {
    expect(parseGit('EDITOR="code -w" git commit -m x'))
      .toEqual({ sub: 'commit', args: ['-m', 'x'], rawArgs: ['-m', 'x'], repoDir: null, truncated: false });
  });

  it('reports a subcommand swallowed by an unterminated quote, rather than returning null', () => {
    expect(parseGit('git -C "/a/b commit -m x'))
      .toEqual({ sub: null, args: [], rawArgs: [], repoDir: '"/a/b commit -m x', truncated: true });
    // Still null when there is simply no subcommand — no quote is involved, so nothing was hidden.
    expect(parseGit('git -C /repo')).toBeNull();
  });
});

describe('cdTarget', () => {
  it('returns undefined for non-cd segments', () => {
    expect(cdTarget('git commit -m x', KANBAN)).toBeUndefined();
    expect(cdTarget('npm test', KANBAN)).toBeUndefined();
  });

  it('resolves absolute and relative targets', () => {
    expect(cdTarget(`cd ${OTHER}`, KANBAN)).toBe(OTHER);
    expect(cdTarget('cd ../other', KANBAN)).toBe(OTHER);
  });

  it('returns null when resolving would mean guessing', () => {
    expect(cdTarget('cd -', KANBAN)).toBeNull();
    expect(cdTarget('cd', KANBAN)).toBeNull();
    expect(cdTarget('cd $SOMEWHERE', KANBAN)).toBeNull();
    expect(cdTarget('cd ~someuser/repo', KANBAN)).toBeNull();
  });

  it('keeps a balanced quoted span together instead of truncating it', () => {
    // Whitespace-splitting delivered '"/repos/my' — a truncated path that still RESOLVES, so the
    // guard judged one repo by another's branch. Naming it is what makes latching an unresolvable
    // cd safe: a quoted spaced path is nameable, so it must be resolved rather than refused
    // (tkt-a4c21bf57492).
    expect(cdTarget('cd "/repos/my repo"', KANBAN)).toBe('/repos/my repo');
    expect(cdTarget("cd '/repos/my repo'", KANBAN)).toBe('/repos/my repo');
    expect(cdTarget('cd "../my repo"', KANBAN)).toBe('/repos/my repo');
    expect(cdTarget('cd "/repos/other"', KANBAN)).toBe(OTHER);
  });

  it('reaches cd through group punctuation and an env prefix', () => {
    // The `^[({\s]+` strip runs on the WHOLE string, not per token. Losing that is one of the two
    // fail-opens tkt-3006d09810f7 reverted, so quotedTokens must not reintroduce it — the third row
    // is the one that binds both halves at once.
    expect(cdTarget('( FOO=bar cd /repos/other', KANBAN)).toBe(OTHER);
    expect(cdTarget('(cd /repos/other)', KANBAN)).toBe(OTHER);
    expect(cdTarget('( FOO=bar cd "/repos/my repo"', KANBAN)).toBe('/repos/my repo');
  });

  it('dequotes a span anywhere in the token, not only one that wraps it', () => {
    // A first-char/last-char test calls all of these unbalanced, and with the latch below that turns
    // a REFUSAL into the answer for a directory the command names perfectly well — the false block
    // that reverted tkt-3006d09810f7, one spelling over. Raised by review on tkt-a4c21bf57492.
    expect(cdTarget('cd "/repos/my repo"/sub', KANBAN)).toBe('/repos/my repo/sub');
    expect(cdTarget('cd "/repos/my repo"/', KANBAN)).toBe('/repos/my repo/');
    expect(cdTarget('cd /repos/"my repo"', KANBAN)).toBe('/repos/my repo');
    expect(cdTarget("cd /repos/'my repo'", KANBAN)).toBe('/repos/my repo');
    // The fused form is the one that was FAIL-OPEN: it does not start with a quote, so nothing
    // stripped it, and `/repos/"my repo"` resolved as a real-looking path nobody named.
    expect(cdTarget('cd /a/"b c"', KANBAN)).toBe('/a/b c');
  });

  it('still returns null for an UNTERMINATED quote', () => {
    // The span was truncated before it reached us, so no directory is named — the fail-closed
    // reading, and the one quoted shape that must still latch.
    expect(cdTarget('cd "/repos/my repo', KANBAN)).toBeNull();
    expect(cdTarget("cd '/repos/my repo", KANBAN)).toBeNull();
    expect(cdTarget('cd /repos/"my repo', KANBAN)).toBeNull();
  });

  it('reads the operand past cd option flags, but not past a bare dash', () => {
    // `cd -P /x` names a directory; only a BARE `-` is OLDPWD, which cannot be resolved. Latching
    // the flag forms refused a nameable directory — the same false block as above (review finding).
    expect(cdTarget('cd -P /repos/other', KANBAN)).toBe(OTHER);
    expect(cdTarget('cd -L /repos/other', KANBAN)).toBe(OTHER);
    expect(cdTarget('cd -- /repos/other', KANBAN)).toBe(OTHER);
    expect(cdTarget('cd -P "/repos/my repo"', KANBAN)).toBe('/repos/my repo');
    expect(cdTarget('cd -', KANBAN)).toBeNull();
    expect(cdTarget('cd -P', KANBAN)).toBeNull(); // no operand — goes HOME, unknowable
    // `--` is how a shell names a directory that LOOKS like a flag, so the operand after it is a
    // path however it starts. Added because mutating `target === '-'` to `target.startsWith('-')`
    // left the suite green: after operandOf consumes the flags nothing else begins with a dash, so
    // this is the only input that tells the two spellings apart.
    expect(cdTarget('cd -- -weird', KANBAN)).toBe('/repos/kanban/-weird');
  });
});

describe('decide — whole-tree staging', () => {
  it('blocks -A / --all / . / * / :/ and the stage alias', () => {
    for (const cmd of ['git add -A', 'git add --all', 'git add .', "git add '*'", 'git add :/', 'git stage -A']) {
      expect(blocked(cmd, 'feat/x')).toBe(true);
    }
  });

  it('allows explicit file staging', () => {
    expect(blocked('git add server/index.ts src/App.tsx', 'feat/x')).toBe(false);
    expect(blocked('git add ./server/index.ts', 'feat/x')).toBe(false);
  });
});

describe('decide — commit', () => {
  it('blocks commit -a / -am on any branch (bypasses staging)', () => {
    expect(blocked('git commit -am "x"', 'feat/x')).toBe(true);
    expect(blocked('git commit -a', 'feat/x')).toBe(true);
  });

  it('blocks commit on main, allows a normal commit on a feature branch', () => {
    expect(blocked('git commit -m "x"', 'main')).toBe(true);
    expect(blocked('git commit -m "x"', 'feat/x')).toBe(false);
  });

  it('does not mistake --amend for the -a/--all flag', () => {
    expect(blocked('git commit --amend -m "x"', 'feat/x')).toBe(false);
  });
});

describe('decide — push', () => {
  it('blocks a bare push while on main', () => {
    expect(blocked('git push', 'main')).toBe(true);
    expect(blocked('git push origin', 'main')).toBe(true);
  });

  it('blocks pushes that target main from any branch, including full refspecs', () => {
    expect(blocked('git push -u origin main', 'feat/x')).toBe(true);
    expect(blocked('git push origin HEAD:main', 'feat/x')).toBe(true);
    expect(blocked('git push origin HEAD:refs/heads/main', 'feat/x')).toBe(true);
  });

  it('allows pushing a feature branch', () => {
    expect(blocked('git push -u origin feat/x', 'feat/x')).toBe(false);
  });

  it('allows safe pushes from main (branch deletes, tag pushes)', () => {
    expect(blocked('git push origin --delete feat/old', 'main')).toBe(false);
    expect(blocked('git push --tags', 'main')).toBe(false);
  });
});

describe('decide — compound commands & branch tracking', () => {
  it('trips on a forbidden segment inside a chain', () => {
    expect(blocked('git add . && git commit -m "x"', 'feat/x')).toBe(true);
  });

  it('catches a second command after a newline', () => {
    expect(blocked('git status\ngit push origin main', 'feat/x')).toBe(true);
  });

  it('tracks an in-chain branch switch so branch-then-work is allowed', () => {
    expect(blocked('git switch -c feat/x && git commit -m "x"', 'main')).toBe(false);
    expect(blocked('git switch -c feat/x && git push -u origin feat/x', 'main')).toBe(false);
    expect(blocked('git checkout -b feat/x && git commit -m "x"', 'main')).toBe(false);
  });
});

describe('decide — destructive git flags (blocked on any branch)', () => {
  it('blocks force-push variants', () => {
    expect(blocked('git push --force origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push -f origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push --force-with-lease origin feat/x', 'feat/x')).toBe(true);
  });

  it('blocks git add -f / --force (can stage gitignored secrets)', () => {
    expect(blocked('git add -f .env', 'feat/x')).toBe(true);
    expect(blocked('git add --force dist/bundle.js', 'feat/x')).toBe(true);
  });

  it('blocks git branch -D (force delete) but allows -d', () => {
    expect(blocked('git branch -D feat/x', 'main')).toBe(true);
    expect(blocked('git branch -d feat/x', 'main')).toBe(false);
  });

  it('blocks git reset --hard, git clean -f, git checkout -f', () => {
    expect(blocked('git reset --hard HEAD~1', 'feat/x')).toBe(true);
    expect(blocked('git clean -fd', 'feat/x')).toBe(true);
    expect(blocked('git checkout -f main', 'feat/x')).toBe(true);
  });

  it('still allows the normal workflow shapes', () => {
    expect(blocked('git push -u origin feat/x', 'feat/x')).toBe(false);
    expect(blocked('git add src/App.tsx', 'feat/x')).toBe(false);
    expect(blocked('git checkout -b feat/y', 'main')).toBe(false);
  });
});

describe('decide — edge cases', () => {
  // Fails CLOSED, reversing the original permissive behavior: an unresolvable branch is the one
  // unknown that silently disables the never-commit-to-main rule (tkt-fbc74a3252fe).
  it('blocks commit/push when the branch is undeterminable', () => {
    expect(decide('git commit -m "x"', () => null).blocked).toBe(true);
    expect(decide('git push', () => null).blocked).toBe(true);
  });

  // …but only those two, so a broken branch probe can never wedge ordinary work.
  it('still allows everything else when the branch is undeterminable', () => {
    for (const cmd of ['git status', 'git add src/App.tsx', 'git switch -c feat/x', 'git log --oneline']) {
      expect(decide(cmd, () => null).blocked).toBe(false);
    }
  });

  it('ignores empty / non-string commands', () => {
    expect(blocked('', 'main')).toBe(false);
    expect(decide(undefined, onBranch('main')).blocked).toBe(false);
  });

  it('does not false-positive on data that merely mentions a git command', () => {
    expect(blocked('npm run lint', 'main')).toBe(false);
    expect(blocked('echo "git add -A is documented"', 'feat/x')).toBe(false);
    expect(blocked("printf 'git add -A'", 'feat/x')).toBe(false);
  });
});

describe('decide — hardened bypasses (tkt-0b9b9543907f)', () => {
  it('blocks +refspec force-push (main and feature branches)', () => {
    expect(blocked('git push origin +main', 'feat/x')).toBe(true);
    expect(blocked('git push origin +feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push origin +refs/heads/main', 'feat/x')).toBe(true);
  });

  it('blocks clustered force flags (-uf / -fu)', () => {
    expect(blocked('git push -uf origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push -fu origin feat/x', 'feat/x')).toBe(true);
    // a non-force cluster is still fine
    expect(blocked('git push -u origin feat/x', 'feat/x')).toBe(false);
  });

  it('blocks `git push origin HEAD` while on main, allows it on a feature branch', () => {
    expect(blocked('git push origin HEAD', 'main')).toBe(true);
    expect(blocked('git push origin @', 'main')).toBe(true);
    expect(blocked('git push origin HEAD', 'feat/x')).toBe(false);
  });

  it('blocks branch force-delete in all shapes, allows safe -d', () => {
    for (const cmd of ['git branch -D x', 'git branch --delete --force x', 'git branch -d -f x', 'git branch -df x', 'git branch -Df x']) {
      expect(blocked(cmd, 'feat/x'), cmd).toBe(true);
    }
    expect(blocked('git branch -d x', 'feat/x')).toBe(false);
    expect(blocked('git branch --delete x', 'feat/x')).toBe(false);
  });

  it('blocks git clean force via long flag and clusters, allows dry-run', () => {
    for (const cmd of ['git clean --force', 'git clean -f', 'git clean -xdf', 'git clean -ffd']) {
      expect(blocked(cmd, 'feat/x'), cmd).toBe(true);
    }
    expect(blocked('git clean -n', 'feat/x')).toBe(false);
  });

  it('blocks `git switch - && git commit` (previous branch could be main)', () => {
    expect(blocked('git switch - && git commit -m x', 'feat/x')).toBe(true);
    expect(blocked('git checkout - && git commit -m x', 'feat/x')).toBe(true);
    // switching to a named feature branch then committing is still fine
    expect(blocked('git switch feat/y && git commit -m x', 'main')).toBe(false);
  });
});

describe('decide — the command target picks the repo (tkt-74bc8f9b6ba5)', () => {
  // Before this fix, every command was judged against the hook's own cwd, so
  // working in a sibling repo while kanban sat on main blocked every commit.
  it('judges a commit by the repo the chain cd-ed into, not the start dir', () => {
    expect(decide(`cd ${OTHER} && git commit -m x`, twoRepos, KANBAN).blocked).toBe(false);
    expect(decide('git commit -m x', twoRepos, KANBAN).blocked).toBe(true); // kanban is on main
  });

  it('honors git -C without a cd', () => {
    expect(decide(`git -C ${OTHER} commit -m x`, twoRepos, KANBAN).blocked).toBe(false);
    expect(decide(`git -C ${KANBAN} commit -m x`, twoRepos, OTHER).blocked).toBe(true);
  });

  it('resolves a relative cd against startDir', () => {
    expect(decide('cd ../other && git commit -m x', twoRepos, KANBAN).blocked).toBe(false);
  });

  it('keeps branch state per directory — a switch in one repo does not unlock another', () => {
    expect(
      decide(`cd ${OTHER} && git switch -c feat/y && cd ${KANBAN} && git commit -m x`, twoRepos, KANBAN).blocked,
    ).toBe(true);
  });

  it('still blocks a push to main from a sibling repo', () => {
    expect(decide(`cd ${OTHER} && git push origin main`, twoRepos, KANBAN).blocked).toBe(true);
  });

  it('falls back to the start dir when a cd is unresolvable, rather than giving up', () => {
    // Mirrors the real currentBranch contract: any dir it can't read falls back to
    // startDir. A stub that returned null here would model a hole the code doesn't have.
    const realistic = (d) => twoRepos(d) ?? twoRepos(KANBAN);
    expect(decide('cd - && git commit -m x', realistic, KANBAN).blocked).toBe(true);
    expect(decide('cd /typo-dir && git commit -m x', realistic, KANBAN).blocked).toBe(true);
  });

  it('restores the outer dir when a subshell closes', () => {
    // `(cd other && …)` does not move the caller's cwd, so the later commit is in kanban/main.
    expect(decide(`(cd ${OTHER} && git status) && git commit -m x`, twoRepos, KANBAN).blocked).toBe(true);
    expect(decide(`(cd ${OTHER} && git commit -m x)`, twoRepos, KANBAN).blocked).toBe(false);
  });

  it('resolves each distinct repo once', () => {
    const spy = vi.fn(twoRepos);
    decide(`git status && git log && cd ${OTHER} && git commit -m x && git push origin feat/x`, spy, KANBAN);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([KANBAN, OTHER]);
  });
});

// The guard half of tkt-2734584f8715's defect (tkt-3006d09810f7). decide() restored a subshell's
// directory with a regex on the raw segment, and looked for a `cd` in a segment's FIRST word only.
// Both miss a move, and a missed move is judged against the SESSION's branch — which while working a
// ticket is a feature branch, i.e. allowed. So each miss is a never-commit-to-main bypass, and the
// session state that reaches it is the ordinary one.
describe('decide — a cd the parser missed must not exempt a commit (tkt-3006d09810f7)', () => {
  // Session sits on OTHER (feat/x); every command below acts on KANBAN, which is on main.
  //
  // The resolver MUST fall back to the session's branch for a dir it does not know, because that is
  // what the real one does (currentBranch(dir, fallbackDir)). A stub returning null for an unknown
  // dir models a contract the code does not have, and the pre-existing branch===null rule then
  // satisfies every case here whether or not the new guard exists — verified by deleting the guard
  // and watching all of them stay green. That is the hazard the `end to end` suite below names.
  const sessionAt = (home) => (d) => twoRepos(d) ?? twoRepos(home);
  const from = (cmd) => decide(cmd, sessionAt(OTHER), OTHER).blocked;
  const fromMain = (cmd) => decide(cmd, sessionAt(KANBAN), KANBAN).blocked;

  it('blocks a commit after a segment that ends in a command substitution', () => {
    // `export SHA=$(date)` ends in a `)` that closes no subshell — counting it popped a frame
    // nothing pushed, silently restoring the pre-`cd` directory.
    expect(from(`(cd ${KANBAN} && export SHA=$(date) && git commit -m x)`)).toBe(true);
  });

  it('blocks a commit after a cd hidden behind a pipeline or a command word', () => {
    expect(from(`echo x | (cd ${KANBAN} && git commit -m y)`)).toBe(true);
    expect(from(`time (cd ${KANBAN} && git commit -m x)`)).toBe(true);
    expect(from(`for d in a; do (cd ${KANBAN} && git commit -m x); done`)).toBe(true);
  });

  it('blocks a push the same way — the push rule reads the same directory', () => {
    expect(from(`(cd ${KANBAN} && export SHA=$(date) && git push origin main)`)).toBe(true);
    expect(from(`echo x | (cd ${KANBAN} && git push)`)).toBe(true);
  });

  // Controls. A guard that blocks everything is not a fix, so the rows that were already correct
  // must still be correct — and still for the right reason, not because everything now blocks.
  it('still blocks the plain forms it always blocked', () => {
    expect(from(`cd ${KANBAN} && git commit -m x`)).toBe(true);
    expect(from(`(cd ${KANBAN} && git commit -m x)`)).toBe(true);
    expect(from(`(cd ${KANBAN} && echo "oops :)" && git commit -m x)`)).toBe(true);
  });

  it('sees a hidden cd even when the segment is led by a git command word', () => {
    // Single `|` is not a split point, so this is ONE segment whose command word is `git`. While the
    // hidden-move check sat in the `else` of `if (git)`, swapping `echo` for `git` reopened the whole
    // bypass — the suite's own control passed and this did not.
    expect(from(`git log | (cd ${KANBAN} && git commit -m x)`)).toBe(true);
    expect(from(`git status | (cd ${KANBAN} && git push origin main)`)).toBe(true);
  });

  it('judges a commit where it commits, not where a later hidden cd goes', () => {
    // The `cd` runs after the segment's first command, so applying the move before the rules would
    // let a trailing `cd` into a feature repo excuse a commit that lands on main.
    expect(fromMain(`git commit -m x | (cd ${OTHER})`)).toBe(true);
  });

  it('latches an EXPLICIT unresolvable cd too, now that a quoted span survives', () => {
    // Pinned the other way while `cd "<path with a space>"` still arrived here unresolvable:
    // latching then refused a nameable directory, with a remedy that had no valid spelling. The
    // tokenizer fix removes that case from the set, so the latch can cover the rest. Full adversary
    // list in the tkt-a4c21bf57492 block below.
    expect(from('cd $D && git commit -m x')).toBe(true);
  });

  it('still follows a cd into a feature branch from a session on main', () => {
    // kanban's .claude/settings.audit.test.mjs pins this direction against the pinned build, so
    // over-blocking the plain form breaks a consumer's gate.
    expect(fromMain(`cd ${OTHER} && git commit -m x`)).toBe(false);
    expect(fromMain(`(cd ${OTHER} && export SHA=$(date) && git commit -m x)`)).toBe(false);
  });

  it('allows a hidden cd whose target it can name, in either direction', () => {
    // A hidden move is only unknowable when its TARGET is. Blocking on the mere fact of one refused
    // a commit into a repo the command names perfectly well — including the session's own.
    expect(fromMain(`echo x | (cd ${OTHER} && git commit -m x)`)).toBe(false);
    expect(from(`time (cd ${OTHER} && git commit -m x)`)).toBe(false);
    expect(from(`for d in a; do (cd ${OTHER} && git commit -m x); done`)).toBe(false);
    // ...and still blocks when that named target is the one on main.
    expect(fromMain(`echo x | (cd ${KANBAN} && git commit -m x)`)).toBe(true);
  });

  it('does not read a quoted cd in a commit message as a move', () => {
    // hiddenDirTarget tokenizes on whitespace, so without masking an `&& cd` inside a message reads
    // as a move. The first two only prove it does not BLOCK — the resolver falls back to the
    // session's own branch either way, so they pass with masking disabled. The third is the one that
    // binds it: from a session on main, a quoted path naming the feature repo would repoint the
    // guard and let a commit on main through.
    expect(from(`git commit -m "fix && cd handling"`)).toBe(false);
    expect(from(`echo "run && cd /elsewhere" && git commit -m x`)).toBe(false);
    expect(fromMain(`echo "a && cd ${OTHER} && b" && git commit -m x`)).toBe(true);
  });

  it('does not block reads or non-branch rules after an unresolvable move', () => {
    // Fail-closed is scoped to commit/push, exactly as the branch===null rule is: an unknown
    // directory must not wedge ordinary work.
    expect(from(`echo x | (cd $D && git status)`)).toBe(false);
    expect(from(`echo x | (cd $D && npm test)`)).toBe(false);
  });

  it('restores the unknown-directory latch when a subshell closes, not just the directory', () => {
    // The `outer` frame carries [dir, unknownDir] as a PAIR. Saving only dir lets an inner subshell
    // that cd-ed somewhere nameable clear the latch on its way out, and the commit after it is then
    // judged against the session repo — the same fail-open, laundered through a nested subshell.
    expect(from(`echo x | (cd $D && (cd /tmp && ls) && git commit -m y)`)).toBe(true);
  });

  it('re-pins the directory when an absolute cd follows the hidden one', () => {
    expect(from(`echo x | (cd ${KANBAN} && cd ${OTHER} && git commit -m x)`)).toBe(false);
    expect(fromMain(`echo x | (cd ${OTHER} && cd ${KANBAN} && git commit -m x)`)).toBe(true);
  });

  it('honors an absolute -C through an unresolvable move, and refuses a relative one', () => {
    expect(from(`echo x | (cd $D && git -C ${OTHER} commit -m x)`)).toBe(false);
    expect(from(`echo x | (cd $D && git -C ../other commit -m x)`)).toBe(true);
  });

  // One case per guard line added by this fix. Six of them bound nothing when first written — the
  // repair for a guard that shipped untested must not itself ship untested (~/.claude/CLAUDE.md →
  // "A guarantee needs an adversary list before the code").

  it('slices a raw target at offsets the mask preserves', () => {
    // maskData maps `$(` to TWO characters for exactly this reason: hiddenDirTarget recovers the raw
    // token by offset, so a one-character shift silently yields a different directory — one the
    // guard then resolves and judges with full confidence.
    expect(from(`echo $(date) | (cd ${KANBAN} && git commit -m x)`)).toBe(true);
    expect(fromMain(`echo $(date) | (cd ${OTHER} && git commit -m x)`)).toBe(false);
    // And the token itself must come from the RAW text, not the mask. A quoted target masks to
    // underscores, which resolve as a plausible RELATIVE path instead of the absolute one written —
    // so the guard would follow the command to a directory nobody named.
    expect(from(`echo x | (cd "${KANBAN}" && git commit -m x)`)).toBe(true);
  });

  it('treats a hidden bare cd, cd - and popd as moves it cannot name', () => {
    expect(from('echo x | (cd && git commit -m y)')).toBe(true);
    expect(from('echo x | (cd - && git commit -m y)')).toBe(true);
    expect(from('echo x | (popd && git commit -m y)')).toBe(true);
    // `popd` returns to a stack this cannot see, so its next token is never a target. Without a
    // token after it the `!next` guard answers first, which is why this case carries one: read as a
    // target it resolves to a real-looking directory, and a real-looking directory is never refused.
    expect(from('echo x | (popd /tmp && git commit -m y)')).toBe(true);
  });

  it('does not read cd as a move when it is an ordinary argument', () => {
    // Only the command position counts. Without that check this repoints the guard at the feature
    // repo and a commit landing on main walks.
    expect(fromMain(`ls cd ${OTHER} && git commit -m x`)).toBe(true);
  });

  it('opens a subshell frame for a paren that does not start the segment', () => {
    // `echo x | (cd …` — the old `/^\(+/` missed it, so the matching close popped a frame nothing
    // pushed and the move leaked out of the subshell it belonged to.
    expect(from(`echo x | (cd ${KANBAN} && git status) && git commit -m x`)).toBe(false);
  });

  it('sees a hidden cd even when the segment also opens with an explicit one', () => {
    expect(from(`cd /tmp | (cd ${KANBAN} && git commit -m y)`)).toBe(true);
  });
});

// parseGit split on plain whitespace, so a quoted span carrying a space arrived as two tokens and
// every token after it sat one slot off. The consequences point in BOTH directions: a `-C` path or
// an env prefix with a space fell OUT of the never-commit-to-main rule (a fail-open — the shape the
// guard exists for), while a commit message merely containing `-a` fell INTO the whole-tree-staging
// rule (a false block). One quote-aware tokenizer, the same one cd parsing already uses, is the fix
// rather than a second copy here (tkt-8f2e1f9894e2).
describe('decide — a quoted span must not split into tokens (tkt-8f2e1f9894e2)', () => {
  const SPACED = '/repos/my repo';
  const spaced = byDir({
    [KANBAN]: 'main',
    [OTHER]: 'feat/x',
    [SPACED]: 'main',
    [`${SPACED}/sub`]: 'main',
    '/repos/my repo two': 'feat/x',
  });

  it('blocks a commit on main in a -C repo whose path contains a space, in both quote styles', () => {
    expect(decide(`git -C "${SPACED}" commit -m x`, spaced, OTHER).blocked).toBe(true);
    expect(decide(`git -C '${SPACED}' commit -m x`, spaced, OTHER).blocked).toBe(true);
  });

  it('still allows that same -C commit when the spaced repo is on a feature branch', () => {
    // The control the row above needs: without it, a tokenizer that refused every quoted -C
    // outright would pass the block case while wedging the ordinary one.
    expect(decide(`git -C "/repos/my repo two" commit -m x`, spaced, KANBAN).blocked).toBe(false);
  });

  it('resolves a quoted span wherever it sits in the -C token, as cd already does', () => {
    expect(decide(`git -C "${SPACED}"/sub commit -m x`, spaced, OTHER).blocked).toBe(true);
    expect(decide(`git -C /repos/"my repo" commit -m x`, spaced, OTHER).blocked).toBe(true);
  });

  it('blocks a commit on main behind an env prefix whose value contains a space', () => {
    // The worst shape of the three: parseGit returned null, so the invocation was invisible to
    // EVERY rule — not just the branch ones. The unquoted control passes today.
    expect(decide('EDITOR="code -w" git commit -m x', onBranch('main')).blocked).toBe(true);
    expect(decide('EDITOR=vim git commit -m x', onBranch('main')).blocked).toBe(true);
  });

  it('does not read -a inside a quoted commit message as commit --all', () => {
    // The false-block direction. `commitStagesAll` was handed a bare `-a` the author never wrote,
    // so this was refused on every branch, protected or not.
    expect(blocked('git commit -m "fix -a bug"', 'feat/x')).toBe(false);
    expect(blocked("git commit -m 'fix -a bug'", 'feat/x')).toBe(false);
    expect(blocked('git commit -am "fix"', 'feat/x')).toBe(true); // the real -am still blocks
  });

  it('does not read a blanket staging token inside a quoted path as whole-tree staging', () => {
    // The fixture must be one the OLD tokenizer actually got wrong. `"my dir/file .txt"` was not:
    // it split to `.txt"`, which is in no blanket set, so the case passed with and without the fix
    // — a control that passes is the finding (review, tkt-8f2e1f9894e2). These two split to a bare
    // `.`, which IS blanket, and were refused on every branch.
    expect(blocked('git add "a . b"', 'feat/x')).toBe(false);
    expect(blocked('git add "release notes . draft"', 'feat/x')).toBe(false);
    expect(blocked('git add -A', 'feat/x')).toBe(true); // control
    expect(blocked('git add .', 'feat/x')).toBe(true); // control
  });

  it('reads short-flag letters only up to an attached value', () => {
    // Keeping the quotes in the token fused `-m"fix and go"` into one arg, and the cluster scan then
    // read the MESSAGE as flag letters: an `a` anywhere made it `commit -a`, an `f` made a push a
    // force-push. Both refused ordinary work on any branch — the same false-block direction this
    // suite exists to close, one spelling over (review, tkt-8f2e1f9894e2).
    expect(blocked('git commit -m"fix the bug and go"', 'feat/x')).toBe(false);
    expect(blocked("git commit -m'fix the bug and go'", 'feat/x')).toBe(false);
    expect(blocked('git push -o"ci skip fast" origin feat/x', 'feat/x')).toBe(false);
    // Controls: a real attached cluster still carries its letters, and the detached forms are
    // untouched. Without these, stripping the letters entirely would pass the three rows above.
    expect(blocked('git commit -am"fix"', 'feat/x')).toBe(true);
    expect(blocked('git commit -a', 'feat/x')).toBe(true);
    expect(blocked('git push -f origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push -uf origin feat/x', 'feat/x')).toBe(true);
  });

  it('refuses a git command whose subcommand an unterminated quote swallowed', () => {
    // quotedTokens fuses the rest of the line into one token, so `-C` consumes it and NO token is
    // left where the subcommand belongs. parseGit returning null there hid the invocation from every
    // rule — where the whitespace split still recovered `commit` and blocked it on main. Fail closed
    // instead: the shell would reject an unterminated quote anyway (review, tkt-8f2e1f9894e2).
    expect(blocked('git -C "/a/b commit -m x', 'feat/x')).toBe(true);
    expect(blocked("git -C '/a/b push origin main", 'feat/x')).toBe(true);
    // Controls: a terminated quote is judged normally, and a genuinely subcommand-less git is still
    // not a block — `parseGit('git')` must stay null, or every bare `git` would be refused.
    expect(decide('git -C "/repos/my repo" status', spaced, OTHER).blocked).toBe(false);
    expect(blocked('git', 'feat/x')).toBe(false);
    expect(blocked('git -C /repos/other', 'feat/x')).toBe(false);
  });

  it('leaves every unquoted shape exactly as it was', () => {
    expect(decide(`git -C ${KANBAN} commit -m x`, twoRepos, OTHER).blocked).toBe(true);
    expect(decide(`git -C ${OTHER} commit -m x`, twoRepos, KANBAN).blocked).toBe(false);
    expect(blocked('git commit -m x', 'main')).toBe(true);
    expect(blocked('git commit -m x', 'feat/x')).toBe(false);
    expect(blocked('git push origin main', 'feat/x')).toBe(true);
  });
});

// Every other suite stubs getBranch. A stub can model a contract the real resolver
// doesn't honor — which is exactly how the cd-to-nowhere fail-open shipped green.
// This drives the real hook binary against real repos.
describe('the real hook, end to end', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'guard-'));
  const repo = (name, branch, { remote = true, defaultBranch = 'main' } = {}) => {
    const p = join(tmp, name);
    mkdirSync(p);
    const run = (c) => execSync(c, { cwd: p, stdio: 'ignore', env: hermeticEnv() });
    run(`git init -q -b ${defaultBranch}`);
    // The remote is load-bearing, not decoration: the protected-branch rules now only apply to repos
    // that have one (tkt-f32915b3e858). Without it every repo here is exempt and this whole describe
    // block passes while asserting nothing — the fresh-temp-dir habit hiding a guard.
    if (remote) run('git remote add origin https://example.invalid/r.git');
    run('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
    if (branch !== defaultBranch) run(`git switch -q -c ${branch}`);
    return p;
  };
  const onMain = repo('on-main', 'main');
  const onFeat = repo('on-feat', 'feat/x');

  const hook = fileURLToPath(new URL('./guard-bash.mjs', import.meta.url));
  // Hermetic base so an ambient GIT_DIR can't silently redirect these fixtures (tkt-cf1e0c0b3dda);
  // `env` puts specific vars back INTO the child, which is the only way a test reaches the hook's
  // own git-resolution behavior rather than the harness's (tkt-fbc74a3252fe).
  const runHook = (command, cwd, env = {}) => {
    const r = spawnSync('node', [hook], {
      input: JSON.stringify({ cwd, tool_input: { command } }),
      encoding: 'utf8',
      env: { ...hermeticEnv(), ...env },
    });
    return r.status; // 2 = blocked, 0 = allowed
  };

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // End-to-end for the merged change: the unit cases above stub the repo shape, so they would pass
  // even if the real git-backed resolution were wrong. These drive the actual hook against actual
  // repos (tkt-f32915b3e858 + plan 2.1).
  const noRemote = repo('no-remote', 'main', { remote: false });
  const onMaster = repo('on-master', 'master', { defaultBranch: 'master' });

  it('allows a commit on the default branch in a repo with no remote', () => {
    expect(runHook('git commit -m x', noRemote)).toBe(0);
  });

  it('still blocks the same commit once a remote exists (the control)', () => {
    expect(runHook('git commit -m x', onMain)).toBe(2);
  });

  it('blocks a commit on master when master is the default branch', () => {
    expect(runHook('git commit -m x', onMaster)).toBe(2);
  });

  it('prefers a local main over a local master when no remote-tracking ref resolves', () => {
    // Documents the ladder's real precedence rather than a wish. Creating a local `main` in a
    // master-default repo makes `main` resolve first (origin/HEAD needs a fetched remote), so `main`
    // becomes the protected branch here. Worth pinning: the obvious test — "commits on main are
    // allowed when master is the default" — measures the fixture, not the guard, because creating
    // that branch is what changes the answer. TICKET_WORKFLOW_PROTECTED_BRANCH is the way out.
    execSync('git switch -q -c main', { cwd: onMaster, stdio: 'ignore', env: hermeticEnv() });
    expect(runHook('git commit -m x', onMaster)).toBe(2);
    expect(runHook('git commit -m x', onMaster, { TICKET_WORKFLOW_PROTECTED_BRANCH: 'master' })).toBe(0);
    execSync('git switch -q master', { cwd: onMaster, stdio: 'ignore', env: hermeticEnv() });
  });

  it('still blocks whole-tree staging in a no-remote repo', () => {
    // The exemption is scoped to the protected-branch rules only.
    expect(runHook('git add -A', noRemote)).toBe(2);
  });

  it('blocks the QUOTED spellings through the real binary too (tkt-6d1ae448e3b3)', () => {
    // The unit rows for this fix go through decide() with a stubbed branch, so they would pass even
    // if the real hook never reached the changed code. These drive the actual binary.
    expect(runHook('git add "."', onFeat)).toBe(2);
    expect(runHook('git push origin "main"', onFeat)).toBe(2);
    expect(runHook('git switch "main" && git commit -m x', onFeat)).toBe(2);
    // Controls: the ordinary shapes this must not start refusing — without them, a hook that blocked
    // everything would pass the three rows above.
    expect(runHook('git add src/one.ts', onFeat)).toBe(0);
    expect(runHook('git commit -m"fix and go"', onFeat)).toBe(0);
    expect(runHook('git push origin feat/x', onFeat)).toBe(0);
  });

  it('fails CLOSED when the protected branch is genuinely ambiguous', () => {
    // The first version of this test passed `TICKET_WORKFLOW_PROTECTED_BRANCH: ''`, which trims to
    // falsy and is ignored — so it asserted exit 0 and never reached the fail-closed path at all.
    // A control that passes is the finding. This builds the ambiguity for real: origin/main and
    // origin/master both present, origin/HEAD unset.
    const amb = repo('ambiguous', 'feat/x');
    const run = (c) => execSync(c, { cwd: amb, stdio: 'ignore', env: hermeticEnv() });
    run('git update-ref refs/remotes/origin/main HEAD');
    run('git update-ref refs/remotes/origin/master HEAD');
    expect(runHook('git commit -m x', amb)).toBe(2);
    // ...and does not wedge ordinary work.
    expect(runHook('git status', amb)).toBe(0);
    // ...and the override is the documented way out, but only when it names a real branch.
    expect(runHook('git commit -m x', amb, { TICKET_WORKFLOW_PROTECTED_BRANCH: 'master' })).toBe(0);
    expect(runHook('git commit -m x', amb, { TICKET_WORKFLOW_PROTECTED_BRANCH: 'nope' })).toBe(2);
  });

  it('does not block commits in a healthy repo whose default branch is develop', () => {
    // Fail-closed must not mean "block every commit in a correctly configured repo": a develop-default
    // repo with an unfetched remote has no resolvable default, and previously worked fine.
    const dev = repo('develop-default', 'develop', { defaultBranch: 'develop' });
    expect(runHook('git commit -m x', dev)).toBe(0);
    expect(runHook('git add -A', dev)).toBe(2); // the unconditional rules still fire
  });

  it('honors TICKET_WORKFLOW_PROTECTED_BRANCH', () => {
    expect(runHook('git commit -m x', onFeat, { TICKET_WORKFLOW_PROTECTED_BRANCH: 'feat/x' })).toBe(2);
  });

  it('blocks a commit on main and allows one on a feature branch', () => {
    expect(runHook('git commit -m x', onMain)).toBe(2);
    expect(runHook('git commit -m x', onFeat)).toBe(0);
  });

  // GIT_DIR, not cwd, decides where a commit LANDS (measured: cwd=on-feat + GIT_DIR=on-main/.git
  // puts the commit on main). So the guard must judge the repo GIT_DIR names — scrubbing it would
  // grade a repo the commit never touches and allow a direct commit to main (tkt-fbc74a3252fe).
  // Dangerous direction first, so a regression reports the fail-open rather than the benign symptom.
  it('honors an ambient GIT_DIR — it judges the repo the commit will land in', () => {
    expect(runHook('git commit -m x', onFeat, { GIT_DIR: join(onMain, '.git') })).toBe(2);
    expect(runHook('git commit -m x', onMain, { GIT_DIR: join(onFeat, '.git') })).toBe(0);
  });

  // Each of these breaks `git rev-parse` outright rather than redirecting it, so the branch comes
  // back null — which used to mean "allowed" (tkt-fbc74a3252fe). The on-feat half matters most: the
  // branch there would have been safe, so only the fail-closed rule can be producing the block.
  it('fails CLOSED when the environment breaks branch resolution', () => {
    for (const env of [{ GIT_CONFIG_PARAMETERS: 'garbage' }, { GIT_COMMON_DIR: '/nonexistent' }, { GIT_OBJECT_DIRECTORY: '/nonexistent' }]) {
      expect(runHook('git commit -m x', onMain, env)).toBe(2);
      expect(runHook('git commit -m x', onFeat, env)).toBe(2);
    }
  });

  // GIT_CEILING_DIRECTORIES only bites where discovery must walk UP, so a repo root is immune and
  // a subdirectory is not — measured, not assumed.
  it('fails CLOSED when GIT_CEILING_DIRECTORIES blocks discovery from a subdirectory', () => {
    const sub = join(onFeat, 'sub');
    mkdirSync(sub, { recursive: true });
    expect(runHook('git commit -m x', sub)).toBe(0); // control: resolves feat/x, allowed
    expect(runHook('git commit -m x', sub, { GIT_CEILING_DIRECTORIES: onFeat })).toBe(2);
  });

  it('judges by the repo the chain cd-ed into — the bug this fixes', () => {
    expect(runHook(`cd ${onFeat} && git commit -m x`, onMain)).toBe(0);
    expect(runHook(`cd ${onMain} && git commit -m x`, onFeat)).toBe(2);
  });

  it('honors git -C', () => {
    expect(runHook(`git -C ${onFeat} commit -m x`, onMain)).toBe(0);
    expect(runHook(`git -C ${onMain} commit -m x`, onFeat)).toBe(2);
  });

  it('fails closed when the cd target is unusable', () => {
    // The regression the review caught: these were ALLOWED before the fallback.
    expect(runHook('cd /nonexistent-xyz && git commit -m x', onMain)).toBe(2);
    expect(runHook('cd - && git commit -m x', onMain)).toBe(2);
    expect(runHook('cd $NOPE && git commit -m x', onMain)).toBe(2);
  });
});

// tkt-a4c21bf57492. An explicit `cd` whose target this parser cannot NAME used to leave `dir` null
// without latching `unknownDir`, and a null dir alone falls back to the SESSION repo — a feature
// branch while a ticket is being worked, i.e. the permissive answer. The fix could not be the latch
// alone: `cd "<path with a space>"` reached the same slot, and refusing it would refuse a directory
// that is perfectly nameable, with a remedy ("a plain literal path") that has no valid spelling for
// such a path. That is why tkt-3006d09810f7 wrote this fix and reverted it. Tokenizer first, then
// the latch.
describe('decide — an explicit cd it cannot name must not exempt a commit (tkt-a4c21bf57492)', () => {
  // Two repos whose paths contain a space, one per branch state, so "resolved to the right repo"
  // and "refused because unresolvable" cannot be confused for one another: a block proves nothing
  // on its own, since the latch would produce one too.
  const SPACED_MAIN = '/repos/my repo';
  const SPACED_FEAT = '/repos/other one';
  const fourRepos = byDir({
    [KANBAN]: 'main',
    [OTHER]: 'feat/x',
    [SPACED_MAIN]: 'main',
    [SPACED_FEAT]: 'feat/y',
  });
  // As the block above: the resolver must fall back to the SESSION's branch for a dir it does not
  // know, because that is what currentBranch does. A stub returning null models a contract the code
  // does not have, and the pre-existing branch===null rule would then satisfy every case here
  // whether or not the latch exists.
  const sessionAt = (home) => (d) => fourRepos(d) ?? fourRepos(home);
  const at = (home, cmd) => decide(cmd, sessionAt(home), home);
  const from = (cmd) => at(OTHER, cmd).blocked;      // session on feat/x — the permissive direction
  const fromMain = (cmd) => at(KANBAN, cmd).blocked; // session on main

  // ---- the tokenizer half: a quoted spaced path is NAMEABLE, so it must resolve ----

  it('does not refuse a quoted spaced target carrying a suffix', () => {
    // Review finding: `"…"/sub` failed a first/last-char balance test, so the new latch REFUSED a
    // directory the command names. Before this ticket it fell back to the session and was allowed,
    // so the latch turned a fail-open into a false block rather than into a correct answer.
    const r = at(OTHER, `cd "${SPACED_FEAT}"/sub && git commit -m x`);
    expect(r.reason ?? '', 'a nameable directory must not be refused').not.toMatch(/cannot name/i);
    // ...and the fused spelling is judged where it points, not at the session.
    expect(fromMain(`cd /repos/"other one" && git commit -m x`)).toBe(false);
    expect(from(`cd /repos/"my repo" && git commit -m x`)).toBe(true);
  });

  it('does not refuse a cd carrying an option flag', () => {
    expect(fromMain(`cd -P ${OTHER} && git commit -m x`)).toBe(false);
    expect(from(`cd -P ${KANBAN} && git commit -m x`)).toBe(true);
    expect(from('cd -P $D && git commit -m x')).toBe(true); // flag + unnameable operand still latches
  });

  it('judges a quoted spaced target at THAT repo, in both directions', () => {
    // The direction that binds the tokenizer rather than the latch: from a session on main, a
    // quoted path naming a FEATURE repo must be ALLOWED. Truncation ('"/repos/my') or a null both
    // produce a block here, so only real resolution passes.
    expect(fromMain(`cd "${SPACED_FEAT}" && git commit -m x`)).toBe(false);
    expect(fromMain(`cd '${SPACED_FEAT}' && git commit -m x`)).toBe(false);
    // ...and the reverse still blocks, for the RIGHT reason — not as an unresolvable move.
    const blocked = at(OTHER, `cd "${SPACED_MAIN}" && git commit -m x`);
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason, `blocked for the wrong reason: ${blocked.reason}`).toMatch(/commits to main/i);
  });

  it('cannot reach the UNTERMINATED-quote latch through decide, and says so', () => {
    // Scoped down after review refuted the first version, which said "unbalanced" and generalized
    // from one spelling. `cd "/a/b c"/sub` IS unbalanced by a first/last-char test, DOES split in
    // two, and did reach the latch — a reachable false block, now fixed by dequoting properly.
    // What survives is the narrower claim: an UNTERMINATED quote suppresses splitSegments' own
    // split points and swallows the rest of the command, newline included, so no git segment can
    // follow it. The balanced form is the positive control.
    expect(splitSegments('cd "/repos/my repo && git commit -m x')).toHaveLength(1);
    expect(splitSegments('cd "/repos/my repo" && git commit -m x')).toHaveLength(2);
    expect(splitSegments('cd "/repos/my repo\ngit commit -m x')).toHaveLength(1);
    // The refuted counterexample, now resolving rather than latching.
    expect(splitSegments('cd "/repos/my repo"/sub && git commit -m x')).toHaveLength(2);
    expect(cdTarget('cd "/repos/my repo"/sub', KANBAN)).toBe('/repos/my repo/sub');
    // So the fail-closed reading of an unterminated quote is observable only one level down, where
    // the cdTarget suite above asserts it. Recorded rather than deleted: a reader who adds a
    // `decide`-level case for it will watch it pass while binding nothing.
    expect(cdTarget('cd "/repos/my repo', KANBAN)).toBeNull();
  });

  // ---- the latch half: a genuinely unnameable target refuses commit and push ----

  it('blocks a commit after every unnameable explicit cd spelling', () => {
    for (const move of ['cd $D', 'cd', 'cd -', 'cd ~someuser/repo']) {
      const r = at(OTHER, `${move} && git commit -m x`);
      expect(r.blocked, `${move} must latch`).toBe(true);
      expect(r.reason, `${move} blocked for the wrong reason`).toMatch(/cannot name/i);
    }
  });

  it('blocks a push the same way — the latch is scoped to commit AND push', () => {
    expect(from('cd $D && git push origin feat/x')).toBe(true);
  });

  it("blocks the hook header's own worked example", () => {
    // Printed in guard-bash.mjs as a shape it does not defend ("poisoning the unresolvable-dir
    // slot"). A switch between the two moves is what made it interesting: it repoints the branch
    // map for the unknown dir, but the latch is not read from the branch.
    expect(from('cd $A && git switch -c x && cd $B && git commit -m x')).toBe(true);
  });

  // ---- controls: a fix that blocks everything is not a fix ----

  it('does not wedge reads or non-git work after an unnameable cd', () => {
    expect(from('cd $D && git status')).toBe(false);
    expect(from('cd $D && git log --oneline')).toBe(false);
    expect(from('cd $D && npm test')).toBe(false);
  });

  it('clears the latch when a nameable cd follows, and re-latches when one precedes', () => {
    expect(fromMain(`cd $D && cd ${OTHER} && git commit -m x`)).toBe(false); // cleared → judged at OTHER
    expect(from(`cd $D && cd ${KANBAN} && git commit -m x`)).toBe(true);     // cleared → judged at KANBAN
    expect(from(`cd ${OTHER} && cd $D && git commit -m x`)).toBe(true);      // re-latched
  });

  it('restores the latch as a pair with dir when a subshell closes', () => {
    // The inner move is scoped to the subshell, so the commit after it runs in the session repo.
    expect(from('(cd $D && ls) && git commit -m x')).toBe(false);
    expect(fromMain('(cd $D && ls) && git commit -m x')).toBe(true);
    // ...and a latch set INSIDE must not leak past the close, nor be cleared by a nameable inner cd.
    expect(from(`(cd $D && (cd ${OTHER} && ls)) && git commit -m x`)).toBe(false);
  });

  it('honors an absolute -C through the latch, and refuses a relative one', () => {
    expect(from(`cd $D && git -C ${OTHER} commit -m x`)).toBe(false);
    expect(from(`cd $D && git -C ${KANBAN} commit -m x`)).toBe(true); // binds the OTHER direction
    expect(from('cd $D && git -C ../other commit -m x')).toBe(true);
    // A QUOTED -C path is deliberately absent: parseGit still whitespace-splits, so `git -C "/a/b c"
    // commit` is not recognized as a commit at all and passes every rule. Review found this row
    // asserting `false` and PASSING for that reason — a control binding nothing. It is a
    // pre-existing fail-open in parseGit, filed separately rather than fixed here.
  });

  it('leaves both directions of the plain cd-following rule untouched', () => {
    // kanban's .claude/settings.audit.test.mjs asserts both against the pinned build.
    expect(fromMain(`cd ${OTHER} && git commit -m x`)).toBe(false);
    expect(from(`cd ${KANBAN} && git commit -m x`)).toBe(true);
  });

  it('leaves a resolvable-but-nonexistent target falling back, NOT latching', () => {
    // The spelling kanban pins as a deliberate fail-open is an UNQUOTED spaced path, whose first
    // token is a real absolute path — mis-named, not un-nameable. This fix does not close it, and
    // must not appear to: kanban's audit runs the pinned build and would go red on a tag bump.
    const spaced = at(OTHER, '/repos/my repo');
    expect(spaced).toBeDefined();
    expect(from('cd /repos/my repo && git commit -m x')).toBe(false);
    expect(from('cd /typo-dir && git commit -m x')).toBe(false);
  });
});

describe('decide — no false positives on quoted / heredoc data', () => {
  it('does not split on && or newlines inside quotes / $( … )', () => {
    // The CLAUDE.md heredoc commit whose body mentions `git add -A` — one command.
    const heredoc = [
      'git commit -m "$(cat <<\'EOF\'',
      'Subject line',
      '',
      'Body that references git add -A and a && chain in prose.',
      'EOF',
      ')"',
    ].join('\n');
    expect(blocked(heredoc, 'feat/x')).toBe(false);
    // A quoted JS string containing `&& git commit` is data, not a command.
    expect(blocked(`node -e 'const s = "git switch - && git commit -m x"'`, 'main')).toBe(false);
  });

  it('still splits and blocks real chained commands', () => {
    expect(blocked('git add server/x.ts && git add -A', 'feat/x')).toBe(true);
    expect(blocked('git switch main && git commit -m x', 'feat/x')).toBe(true);
  });
});

// tkt-f32915b3e858 + plan 2.1. Two opposite corrections to the SAME two rules in ruleFor(), which is
// why they ship together: gating on remote presence relaxes the guard for local-only repos, while
// resolving the real default branch tightens it for repos not on `main`. Shipped alone, the
// fail-closed half of the second lands hardest exactly where the first is trying to stop blocking.
describe('main-branch rules: remote-gated, default-branch-aware', () => {
  const repo = (over = {}) => () => ({ hasRemote: true, protectedBranches: ['main'], ...over });
  const verdict = (cmd, branch, over) => decide(cmd, onBranch(branch), undefined, repo(over));

  it('allows a commit on main in a repo with NO remote', () => {
    // "lands on main via a squash-merged PR" is meaningless with nowhere to push. Hit live in a
    // local-only repo that has no remote at all.
    expect(verdict('git commit -m x', 'main', { hasRemote: false }).blocked).toBe(false);
  });

  it('still blocks a commit on main when a remote IS configured', () => {
    // The control: without it, the case above is satisfied by a guard that stopped guarding.
    expect(verdict('git commit -m x', 'main').blocked).toBe(true);
    expect(verdict('git push', 'main').blocked).toBe(true);
  });

  it('blocks a commit on the repo\'s real default branch when it is not named main', () => {
    // A repo on master got ZERO protection and no warning, because 'main' was a bare literal.
    expect(verdict('git commit -m x', 'master', { protectedBranches: ['master'] }).blocked).toBe(true);
    expect(verdict('git push origin master', 'master', { protectedBranches: ['master'] }).blocked).toBe(true);
  });

  it('does not block a feature branch in a repo whose default branch is master', () => {
    expect(verdict('git commit -m x', 'feat/x', { protectedBranches: ['master'] }).blocked).toBe(false);
  });

  it('does not treat main as protected when the default branch is master', () => {
    // 'main' is just another branch there — blocking it would be the hardcoded literal in reverse.
    expect(verdict('git commit -m x', 'main', { protectedBranches: ['master'] }).blocked).toBe(false);
  });

  it('fails CLOSED when the protected branch cannot be resolved', () => {
    // Same reasoning as the unresolvable-branch rule: every way of breaking git must not become a
    // commit-to-default bypass. Run on a branch the other rules would allow, so the block is
    // attributable to this one.
    expect(verdict('git commit -m x', 'feat/x', { protectedBranches: null }).blocked).toBe(true);
    expect(verdict('git push', 'feat/x', { protectedBranches: null }).blocked).toBe(true);
  });

  it('does not let an unresolvable protected branch wedge ordinary work', () => {
    expect(verdict('git status', 'feat/x', { protectedBranches: null }).blocked).toBe(false);
    expect(verdict('git add file.ts', 'feat/x', { protectedBranches: null }).blocked).toBe(false);
  });

  it('keeps the no-remote exemption from swallowing the unconditional rules', () => {
    // Whole-tree staging and destructive shapes are not repo-shape-dependent.
    expect(verdict('git add -A', 'main', { hasRemote: false }).blocked).toBe(true);
    expect(verdict('git commit -am x', 'main', { hasRemote: false }).blocked).toBe(true);
    expect(verdict('git reset --hard', 'main', { hasRemote: false }).blocked).toBe(true);
  });
});

// Review findings on the first cut of the above — each was a live bypass with 201 tests green.
describe('protected-branch resolution: the cases that shipped broken', () => {
  const repo = (over = {}) => () => ({ hasRemote: true, protectedBranches: ['main'], ...over });
  const verdict = (cmd, branch, over) => decide(cmd, onBranch(branch), undefined, repo(over));

  it('blocks a BARE push on a protected branch that is not named main', () => {
    // pushesMain's final return still compared against the literal 'main', so `git push` on master
    // in a master-default repo was allowed — the exact bypass this work set out to close.
    expect(verdict('git push', 'master', { protectedBranches: ['master'] }).blocked).toBe(true);
    expect(verdict('git push', 'main', { protectedBranches: ['master'] }).blocked).toBe(false);
  });

  it('still blocks a push to an explicit URL in a repo with NO remote', () => {
    // "No configured remote" is not "nowhere to push": `git push <url> main` needs none. Gating the
    // push rule on hasRemote turned an explicit push to a protected branch into an allow.
    expect(verdict('git push https://example.invalid/r.git main', 'feat/x', { hasRemote: false }).blocked).toBe(true);
    expect(verdict('git push https://example.invalid/r.git HEAD:main', 'feat/x', { hasRemote: false }).blocked).toBe(true);
  });

  it('protects every well-known branch when several exist', () => {
    expect(verdict('git commit -m x', 'main', { protectedBranches: ['main', 'master'] }).blocked).toBe(true);
    expect(verdict('git commit -m x', 'master', { protectedBranches: ['main', 'master'] }).blocked).toBe(true);
    expect(verdict('git commit -m x', 'feat/x', { protectedBranches: ['main', 'master'] }).blocked).toBe(false);
  });
});

describe('protectedBranches resolution', () => {
  // A fake git so each ref topology is a data case, not a fixture to build.
  const fakeGit = (refs, head = null) => (args) => {
    if (args[0] === 'symbolic-ref') return head ? { out: head } : { err: 'no origin/HEAD' };
    if (args[0] === 'rev-parse') {
      const ref = args[3].replace(/\^\{commit\}$/, '');
      return refs.includes(ref) ? { out: 'sha' } : { out: '' };
    }
    return { out: '' };
  };
  const resolve = (refs, head, env = {}) => protectedBranches('/x', fakeGit(refs, head), env);

  it('uses origin/HEAD when it is set', () => {
    expect(resolve(['origin/main', 'origin/master'], 'origin/develop')).toEqual(['develop']);
  });

  it('REFUSES when origin/HEAD is unset and both origin/main and origin/master exist', () => {
    // The mid-rename repo: first-match would pick main, leaving the real default master unguarded
    // AND blocking an ordinary branch. Both directions wrong, so it must refuse.
    expect(resolve(['origin/main', 'origin/master'], null)).toBeNull();
  });

  it('uses the single remote well-known branch when only one exists', () => {
    expect(resolve(['origin/master'], null)).toEqual(['master']);
  });

  it('falls back to the well-known names rather than blocking a healthy repo', () => {
    // A develop-default repo with nothing fetched is HEALTHY; returning null would block every
    // commit in it. This is not a fail-open — {main, master} is what the guard protected before.
    expect(resolve([], null)).toEqual(['main', 'master']);
  });

  it('REFUSES an override naming a branch this repo does not have', () => {
    // The variable is process-wide, so a value set for one repo would otherwise silently disarm the
    // guard in every other repo on the machine.
    expect(resolve(['main'], null, { TICKET_WORKFLOW_PROTECTED_BRANCH: 'mian' })).toBeNull();
    expect(resolve(['main'], null, { TICKET_WORKFLOW_PROTECTED_BRANCH: 'main' })).toEqual(['main']);
  });

  it('ignores a blank override rather than treating it as a value', () => {
    expect(resolve(['main'], null, { TICKET_WORKFLOW_PROTECTED_BRANCH: '   ' })).toEqual(['main']);
  });
});

describe('decide — a quoted VALUE must be judged dequoted (tkt-6d1ae448e3b3)', () => {
  // tkt-8f2e1f9894e2 kept quoting IN the token so a spaced path survived tokenizing, and left its
  // removal to resolveDir. Nothing did the same for sub/args, so every rule that compares a VALUE
  // was matching against a spelling with quote characters still in it — and the quoted spelling of
  // each is one an assistant writes by habit.
  const SPACED = '/repos/my repo';
  const spaced = byDir({ [KANBAN]: 'main', [OTHER]: 'feat/x', [SPACED]: 'main' });

  it('blocks whole-tree staging written with quotes', () => {
    expect(blocked('git add "."', 'feat/x')).toBe(true);
    expect(blocked("git add '.'", 'feat/x')).toBe(true);
    expect(blocked('git add "-A"', 'feat/x')).toBe(true);
    expect(blocked('git stage "*"', 'feat/x')).toBe(true);
    // Controls: the unquoted spelling still blocks, and a quoted path that merely CONTAINS a dot
    // is still not whole-tree staging — the row tkt-8f2e1f9894e2 added must survive dequoting.
    expect(blocked('git add .', 'feat/x')).toBe(true);
    expect(blocked('git add "a . b"', 'feat/x')).toBe(false);
  });

  it('blocks a push whose protected target is quoted', () => {
    expect(blocked('git push origin "main"', 'feat/x')).toBe(true);
    expect(blocked("git push origin 'main'", 'feat/x')).toBe(true);
    expect(blocked('git push origin "feat/x:main"', 'feat/x')).toBe(true);
    // Controls: unquoted still blocks, and a quoted FEATURE target is still an ordinary push.
    expect(blocked('git push origin main', 'feat/x')).toBe(true);
    expect(blocked('git push origin "feat/x"', 'feat/x')).toBe(false);
  });

  it('records a quoted switch target dequoted, so the commit after it is still judged', () => {
    expect(blocked('git switch "main" && git commit -m x', 'feat/x')).toBe(true);
    expect(blocked("git switch 'main' && git commit -m x", 'feat/x')).toBe(true);
    expect(blocked('git checkout -b "main" && git commit -m x', 'feat/x')).toBe(true);
    // Controls: the unquoted chain still blocks, and switching to a real feature branch still works.
    expect(blocked('git switch main && git commit -m x', 'feat/x')).toBe(true);
    expect(blocked('git switch "feat/y" && git commit -m x', 'feat/x')).toBe(false);
  });

  it('reads a quoted SUBCOMMAND as the subcommand', () => {
    expect(blocked('git "commit" -m x', 'main')).toBe(true);
    expect(blocked("git 'push' origin main", 'feat/x')).toBe(true);
    expect(blocked('git "status"', 'main')).toBe(false); // control: a read is still a read
  });

  it('dequotes a span sitting anywhere in the token, not only one that wraps it', () => {
    // The same shape resolveDir already accepts for -C: `/a/"my repo"` names one path.
    expect(blocked('git push origin ma"in"', 'feat/x')).toBe(true);
    expect(blocked('git switch ma"in" && git commit -m x', 'feat/x')).toBe(true);
  });

  it('blocks destructive shapes written with quotes', () => {
    expect(blocked('git push origin "+main"', 'feat/x')).toBe(true);
    expect(blocked('git push "--force" origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git reset "--hard"', 'feat/x')).toBe(true);
    expect(blocked('git push --force origin feat/x', 'feat/x')).toBe(true); // control
  });

  it('still reads short-flag LETTERS raw, so an attached quoted value is not a flag cluster', () => {
    // The regression this fix must not cause. Dequoting `-m"fix and go"` to `-mfix and go` puts the
    // message text back into the cluster scan — an `a` reads as `commit -a`, an `f` as a force-push.
    // That is exactly the false block tkt-8f2e1f9894e2 closed, so flag letters keep reading the RAW
    // token while values read the dequoted one.
    expect(blocked('git commit -m"fix and go"', 'feat/x')).toBe(false);
    expect(blocked("git commit -m'fix and go'", 'feat/x')).toBe(false);
    expect(blocked('git push -o"ci skip fast" origin feat/x', 'feat/x')).toBe(false);
    expect(blocked('git commit -am"fix"', 'feat/x')).toBe(true); // control: a real cluster still blocks
  });

  it('does not let a quoted safe-flag push exempt itself from the main rule', () => {
    // Dequoting made quoted flags parse as FLAGS for the first time — correct, and it put them in
    // reach of pushesMain's safeFlag exemption for the first time too. `--mirror` pushes every ref,
    // main included, so it is not safe in either spelling; the old block was an accident of the
    // quote making it look like a positional, and the UNQUOTED spelling was walking through.
    expect(blocked('git push "--mirror"', 'main')).toBe(true);
    expect(blocked('git push --mirror', 'main')).toBe(true);
    // Controls: the genuinely safe flags stay exempt in BOTH spellings. Without them, dropping the
    // exemption wholesale would pass the two rows above.
    expect(blocked('git push "--tags"', 'main')).toBe(false);
    expect(blocked('git push --tags', 'main')).toBe(false);
    expect(blocked('git push "--delete" origin feat/x', 'main')).toBe(false);
  });

  it('does not pretend an unterminated quote in an ARG fails closed', () => {
    // `truncated` fires only when the unterminated span swallows the SUBCOMMAND slot. An arg-level
    // one parses cleanly and falls back to the raw token, so it is an ALLOW. Pinned as documented
    // behaviour, not as a guarantee — the argValue comment used to claim the opposite.
    expect(blocked('git push origin "main', 'feat/x')).toBe(false);
    expect(blocked('git -C "/a/b push origin main', 'feat/x')).toBe(true); // control: subcommand slot
  });

  it('leaves the -C repo path raw, so resolveDir still owns its dequoting', () => {
    expect(decide(`git -C "${SPACED}" commit -m x`, spaced, OTHER).blocked).toBe(true);
    expect(decide(`git -C "${SPACED}" status`, spaced, OTHER).blocked).toBe(false);
  });

  it('keeps an UNTERMINATED quote falling back to the raw token rather than to null', () => {
    // dequote() reports null for an unterminated quote. Treating that as an empty value would make
    // `git add "` compare equal to nothing at all; the raw token is the honest reading, and the
    // shell rejects the command anyway. The commit/push fail-closed paths are unaffected.
    expect(blocked('git add "a', 'feat/x')).toBe(false);
    expect(blocked('git -C "/a/b commit -m x', 'feat/x')).toBe(true); // control: still fails closed
  });
});
