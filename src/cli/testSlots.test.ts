import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdTestSlots } from './index.js';
import { EXIT, testSlotsStateDir } from '../test-run/slots.js';

const tempDirs: string[] = [];
const savedExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-cli-slots-'));
  tempDirs.push(dir);
  return dir;
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  return { out, err };
}

function plant(dir: string, slot: number, pid: number, repo: string): void {
  writeFileSync(path.join(dir, `slot-${slot}`), JSON.stringify({ version: 1, pid, repo, cwd: `/work/${repo}`, startedAt: new Date().toISOString(), tmpDir: '/x' }));
}

function exitedPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid === undefined || r.pid === 0) throw new Error('could not spawn a probe child');
  return r.pid;
}

describe('testSlotsStateDir', () => {
  it('honours TEST_SLOTS_DIR and otherwise lands under ~/.claude/state', () => {
    expect(testSlotsStateDir({ TEST_SLOTS_DIR: '/custom' })).toBe('/custom');
    expect(testSlotsStateDir({})).toMatch(/\/\.claude\/state\/test-slots$/);
  });
});

describe('test-slots status', () => {
  it('reports an empty board, naming the dir', () => {
    const dir = stateDir();
    const { out } = capture();
    cmdTestSlots([], { TEST_SLOTS_DIR: dir });
    expect(out).toEqual([`no test slots held (${dir})`]);
    expect(process.exitCode).toBe(savedExitCode);
  });

  it('reads a never-used machine as empty WITHOUT creating the state dir', () => {
    const dir = path.join(stateDir(), 'never-created');
    const { out } = capture();
    cmdTestSlots(['status'], { TEST_SLOTS_DIR: dir });
    expect(out).toEqual([`no test slots held (${dir})`]);
    expect(existsSync(dir)).toBe(false);
  });

  it('lists every holder with pid, repo, cwd and liveness', () => {
    const dir = stateDir();
    plant(dir, 0, process.pid, 'live-repo');
    plant(dir, 1, exitedPid(), 'dead-repo');
    const { out } = capture();
    cmdTestSlots(['status'], { TEST_SLOTS_DIR: dir });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^slot 0: pid \d+ live-repo \/work\/live-repo \(alive/);
    expect(out[1]).toMatch(/^slot 1: pid \d+ dead-repo \/work\/dead-repo \(dead/);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']); // status never removes
  });

  it('--json emits the rows as data', () => {
    const dir = stateDir();
    plant(dir, 0, process.pid, 'live-repo');
    const { out } = capture();
    cmdTestSlots(['--json'], { TEST_SLOTS_DIR: dir });
    const parsed: unknown = JSON.parse(out.join('\n'));
    expect(parsed).toMatchObject({ stateDir: dir, verb: 'status', slots: [{ slot: 0, liveness: 'alive', record: { repo: 'live-repo' } }] });
  });
});

describe('test-slots clear-stale', () => {
  it('removes dead holders, keeps live ones, and says what it removed', () => {
    const dir = stateDir();
    plant(dir, 0, process.pid, 'live-repo');
    plant(dir, 1, exitedPid(), 'dead-repo');
    const { out } = capture();
    cmdTestSlots(['clear-stale'], { TEST_SLOTS_DIR: dir });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^removed slot 1: pid \d+ dead-repo/);
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });

  it('reports nothing to do on a clean board', () => {
    const dir = stateDir();
    const { out } = capture();
    cmdTestSlots(['clear-stale'], { TEST_SLOTS_DIR: dir });
    expect(out).toEqual([`no stale test slots (${dir})`]);
  });
});

describe('test-slots — refusals', () => {
  it.each([['frobnicate'], ['-json'], ['status', 'extra'], ['--check']])('usage error %j exits 2 without touching state', (...args) => {
    const dir = stateDir();
    const { err } = capture();
    cmdTestSlots(args, { TEST_SLOTS_DIR: dir });
    expect(process.exitCode).toBe(2);
    expect(err[0]).toContain('usage: ticket-workflow test-slots');
  });

  it('unreadable state exits with STATE_UNREADABLE, never as an empty board', () => {
    const file = path.join(stateDir(), 'a-file');
    writeFileSync(file, 'x');
    const { out, err } = capture();
    cmdTestSlots(['status'], { TEST_SLOTS_DIR: file });
    expect(process.exitCode).toBe(EXIT.STATE_UNREADABLE);
    expect(out).toEqual([]);
    expect(err[0]).toContain('Cannot read the test-slot state');
  });

  it('a corrupt slot is a refusal for clear-stale too — it is never silently removed', () => {
    const dir = stateDir();
    writeFileSync(path.join(dir, 'slot-0'), 'garbage');
    capture();
    cmdTestSlots(['clear-stale'], { TEST_SLOTS_DIR: dir });
    expect(process.exitCode).toBe(EXIT.STATE_UNREADABLE);
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });
});
