import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arm, decide, ghMergeState, markerPath, readMarker } from './guard-worktree.mjs';
import { worktreeKind } from './lib/worktree.mjs';

/**
 * The post-merge state (tkt-c9ae67a61caf): an armed session whose every started ticket has a PR
 * verified MERGED may run work-preserving cleanup in that repo's primary — a fast-forward of a clean
 * default branch, and a restore of a file whose content already equals origin's. Nothing else unlocks.
 *
 * One case per dimension of the ticket's adversary list, written before the code. The merge signal
 * is stubbed in the decide() cases because it is network; ghMergeState is tested on its own against
 * an injected runner, and one process-level case drives the real gh against a repo with no GitHub
 * remote to prove the default wiring fails closed.
 */

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const SID = 'ses-postmerge-0123456789';
const A = 'tkt-aaaaaaaaaaaa';
const B = 'tkt-bbbbbbbbbbbb';

let fx;
let stateDir;

function identity(dir) {
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
}

function commitAll(dir, files, msg) {
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  git(['add', ...Object.keys(files)], dir);
  git(['commit', '-qm', msg], dir);
}

/** A bare origin, a writer that has pushed ahead, and a clone of the OLD state that has fetched. */
function seedOrigin(root, name) {
  const origin = path.join(root, `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', origin], root);
  const writer = path.join(root, `${name}-writer`);
  git(['clone', '-q', origin, writer], root);
  identity(writer);
  commitAll(writer, { 'tracked.txt': 'v1\n', 'other.txt': 'o1\n', 'linkme.txt': 'same\n', 'filtered.txt': 'f\n', '.gitignore': 'secret.env\n' }, 'init');
  git(['push', '-q', 'origin', 'HEAD:main'], writer);
  return { origin, writer };
}

function cloneBehind(root, origin, writer, name) {
  const dir = path.join(root, name);
  git(['clone', '-q', origin, dir], root);
  identity(dir);
  return dir;
}

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'tw-postmerge-'));
  const { origin, writer } = seedOrigin(root, 'repo');

  const clean = cloneBehind(root, origin, writer, 'clean');
  const dirty = cloneBehind(root, origin, writer, 'dirty');
  const paused = cloneBehind(root, origin, writer, 'paused');
  // ahead: a local commit on main that origin never saw, so main is not an ancestor of origin/main.
  const ahead = cloneBehind(root, origin, writer, 'ahead');
  commitAll(ahead, { 'other.txt': 'local commit\n' }, 'local');

  // origin/main moves ahead: tracked.txt changes and new.txt appears.
  commitAll(writer, { 'tracked.txt': 'v2\n', 'new.txt': 'n\n' }, 'upstream');
  git(['push', '-q', 'origin', 'HEAD:main'], writer);
  for (const d of [clean, dirty, paused, ahead]) git(['fetch', '-q', 'origin'], d);

  // clean: on main, behind, no tracked modifications — but an untracked file, which git's own
  // fast-forward refuses to overwrite, so it must not count as dirty.
  writeFileSync(path.join(clean, 'scratch.txt'), 'mine\n');

  // dirty: tracked.txt already equals origin/main (the leftover copy), other.txt holds real edits,
  // new.txt is untracked here but equals origin's blob, linkme.txt is a symlink to a file whose
  // content equals its blob.
  writeFileSync(path.join(dirty, 'tracked.txt'), 'v2\n');
  writeFileSync(path.join(dirty, 'other.txt'), 'real work\n');
  writeFileSync(path.join(dirty, 'new.txt'), 'n\n');
  mkdirSync(path.join(dirty, 'sub'));
  writeFileSync(path.join(root, 'same-content.txt'), 'same\n');
  rmSync(path.join(dirty, 'linkme.txt'));
  symlinkSync(path.join(root, 'same-content.txt'), path.join(dirty, 'linkme.txt'));

  // A clean filter that hides a line: hash-object WITH filters sees the edited file as the blob.
  git(['config', 'filter.strip.clean', 'grep -v LOCAL'], dirty);
  writeFileSync(path.join(dirty, '.git', 'info', 'attributes'), 'filtered.txt filter=strip\n');
  writeFileSync(path.join(dirty, 'filtered.txt'), 'f\nLOCAL precious edit\n');

  // clash: upstream starts TRACKING a path the primary holds as an IGNORED file, which a
  // fast-forward overwrites without complaint.
  const c = seedOrigin(root, 'clash');
  const clash = cloneBehind(root, c.origin, c.writer, 'clash');
  writeFileSync(path.join(c.writer, 'secret.env'), 'SECRET=upstream\n');
  git(['add', '-f', 'secret.env'], c.writer);
  git(['commit', '-qm', 'track secret.env'], c.writer);
  git(['push', '-q', 'origin', 'HEAD:main'], c.writer);
  git(['fetch', '-q', 'origin'], clash);
  writeFileSync(path.join(clash, 'secret.env'), 'SECRET=local\n');

  // paused: a paused session's branch, carrying the same leftover copy.
  git(['switch', '-q', '-c', 'feat/paused'], paused);
  writeFileSync(path.join(paused, 'tracked.txt'), 'v2\n');

  // Another repository entirely, in the same dirty-but-restorable shape.
  const f = seedOrigin(root, 'foreign');
  const foreign = cloneBehind(root, f.origin, f.writer, 'foreign');
  commitAll(f.writer, { 'tracked.txt': 'v2\n' }, 'upstream');
  git(['push', '-q', 'origin', 'HEAD:main'], f.writer);
  git(['fetch', '-q', 'origin'], foreign);
  writeFileSync(path.join(foreign, 'tracked.txt'), 'v2\n');

  const linked = path.join(root, 'linked');
  git(['worktree', 'add', '-q', '-b', 'side', linked], clean);

  fx = { root, clean, dirty, paused, ahead, clash, foreign, linked };
});

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'tw-postmerge-state-'));
});

const env = () => ({ WORKTREE_GUARD_STATE_DIR: stateDir });
const running = (command, cwd) => ({ session_id: SID, tool_name: 'Bash', tool_input: { command }, cwd });
// Memoised for the reason guard-worktree.test.mjs gives: per-row git spawns starve parallel suites.
const memo = (fn) => { const cache = new Map(); return (dir) => { if (!cache.has(dir)) cache.set(dir, fn(dir)); return cache.get(dir); }; };
const top = memo((dir) => git(['rev-parse', '--show-toplevel'], dir).trim());
const realKind = memo(worktreeKind);

/** Merged exactly for the (ticket, repo) pairs given — so a foreign repo answers "no PR here". */
const mergedIn = (pairs) => (ticket, root) =>
  pairs.some(([t, dir]) => t === ticket && top(dir) === root) ? 'merged' : 'unmerged';

const allMerged = () => mergedIn([fx.clean, fx.dirty, fx.paused, fx.ahead, fx.clash].map((d) => [A, d]));

const verdict = (payload, opts = {}) =>
  decide(payload, {
    ticket: A,
    marker: { ticket: A, tickets: [A], complete: true },
    kindOf: realKind,
    mergeState: allMerged(),
    ...opts,
  });

// First on purpose: measured 1.3s here against 18s+ after the in-process cases, where the delay was
// the worker's spawnSync returning late (the hook itself decided in ~180ms) — cause not identified.
describe('post-merge through the process', () => {
  it('stays blocked when the real gh cannot verify a merge (no GitHub remote)', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(markerPath(SID, env()), JSON.stringify({ ticket: A, tickets: [A], complete: true }));
    const r = spawnSync('node', [path.join(HOOKS_DIR, 'guard-worktree.mjs')], {
      input: JSON.stringify(running('git checkout -- tracked.txt', fx.dirty)),
      env: { ...process.env, ...env() },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/Post-merge cleanup refused: not every ticket/);
    expect(readFileSync(path.join(fx.dirty, 'tracked.txt'), 'utf8')).toBe('v2\n');
  });
});

describe('post-merge: fast-forward of the default branch', () => {
  it.each([
    // Bare: it follows branch.main.merge/remote, which can name an unmerged branch (review).
    ['git pull --ff-only', true],
    ['git pull --ff-only origin main', false],
    ['git pull origin main --ff-only', false],
    ['git merge --ff-only origin/main', false],
    ['git pull', true],
    ['git pull --rebase', true],
    ['git pull --ff-only --autostash', true],
    ['git pull --ff-only upstream main', true],
    ['git pull --ff-only origin feat/x', true],
    ['git merge origin/main', true],
    ['git merge --ff-only feat/x', true],
    ['git merge --ff-only origin/main extra', true],
  ])('%s in a clean primary on main: blocked=%s', (command, blocked) => {
    expect(verdict(running(command, fx.clean)).blocked).toBe(blocked);
  });

  it('is refused when the primary has tracked modifications', () => {
    expect(verdict(running('git merge --ff-only origin/main', fx.dirty)).blocked).toBe(true);
  });

  it("is refused on a non-default branch — a paused session's work", () => {
    expect(verdict(running('git merge --ff-only origin/main', fx.paused)).blocked).toBe(true);
  });

  it('is refused when an IGNORED local file sits where upstream now tracks one', () => {
    const r = verdict(running('git merge --ff-only origin/main', fx.clash));
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/secret\.env/);
  });

  it('is refused when main has commits origin does not', () => {
    expect(verdict(running('git merge --ff-only origin/main', fx.ahead)).blocked).toBe(true);
  });
});

describe('post-merge: content-verified restore', () => {
  it.each([
    ['git checkout -- tracked.txt', false],
    ['git restore tracked.txt', false],
    ['git restore -- tracked.txt', false],
    [`git checkout -- ${'tracked.txt'} sub/../tracked.txt`, false],
    // Differs from origin/main: that IS the edit a restore would destroy.
    ['git checkout -- other.txt', true],
    ['git checkout -- tracked.txt other.txt', true],
    // Untracked here, though its content equals origin's blob.
    ['git checkout -- new.txt', true],
    ['git checkout -- missing.txt', true],
    // A symlink whose TARGET content equals the blob: hash-object would follow it and match.
    ['git checkout -- linkme.txt', true],
    // A clean filter strips the local line before hashing, so a filtered compare calls it equal.
    ['git checkout -- filtered.txt', true],
    ['git checkout -- .', true],
    ['git checkout -- sub', true],
    ['git checkout -- *.txt', true],
    ['git checkout -- ":(glob)*.txt"', true],
    ['git checkout -- ../outside.txt', true],
    ['git checkout tracked.txt', true],
    ['git checkout -f -- tracked.txt', true],
    ['git checkout origin/main -- tracked.txt', true],
    ['git restore --staged tracked.txt', true],
    ['git restore --source=HEAD~1 tracked.txt', true],
    ['git checkout --', true],
  ])('%s: blocked=%s', (command, blocked) => {
    expect(verdict(running(command, fx.dirty)).blocked).toBe(blocked);
  });

  it('resolves paths against a git -C target', () => {
    expect(verdict(running(`git -C ${fx.dirty} checkout -- tracked.txt`, fx.root)).blocked).toBe(false);
    expect(verdict(running(`git -C ${fx.dirty} checkout -- other.txt`, fx.root)).blocked).toBe(true);
  });

  it("is refused on a non-default branch even when the content matches", () => {
    expect(verdict(running('git checkout -- tracked.txt', fx.paused)).blocked).toBe(true);
  });
});

describe('post-merge: the merge signal is the authorization', () => {
  const restore = () => running('git checkout -- tracked.txt', fx.dirty);

  it.each([
    ['unmerged', () => 'unmerged'],
    ['unknown (gh failed)', () => 'unknown'],
    ['a verifier that throws', () => { throw new Error('boom'); }],
    ['a verifier returning a non-answer', () => true],
  ])('stays armed when the merge state is %s', (_label, mergeState) => {
    expect(verdict(restore(), { mergeState }).blocked).toBe(true);
  });

  it('stays armed when one of two started tickets is unmerged', () => {
    const marker = { ticket: B, tickets: [A, B], complete: true };
    expect(verdict(restore(), { marker, mergeState: mergedIn([[A, fx.dirty]]) }).blocked).toBe(true);
  });

  it('unlocks when every started ticket is merged', () => {
    const marker = { ticket: B, tickets: [A, B], complete: true };
    expect(verdict(restore(), { marker, mergeState: mergedIn([[A, fx.dirty], [B, fx.dirty]]) }).blocked).toBe(false);
  });

  it.each([
    ['an incomplete marker', { ticket: A, tickets: [A], complete: false }],
    ['a marker naming no tickets', { ticket: null, tickets: [], complete: true }],
    ['no marker read at all', undefined],
  ])('stays armed with %s', (_label, marker) => {
    expect(verdict(restore(), { marker }).blocked).toBe(true);
  });

  it('never consults ticket status — only the verifier is asked', () => {
    const asked = [];
    verdict(restore(), { mergeState: (t, root, base) => { asked.push([t, root, base]); return 'unmerged'; } });
    expect(asked).toEqual([[A, top(fx.dirty), 'main']]);
  });
});

describe('post-merge: what stays blocked even when merged', () => {
  it.each([
    ['a commit', 'git commit -m x', () => fx.clean],
    ['a branch cut', 'git switch -c feat/y', () => fx.clean],
    ['a branch create', 'git branch newthing', () => fx.clean],
    ['a hard reset', 'git reset --hard origin/main', () => fx.dirty],
    ['a branch switch', 'git checkout main', () => fx.paused],
    ['a stash', 'git stash', () => fx.dirty],
  ])('%s', (_label, command, cwd) => {
    expect(verdict(running(command, cwd())).blocked).toBe(true);
  });

  it('an Edit into the primary', () => {
    const payload = { session_id: SID, tool_name: 'Edit', tool_input: { file_path: path.join(fx.clean, 'tracked.txt') }, cwd: fx.clean };
    expect(verdict(payload).blocked).toBe(true);
  });

  it("the same restore in ANOTHER repo's primary, where the ticket has no merged PR", () => {
    expect(verdict(running('git checkout -- tracked.txt', fx.foreign)).blocked).toBe(true);
  });

  it('still allows the linked worktree as before (no regression in the unlocked direction)', () => {
    expect(verdict(running('git commit -m x', fx.linked)).blocked).toBe(false);
  });

  it('says why a cleanup shape was refused', () => {
    const r = verdict(running('git checkout -- other.txt', fx.dirty));
    expect(r.reason).toMatch(/post-merge/i);
    expect(r.reason).toMatch(/other\.txt/);
  });
});

describe('marker: every started ticket', () => {
  const start = (id) => ({ session_id: SID, tool_name: 'mcp__kanban__start_ticket', tool_input: { id } });

  it('accumulates tickets across start_ticket calls, without duplicates', () => {
    arm(start(A), env());
    arm(start(B), env());
    arm(start(A), env());
    expect(readMarker(SID, env())).toMatchObject({ ticket: A, tickets: [A, B], complete: true });
  });

  it('reads a legacy single-ticket marker as incomplete', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(markerPath(SID, env()), JSON.stringify({ ticket: A, armedAt: 'x' }));
    expect(readMarker(SID, env())).toMatchObject({ tickets: [A], complete: false });
  });

  it('keeps a marker incomplete once any arm could not read its predecessor', () => {
    writeFileSync(markerPath(SID, env()), 'not json');
    arm(start(A), env());
    expect(readMarker(SID, env()).complete).toBe(false);
    arm(start(B), env());
    expect(readMarker(SID, env())).toMatchObject({ tickets: [A, B], complete: false });
  });

  it('marks a start_ticket with no ticket id incomplete', () => {
    arm({ session_id: SID, tool_name: 'mcp__kanban__start_ticket', tool_input: {} }, env());
    expect(readMarker(SID, env()).complete).toBe(false);
  });

  it.each([
    ['a missing marker', null],
    ['unparseable JSON', 'nope'],
    ['tickets that are not strings', JSON.stringify({ ticket: A, tickets: [A, 3], complete: true })],
  ])('reads %s as no usable tickets', (_label, content) => {
    if (content !== null) writeFileSync(markerPath(SID, env()), content);
    expect(readMarker(SID, env()).complete).toBe(false);
  });

  it('a resumed session (same id) keeps its tickets; a /clear (new id) has none', () => {
    arm(start(A), env());
    expect(readMarker(SID, env()).tickets).toEqual([A]);
    expect(readMarker('ses-after-clear', env()).tickets).toEqual([]);
  });
});

describe('marker: the read-modify-write in arm() is locked', () => {
  const start = (id) => ({ session_id: SID, tool_name: 'mcp__kanban__start_ticket', tool_input: { id } });

  // Two start_ticket hooks in one session (parallel calls, or a subagent carrying the parent's id)
  // must not let the last write drop the other's ticket (review). A lock it cannot take is the
  // observable stand-in: the arm still succeeds, but the marker can no longer vouch for completeness.
  it('marks the marker incomplete when another arm holds the lock, and still arms', () => {
    arm(start(A), env());
    mkdirSync(`${markerPath(SID, env())}.lock`);
    const r = arm(start(B), { ...env(), WORKTREE_GUARD_LOCK_WAIT_MS: '50' });
    expect(r.blocked).toBe(false);
    expect(readMarker(SID, env())).toMatchObject({ tickets: [A, B], complete: false });
  });

  it('releases its lock, so the next arm stays complete', () => {
    arm(start(A), env());
    arm(start(B), env());
    expect(readMarker(SID, env())).toMatchObject({ tickets: [A, B], complete: true });
  });
});

describe('ghMergeState', () => {
  const ROOT = '/repo/root';
  const ok = (prs) => () => ({ status: 0, stdout: JSON.stringify(prs), stderr: '' });
  const pr = (over = {}) => ({ headRefName: `feat/${A}-slug`, baseRefName: 'main', mergedAt: '2026-09-16T00:00:00Z', state: 'MERGED', ...over });
  const origin = (url) => (args) => (args[0] === 'remote' ? { out: url } : { err: 'unexpected' });
  const GIT = origin('git@github.com:acme/widgets.git');
  const ask = (run, git = GIT) => ghMergeState(A, ROOT, 'main', run, git);

  it('reports merged for a merged PR into the default branch whose head names the ticket', () => {
    expect(ask(ok([pr()]))).toBe('merged');
  });

  it.each([
    ['no PRs', []],
    ['a PR merged into another base', [pr({ baseRefName: 'develop' })]],
    ['a PR whose head names another ticket', [pr({ headRefName: `feat/${B}-slug` })]],
    ['a head where the id is only a prefix of a longer hex run', [pr({ headRefName: `feat/${A}0-slug` })]],
    ['a PR with no mergedAt', [pr({ mergedAt: null, state: 'CLOSED' })]],
    // An earlier merged PR for the ticket does not vouch for the one still open (review).
    ['a merged PR alongside an OPEN one for the same ticket', [pr(), pr({ headRefName: `feat/${A}-take-two`, mergedAt: null, state: 'OPEN' })]],
  ])('reports unmerged for %s', (_label, prs) => {
    expect(ask(ok(prs))).toBe('unmerged');
  });

  it.each([
    ['a non-zero exit', () => ({ status: 1, stdout: '', stderr: 'no GitHub remote' })],
    ['a spawn error', () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' })],
    ['a timeout signal', () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' })],
    ['unparseable output', () => ({ status: 0, stdout: 'not json', stderr: '' })],
    ['output that is not an array', () => ({ status: 0, stdout: '{}', stderr: '' })],
    ['a runner that throws', () => { throw new Error('boom'); }],
  ])('reports unknown on %s', (_label, run) => {
    expect(ask(run)).toBe('unknown');
  });

  it.each([
    ['git@github.com:acme/widgets.git', 'github.com/acme/widgets'],
    ['https://github.com/acme/widgets', 'github.com/acme/widgets'],
    ['https://github.com/acme/widgets.git', 'github.com/acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'github.com/acme/widgets'],
    ['https://ghe.example.com/acme/widgets.git', 'ghe.example.com/acme/widgets'],
  ])('pins gh to origin %s as -R %s', (url, repo) => {
    const calls = [];
    ask((cmd, args, opts) => { calls.push({ cmd, args, opts }); return ok([])(); }, origin(url));
    expect(calls).toHaveLength(1);
    const { args } = calls[0];
    expect(args[args.indexOf('-R') + 1]).toBe(repo);
  });

  it.each([
    ['a local path', origin('/srv/git/widgets.git')],
    ['a nested path', origin('https://github.com/acme/sub/widgets.git')],
    ['no origin', () => ({ err: 'No such remote' })],
  ])('reports unknown, without asking gh, for %s', (_label, git) => {
    let asked = false;
    expect(ask(() => { asked = true; return ok([pr()])(); }, git)).toBe('unknown');
    expect(asked).toBe(false);
  });

  it('asks for every PR state, from the repo root, with GH_REPO stripped', () => {
    const calls = [];
    const saved = process.env.GH_REPO;
    process.env.GH_REPO = 'someone/else';
    try {
      ask((cmd, args, opts) => { calls.push({ cmd, args, opts }); return ok([])(); });
    } finally {
      if (saved === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = saved;
    }
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args.join(' ')).toMatch(/pr list .*--state all/);
    expect(calls[0].opts.cwd).toBe(ROOT);
    expect(calls[0].opts.timeout).toBeGreaterThan(0);
    expect(calls[0].opts.env.GH_REPO).toBeUndefined();
  });
});
