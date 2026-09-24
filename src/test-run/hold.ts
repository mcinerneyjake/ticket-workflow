import { randomUUID } from 'node:crypto';
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
  /** Returns a remover where it can: a re-acquiring holder must unregister before registering again. */
  readonly registerExit?: (fn: () => void) => (() => void) | void;
  readonly registry?: Registry;
}

interface Held {
  readonly slot: number;
  readonly file: string;
  readonly pid: number;
  /** Distinguishes this hold from any other in the same pid, at both reclaim and release. */
  readonly token: string;
  readonly tmpDir: string;
  readonly stateDir: string;
  readonly timer: NodeJS.Timeout;
  readonly log: (line: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly tmpStack: TmpDirStack;
  unregisterExit: (() => void) | undefined;
  released: boolean;
}

/** The live holds writing one env's TMPDIR, oldest first, and what that env had before any of them. */
interface TmpDirStack {
  readonly prevTmpDir: string | undefined;
  /** os.tmpdir() before any live hold; only process.env's stack is ever read for it. */
  readonly tmpRoot: string;
  readonly live: Held[];
}

export interface RunState {
  readonly outcome: HoldOutcome;
  readonly held: Held | null;
}

declare global {
  // The config file and globalSetup load through different module registries; only globalThis is
  // shared between them (measured in copart-filter's testDbLock, the shape this mirrors).
  var __ticketWorkflowTestRun: Promise<RunState> | undefined;
  var __ticketWorkflowHeldTokens: Set<string> | undefined;
  var __ticketWorkflowTmpDirStacks: WeakMap<NodeJS.ProcessEnv, TmpDirStack> | undefined;
}

export const globalRegistry: Registry = {
  get: () => globalThis.__ticketWorkflowTestRun,
  set: (p) => {
    globalThis.__ticketWorkflowTestRun = p;
  },
};

/**
 * Tokens of the slots this process still holds. On globalThis for the same reason the registry is,
 * and not injectable for a reason the registry is: two of these would each read the other's live hold
 * as an orphan to reclaim, which is the defect (tkt-a99209bedbb9).
 */
function heldTokens(): Set<string> {
  globalThis.__ticketWorkflowHeldTokens ??= new Set();
  return globalThis.__ticketWorkflowHeldTokens;
}

// A single saved TMPDIR per hold assumed LIFO release: out of order, the first release restored a
// value the second was still using and deleted the second's dir nested inside its own (tkt-6d494a02f2f3).
function tmpDirStacks(): WeakMap<NodeJS.ProcessEnv, TmpDirStack> {
  globalThis.__ticketWorkflowTmpDirStacks ??= new WeakMap();
  return globalThis.__ticketWorkflowTmpDirStacks;
}

/** os.tmpdir() as it read before any live hold rewrote TMPDIR; it re-reads process.env on every call. */
function defaultTmpRoot(): string {
  return tmpDirStacks().get(process.env)?.tmpRoot ?? tmpdir();
}

function liveTmpDirs(env: NodeJS.ProcessEnv): Set<string> {
  const stacks = tmpDirStacks();
  const live = [...(stacks.get(env)?.live ?? []), ...(stacks.get(process.env)?.live ?? [])];
  return new Set(live.map((h) => h.tmpDir));
}

function pushTmpDir(held: Held): void {
  held.tmpStack.live.push(held);
  tmpDirStacks().set(held.env, held.tmpStack);
  held.env.TMPDIR = held.tmpDir;
}

function popTmpDir(held: Held): void {
  const { live, prevTmpDir } = held.tmpStack;
  const at = live.indexOf(held);
  if (at === -1) return;
  live.splice(at, 1);
  const top = live.at(-1);
  if (top !== undefined) held.env.TMPDIR = top.tmpDir;
  else {
    tmpDirStacks().delete(held.env);
    if (prevTmpDir === undefined) delete held.env.TMPDIR;
    else held.env.TMPDIR = prevTmpDir;
  }
}

export function defaultSetExitCode(code: number): void {
  process.exitCode = code;
}

export function defaultRegisterExit(fn: () => void): () => void {
  process.once('exit', fn);
  return () => {
    process.removeListener('exit', fn);
  };
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

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  // FIRST, because `released` is already true: nothing above this line may throw, or the restore is
  // lost for good, leaving TMPDIR on this run's soon-deleted dir (tkt-43881f6840ad, tkt-6d494a02f2f3).
  popTmpDir(held);
  // Also before anything that can throw: a slot file left behind by the release below must look like
  // an orphan to the next claim, or tkt-0ce4d4313ce7's self-reclaim never fires for it.
  heldTokens().delete(held.token);
  const unregister = held.unregisterExit;
  held.unregisterExit = undefined;
  try {
    unregister?.();
  } catch (err) {
    // A consumer-supplied remover is arbitrary code; losing the slot release to it would be worse.
    held.log(`[test-run] WARNING: could not unregister the exit hook: ${err instanceof Error ? err.message : String(err)}`);
  }
  let outcome;
  try {
    outcome = releaseSlot(held.file, held.pid, held.token);
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
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((line: string) => console.error(line));
  const probe = opts.probe ?? pidLiveness;
  const setExitCode = opts.setExitCode ?? defaultSetExitCode;
  const registerExit = opts.registerExit ?? defaultRegisterExit;
  const stateDir = opts.stateDir ?? testSlotsStateDir(env);
  const pid = process.pid;
  const token = randomUUID();
  let runDir: string | null = null;
  let pushed: Held | null = null;

  try {
    const slots = opts.slots ?? envInt(env, 'TEST_SLOTS', 2, 1);
    const waitMs = opts.waitMs ?? envInt(env, 'TEST_SLOTS_WAIT_MS', 10 * 60_000, 0);
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const heartbeatMs = opts.heartbeatMs ?? 30_000;
    const tmpTtlMs = opts.tmpTtlMs ?? 6 * 60 * 60_000;
    const tmpRoot = opts.tmpRoot ?? defaultTmpRoot();

    // TMPDIR first: a run refused on tmpdir grounds must not be holding a slot.
    const prepared = prepareRunTmpDir({ tmpRoot, repo, pid, probe, now: now(), tmpTtlMs, log, keep: liveTmpDirs(env) });
    runDir = prepared.runDir;
    const record: SlotRecord = { version: 1, pid, repo, cwd, startedAt: new Date(now()).toISOString(), tmpDir: runDir, token };
    const holders = (): string => listSlots(stateDir, { probe, now: now(), ttlMs }).map(formatSlot).join('\n  ');

    const start = now();
    let delay = 1000;
    let lastReport = Number.NEGATIVE_INFINITY;
    let claim = claimSlot({ stateDir, slots, record, probe, now: now(), ttlMs, log, heldTokens: heldTokens() });
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
      claim = claimSlot({ stateDir, slots, record, probe, now: now(), ttlMs, log, heldTokens: heldTokens() });
    }

    // No `await` between claimSlot linking the slot and this line, so a concurrent acquire in this
    // process can never observe the slot before its token counts as live and reclaim it as an orphan.
    heldTokens().add(token);
    const tmpStack = tmpDirStacks().get(env) ?? { prevTmpDir: env.TMPDIR, tmpRoot: defaultTmpRoot(), live: [] };
    const timer = setInterval(() => {
      try {
        heartbeat(claim.file, now());
      } catch {
        // A vanished slot is reported at release; nothing useful to do from a timer.
      }
    }, heartbeatMs);
    timer.unref();
    const held: Held = { slot: claim.slot, file: claim.file, pid, token, tmpDir: runDir, stateDir, timer, log, setExitCode, env, tmpStack, unregisterExit: undefined, released: false };
    pushTmpDir(held);
    pushed = held;
    const remove = registerExit(() => releaseHeld(held));
    // `registerExit` used to be declared `=> void`, so a consumer written against that may return
    // something else entirely (`process.on` returns `process`). Under a re-acquiring watcher that
    // silently leaks one exit listener per re-run, so name it rather than treating it as "no remover".
    if (remove !== undefined && typeof remove !== 'function') {
      log('[test-run] WARNING: registerExit returned a non-function, so its exit hook cannot be unregistered; a watch re-run leaks one listener per run');
    }
    held.unregisterExit = typeof remove === 'function' ? remove : undefined;
    log(`[test-run] slot ${claim.slot + 1}/${slots} · TMPDIR=${runDir}`);
    return { outcome: { kind: 'held', slot: claim.slot, tmpDir: runDir, stateDir }, held };
  } catch (err) {
    // A refused run holds nothing: whatever refused it, the run dir prepared above goes too. The
    // token goes with it, so a slot file linked before the throw is reclaimable rather than wedged
    // behind a token no Held will ever release.
    heldTokens().delete(token);
    // A dead entry would never let its stack empty, so TMPDIR could never return to the original.
    if (pushed !== null) popTmpDir(pushed);
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
