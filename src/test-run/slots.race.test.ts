import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The one dimension a single process cannot exercise: N real processes racing for the last slot.
// Children import slots.ts directly (Node 24 strips types; the module has no relative imports).

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SLOTS_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'slots.ts')).href;

// A winner holds its slot until the parent closes its stdin — after every sibling has reported — so
// a slow starter can never find the winner already exited and reclaim it legitimately.
const CHILD = `
const m = await import(process.argv[1]);
const stateDir = process.argv[2];
const record = { version: 1, pid: process.pid, repo: 'race', cwd: '/race', startedAt: new Date().toISOString(), tmpDir: '/race' };
const claim = m.claimSlot({ stateDir, slots: 1, record, probe: m.pidLiveness, now: Date.now(), ttlMs: 900000, log: () => {} });
process.stdout.write(JSON.stringify({ pid: process.pid, granted: claim !== null }) + '\\n');
if (claim === null) process.exit(0);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

function exitedPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid === undefined || r.pid === 0) throw new Error('could not spawn a probe child');
  return r.pid;
}

interface ChildResult {
  readonly pid: number;
  readonly granted: boolean;
}

interface Running {
  readonly child: ChildProcess;
  readonly reported: Promise<ChildResult>;
  readonly exited: Promise<number | null>;
}

function parseReport(line: string): ChildResult {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed === 'object' && parsed !== null && 'pid' in parsed && 'granted' in parsed && typeof parsed.pid === 'number' && typeof parsed.granted === 'boolean') {
    return { pid: parsed.pid, granted: parsed.granted };
  }
  throw new Error(`unexpected child output: ${line}`);
}

function startChild(stateDir: string): Running {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, SLOTS_URL, stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const reported = new Promise<ChildResult>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl !== -1) {
        try {
          resolve(parseReport(out.slice(0, nl)));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => reject(new Error(`child exited ${code} before reporting: ${err}`)));
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, reported, exited };
}

describe('claimSlot under a real race', () => {
  it('eight processes contending for one slot left by a dead holder: exactly one is granted', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'tw-race-'));
    tempDirs.push(stateDir);
    // A dead holder pre-planted, so every child goes through reclaim-then-link rather than finding
    // the slot simply free — the two primitives whose atomicity this test pins.
    writeFileSync(
      path.join(stateDir, 'slot-0'),
      JSON.stringify({ version: 1, pid: exitedPid(), repo: 'dead', cwd: '/dead', startedAt: new Date().toISOString(), tmpDir: '/dead' }),
    );
    const N = 8;
    const running = Array.from({ length: N }, () => startChild(stateDir));
    let results: ChildResult[];
    try {
      results = await Promise.all(running.map((r) => r.reported));
    } finally {
      for (const r of running) r.child.stdin?.end();
    }
    const codes = await Promise.all(running.map((r) => r.exited));
    expect(results).toHaveLength(N);
    expect(codes).toEqual(Array.from({ length: N }, () => 0));
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect(new Set(results.map((r) => r.pid)).size).toBe(N);
  }, 30_000);
});
