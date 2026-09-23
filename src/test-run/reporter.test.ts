import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { holdTestRun, releaseTestRun, type HoldTestRunOptions, type Registry, type RunState } from './hold.js';
import { INTERACTIVE_WAIT_MS, TestRunSlotReporter, type TestRunReporterContext } from './reporter.js';
import { EXIT, TestRunRefusal } from './slots.js';

/**
 * A live pid that is never ours. `claimSlot` reclaims a slot recording the CLAIMANT's own pid
 * (tkt-0ce4d4313ce7), so a case meaning "somebody else holds this" must not spell it `process.pid`.
 */
const FOREIGN_PID = 1;
if (FOREIGN_PID === process.pid) throw new Error('FOREIGN_PID must not be this process: the cases below would invert silently');

// The dimensions a watcher moves through: watch on/off · onInit seen or not · first run/RE-RUN ·
// slot free/full at re-acquire · hold granted/skipped. Every case injects its own state dir.

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type TestRegistry = Registry & { current: Promise<RunState> | undefined };

function registry(): TestRegistry {
  const r: TestRegistry = { current: undefined, get: () => r.current, set: (p) => { r.current = p; } };
  return r;
}

interface Fixture {
  readonly opts: HoldTestRunOptions;
  readonly stateDir: string;
  readonly tmpRoot: string;
  readonly registry: TestRegistry;
  readonly log: string[];
  readonly clock: { now: number };
}

function fixture(over: Partial<HoldTestRunOptions> = {}): Fixture {
  const stateDir = temp('tw-rep-state-');
  const tmpRoot = temp('tw-rep-tmp-');
  const log: string[] = [];
  const reg = registry();
  const clock = { now: 1_700_000_000_000 };
  const opts: HoldTestRunOptions = {
    repo: 'demo',
    cwd: '/work/demo',
    env: {},
    stateDir,
    tmpRoot,
    heartbeatMs: 60_000,
    waitMs: 0,
    // A fake clock: the wait loop advances only when its own sleep does, so a budget is reached
    // deterministically instead of by real elapsed time.
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    log: (l) => log.push(l),
    setExitCode: () => undefined,
    registerExit: () => undefined,
    registry: reg,
    ...over,
  };
  return { opts, stateDir, tmpRoot, registry: reg, log, clock };
}

const watching = (watch: boolean): TestRunReporterContext => ({ config: { watch } });

describe('TestRunSlotReporter — watch mode releases between runs', () => {
  it('frees the slot at the end of a run and takes one again at the start of the next', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));

    await holdTestRun(f.opts); // the config-time hold a real consumer already performed
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);

    await r.onTestRunStart(); // first run: shares the existing hold, claims nothing new
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);

    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual([]); // idle: holds nothing

    await r.onTestRunStart();
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual([]);
  });

  it('gives each re-run a fresh run dir beside the last, not nested inside it', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));

    const first = await holdTestRun(f.opts);
    const firstDir = first.kind === 'held' ? first.tmpDir : '';
    await r.onTestRunStart(); // pairs with the end below; an unpaired end releases nothing
    await r.onTestRunEnd();
    await r.onTestRunStart();
    const state = await f.registry.get();
    const secondDir = state?.outcome.kind === 'held' ? state.outcome.tmpDir : '';

    expect(secondDir).not.toBe(firstDir);
    expect(secondDir.startsWith(firstDir)).toBe(false);
    expect(path.dirname(secondDir)).toBe(path.join(f.tmpRoot, 'demo-test'));
    await r.onTestRunEnd();
  });

  it('rejects rather than running unguarded when no slot is free at the re-acquire', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));
    await holdTestRun(f.opts);
    await r.onTestRunStart();
    await r.onTestRunEnd();

    // Both slots taken by live holders while this watcher sat idle.
    for (const slot of [0, 1]) {
      writeFileSync(
        path.join(f.stateDir, `slot-${slot}`),
        JSON.stringify({ version: 1, pid: FOREIGN_PID, repo: 'other', cwd: '/work/other', startedAt: new Date().toISOString(), tmpDir: '/x' }),
      );
    }
    const err: unknown = await r.onTestRunStart().then(() => null, (e: unknown) => e);
    // Narrowed by a throw, not an `if`: a non-refusal must fail the test, never skip the assertion.
    if (!(err instanceof TestRunRefusal)) throw new Error(`expected a TestRunRefusal, got ${String(err)}`);
    expect(err.code).toBe(EXIT.SLOTS_FULL);
  });
});

describe('TestRunSlotReporter — the cases that must stay inert', () => {
  it('does nothing at all under `vitest run`, leaving the config hold for globalSetup to release', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(false));

    await holdTestRun(f.opts);
    await r.onTestRunStart();
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']); // still held, exactly as today

    await releaseTestRun(f.registry);
    expect(readdirSync(f.stateDir)).toEqual([]);
  });

  it('stays inert when onInit was never called, rather than assuming watch', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    await holdTestRun(f.opts);
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(f.registry);
  });

  it('treats a context with no watch flag as not watching', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit({ config: {} });
    await holdTestRun(f.opts);
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(f.registry);
  });

  it('is harmless in watch mode when the hold itself was skipped, and claims no slot', async () => {
    const f = fixture({ env: { VITEST_WORKER_ID: '1' } });
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));
    await expect(holdTestRun(f.opts)).resolves.toEqual({ kind: 'skipped', reason: 'worker' });
    await r.onTestRunEnd();
    await r.onTestRunStart();
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual([]);
  });

  it('defaults its options, so a consumer can construct it with none', () => {
    expect(() => new TestRunSlotReporter()).not.toThrow();
  });
});

// Each case below is a way vitest can reach this reporter OUT of the start/end pairing it assumes.
// Every one must end with the slot still HELD: releasing without a re-acquire is the unguarded run.
describe('TestRunSlotReporter — the unpaired and unknowable cases keep the slot', () => {
  it('releases nothing on an onTestRunEnd that no onTestRunStart of ours preceded', async () => {
    // Typecheck watch: a TSC rebuild dispatches onTestRunEnd directly (vitest 4.1 cli-api).
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));
    await holdTestRun(f.opts);

    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);

    // A real run still pairs normally afterwards.
    await r.onTestRunStart();
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual([]);
  });

  it('does not release twice for one run, so a trailing end cannot free a freshly taken slot', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));
    await holdTestRun(f.opts);
    await r.onTestRunStart();
    await r.onTestRunEnd();
    expect(readdirSync(f.stateDir)).toEqual([]);

    await r.onTestRunStart(); // next run takes a slot
    await r.onTestRunEnd();
    await r.onTestRunEnd(); // stray end: must not release anything it did not take
    expect(readdirSync(f.stateDir)).toEqual([]);
  });

  it('warns exactly once when onInit never fired, instead of silently holding for the session', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    await holdTestRun(f.opts);
    await r.onTestRunStart();
    await r.onTestRunStart();
    const warnings = f.log.filter((l) => l.includes('onInit never fired'));
    expect(warnings).toHaveLength(1);
    expect(readdirSync(f.stateDir)).toEqual(['slot-0']);
  });

  it('explains the refusal before it propagates, because vitest turns it into a fatal exit', async () => {
    const f = fixture();
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));
    await holdTestRun(f.opts);
    await r.onTestRunStart();
    await r.onTestRunEnd();
    for (const slot of [0, 1]) {
      writeFileSync(
        path.join(f.stateDir, `slot-${slot}`),
        JSON.stringify({ version: 1, pid: FOREIGN_PID, repo: 'other', cwd: '/work/other', startedAt: new Date().toISOString(), tmpDir: '/x' }),
      );
    }
    const err: unknown = await r.onTestRunStart().then(() => null, (e: unknown) => e);
    if (!(err instanceof TestRunRefusal)) throw new Error(`expected a TestRunRefusal, got ${String(err)}`);
    expect(f.log.some((l) => l.includes('the watcher stops'))).toBe(true);
  });
});

describe('TestRunSlotReporter — the re-acquire budget', () => {
  it('waits seconds rather than the ten-minute default, since it now runs on every save', async () => {
    const f = fixture({ waitMs: undefined });
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));
    writeFileSync(
      path.join(f.stateDir, 'slot-0'),
      JSON.stringify({ version: 1, pid: FOREIGN_PID, repo: 'other', cwd: '/work/other', startedAt: new Date().toISOString(), tmpDir: '/x' }),
    );
    writeFileSync(
      path.join(f.stateDir, 'slot-1'),
      JSON.stringify({ version: 1, pid: FOREIGN_PID, repo: 'other', cwd: '/work/other', startedAt: new Date().toISOString(), tmpDir: '/x' }),
    );
    const err: unknown = await r.onTestRunStart().then(() => null, (e: unknown) => e);
    if (!(err instanceof TestRunRefusal)) throw new Error(`expected a TestRunRefusal, got ${String(err)}`);
    // The refusal message names the budget it actually used.
    expect(err.message).toContain(`${INTERACTIVE_WAIT_MS / 1000}s`);
    expect(err.message).not.toContain('600s');
  });

  it('yields to an explicit TEST_SLOTS_WAIT_MS rather than overriding the operator', async () => {
    const f = fixture({ waitMs: undefined, env: { TEST_SLOTS_WAIT_MS: '5000' } });
    const r = new TestRunSlotReporter(f.opts);
    r.onInit(watching(true));
    for (const slot of [0, 1]) {
      writeFileSync(
        path.join(f.stateDir, `slot-${slot}`),
        JSON.stringify({ version: 1, pid: FOREIGN_PID, repo: 'other', cwd: '/work/other', startedAt: new Date().toISOString(), tmpDir: '/x' }),
      );
    }
    const err: unknown = await r.onTestRunStart().then(() => null, (e: unknown) => e);
    if (!(err instanceof TestRunRefusal)) throw new Error(`expected a TestRunRefusal, got ${String(err)}`);
    expect(err.message).toContain('5s');
  });
});
