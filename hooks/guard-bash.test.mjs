import { describe, it, expect, vi, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGit, cdTarget, decide } from './guard-bash.mjs';
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
    expect(parseGit('git add -A')).toEqual({ sub: 'add', args: ['-A'], repoDir: null });
    expect(parseGit('git commit -m "x"')).toEqual({ sub: 'commit', args: ['-m', '"x"'], repoDir: null });
  });

  it('captures -C as repoDir, skips -c, skips env prefixes', () => {
    expect(parseGit('git -C /repo add foo')).toEqual({ sub: 'add', args: ['foo'], repoDir: '/repo' });
    expect(parseGit('git -c user.name=x commit')).toEqual({ sub: 'commit', args: [], repoDir: null });
    expect(parseGit('FOO=bar git add foo')).toEqual({ sub: 'add', args: ['foo'], repoDir: null });
  });

  it('requires the command word to be git (not just a mention)', () => {
    expect(parseGit('echo "git add -A"')).toBeNull();
    expect(parseGit('npm test')).toBeNull();
    expect(parseGit('git')).toBeNull();
  });

  it('sees through subshell/group punctuation', () => {
    expect(parseGit('(git add -A)')).toEqual({ sub: 'add', args: ['-A'], repoDir: null });
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
    expect(cdTarget('cd ~jake/repo', KANBAN)).toBeNull();
  });

  it('returns null for a quoted path with a space rather than a truncated one', () => {
    // Tokens are whitespace-split upstream, so '/repos/my repo' arrives as '"/repos/my'.
    // Returning '/repos/my' would judge that repo by a different one's branch.
    expect(cdTarget('cd "/repos/my repo"', KANBAN)).toBeNull();
    expect(cdTarget("cd '/repos/my repo'", KANBAN)).toBeNull();
    expect(cdTarget('cd "/repos/other"', KANBAN)).toBe(OTHER);
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
    // "lands on main via a squash-merged PR" is meaningless with nowhere to push. Hit live in
    // level-up/job-hunt, which has no remote.
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
