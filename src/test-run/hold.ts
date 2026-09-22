import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claimSlot,
  DEFAULT_TTL_MS,
  envInt,
  EXIT,
  formatSlot,
  heartbeat,
  listSlots,
  pidLiveness,
  releaseSlot,
  TestRunRefusal,
  testSlotsStateDir,
  type Probe,
  type SlotRecord,
} from './slots.js';
import { prepareRunTmpDir, removeRunTmpDir } from './tmpdir.js';

// The config-time entry (tkt-14788b3fc356): one of K machine-wide run slots plus a per-run TMPDIR,
// taken by a top-level `await` in vitest.config.ts before vitest snapshots the worker env or cleans
// the coverage dir. Released by ./globalSetup.ts at teardown and, best-effort, on exit.

export type SkipReason = 'worker' | 'ci';

export type HoldOutcome =
  | { readonly kind: 'held'; readonly slot: number; readonly tmpDir: string; readonly stateDir: string }
  | { readonly kind: 'skipped'; readonly reason: SkipReason };

export interface Registry {
  get(): Promise<RunState> | undefined;
  set(p: Promise<RunState> | undefined): void;
}

export interface HoldTestRunOptions {
  readonly repo?: string;
  readonly cwd?: string;
  /** Read for the guards and overrides; WRITTEN for TMPDIR. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDir?: string;
  readonly slots?: number;
  readonly waitMs?: number;
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
  readonly tmpRoot?: string;
  readonly tmpTtlMs?: number;
  readonly probe?: Probe;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly registerExit?: (fn: () => void) => void;
  readonly registry?: Registry;
}

interface Held {
  readonly slot: number;
  readonly file: string;
  readonly pid: number;
  readonly tmpDir: string;
  readonly stateDir: string;
  readonly timer: NodeJS.Timeout;
  readonly log: (line: string) => void;
  readonly setExitCode: (code: number) => void;
  released: boolean;
}

export interface RunState {
  readonly outcome: HoldOutcome;
  readonly held: Held | null;
}

declare global {
  // The config file and globalSetup load through different module registries; only globalThis is
  // shared between them (measured in copart-filter's testDbLock, the shape this mirrors).
  var __ticketWorkflowTestRun: Promise<RunState> | undefined;
}

const globalRegistry: Registry = {
  get: () => globalThis.__ticketWorkflowTestRun,
  set: (p) => {
    globalThis.__ticketWorkflowTestRun = p;
  },
};

export function defaultSetExitCode(code: number): void {
  process.exitCode = code;
}

export function defaultRegisterExit(fn: () => void): void {
  process.once('exit', fn);
}

function sanitizeRepo(name: string): string {
  return name.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function defaultRepoName(cwd: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && 'name' in pkg && typeof pkg.name === 'string' && pkg.name !== '') {
      return sanitizeRepo(pkg.name);
    }
  } catch {
    // No package.json, or an unreadable one: the directory name is the next best label.
  }
  return sanitizeRepo(path.basename(cwd));
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `CI` set to anything non-empty counts; GitHub sets `CI=true`. `TEST_SLOTS_FORCE=1` overrides it. */
function skipReason(env: NodeJS.ProcessEnv): SkipReason | null {
  if (env.VITEST_WORKER_ID !== undefined) return 'worker';
  if (env.CI !== undefined && env.CI !== '' && env.TEST_SLOTS_FORCE !== '1') return 'ci';
  return null;
}

function releaseHeld(held: Held): void {
  if (held.released) return;
  held.released = true;
  clearInterval(held.timer);
  let outcome;
  try {
    outcome = releaseSlot(held.file, held.pid);
  } catch (err) {
    // Vitest swallows a globalSetup teardown rejection and exits 0; the exit code is what survives.
    held.setExitCode(1);
    throw err;
  }
  if (outcome !== 'released') {
    held.log(
      `[test-run] WARNING: slot ${held.slot} was ${outcome === 'missing' ? 'removed' : 'reissued to another run'} mid-run; this run was unguarded for part of it`,
    );
  }
  try {
    removeRunTmpDir(held.tmpDir);
  } catch (err) {
    held.log(`[test-run] WARNING: could not remove ${held.tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function acquire(opts: HoldTestRunOptions): Promise<RunState> {
  const env = opts.env ?? process.env;
  const skipped = skipReason(env);
  if (skipped !== null) return { outcome: { kind: 'skipped', reason: skipped }, held: null };

  const cwd = opts.cwd ?? process.cwd();
  const repo = opts.repo ?? defaultRepoName(cwd);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((line: string) => console.error(line));
  const probe = opts.probe ?? pidLiveness;
  const setExitCode = opts.setExitCode ?? defaultSetExitCode;
  const registerExit = opts.registerExit ?? defaultRegisterExit;
  const stateDir = opts.stateDir ?? testSlotsStateDir(env);
  const pid = process.pid;
  let runDir: string | null = null;

  try {
    const slots = opts.slots ?? envInt(env, 'TEST_SLOTS', 2, 1);
    const waitMs = opts.waitMs ?? envInt(env, 'TEST_SLOTS_WAIT_MS', 10 * 60_000, 0);
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const heartbeatMs = opts.heartbeatMs ?? 30_000;
    const tmpTtlMs = opts.tmpTtlMs ?? 6 * 60 * 60_000;
    // Read BEFORE TMPDIR is rewritten below, or a second config load would nest a run dir in the first.
    const tmpRoot = opts.tmpRoot ?? tmpdir();

    // TMPDIR first: a run refused on tmpdir grounds must not be holding a slot.
    const prepared = prepareRunTmpDir({ tmpRoot, repo, pid, probe, now: now(), tmpTtlMs, log });
    runDir = prepared.runDir;
    const record: SlotRecord = { version: 1, pid, repo, cwd, startedAt: new Date(now()).toISOString(), tmpDir: runDir };
    const holders = (): string => listSlots(stateDir, { probe, now: now(), ttlMs }).map(formatSlot).join('\n  ');

    const start = now();
    let delay = 1000;
    let lastReport = Number.NEGATIVE_INFINITY;
    let claim = claimSlot({ stateDir, slots, record, probe, now: now(), ttlMs, log });
    while (claim === null) {
      const t = now();
      if (t - lastReport >= 60_000) {
        log(`[test-run] waiting for a test slot (${slots} in use):\n  ${holders()}`);
        lastReport = t;
      }
      if (t - start >= waitMs) {
        throw new TestRunRefusal(
          EXIT.SLOTS_FULL,
          `No test slot became free within ${Math.round(waitMs / 1000)}s; refusing to run unguarded. Holders:\n  ${holders()}\nRetry later, or \`ticket-workflow test-slots status\` to see who holds them.`,
        );
      }
      await sleep(Math.min(delay, Math.max(0, waitMs - (t - start))));
      delay = Math.min(delay * 2, 10_000);
      claim = claimSlot({ stateDir, slots, record, probe, now: now(), ttlMs, log });
    }

    env.TMPDIR = runDir;
    const timer = setInterval(() => {
      try {
        heartbeat(claim.file, now());
      } catch {
        // A vanished slot is reported at release; nothing useful to do from a timer.
      }
    }, heartbeatMs);
    timer.unref();
    const held: Held = { slot: claim.slot, file: claim.file, pid, tmpDir: runDir, stateDir, timer, log, setExitCode, released: false };
    registerExit(() => releaseHeld(held));
    log(`[test-run] slot ${claim.slot + 1}/${slots} · TMPDIR=${runDir}`);
    return { outcome: { kind: 'held', slot: claim.slot, tmpDir: runDir, stateDir }, held };
  } catch (err) {
    // A refused run holds nothing: whatever refused it, the run dir prepared above goes too.
    if (runDir !== null) removeRunTmpDir(runDir);
    if (err instanceof TestRunRefusal) setExitCode(err.code);
    throw err;
  }
}

/** Takes the run slot and TMPDIR for this process, once; later calls share the first outcome. */
export async function holdTestRun(opts: HoldTestRunOptions = {}): Promise<HoldOutcome> {
  const registry = opts.registry ?? globalRegistry;
  const pending = registry.get() ?? acquire(opts);
  registry.set(pending);
  try {
    return (await pending).outcome;
  } catch (err) {
    // A failed acquire must not stick: watch mode re-resolves the config and should retry.
    if (registry.get() === pending) registry.set(undefined);
    throw err;
  }
}

/** Releases what `holdTestRun` took. Fails the run (exit code 1) if the slot cannot be released. */
export async function releaseTestRun(registry: Registry = globalRegistry): Promise<void> {
  const pending = registry.get();
  if (pending === undefined) return;
  registry.set(undefined);
  let state: RunState;
  try {
    state = await pending;
  } catch {
    return; // a refused acquire holds nothing
  }
  if (state.held !== null) releaseHeld(state.held);
}
