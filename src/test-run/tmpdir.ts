import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { errnoCode, EXIT, TestRunRefusal, type Probe } from './slots.js';

// Per-run TMPDIR (tkt-14788b3fc356): every mkdtemp a suite leaks dies with the run, and no two runs
// share a directory. The root stays under the DEFAULT tmpdir — outside every git tree and CLAUDE.md
// ancestor — or the tests asserting "not a repository" and clean-room's neutral-dir check flip.

const RUN_NAME = /^run-(\d+)-/;

export interface PrepareOptions {
  readonly tmpRoot: string;
  readonly repo: string;
  readonly pid: number;
  readonly probe: Probe;
  readonly now: number;
  readonly tmpTtlMs: number;
  readonly log: (line: string) => void;
}

export interface PreparedTmpDir {
  readonly runRoot: string;
  readonly runDir: string;
  readonly removed: readonly string[];
}

function unavailable(what: string, err: unknown): TestRunRefusal {
  const code = errnoCode(err) ?? (err instanceof Error ? err.message : String(err));
  return new TestRunRefusal(
    EXIT.TMPDIR_UNAVAILABLE,
    `Cannot prepare a per-run TMPDIR (${what}: ${code}); refusing to run against the shared tmpdir.`,
  );
}

/** Sweeps sibling run dirs whose holder is dead or which outlived the TTL; unrecognised names stay. */
function sweepSiblings(runRoot: string, own: string, opts: PrepareOptions): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(runRoot)) {
    const full = path.join(runRoot, name);
    if (full === own) continue;
    const m = RUN_NAME.exec(name);
    if (m === null) continue;
    const pid = Number(m[1]);
    let reason: string | null = null;
    if (opts.probe(pid) === 'dead') reason = 'process is gone';
    else {
      let ageMs: number;
      try {
        ageMs = opts.now - statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs > opts.tmpTtlMs) reason = `older than ${Math.round(opts.tmpTtlMs / 60_000)} min`;
    }
    if (reason === null) continue;
    rmSync(full, { recursive: true, force: true });
    removed.push(full);
    opts.log(`[test-run] removed stale run tmpdir ${full} — ${reason}`);
  }
  return removed;
}

export function prepareRunTmpDir(opts: PrepareOptions): PreparedTmpDir {
  const runRoot = path.join(opts.tmpRoot, `${opts.repo}-test`);
  const runDir = path.join(runRoot, `run-${opts.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(runDir, { recursive: true });
  } catch (err) {
    throw unavailable(`mkdir ${runDir}`, err);
  }
  let removed: string[];
  try {
    removed = sweepSiblings(runRoot, runDir, opts);
  } catch (err) {
    throw unavailable(`sweep ${runRoot}`, err);
  }
  return { runRoot, runDir, removed };
}

export function removeRunTmpDir(runDir: string): void {
  rmSync(runDir, { recursive: true, force: true });
}
