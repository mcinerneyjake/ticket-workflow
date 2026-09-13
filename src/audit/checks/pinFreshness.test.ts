import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinFreshness } from './pinFreshness.js';
import { readRepoFile, type AuditContext, type Exec } from '../types.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real `git ls-remote --tags` answer: peeled `^{}` duplicates included. */
function lsRemote(tags: readonly string[]): string {
  return tags.map((t, i) => `${String(i).repeat(40)}\trefs/tags/${t}\n${String(i).repeat(40)}\trefs/tags/${t}^{}`).join('\n');
}

const REMOTE_OK = (tags: readonly string[]): Exec => () => ({ kind: 'ran', ok: true, status: 0, stdout: lsRemote(tags), stderr: '' });
const REMOTE_UNREACHABLE: Exec = () => ({ kind: 'ran', ok: false, status: 128, stdout: '', stderr: 'fatal: could not read Username' });
/** What `--exit-code` really does on a remote with no matching refs: status 2, and NO stderr. */
const REMOTE_NO_REFS: Exec = () => ({ kind: 'ran', ok: false, status: 2, stdout: '', stderr: '' });
const GIT_ABSENT: Exec = () => ({ kind: 'absent' });

function run(pkg: unknown, exec: Exec = REMOTE_OK(['v0.23.0', 'v0.24.0'])) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-pin-fresh-'));
  tempDirs.push(dir);
  if (pkg !== undefined) writeFileSync(path.join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  const ctx: AuditContext = { repoDir: dir, read: (rel) => readRepoFile(dir, rel), exec };
  return pinFreshness.run(ctx);
}

const consumer = (ref: string) => ({ dependencies: { 'ticket-workflow': `github:someowner/ticket-workflow#${ref}` } });

describe('pin-freshness — advisory by design', () => {
  // The reason this check exists separately: consumers run `audit .` as a REQUIRED check, so a tag
  // cut in this repo must not fail every open PR in an untouched consumer.
  it('is advisory, so it can never move a consumer\'s exit code', () => {
    expect(pinFreshness.advisory).toBe(true);
    expect(run(consumer('v0.23.0')).advisory).toBe(true);
  });

  it('passes when the pin is the newest tag', () => {
    const res = run(consumer('v0.24.0'));
    expect(res.status, res.detail).toBe('pass');
  });

  it('fails when a newer tag exists', () => {
    const res = run(consumer('v0.23.0'));
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('v0.24.0');
  });

  // Tags arrive in LEXICAL order here on purpose: that is what a git ignoring --sort, or a parser
  // trusting input order, yields, and lexically v0.9.1 sorts after v0.24.0 (measured against the
  // real remote 2026-09-12). Taking the last line would report a downgrade to v0.9.1.
  it('orders tags by version, not lexically', () => {
    const res = run(consumer('v0.24.0'), REMOTE_OK(['v0.10.0', 'v0.23.0', 'v0.24.0', 'v0.9.0', 'v0.9.1']));
    expect(res.status, res.detail).toBe('pass');
  });

  it('fails when the pinned tag is not on the remote at all', () => {
    const res = run(consumer('v0.99.0'), REMOTE_OK(['v0.23.0', 'v0.24.0']));
    expect(res.status, res.detail).toBe('fail');
    expect(res.detail).toContain('v0.99.0');
  });
});

describe('pin-freshness — "cannot determine" is never PASS', () => {
  it('blocks when the remote is unreachable', () => {
    expect(run(consumer('v0.24.0'), REMOTE_UNREACHABLE).status).toBe('blocked');
  });

  it('blocks when git is not on PATH', () => {
    expect(run(consumer('v0.24.0'), GIT_ABSENT).status).toBe('blocked');
  });

  // Review finding 7: `split('\n')[0] ?? fallback` is dead code — split always yields at least ''.
  // --exit-code firing is precisely the case with an empty stderr, so the operator got a detail
  // ending in "undetermined: " with no reason and no exit code.
  it('names a reason even when git fails silently under --exit-code', () => {
    const res = run(consumer('v0.24.0'), REMOTE_NO_REFS);
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toMatch(/git exited 2/);
    expect(res.detail.trimEnd(), 'must not end mid-sentence with no reason').not.toMatch(/undetermined:$/);
  });

  // Review finding 8: the old test fabricated ok:true + empty stdout, which real git cannot
  // produce under --exit-code. A remote whose tags are all non-version IS reachable this way.
  it('blocks when the remote has tags but none is a version tag', () => {
    const res = run(consumer('v0.24.0'), REMOTE_OK(['latest', 'release-1', 'nightly']));
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('no version tags');
  });

  it('blocks a spec it cannot read as a git pin', () => {
    expect(run({ dependencies: { 'ticket-workflow': '^0.24.0' } }).status).toBe('blocked');
  });

  it('blocks a pin that is not a version tag, deferring the FAIL to pin-parity', () => {
    const res = run(consumer('main'));
    expect(res.status, res.detail).toBe('blocked');
    expect(res.detail).toContain('pin-parity');
  });

  it('blocks a declaration that is not a string', () => {
    expect(run({ dependencies: { 'ticket-workflow': null } }).status).toBe('blocked');
  });
});

describe('pin-freshness — non-consumers', () => {
  it('passes with no dependency on the package', () => {
    expect(run({ name: 'unrelated' }).status).toBe('pass');
  });

  it('passes with no package.json', () => {
    expect(run(undefined).status).toBe('pass');
  });

  it('ignores a self-referencing bin entry', () => {
    expect(run({ name: 'ticket-workflow', bin: { 'ticket-workflow': 'dist/cli/index.js' } }).status).toBe('pass');
  });
});
