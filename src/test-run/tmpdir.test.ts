import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, pidLiveness, TestRunRefusal } from './slots.js';
import { prepareRunTmpDir, removeRunTmpDir } from './tmpdir.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-tmproot-'));
  tempDirs.push(dir);
  return dir;
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const SIX_HOURS = 6 * 60 * 60_000;

function exitedPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid === undefined || r.pid === 0) throw new Error('could not spawn a probe child');
  return r.pid;
}

function prepare(tmpRoot: string) {
  const log: string[] = [];
  const out = prepareRunTmpDir({ tmpRoot, repo: 'demo', pid: process.pid, probe: pidLiveness, now: Date.now(), tmpTtlMs: SIX_HOURS, log: (l) => log.push(l) });
  return { ...out, log };
}

describe('prepareRunTmpDir', () => {
  it('creates <tmpRoot>/<repo>-test/run-<pid>-<rand> and returns it', () => {
    const tmpRoot = root();
    const { runRoot, runDir, removed } = prepare(tmpRoot);
    expect(runRoot).toBe(path.join(tmpRoot, 'demo-test'));
    expect(path.dirname(runDir)).toBe(runRoot);
    expect(path.basename(runDir)).toMatch(new RegExp(`^run-${process.pid}-[a-z0-9]+$`));
    expect(existsSync(runDir)).toBe(true);
    expect(removed).toEqual([]);
  });

  it('sweeps a dead sibling and an over-TTL sibling, keeps a live fresh sibling and unrecognised names', () => {
    const tmpRoot = root();
    const runRoot = path.join(tmpRoot, 'demo-test');
    mkdirSync(runRoot, { recursive: true });
    const dead = path.join(runRoot, `run-${exitedPid()}-aaaa`);
    const fresh = path.join(runRoot, `run-${process.pid}-bbbb`);
    const old = path.join(runRoot, `run-${process.pid}-cccc`);
    const junk = path.join(runRoot, 'junk');
    for (const d of [dead, fresh, old, junk]) mkdirSync(d);
    const t = new Date(Date.now() - SIX_HOURS - 60_000);
    utimesSync(old, t, t);

    const { runDir, removed, log } = prepare(tmpRoot);
    expect([...removed].sort()).toEqual([dead, old].sort());
    expect(readdirSync(runRoot).sort()).toEqual([path.basename(runDir), 'junk', `run-${process.pid}-bbbb`].sort());
    expect(log).toHaveLength(2);
  });

  it('refuses with TMPDIR_UNAVAILABLE when the run root is a regular file', () => {
    const tmpRoot = root();
    writeFileSync(path.join(tmpRoot, 'demo-test'), 'x');
    let err: unknown;
    try {
      prepare(tmpRoot);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TestRunRefusal);
    expect(err instanceof TestRunRefusal && err.code).toBe(EXIT.TMPDIR_UNAVAILABLE);
  });

  it.skipIf(isRoot)('refuses with TMPDIR_UNAVAILABLE when the tmpdir is not writable', () => {
    const tmpRoot = root();
    chmodSync(tmpRoot, 0o500);
    let err: unknown;
    try {
      prepare(tmpRoot);
    } catch (e) {
      err = e;
    }
    expect(err instanceof TestRunRefusal && err.code).toBe(EXIT.TMPDIR_UNAVAILABLE);
  });
});

describe('removeRunTmpDir', () => {
  it('removes the run dir and its contents, and tolerates a dir that is already gone', () => {
    const { runDir } = prepare(root());
    writeFileSync(path.join(runDir, 'leak'), 'x');
    removeRunTmpDir(runDir);
    expect(existsSync(runDir)).toBe(false);
    expect(() => removeRunTmpDir(runDir)).not.toThrow();
  });
});
