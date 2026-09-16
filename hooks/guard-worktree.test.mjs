import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, realpathSync, utimesSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arm, decide, isArmed, markerPath, MARKER_MAX_AGE_MS } from './guard-worktree.mjs';
import { worktreeKind } from './lib/worktree.mjs';

/**
 * guard-worktree: once a session has called start_ticket, it may not write to a repository's
 * PRIMARY checkout (tkt-1d647fd64ce4).
 *
 * One case per DIMENSION rather than several per happy path, because the defect this guard exists to
 * stop is a fail-OPEN, and a fail-open lives in the dimension nobody sampled. The dimensions here are
 * marker state, payload shape, checkout kind, and — for Bash — how the directory is named.
 *
 * The checkout fixtures are REAL repos with REAL linked worktrees. A stubbed worktreeKind would make
 * every case below a test of the stub: "is this a linked worktree" is precisely the question the
 * guard can get wrong, and git is the only thing that answers it authoritatively.
 */

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const SID = 'ses-0123456789abcdef';
const TICKET = 'tkt-abcdef123456';

let fx;
let stateDir;

function seedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', '.'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n');
  writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  git(['add', 'tracked.txt', '.gitignore'], dir);
  git(['commit', '-qm', 'init'], dir);
}

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'tw-wtguard-'));

  const primary = path.join(root, 'primary');
  seedRepo(primary);
  mkdirSync(path.join(primary, 'ignored'));
  writeFileSync(path.join(primary, 'ignored', 'note.txt'), 'x\n');

  const linked = path.join(root, 'linked');
  git(['worktree', 'add', '-q', '-b', 'side', linked], primary);

  // The shape EnterWorktree produces: a worktree NESTED inside the primary's own tree. It is still a
  // linked checkout, and reading it as "inside the primary, therefore blocked" would make the guard
  // forbid the only thing it tells you to do.
  const nested = path.join(primary, '.claude', 'worktrees', TICKET);
  git(['worktree', 'add', '-q', '-b', 'nested', nested], primary);

  const plain = path.join(root, 'plain');
  mkdirSync(plain);

  const foreign = path.join(root, 'foreign');
  seedRepo(foreign);
  const foreignWt = path.join(foreign, '.claude', 'worktrees', TICKET);
  git(['worktree', 'add', '-q', '-b', 'fside', foreignWt], foreign);

  symlinkSync(path.join(primary, 'tracked.txt'), path.join(linked, 'link-to-primary.txt'));

  // A primary whose path contains a SPACE, with a real directory sitting at the point an unquoted
  // operand truncates to. Without that neighbour the truncated path resolves to nothing and the
  // guard blocks for the wrong reason, so the case would pass while proving nothing.
  const spaced = path.join(root, 'my repo');
  mkdirSync(path.join(root, 'my'));
  seedRepo(spaced);
  const spacedWt = path.join(root, 'spaced-wt');
  git(['worktree', 'add', '-q', '-b', 'spacedside', spacedWt], spaced);

  mkdirSync(path.join(primary, 'src'));
  writeFileSync(path.join(primary, 'src', 'deep.txt'), 'x\n');

  fx = { root, primary, linked, nested, plain, foreign, foreignWt, spaced, spacedWt };
});

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'tw-wtstate-'));
});

const env = () => ({ WORKTREE_GUARD_STATE_DIR: stateDir });
const startTicket = (extra = {}) => ({
  session_id: SID, tool_name: 'mcp__kanban__start_ticket', tool_input: { id: TICKET }, ...extra,
});
const editing = (file, extra = {}) => ({
  session_id: SID, tool_name: 'Edit', tool_input: { file_path: file }, cwd: fx.primary, ...extra,
});
const running = (command, cwd, extra = {}) => ({
  session_id: SID, tool_name: 'Bash', tool_input: { command }, cwd, ...extra,
});
const verdict = (payload, opts = {}) => decide(payload, { ticket: TICKET, kindOf: realKind, ...opts });

/**
 * REAL detection, memoised per directory.
 *
 * Still git answering "primary or linked" — a stub would make these cases tests of the stub — but
 * asked once per fixture rather than once per row. The fixtures are built in beforeAll and their
 * kind never changes, so the cache cannot mask a transition. Measured reason: three `git rev-parse`
 * spawns per decide() across ~40 rows starved the slower suites sharing the run, timing out audit
 * tests that pass on their own.
 */
const kindCache = new Map();
const realKind = (dir) => {
  if (!kindCache.has(dir)) kindCache.set(dir, worktreeKind(dir));
  return kindCache.get(dir);
};

const COMMIT = 'commit -m x';
const gitCmd = (rest) => `git ${rest}`;

describe('arming', () => {
  it('writes a marker naming the ticket, and reads back as armed', () => {
    const r = arm(startTicket(), env());
    expect(r.blocked).toBe(false);
    expect(isArmed(SID, env())).toBe(true);
    expect(JSON.parse(readFileSync(markerPath(SID, env()), 'utf8'))).toMatchObject({ ticket: TICKET });
  });

  it('is not armed with no marker', () => {
    expect(isArmed(SID, env())).toBe(false);
  });

  // The marker is per SESSION. Another session's ticket must not arm this one, or one ticket session
  // would silently police every other session on the machine.
  it("is not armed by another session's marker", () => {
    arm(startTicket({ session_id: 'ses-someone-else' }), env());
    expect(isArmed(SID, env())).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['path traversal', '../escape'],
    ['a slash', 'ses/../../etc'],
    ['too long', 'a'.repeat(129)],
    ['not a string', 42],
  ])('blocks start_ticket on a %s session_id', (_label, session_id) => {
    const r = arm(startTicket({ session_id }), env());
    expect(r.blocked).toBe(true);
    // Fail CLOSED: an id that cannot key a marker means the session could never be enforced, so the
    // ticket must not start rather than start unguarded.
    expect(r.reason).toMatch(/session_id/i);
  });

  it('blocks start_ticket when the marker cannot be written', () => {
    const readOnly = path.join(fx.root, 'ro-state');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    const r = arm(startTicket(), { WORKTREE_GUARD_STATE_DIR: path.join(readOnly, 'nested') });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/could not|write/i);
  });

  it('prunes markers older than the max age, and keeps younger ones', () => {
    const old = path.join(stateDir, 'ses-ancient');
    const young = path.join(stateDir, 'ses-recent');
    writeFileSync(old, '{}');
    writeFileSync(young, '{}');
    const longAgo = (Date.now() - MARKER_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(old, longAgo, longAgo);

    arm(startTicket(), env());

    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    // The arming session's own marker is the point of the call; pruning must never eat it.
    expect(isArmed(SID, env())).toBe(true);
  });

  it('still arms when pruning has nothing it can do', () => {
    // Pruning is housekeeping. A failure there must not block a ticket, which is the opposite
    // direction from a failed marker WRITE above — that one is the guard's whole authorization.
    const r = arm(startTicket(), env());
    expect(r.blocked).toBe(false);
  });
});

describe('edit targets', () => {
  it.each([
    ['the primary checkout', () => path.join(fx.primary, 'tracked.txt'), true],
    ['a linked worktree', () => path.join(fx.linked, 'tracked.txt'), false],
    ['a nested .claude/worktrees checkout', () => path.join(fx.nested, 'tracked.txt'), false],
    ['a directory in no repo at all', () => path.join(fx.plain, 'notes.txt'), false],
    ['a file that does not exist yet in the primary', () => path.join(fx.primary, 'brand-new.txt'), true],
    ['a new file under directories that do not exist yet in the primary', () => path.join(fx.primary, 'a', 'b', 'c.txt'), true],
    ['a gitignored path in the primary', () => path.join(fx.primary, 'ignored', 'note.txt'), true],
    // realpath, not the lexical path: the symlink LIVES in a linked worktree, so a lexical reading
    // calls it allowed while the write lands in the primary.
    ['a symlink in a worktree pointing into the primary', () => path.join(fx.linked, 'link-to-primary.txt'), true],
  ])('%s: blocked=%s', (_label, file, blocked) => {
    expect(verdict(editing(file())).blocked).toBe(blocked);
  });

  it.each(['Edit', 'Write', 'NotebookEdit'])('applies to %s', (tool) => {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const payload = { session_id: SID, tool_name: tool, tool_input: { [key]: path.join(fx.primary, 'x.txt') }, cwd: fx.primary };
    expect(verdict(payload).blocked).toBe(true);
  });

  it('allows a tool the guard does not police', () => {
    const payload = { session_id: SID, tool_name: 'Read', tool_input: { file_path: path.join(fx.primary, 'tracked.txt') }, cwd: fx.primary };
    expect(verdict(payload).blocked).toBe(false);
  });

  // null is git failing to answer, NOT "no repo". Folding the two together is the fail-open this
  // guard's detection helper is split to prevent, so it gets its own case.
  it('blocks when the checkout kind cannot be determined', () => {
    expect(verdict(editing(path.join(fx.linked, 'tracked.txt')), { kindOf: () => null }).blocked).toBe(true);
  });

  it('blocks an edit whose path is missing from the payload', () => {
    expect(verdict({ session_id: SID, tool_name: 'Edit', tool_input: {}, cwd: fx.primary }).blocked).toBe(true);
  });

  it('blocks an edit with no tool_input at all', () => {
    expect(verdict({ session_id: SID, tool_name: 'Edit', cwd: fx.primary }).blocked).toBe(true);
  });

  it('names the existing worktree in the block message', () => {
    const r = verdict(editing(path.join(fx.primary, 'tracked.txt')));
    expect(r.reason).toContain('EnterWorktree');
    expect(r.reason).toContain(path.join('.claude', 'worktrees', TICKET));
  });
});

describe('bash: which directory the command acts on', () => {
  it.each([
    ['a branch cut in the primary', () => gitCmd('switch -c feat/x'), () => fx.primary, true],
    ['a branch cut in a linked worktree', () => gitCmd('switch -c feat/x'), () => fx.linked, false],
    ['a commit after cd into the primary', () => `cd ${fx.primary} && ${gitCmd(COMMIT)}`, () => fx.linked, true],
    ['a commit after cd into a worktree', () => `cd ${fx.linked} && ${gitCmd(COMMIT)}`, () => fx.primary, false],
    ['git -C aimed at the primary', () => gitCmd(`-C ${fx.primary} add tracked.txt`), () => fx.linked, true],
    ['git -C aimed at a worktree', () => gitCmd(`-C ${fx.linked} add tracked.txt`), () => fx.primary, false],
    ['a cd to an unresolvable variable', () => `cd $TARGET && ${gitCmd(COMMIT)}`, () => fx.linked, true],
    ['a leading pushd into the primary', () => `pushd ${fx.primary}; ${gitCmd(COMMIT)}`, () => fx.linked, true],
    ['a popd, whose destination is untracked', () => `popd; ${gitCmd(COMMIT)}`, () => fx.linked, true],
    ['a cd to an unquoted path containing a space', () => `cd ${fx.primary}/my dir && ${gitCmd(COMMIT)}`, () => fx.linked, true],
    ['a hidden cd into the primary behind a pipe', () => `echo x | (cd ${fx.primary} && ${gitCmd(COMMIT)})`, () => fx.linked, true],
    ['a status in the primary', () => gitCmd('status'), () => fx.primary, false],
    ['a push from the primary', () => gitCmd('push origin main'), () => fx.primary, false],
    ['a fetch in the primary', () => gitCmd('fetch origin'), () => fx.primary, false],
    ['a non-git command in the primary', () => 'ls -la', () => fx.primary, false],
    ['an unknown git verb in the primary', () => gitCmd('frobnicate --hard'), () => fx.primary, true],
    ['an unknown git verb in a worktree', () => gitCmd('frobnicate --hard'), () => fx.linked, false],
    ['a commit in a directory that is no repo', () => gitCmd(COMMIT), () => fx.plain, false],
  ])('%s: blocked=%s', (_label, command, cwd, blocked) => {
    expect(verdict(running(command(), cwd())).blocked).toBe(blocked);
  });

  it('restores the directory when a subshell closes', () => {
    // `(cd <worktree> && …)` must not leave the guard thinking the rest of the line runs there.
    const cmd = `(cd ${fx.linked} && ${gitCmd('status')}) && ${gitCmd(COMMIT)}`;
    expect(verdict(running(cmd, fx.primary)).blocked).toBe(true);
  });

  it('blocks when the payload carries no cwd to judge against', () => {
    const payload = { session_id: SID, tool_name: 'Bash', tool_input: { command: gitCmd(COMMIT) } };
    expect(verdict(payload).blocked).toBe(true);
  });

  it('allows an empty command', () => {
    expect(verdict(running('', fx.primary)).blocked).toBe(false);
  });
});

describe('bash: git worktree and stash', () => {
  it.each([
    ['worktree add .claude/worktrees/x', false],
    ['worktree list', false],
    ['worktree prune', false],
    ['worktree remove .claude/worktrees/x', false],
    ['worktree remove -f .claude/worktrees/x', true],
    ['worktree remove --force .claude/worktrees/x', true],
    ['worktree move a b', true],
  ])('git %s in the primary: blocked=%s', (rest, blocked) => {
    expect(verdict(running(gitCmd(rest), fx.primary)).blocked).toBe(blocked);
  });

  // refs/stash lives in the COMMON dir, so one session's pop takes another session's work even from
  // a worktree of its own. This is the one rule that is not about which checkout you are standing in.
  it.each([
    ['stash', true],
    ['stash push -m x', true],
    ['stash pop', true],
    ['stash apply', true],
    ['stash drop', true],
    ['stash clear', true],
    ['stash list', false],
    ['stash show', false],
  ])('git %s in a LINKED worktree: blocked=%s', (rest, blocked) => {
    expect(verdict(running(gitCmd(rest), fx.linked)).blocked).toBe(blocked);
  });

  it('says why stash is blocked even in a worktree', () => {
    expect(verdict(running(gitCmd('stash pop'), fx.linked)).reason).toMatch(/stash/i);
  });
});

describe('bash: read-only forms of mutating verbs', () => {
  it.each([
    ['branch', false],
    ['branch -a', false],
    ['branch --list feat/*', false],
    ['branch newthing', true],
    ['branch -d side', true],
    ['branch -D side', true],
    ['branch -m old new', true],
    ['tag', false],
    ['tag -l v1*', false],
    ['tag v1.0.0', true],
    ['config --get user.email', false],
    ['config --list', false],
    ['config user.email t@t', true],
    // Read-only selectors that take a VALUE. Reading their operand as "a name to create" refused
    // ordinary inspection from the primary — a false block, and common enough to be real friction.
    ['branch --contains HEAD', false],
    ['branch --merged main', false],
    ['branch --no-merged main', false],
    ['tag --contains v1', false],
    ['tag --points-at HEAD', false],
    ['branch --sort=-committerdate', false],
  ])('git %s in the primary: blocked=%s', (rest, blocked) => {
    expect(verdict(running(gitCmd(rest), fx.primary)).blocked).toBe(blocked);
  });
});

describe('bash: gh', () => {
  it.each([
    ['pr checkout 5', true],
    ['pr view 5', false],
    ['pr create --fill', false],
  ])('gh %s in the primary: blocked=%s', (rest, blocked) => {
    expect(verdict(running(`gh ${rest}`, fx.primary)).blocked).toBe(blocked);
  });

  it('allows gh pr checkout in a linked worktree', () => {
    expect(verdict(running('gh pr checkout 5', fx.linked)).blocked).toBe(false);
  });
});

// Every case below was a live bypass measured by review on the first cut of this guard, or a false
// block it caused. They are grouped so a regression names the defect it restores rather than just a
// row number.
describe('regressions found by review', () => {
  it.each([
    ['a pipeline right-hand side', () => 'cat p.diff | git apply'],
    ['a pipeline with a mutating checkout', () => 'true | git checkout -- .'],
    ['a then-branch', () => 'if true; then git checkout -- .; fi'],
    ['a do-body', () => 'for f in a; do git checkout -- .; done'],
    ['an xargs wrapper', () => 'echo . | xargs git checkout --'],
  ])('blocks git that is not the segment head: %s', (_label, command) => {
    expect(verdict(running(command(), fx.primary)).blocked).toBe(true);
  });

  it('still allows those same shapes in a linked worktree', () => {
    // Without this, the cases above would also pass if the guard simply blocked every pipeline.
    expect(verdict(running('true | git checkout -- .', fx.linked)).blocked).toBe(false);
  });

  it.each([
    ['behind a pipe', () => `echo x | (cd ${fx.spaced} ; ${gitCmd(COMMIT)})`],
    ['in a then-branch', () => `if true; then cd ${fx.spaced} ; ${gitCmd(COMMIT)}; fi`],
    ['at the segment head', () => `cd ${fx.spaced} ; ${gitCmd(COMMIT)}`],
  ])('blocks an unquoted spaced cd path %s', (_label, command) => {
    // The truncated operand names a REAL directory outside any repo, which is the allow answer —
    // so a guard that checks this only at the segment head has a live bypass one spelling over.
    expect(verdict(running(command(), fx.spacedWt)).blocked).toBe(true);
  });

  it.each([
    ['--git-dir/--work-tree flags', () => `git --work-tree=${fx.primary} --git-dir=${fx.primary}/.git checkout -- .`, true],
    ['GIT_DIR/GIT_WORK_TREE env prefixes', () => `GIT_DIR=${fx.primary}/.git GIT_WORK_TREE=${fx.primary} git checkout -- .`, true],
    ['a retarget carrying a read-only verb', () => `git --git-dir=${fx.primary}/.git status`, false],
  ])('%s: blocked=%s', (_label, command, blocked) => {
    expect(verdict(running(command(), fx.linked)).blocked).toBe(blocked);
  });

  it.each([
    ['git push . HEAD:refs/heads/side', true],
    ['git fetch . main:side', true],
    ['git push ../elsewhere HEAD:refs/heads/side', true],
    ['git push origin main', false],
    ['git fetch origin', false],
  ])('%s from the primary: blocked=%s', (command, blocked) => {
    // push/fetch are read-only ABOUT A REMOTE. Against a local path they move branches, and under
    // receive.denyCurrentBranch=updateInstead a push rewrites the target worktree's files outright.
    expect(verdict(running(command, fx.primary)).blocked).toBe(blocked);
  });

  it('names the repository root in the message, not the edited file\'s directory', () => {
    const r = verdict(editing(path.join(fx.primary, 'src', 'deep.txt')));
    // realpath on the expectation: the guard reports git's own answer, and on macOS /var resolves
    // through a symlink to /private/var, so a literal fixture path would never match.
    expect(r.reason).toContain(`PRIMARY checkout ${realpathSync(fx.primary)}`);
    expect(r.reason).not.toMatch(/PRIMARY checkout \S*\/src/);
    // The existing-worktree branch looks under the ROOT, so naming src/ would silently skip it.
    expect(r.reason).toContain('already exists');
  });

  it('arms on a start_ticket from a server that is not named kanban', () => {
    // Driven through the PROCESS on purpose: arm() never inspects tool_name, so calling it directly
    // would pass whatever the matcher does, and prove nothing. An exact tool-name match leaves such
    // a consumer unarmed for the life of the install, with no marker and no stderr — the permissive
    // answer, reached by a check that never applied.
    const r = spawnSync('node', [path.join(HOOKS_DIR, 'guard-worktree.mjs')], {
      input: JSON.stringify(startTicket({ tool_name: 'mcp__board__start_ticket' })),
      env: { ...process.env, WORKTREE_GUARD_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(isArmed(SID, env())).toBe(true);
  });

  it('does not arm on an unrelated MCP tool whose name merely ends in _ticket', () => {
    // The negative control for the matcher above: a suffix regex that was too loose would arm here.
    const r = spawnSync('node', [path.join(HOOKS_DIR, 'guard-worktree.mjs')], {
      input: JSON.stringify(startTicket({ tool_name: 'mcp__board__archive_ticket' })),
      env: { ...process.env, WORKTREE_GUARD_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(isArmed(SID, env())).toBe(false);
  });
});

describe('foreign targets', () => {
  it("blocks a write to another repo's primary", () => {
    expect(verdict(editing(path.join(fx.foreign, 'tracked.txt'))).blocked).toBe(true);
  });

  it("allows a write to another repo's linked worktree", () => {
    expect(verdict(editing(path.join(fx.foreignWt, 'tracked.txt'))).blocked).toBe(false);
  });

  it('offers the git worktree add form for a foreign primary', () => {
    const r = verdict({ ...editing(path.join(fx.foreign, 'tracked.txt')), cwd: fx.linked });
    expect(r.reason).toContain('git worktree add');
  });
});

describe('the hooks as processes', () => {
  const run = (script, payload, extraEnv = {}, input) => spawnSync('node', [script], {
    input: input ?? JSON.stringify(payload),
    env: { ...process.env, WORKTREE_GUARD_STATE_DIR: stateDir, ...extraEnv },
    encoding: 'utf8',
  });
  const guard = () => path.join(HOOKS_DIR, 'guard-worktree.mjs');
  const precheck = () => path.join(HOOKS_DIR, 'guard-worktree-precheck.mjs');

  it('guard: arms on start_ticket and exits 0', () => {
    const r = run(guard(), startTicket());
    expect(r.status, r.stderr).toBe(0);
    expect(isArmed(SID, env())).toBe(true);
  });

  it('guard: blocks an edit into the primary once armed', () => {
    arm(startTicket(), env());
    const r = run(guard(), editing(path.join(fx.primary, 'tracked.txt')));
    expect(r.status, r.stderr).toBe(2);
  });

  it('guard: allows an edit into the primary when NOT armed', () => {
    const r = run(guard(), editing(path.join(fx.primary, 'tracked.txt')));
    expect(r.status, r.stderr).toBe(0);
  });

  it.each([
    ['unparseable', 'not json at all'],
    ['empty', ''],
  ])('precheck: exits 2 on %s stdin', (_label, input) => {
    const r = run(precheck(), null, {}, input);
    expect(r.status, r.stderr).toBe(2);
  });

  it('precheck: exits 0 when there is no marker', () => {
    const r = run(precheck(), editing(path.join(fx.primary, 'tracked.txt')));
    expect(r.status, r.stderr).toBe(0);
  });

  it('precheck: blocks once armed', () => {
    arm(startTicket(), env());
    const r = run(precheck(), editing(path.join(fx.primary, 'tracked.txt')));
    expect(r.status, r.stderr).toBe(2);
    // The exit code ALONE cannot tell a verdict from a broken import — both are 2, and this test
    // passed for the wrong reason until the exports entry existed (measured, tkt-1d647fd64ce4).
    expect(r.stderr).not.toMatch(/could not be loaded/);
    expect(r.stderr).toMatch(/PRIMARY checkout/);
  });

  // The discriminator the case above cannot be: if the bare `ticket-workflow/...` specifier stops
  // resolving, THIS goes red, because a failed import exits 2 where a real verdict exits 0.
  it('precheck: allows an edit into a linked worktree once armed', () => {
    arm(startTicket(), env());
    const r = run(precheck(), editing(path.join(fx.linked, 'tracked.txt')));
    expect(r.status, r.stderr).toBe(0);
  });

  it('precheck: blocks when the guard state cannot be read', () => {
    const walled = path.join(fx.root, 'walled-state');
    mkdirSync(walled, { recursive: true });
    chmodSync(walled, 0o000);
    const r = run(precheck(), editing(path.join(fx.primary, 'tracked.txt')), { WORKTREE_GUARD_STATE_DIR: walled });
    chmodSync(walled, 0o700);
    // "I could not check" is not "no ticket started".
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/arming is unknown/);
  });

  // The whole reason the precheck exists: a broken `ticket-workflow` install must not wedge Edit and
  // Bash for every session on the machine. Unarmed, it must never even reach the import.
  describe('with the package unreachable', () => {
    let orphan;
    beforeEach(() => {
      orphan = path.join(mkdtempSync(path.join(tmpdir(), 'tw-orphan-')), 'guard-worktree-precheck.mjs');
      copyFileSync(path.join(HOOKS_DIR, 'guard-worktree-precheck.mjs'), orphan);
    });

    it('exits 0 when unarmed', () => {
      const r = run(orphan, editing(path.join(fx.primary, 'tracked.txt')));
      expect(r.status, r.stderr).toBe(0);
    });

    it('exits 2 when armed', () => {
      arm(startTicket(), env());
      const r = run(orphan, editing(path.join(fx.primary, 'tracked.txt')));
      expect(r.status, r.stderr).toBe(2);
    });
  });
});
