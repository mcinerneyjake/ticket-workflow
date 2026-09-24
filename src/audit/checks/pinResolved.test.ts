import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinResolved } from './pinResolved.js';
import { readRepoFile, type AuditContext, type Exec } from '../types.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TAG_OBJECT = 'a'.repeat(40);
const COMMIT = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

/** Real ls-remote shape for an annotated tag: the tag OBJECT first, the peeled commit on `^{}`. */
const annotated = (tag: string) => `${TAG_OBJECT}\trefs/tags/${tag}\n${COMMIT}\trefs/tags/${tag}^{}\n`;
/** A lightweight tag has no `^{}` row: the direct row IS the commit. */
const lightweight = (tag: string) => `${COMMIT}\trefs/tags/${tag}\n`;

const remote =
  (answer: (tag: string) => string): Exec =>
  (cmd, args) => {
    const pattern = args.find((a) => a.startsWith('refs/tags/') && !a.endsWith('^{}'));
    const tag = pattern?.slice('refs/tags/'.length) ?? '';
    return { kind: 'ran', ok: true, status: 0, stdout: cmd === 'git' ? answer(tag) : '', stderr: '' };
  };
const ANNOTATED = remote(annotated);
/** What `--exit-code` really does when no ref matches: status 2 and an empty stderr (measured). */
const TAG_ABSENT: Exec = () => ({ kind: 'ran', ok: false, status: 2, stdout: '', stderr: '' });
const UNREACHABLE: Exec = () => ({ kind: 'ran', ok: false, status: 128, stdout: '', stderr: 'fatal: could not read Username' });
const GIT_ABSENT: Exec = () => ({ kind: 'absent' });
const FORBIDDEN_EXEC: Exec = () => {
  throw new Error('no remote call is needed to answer this');
};

interface Repo {
  readonly pkg?: unknown;
  readonly lock?: unknown;
  readonly shrinkwrap?: unknown;
}

const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function run({ pkg, lock, shrinkwrap }: Repo, exec: Exec = ANNOTATED) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-pin-resolved-'));
  tempDirs.push(dir);
  if (pkg !== undefined) writeFileSync(path.join(dir, 'package.json'), asText(pkg));
  if (lock !== undefined) writeFileSync(path.join(dir, 'package-lock.json'), asText(lock));
  if (shrinkwrap !== undefined) writeFileSync(path.join(dir, 'npm-shrinkwrap.json'), asText(shrinkwrap));
  const ctx: AuditContext = { repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec };
  return pinResolved.run(ctx);
}

const consumer = (ref: string) => ({ dependencies: { 'ticket-workflow': `github:someowner/ticket-workflow#${ref}` } });
const lockResolving = (sha: string) => ({
  lockfileVersion: 3,
  packages: {
    '': { name: 'consumer' },
    'node_modules/ticket-workflow': { version: '0.24.0', resolved: `git+ssh://git@github.com/someowner/ticket-workflow.git#${sha}` },
  },
});

describe('pin-resolved — the commit the lock installs is the commit the tag names', () => {
  // The ticket's scenario: package.json reads the same version at both commits, so pin-parity passes.
  it('FAILS when the lock resolves a different commit than the pinned tag', () => {
    const res = run({ pkg: consumer('v0.24.0'), lock: lockResolving(OTHER) });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain(OTHER.slice(0, 7));
    expect(res.detail).toContain(COMMIT.slice(0, 7));
  });

  it('PASSES an annotated tag against its peeled commit, not the tag object', () => {
    const res = run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT) });
    expect(res.status, res.detail).toBe('pass');
    expect(run({ pkg: consumer('v0.24.0'), lock: lockResolving(TAG_OBJECT) }).status).toBe('fail');
  });

  it('PASSES a lightweight tag against its direct row', () => {
    const res = run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT) }, remote(lightweight));
    expect(res.status, res.detail).toBe('pass');
  });

  it('asks the remote for both the tag and its peeled row, and nothing else', () => {
    const seen: string[][] = [];
    const spy: Exec = (cmd, args, opts) => {
      seen.push([cmd, ...args]);
      return ANNOTATED(cmd, args, opts);
    };
    run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT) }, spy);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('refs/tags/v0.24.0');
    expect(seen[0]).toContain('refs/tags/v0.24.0^{}');
    expect(seen[0]).toContain('https://github.com/someowner/ticket-workflow.git');
  });

  it('ignores a row for a different tag that shares the prefix', () => {
    const noisy: Exec = () => ({ kind: 'ran', ok: true, status: 0, stdout: `${OTHER}\trefs/tags/v0.24.0-rc1^{}\n${annotated('v0.24.0')}`, stderr: '' });
    expect(run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT) }, noisy).status).toBe('pass');
  });

  it('reads a lock written in a mixed-case sha as the same commit', () => {
    expect(run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT.toUpperCase()) }).status).toBe('pass');
  });

  it('reads an uppercase sha from the remote as the same commit', () => {
    const upper = remote((tag) => annotated(tag).toUpperCase().replaceAll('REFS/TAGS/', 'refs/tags/').replaceAll(tag.toUpperCase(), tag));
    expect(run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT) }, upper).status).toBe('pass');
  });

  // Review finding: npm installs from the shrinkwrap and ignores package-lock.json when both exist.
  it('judges npm-shrinkwrap.json over package-lock.json when both exist', () => {
    const res = run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT), shrinkwrap: lockResolving(OTHER) });
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('npm-shrinkwrap.json');
  });

  it('compares a shrinkwrap-only repo rather than blocking on the missing package-lock.json', () => {
    const res = run({ pkg: consumer('v0.24.0'), shrinkwrap: lockResolving(COMMIT) });
    expect(res.status, res.detail).toBe('pass');
  });

  // --exit-code's 2 is a definite "no such ref", matching pin-freshness's FAIL for the same fact.
  it('FAILS when the pinned tag is not on the remote', () => {
    const res = run({ pkg: consumer('v0.24.0'), lock: lockResolving(COMMIT) }, TAG_ABSENT);
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('v0.24.0');
  });

  it('is core tier and ADVISORY — its answer depends on the network', () => {
    expect(pinResolved.tier).toBe('core');
    expect(pinResolved.advisory).toBe(true);
    expect(run({ pkg: consumer('v0.24.0'), lock: lockResolving(OTHER) }).advisory).toBe(true);
  });
});

describe('pin-resolved — "cannot determine" is never PASS', () => {
  const pinned = consumer('v0.24.0');

  it('blocks with no package-lock.json', () => {
    const res = run({ pkg: pinned }, FORBIDDEN_EXEC);
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('package-lock.json');
  });

  it('blocks an invalid-JSON lock', () => {
    expect(run({ pkg: pinned, lock: '{ not json' }, FORBIDDEN_EXEC).status).toBe('blocked');
  });

  it('blocks a lock that is an array rather than an object', () => {
    expect(run({ pkg: pinned, lock: [] }, FORBIDDEN_EXEC).status).toBe('blocked');
  });

  it('blocks a lockfileVersion 1 lock, which has no packages map', () => {
    const res = run({ pkg: pinned, lock: { lockfileVersion: 1, dependencies: {} } }, FORBIDDEN_EXEC);
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('packages');
  });

  it('blocks when an install-required dependency has no lock entry', () => {
    const res = run({ pkg: pinned, lock: { lockfileVersion: 3, packages: { '': {} } } }, FORBIDDEN_EXEC);
    expect(res.status, res.detail).toBe('blocked');
  });

  it('blocks a lock entry with no resolved field', () => {
    const lock = { lockfileVersion: 3, packages: { 'node_modules/ticket-workflow': { version: '0.24.0' } } };
    expect(run({ pkg: pinned, lock }, FORBIDDEN_EXEC).status).toBe('blocked');
  });

  it('blocks a resolved field carrying no 40-hex sha', () => {
    for (const sha of ['v0.24.0', 'abc1234', `${COMMIT}0`, `${COMMIT.slice(1)}g`]) {
      const res = run({ pkg: pinned, lock: lockResolving(sha) }, FORBIDDEN_EXEC);
      expect(res.status, `${sha}: ${res.detail}`).toBe('blocked');
    }
  });

  it('blocks when the remote is unreachable', () => {
    const res = run({ pkg: pinned, lock: lockResolving(COMMIT) }, UNREACHABLE);
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('could not read Username');
  });

  it('blocks when git is not on PATH', () => {
    expect(run({ pkg: pinned, lock: lockResolving(COMMIT) }, GIT_ABSENT).status).toBe('blocked');
  });

  it('blocks when the exec itself errors', () => {
    const errored: Exec = () => ({ kind: 'error', message: 'spawn EPERM' });
    expect(run({ pkg: pinned, lock: lockResolving(COMMIT) }, errored).status).toBe('blocked');
  });

  it('blocks, with a reason, when git fails silently with no exit code', () => {
    const silent: Exec = () => ({ kind: 'ran', ok: false, stdout: '', stderr: '' });
    const res = run({ pkg: pinned, lock: lockResolving(COMMIT) }, silent);
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('with no exit code');
    expect(res.detail).not.toContain('undefined');
  });

  it('blocks an unreadable shrinkwrap rather than falling back to package-lock.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-pin-resolved-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pinned));
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lockResolving(COMMIT)));
    mkdirSync(path.join(dir, 'npm-shrinkwrap.json'));
    const res = pinResolved.run({ repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec: FORBIDDEN_EXEC });
    expect(res.status, res.detail).toBe('blocked');
  });

  it('blocks a package.json that is an array', () => {
    expect(run({ pkg: [] }, FORBIDDEN_EXEC).status).toBe('blocked');
  });

  // ok:true with no matching row is what a git ignoring the patterns would yield; never a pass.
  it('blocks when the remote answers but names no row for the tag', () => {
    const empty: Exec = () => ({ kind: 'ran', ok: true, status: 0, stdout: `${COMMIT}\trefs/tags/v9.9.9\n`, stderr: '' });
    expect(run({ pkg: pinned, lock: lockResolving(COMMIT) }, empty).status).toBe('blocked');
  });

  it('blocks a pin that is not a version tag, deferring the FAIL to pin-parity', () => {
    const res = run({ pkg: consumer('main'), lock: lockResolving(COMMIT) }, FORBIDDEN_EXEC);
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('pin-parity');
  });

  it('blocks a spec it cannot read as a git pin', () => {
    expect(run({ pkg: { dependencies: { 'ticket-workflow': '^0.24.0' } } }, FORBIDDEN_EXEC).status).toBe('blocked');
  });

  it('blocks a declaration that is not a string', () => {
    expect(run({ pkg: { dependencies: { 'ticket-workflow': null } } }, FORBIDDEN_EXEC).status).toBe('blocked');
  });

  it('blocks an invalid-JSON package.json', () => {
    expect(run({ pkg: '{ nope' }, FORBIDDEN_EXEC).status).toBe('blocked');
  });
});

describe('pin-resolved — not applicable is a genuine PASS', () => {
  it('passes with no package.json', () => {
    expect(run({}, FORBIDDEN_EXEC).status).toBe('pass');
  });

  it('passes with no dependency on the package', () => {
    expect(run({ pkg: { name: 'unrelated', dependencies: { vitest: '^3.0.0' } } }, FORBIDDEN_EXEC).status).toBe('pass');
  });

  it('ignores a self-referencing bin entry', () => {
    const res = run({ pkg: { name: 'ticket-workflow', bin: { 'ticket-workflow': 'dist/cli/index.js' } } }, FORBIDDEN_EXEC);
    expect(res.status, res.detail).toBe('pass');
  });

  it('passes an optional/peer-only declaration the lock does not install', () => {
    const pkg = { peerDependencies: { 'ticket-workflow': 'github:someowner/ticket-workflow#v0.24.0' } };
    const res = run({ pkg, lock: { lockfileVersion: 3, packages: { '': {} } } }, FORBIDDEN_EXEC);
    expect(res.status, res.detail).toBe('pass');
  });

  it('still compares an optional/peer-only declaration the lock DOES install', () => {
    const pkg = { optionalDependencies: { 'ticket-workflow': 'github:someowner/ticket-workflow#v0.24.0' } };
    expect(run({ pkg, lock: lockResolving(OTHER) }).status).toBe('fail');
  });
});
