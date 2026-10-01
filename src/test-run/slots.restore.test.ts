import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimSlot, clearStaleSlots, EXIT, pidLiveness, TestRunRefusal, type SlotRecord } from './slots.js';

// Its own file because the only seam between reclaim's rename and its restore is `renameSync` itself,
// and mocking `node:fs` is module-wide (tkt-12ebbc36021a).
const seam: { afterStaleRename: ((from: string, to: string) => void) | null; openFds: Map<number, string> } = {
  afterStaleRename: null,
  openFds: new Map(),
};

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args);
      seam.openFds.set(fd, String(args[0]));
      return fd;
    },
    closeSync: (fd: number) => {
      seam.openFds.delete(fd);
      real.closeSync(fd);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      real.renameSync(from, to);
      const hook = seam.afterStaleRename;
      if (hook !== null && String(to).includes('.stale-')) hook(String(from), String(to));
    },
  };
});

const tempDirs: string[] = [];
afterEach(() => {
  seam.afterStaleRename = null;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const TTL = 15 * 60_000;
const FOREIGN_PID = 1;

function record(pid: number, repo: string): SlotRecord {
  return { version: 1, pid, repo, cwd: `/work/${repo}`, startedAt: '2026-09-22T00:00:00.000Z', tmpDir: `/tmp/${repo}`, token: `tok-${repo}` };
}

function exitedPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid === undefined || r.pid === 0) throw new Error('could not spawn a probe child');
  return r.pid;
}

function deadSlot() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'tw-slots-restore-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'slot-0');
  const dead = record(exitedPid(), 'dead');
  fs.writeFileSync(file, JSON.stringify(dead));
  return { dir, file, dead };
}

function sweep(dir: string) {
  return clearStaleSlots(dir, { probe: pidLiveness, now: Date.now(), ttlMs: TTL });
}

function staleFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes('.stale-'));
}

describe('reclaim — what the rename actually took', () => {
  it('control: a hook that changes nothing lets the reclaim proceed, so the seam itself is inert', () => {
    const { dir } = deadSlot();
    let fired = 0;
    seam.afterStaleRename = () => {
      fired += 1;
    };
    expect(sweep(dir).map((v) => v.record?.repo)).toEqual(['dead']);
    expect(fired).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps the judged file open across the rename, which is what stops a newcomer reusing its inode number', () => {
    const { dir } = deadSlot();
    let openAtRename: boolean | undefined;
    seam.afterStaleRename = (from) => {
      openAtRename = [...seam.openFds.values()].includes(from);
    };
    expect(sweep(dir)).toHaveLength(1);
    expect(openAtRename).toBe(true);
  });

  it('puts back a record re-touched between the judgement and the rename — a heartbeat on the same inode', () => {
    const { dir, file, dead } = deadSlot();
    seam.afterStaleRename = (_from, to) => {
      const t = new Date(Date.now() + 5_000);
      fs.utimesSync(to, t, t);
    };
    expect(sweep(dir)).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(dead));
    expect(fs.readdirSync(dir)).toEqual(['slot-0']);
  });

  it('refuses when the slot is re-granted in the rename-to-restore window, and keeps the displaced record', () => {
    const { dir, file, dead } = deadSlot();
    const second = record(FOREIGN_PID, 'second');
    seam.afterStaleRename = (from, to) => {
      const t = new Date(Date.now() + 5_000);
      fs.utimesSync(to, t, t);
      fs.writeFileSync(from, JSON.stringify(second));
    };
    let caught: unknown;
    try {
      sweep(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TestRunRefusal);
    expect(caught instanceof TestRunRefusal ? caught.code : undefined).toBe(EXIT.STATE_UNREADABLE);
    expect(caught instanceof Error ? caught.message : '').toMatch(/changed hands twice/);
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(second));
    const kept = staleFiles(dir);
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0] ?? ''), 'utf8')).toBe(JSON.stringify(dead));
  });

  it('a double race while sweeping our own orphan warns, and does not fail the claim already granted', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'tw-slots-restore-'));
    tempDirs.push(dir);
    // Token-less and older than this process: a recycled pid's leak, which the post-grant sweep reclaims.
    const orphan = { version: 1, pid: process.pid, repo: 'orphan', cwd: '/work/orphan', startedAt: '2000-01-01T00:00:00.000Z', tmpDir: '/tmp/orphan' };
    fs.writeFileSync(path.join(dir, 'slot-1'), JSON.stringify(orphan));
    const second = record(FOREIGN_PID, 'second');
    seam.afterStaleRename = (from, to) => {
      const t = new Date(Date.now() + 5_000);
      fs.utimesSync(to, t, t);
      fs.writeFileSync(from, JSON.stringify(second));
    };
    const log: string[] = [];
    const result = claimSlot({
      stateDir: dir,
      slots: 2,
      record: { ...record(process.pid, 'claimant'), token: 'tok-claimant' },
      probe: () => 'alive',
      now: Date.now(),
      ttlMs: TTL,
      log: (l) => log.push(l),
    });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('changed hands twice'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'slot-1'), 'utf8')).toBe(JSON.stringify(second));
  });
});
