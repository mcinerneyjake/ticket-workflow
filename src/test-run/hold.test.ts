import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRegisterExit, defaultRepoName, defaultSetExitCode, defaultSleep, globalRegistry, holdTestRun, releaseTestRun, type HoldTestRunOptions, type Registry, type RunState } from './hold.js';
import { EXIT, parseSlotRecord, TestRunRefusal, type Liveness } from './slots.js';

// Every case injects env, stateDir, tmpRoot and registry. Inside a vitest worker process.env carries
// VITEST_WORKER_ID, so a helper that read process.env would skip in every case and this whole file
// would pass having exercised nothing — the positive control below is what proves the real path runs.

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

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type TestRegistry = Registry & { current: Promise<RunState> | undefined };

function registry(): TestRegistry {
  const r: TestRegistry = {
    current: undefined,
    get: () => r.current,
    set: (p) => {
      r.current = p;
    },
  };
  return r;
}

interface Harness {
  readonly opts: HoldTestRunOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir: string;
  readonly tmpRoot: string;
  readonly log: string[];
  readonly exitCodes: number[];
  readonly exitHooks: Array<() => void>;
  readonly registry: TestRegistry;
  readonly clock: { now: number };
  readonly sleeps: number[];
}

function harness(over: Partial<HoldTestRunOptions> = {}, env: NodeJS.ProcessEnv = {}): Harness {
  const stateDir = temp('tw-hold-state-');
  const tmpRoot = temp('tw-hold-tmp-');
  const log: string[] = [];
  const exitCodes: number[] = [];
  const exitHooks: Array<() => void> = [];
  const reg = registry();
  const clock = { now: 1_700_000_000_000 };
  const sleeps: number[] = [];
  const opts: HoldTestRunOptions = {
    repo: 'demo',
    cwd: '/work/demo',
    env,
    stateDir,
    tmpRoot,
    heartbeatMs: 60_000,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    log: (l) => log.push(l),
    setExitCode: (c) => exitCodes.push(c),
    registerExit: (fn) => {
      exitHooks.push(fn);
    },
    registry: reg,
    ...over,
  };
  return { opts, env, stateDir, tmpRoot, log, exitCodes, exitHooks, registry: reg, clock, sleeps };
}

/**
 * A live pid that is never ours. `claimSlot` reclaims a slot recording the CLAIMANT's own pid
 * (tkt-0ce4d4313ce7), so a case meaning "somebody else holds this" must not spell it `process.pid`.
 */
const FOREIGN_PID = 1;
if (FOREIGN_PID === process.pid) throw new Error('FOREIGN_PID must not be this process: the cases below would invert silently');

function plantHeld(stateDir: string, slot: number, pid: number, repo = 'other'): string {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `slot-${slot}`);
  writeFileSync(file, JSON.stringify({ version: 1, pid, repo, cwd: `/work/${repo}`, startedAt: new Date().toISOString(), tmpDir: '/x' }));
  return file;
}

async function refusal(p: Promise<unknown>): Promise<TestRunRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TestRunRefusal) return err;
    throw err;
  }
  throw new Error('expected a TestRunRefusal');
}

const alive: Liveness = 'alive';

describe('holdTestRun — the guards, each with a positive control on the same state dir', () => {
  it('is a no-op inside a vitest worker, and the same dir then grants when the guard is absent', async () => {
    const h = harness({}, { VITEST_WORKER_ID: '1' });
    await expect(holdTestRun(h.opts)).resolves.toEqual({ kind: 'skipped', reason: 'worker' });
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(readdirSync(h.tmpRoot)).toEqual([]);

    const positive = harness({ stateDir: h.stateDir, tmpRoot: h.tmpRoot }, {});
    const outcome = await holdTestRun(positive.opts);
    expect(outcome.kind).toBe('held');
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(positive.registry);
  });

  it('is a no-op on CI, and TEST_SLOTS_FORCE=1 overrides that', async () => {
    const ci = harness({}, { CI: 'true' });
    await expect(holdTestRun(ci.opts)).resolves.toEqual({ kind: 'skipped', reason: 'ci' });
    expect(readdirSync(ci.stateDir)).toEqual([]);

    const forced = harness({ stateDir: ci.stateDir, tmpRoot: ci.tmpRoot }, { CI: 'true', TEST_SLOTS_FORCE: '1' });
    expect((await holdTestRun(forced.opts)).kind).toBe('held');
    await releaseTestRun(forced.registry);
  });

  it('has no other escape hatch: TEST_RUN_HOLD=0 still holds a slot', async () => {
    const h = harness({}, { TEST_RUN_HOLD: '0' });
    expect((await holdTestRun(h.opts)).kind).toBe('held');
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(h.registry);
  });
});

describe('holdTestRun — a granted run', () => {
  it('claims slot 0, points env.TMPDIR at a fresh run dir under <tmpRoot>/<repo>-test, and reports both', async () => {
    const h = harness();
    const outcome = await holdTestRun(h.opts);
    expect(outcome.kind).toBe('held');
    if (outcome.kind !== 'held') return;
    expect(outcome.slot).toBe(0);
    expect(outcome.stateDir).toBe(h.stateDir);
    expect(path.dirname(outcome.tmpDir)).toBe(path.join(h.tmpRoot, 'demo-test'));
    expect(h.env.TMPDIR).toBe(outcome.tmpDir);
    expect(existsSync(outcome.tmpDir)).toBe(true);
    const rec = parseSlotRecord(readFileSync(path.join(h.stateDir, 'slot-0'), 'utf8'));
    expect(rec).toMatchObject({ pid: process.pid, repo: 'demo', cwd: '/work/demo', tmpDir: outcome.tmpDir });
    expect(h.log.some((l) => l.startsWith('[test-run] slot 1/2'))).toBe(true);
    expect(h.exitCodes).toEqual([]);
    expect(h.exitHooks).toHaveLength(1);
    await releaseTestRun(h.registry);
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(existsSync(outcome.tmpDir)).toBe(false);
  });

  it('honours TEST_SLOTS from env: with slots 0 and 1 held, TEST_SLOTS=3 grants slot 2', async () => {
    const h = harness({}, { TEST_SLOTS: '3' });
    plantHeld(h.stateDir, 0, FOREIGN_PID);
    plantHeld(h.stateDir, 1, FOREIGN_PID);
    const outcome = await holdTestRun(h.opts);
    expect(outcome).toMatchObject({ kind: 'held', slot: 2 });
    await releaseTestRun(h.registry);
  });

  it('takes the slot once per process: a second call shares the first outcome and adds no file', async () => {
    const h = harness();
    const first = await holdTestRun(h.opts);
    const second = await holdTestRun(h.opts);
    expect(second).toBe(first);
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(h.registry);
  });

  it('keeps the heartbeat moving so a fresh holder is never reclaimed', async () => {
    const h = harness({ heartbeatMs: 20, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    await holdTestRun(h.opts);
    const file = path.join(h.stateDir, 'slot-0');
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 120));
    expect(statSync(file).mtimeMs).toBeGreaterThan(before);
    await releaseTestRun(h.registry);
  });

  it('the exit hook releases too, and a later releaseTestRun is a harmless no-op', async () => {
    const h = harness();
    const outcome = await holdTestRun(h.opts);
    h.exitHooks[0]();
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(outcome.kind === 'held' && existsSync(outcome.tmpDir)).toBe(false);
    await expect(releaseTestRun(h.registry)).resolves.toBeUndefined();
    expect(h.exitCodes).toEqual([]);
  });
});

describe('holdTestRun — waiting and refusing', () => {
  it('waits while the only slot is held, prints the holder, and refuses with SLOTS_FULL at the budget', async () => {
    const h = harness({ slots: 1, waitMs: 5000, probe: () => alive });
    plantHeld(h.stateDir, 0, 4242, 'busy-repo');
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.SLOTS_FULL);
    expect(err.message).toContain('pid 4242 busy-repo /work/busy-repo');
    expect(h.exitCodes).toEqual([EXIT.SLOTS_FULL]);
    expect(h.log.some((l) => l.includes('waiting for a test slot') && l.includes('pid 4242'))).toBe(true);
    expect(h.sleeps).toEqual([1000, 2000, 2000]); // backoff, capped by the remaining budget
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']); // theirs, untouched
    expect(readdirSync(path.join(h.tmpRoot, 'demo-test'))).toEqual([]); // our run dir was removed
    expect(h.registry.current).toBeUndefined(); // a failed acquire does not stick
  });

  it('proceeds within one poll of the holder releasing', async () => {
    const h = harness({ slots: 1, waitMs: 60_000, probe: () => alive });
    const held = plantHeld(h.stateDir, 0, 4242);
    const base = h.opts.sleep;
    let polls = 0;
    const opts: HoldTestRunOptions = {
      ...h.opts,
      sleep: async (ms) => {
        polls += 1;
        if (polls === 2) unlinkSync(held);
        if (base) await base(ms);
      },
    };
    const outcome = await holdTestRun(opts);
    expect(outcome).toMatchObject({ kind: 'held', slot: 0 });
    expect(polls).toBe(2);
    expect(h.exitCodes).toEqual([]);
    await releaseTestRun(h.registry);
  });

  it('waitMs=0 tries exactly once and refuses', async () => {
    const h = harness({ slots: 1 }, { TEST_SLOTS_WAIT_MS: '0' });
    plantHeld(h.stateDir, 0, FOREIGN_PID);
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.SLOTS_FULL);
    expect(h.sleeps).toEqual([]);
  });

  it('refuses a bad TEST_SLOTS with STATE_UNREADABLE before touching the state dir', async () => {
    const h = harness({}, { TEST_SLOTS: 'abc' });
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(h.exitCodes).toEqual([EXIT.STATE_UNREADABLE]);
    expect(readdirSync(h.stateDir)).toEqual([]);
  });

  it('refuses a corrupt slot with STATE_UNREADABLE, distinct from SLOTS_FULL, and removes its run dir', async () => {
    const h = harness({ slots: 1 });
    mkdirSync(h.stateDir, { recursive: true });
    writeFileSync(path.join(h.stateDir, 'slot-0'), 'garbage');
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(err.code).not.toBe(EXIT.SLOTS_FULL);
    expect(readdirSync(path.join(h.tmpRoot, 'demo-test'))).toEqual([]); // a refused run holds nothing
    expect(h.env.TMPDIR).toBeUndefined();
  });

  it('refuses with TMPDIR_UNAVAILABLE when the run root is a file, and claims no slot', async () => {
    const h = harness();
    writeFileSync(path.join(h.tmpRoot, 'demo-test'), 'x');
    const err = await refusal(holdTestRun(h.opts));
    expect(err.code).toBe(EXIT.TMPDIR_UNAVAILABLE);
    expect(h.exitCodes).toEqual([EXIT.TMPDIR_UNAVAILABLE]);
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(h.env.TMPDIR).toBeUndefined();
  });
});

describe('releaseTestRun — the release dimension', () => {
  it('warns, does not throw and sets no exit code when the slot was already removed', async () => {
    const h = harness();
    await holdTestRun(h.opts);
    unlinkSync(path.join(h.stateDir, 'slot-0'));
    await expect(releaseTestRun(h.registry)).resolves.toBeUndefined();
    expect(h.log.some((l) => l.includes('WARNING') && l.includes('removed mid-run'))).toBe(true);
    expect(h.exitCodes).toEqual([]);
  });

  it('warns and leaves a slot that was reissued to another pid', async () => {
    const h = harness();
    await holdTestRun(h.opts);
    const file = plantHeld(h.stateDir, 0, 1, 'thief');
    await releaseTestRun(h.registry);
    expect(h.log.some((l) => l.includes('reissued'))).toBe(true);
    expect(parseSlotRecord(readFileSync(file, 'utf8'))?.repo).toBe('thief');
  });

  it.skipIf(isRoot)('rethrows and sets exit code 1 when the slot cannot be released', async () => {
    const h = harness();
    await holdTestRun(h.opts);
    chmodSync(h.stateDir, 0o500);
    await expect(releaseTestRun(h.registry)).rejects.toThrow();
    expect(h.exitCodes).toEqual([1]);
    chmodSync(h.stateDir, 0o700);
  });

  it.skipIf(isRoot)('re-acquires after a failed release instead of blocking on its own orphaned slot', async () => {
    const h = harness({ slots: 1 });
    await holdTestRun(h.opts);
    chmodSync(h.stateDir, 0o500);
    await expect(releaseTestRun(h.registry)).rejects.toThrow();
    chmodSync(h.stateDir, 0o700); // the transient failure clears; the orphan it left does not
    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);

    // Watch mode re-resolves the config: fresh registry, same process, only slot held by our own pid.
    const second = harness({ slots: 1, stateDir: h.stateDir, tmpRoot: h.tmpRoot });
    const outcome = await holdTestRun(second.opts);
    expect(outcome.kind).toBe('held');
    expect(second.sleeps).toEqual([]); // granted on sight, not after waiting out TEST_SLOTS_WAIT_MS
    expect(second.log.some((l) => l.includes('own orphaned slot'))).toBe(true);
    await releaseTestRun(second.registry);
  });

  it('is a no-op on an empty registry and on a registry whose acquire was refused', async () => {
    const empty = registry();
    await expect(releaseTestRun(empty)).resolves.toBeUndefined();
    const h = harness({}, { TEST_SLOTS: 'nope' });
    await refusal(holdTestRun(h.opts));
    h.registry.set(Promise.reject(new Error('refused earlier')));
    await expect(releaseTestRun(h.registry)).resolves.toBeUndefined();
  });
});

describe('the process-level defaults, exercised directly because the main process is never instrumented', () => {
  it('defaultSetExitCode writes process.exitCode', () => {
    const saved = process.exitCode;
    defaultSetExitCode(75);
    expect(process.exitCode).toBe(75);
    process.exitCode = saved;
  });

  it('defaultRegisterExit registers a one-shot exit listener', () => {
    const before = process.listenerCount('exit');
    const fn = (): void => undefined;
    defaultRegisterExit(fn);
    expect(process.listenerCount('exit')).toBe(before + 1);
    process.removeListener('exit', fn);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('defaultSleep resolves after roughly the requested time', async () => {
    const t0 = Date.now();
    await defaultSleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it('globalRegistry round-trips through globalThis, and is restored afterwards', () => {
    const saved = globalRegistry.get();
    const marker = Promise.resolve<RunState>({ outcome: { kind: 'skipped', reason: 'ci' }, held: null });
    globalRegistry.set(marker);
    expect(globalRegistry.get()).toBe(marker);
    globalRegistry.set(undefined);
    expect(globalRegistry.get()).toBeUndefined();
    globalRegistry.set(saved);
  });

  it('the default log writes the grant line to stderr', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    const h = harness({ log: undefined });
    await holdTestRun(h.opts);
    await releaseTestRun(h.registry);
    spy.mockRestore();
    expect(lines.some((l) => l.startsWith('[test-run] slot 1/2'))).toBe(true);
  });

  it('defaultRepoName reads a sanitised package name, and falls back to the directory name', () => {
    const dir = temp('tw-repo-name-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@scope/my pkg' }));
    expect(defaultRepoName(dir)).toBe('scope-my-pkg');
    const bare = temp('tw-repo-bare-');
    expect(defaultRepoName(bare)).toBe(path.basename(bare));
    writeFileSync(path.join(bare, 'package.json'), '{not json');
    expect(defaultRepoName(bare)).toBe(path.basename(bare));
  });
});

// Re-acquiring in ONE process is the dimension watch mode introduced (tkt-43881f6840ad): every case
// above holds once and exits, so none of them can see what a second hold inherits from the first.
describe('re-acquiring the slot in one process', () => {
  it('restores env.TMPDIR to the value it had before the hold', async () => {
    const h = harness({}, { TMPDIR: '/outer/tmp' });
    await holdTestRun(h.opts);
    expect(h.env.TMPDIR).not.toBe('/outer/tmp');
    await releaseTestRun(h.registry);
    expect(h.env.TMPDIR).toBe('/outer/tmp');
  });

  it('leaves no env.TMPDIR behind when there was none before the hold', async () => {
    const h = harness({}, {});
    await holdTestRun(h.opts);
    expect(h.env.TMPDIR).toBeDefined();
    await releaseTestRun(h.registry);
    expect('TMPDIR' in h.env).toBe(false);
  });

  it('restores env.TMPDIR even when the slot itself cannot be released', async () => {
    const h = harness({}, { TMPDIR: '/outer/tmp' });
    await holdTestRun(h.opts);
    rmSync(h.stateDir, { recursive: true, force: true });
    mkdirSync(h.stateDir, { recursive: true });
    chmodSync(h.stateDir, 0o500);
    await releaseTestRun(h.registry).catch(() => undefined);
    chmodSync(h.stateDir, 0o700);
    expect(h.env.TMPDIR).toBe('/outer/tmp');
  });

  // The real default path: `tmpRoot` falls back to os.tmpdir(), which RE-READS process.env.TMPDIR on
  // every call, so without the restore above the second run dir lands inside the deleted first one.
  it('roots the second run dir beside the first, never inside it', async () => {
    const outer = temp('tw-hold-outer-');
    vi.stubEnv('VITEST_WORKER_ID', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('TMPDIR', outer);
    const h = harness({ tmpRoot: undefined, env: process.env });
    try {
      const first = await holdTestRun(h.opts);
      expect(first.kind).toBe('held');
      const firstDir = first.kind === 'held' ? first.tmpDir : '';
      expect(path.dirname(firstDir)).toBe(path.join(outer, 'demo-test'));
      await releaseTestRun(h.registry);

      const second = await holdTestRun(h.opts);
      const secondDir = second.kind === 'held' ? second.tmpDir : '';
      expect(secondDir.startsWith(firstDir)).toBe(false);
      expect(path.dirname(secondDir)).toBe(path.dirname(firstDir));
      await releaseTestRun(h.registry);
    } finally {
      // A failed expect above would otherwise leave process.env's global TMPDIR stack live for later cases.
      await releaseTestRun(h.registry).catch(() => undefined);
      globalThis.__ticketWorkflowTmpDirStacks?.delete(process.env);
      vi.unstubAllEnvs();
    }
  });

  it('unregisters its exit hook on release, so N cycles leave no listener behind', async () => {
    const before = process.listenerCount('exit');
    for (let i = 0; i < 12; i += 1) {
      const h = harness({ registerExit: undefined });
      await holdTestRun(h.opts);
      await releaseTestRun(h.registry);
    }
    expect(process.listenerCount('exit')).toBe(before);
  });
});

// `registerExit` is public API returning caller-supplied code, so the release path must survive
// whatever it hands back. Both shapes below used to be silently absorbed (tkt-43881f6840ad review).
describe('a hostile registerExit cannot cost the release', () => {
  it('still restores TMPDIR and frees the slot when the remover throws, and says so', async () => {
    const h = harness({ registerExit: () => () => { throw new Error('remover blew up'); } }, { TMPDIR: '/outer/tmp' });
    await holdTestRun(h.opts);
    await releaseTestRun(h.registry);
    expect(h.env.TMPDIR).toBe('/outer/tmp');
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(h.log.some((l) => l.includes('could not unregister the exit hook'))).toBe(true);
  });

  it('names a non-function return rather than treating it as "no remover"', async () => {
    // Typed against the OLD `=> void` contract, which TypeScript lets return a value: this is the
    // shape `registerExit: (fn) => process.on('exit', fn)` has, returning `process`. A consumer on
    // the new types gets a compile error instead, so this guard exists for the ones who don't.
    const legacy: (fn: () => void) => void = () => ({ not: 'a function' });
    const h = harness({ registerExit: legacy });
    await holdTestRun(h.opts);
    expect(h.log.some((l) => l.includes('registerExit returned a non-function'))).toBe(true);
    await releaseTestRun(h.registry);
    expect(readdirSync(h.stateDir)).toEqual([]);
  });
});

// Two live holds in one process (tkt-a99209bedbb9). `registry` is public API and the config and
// globalSetup load through different module registries, so "one hold per process" was an assumption
// the reclaim branch relied on and nothing enforced.
//
// SLOT layer only: `harness` gives each hold its own `env` and `tmpRoot`. The TMPDIR layer is covered
// by 'two live holds sharing one TMPDIR' below.
describe('two live holds in one process', () => {
  it('gives the second hold its own slot instead of cannibalising the first', async () => {
    const first = harness({ slots: 2 });
    const second = harness({ stateDir: first.stateDir, tmpRoot: first.tmpRoot, slots: 2 });

    expect((await holdTestRun(first.opts)).kind).toBe('held');
    expect((await holdTestRun(second.opts)).kind).toBe('held');

    expect(readdirSync(first.stateDir).sort()).toEqual(['slot-0', 'slot-1']);

    await releaseTestRun(first.registry);
    await releaseTestRun(second.registry);
    expect(readdirSync(first.stateDir)).toEqual([]);
  });

  it('leaves the second hold’s slot alone when the first releases', async () => {
    // What makes this hold is the reclaim veto above, which keeps the two on DIFFERENT slots, so the
    // first release only ever reads its own record. Mutating releaseSlot's token clause leaves this
    // green — the release-side guard is covered by the planted case below and by slots.test.ts.
    const first = harness({ slots: 2 });
    const second = harness({ stateDir: first.stateDir, tmpRoot: first.tmpRoot, slots: 2 });
    await holdTestRun(first.opts);
    await holdTestRun(second.opts);
    const secondSlot = readdirSync(first.stateDir).find((n) => n !== 'slot-0') ?? 'slot-1';

    await releaseTestRun(first.registry);

    expect(readdirSync(first.stateDir)).toEqual([secondSlot]);
    expect(parseSlotRecord(readFileSync(path.join(first.stateDir, secondSlot), 'utf8'))?.pid).toBe(process.pid);
    await releaseTestRun(second.registry);
  });

  it('reports rather than deletes when its own slot was reissued to another hold mid-run', async () => {
    // The release-side guard end to end, on the state a degraded veto would produce: two holds on ONE
    // slot file. Planted, because the veto correctly prevents reaching it through holdTestRun — but it
    // is reachable if globalThis is not shared (separate realms), which is the veto's one assumption.
    const h = harness({ slots: 1 });
    await holdTestRun(h.opts);
    const file = path.join(h.stateDir, 'slot-0');
    const mine = parseSlotRecord(readFileSync(file, 'utf8'));
    expect(mine?.token).toBeDefined();
    writeFileSync(file, JSON.stringify({ ...mine, token: 'a-different-hold' }));

    await releaseTestRun(h.registry);

    expect(readdirSync(h.stateDir)).toEqual(['slot-0']);
    expect(parseSlotRecord(readFileSync(file, 'utf8'))?.token).toBe('a-different-hold');
    expect(h.log.some((l) => l.includes('reissued to another run'))).toBe(true);
  });

  it('refuses a second hold rather than stealing the only slot from a live sibling', async () => {
    // The availability side of the veto, asserted deliberately: with the pool full of our OWN live
    // holds the second one refuses, exactly as it would behind a peer. Stealing is the permissive
    // answer, and it is the defect.
    const first = harness({ slots: 1 });
    await holdTestRun(first.opts);
    const second = harness({ stateDir: first.stateDir, tmpRoot: first.tmpRoot, slots: 1, waitMs: 0 });
    expect((await refusal(holdTestRun(second.opts))).code).toBe(EXIT.SLOTS_FULL);
    expect(readdirSync(first.stateDir)).toEqual(['slot-0']);
    await releaseTestRun(first.registry);
  });

  it('still reclaims a genuine self-orphan left by a failed release', async () => {
    // tkt-0ce4d4313ce7's behaviour, as a negative control on the veto added above: once a hold is
    // released its slot is no longer a live sibling, so a leaked file must still be reclaimed.
    const h = harness({ slots: 1 });
    await holdTestRun(h.opts);
    const leaked = readFileSync(path.join(h.stateDir, 'slot-0'), 'utf8');
    await releaseTestRun(h.registry);
    writeFileSync(path.join(h.stateDir, 'slot-0'), leaked);

    const next = harness({ stateDir: h.stateDir, tmpRoot: h.tmpRoot, slots: 1 });
    expect((await holdTestRun(next.opts)).kind).toBe('held');
    expect(next.log.some((l) => l.includes('own orphaned slot'))).toBe(true);
    await releaseTestRun(next.registry);
  });
});

// The TMPDIR layer under two live holds (tkt-6d494a02f2f3). Only process.env reaches os.tmpdir(), so
// these share it with the default tmpRoot: an injected env or explicit tmpRoot would hide the nesting.
describe('two live holds sharing one TMPDIR', () => {
  // A case failing between its releases, or a broken stack, would leave process.env's global stack
  // populated and every later case would join it: a cascade that reads as independent failures.
  const open: TestRegistry[] = [];

  async function twoHolds(outer: string): Promise<{ first: Harness; second: Harness; firstDir: string; secondDir: string }> {
    vi.stubEnv('VITEST_WORKER_ID', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('TMPDIR', outer);
    const first = harness({ tmpRoot: undefined, env: process.env, slots: 2 });
    const second = harness({ tmpRoot: undefined, env: process.env, slots: 2, stateDir: first.stateDir });
    open.push(first.registry, second.registry);
    const a = await holdTestRun(first.opts);
    const b = await holdTestRun(second.opts);
    return { first, second, firstDir: a.kind === 'held' ? a.tmpDir : '', secondDir: b.kind === 'held' ? b.tmpDir : '' };
  }

  afterEach(async () => {
    for (const reg of open.splice(0)) await releaseTestRun(reg).catch(() => undefined);
    globalThis.__ticketWorkflowTmpDirStacks?.delete(process.env);
    vi.unstubAllEnvs();
  });

  it('roots the second run dir beside the live first one, never inside it', async () => {
    const outer = temp('tw-hold-outer-');
    const { first, second, firstDir, secondDir } = await twoHolds(outer);
    expect(path.dirname(firstDir)).toBe(path.join(outer, 'demo-test'));
    expect(path.dirname(secondDir)).toBe(path.join(outer, 'demo-test'));
    await releaseTestRun(second.registry);
    await releaseTestRun(first.registry);
  });

  it('first-in first-out: releasing the first keeps the second’s dir and TMPDIR, then restores the original', async () => {
    const outer = temp('tw-hold-outer-');
    const { first, second, secondDir } = await twoHolds(outer);

    await releaseTestRun(first.registry);
    expect(existsSync(secondDir)).toBe(true);
    expect(process.env.TMPDIR).toBe(secondDir);

    await releaseTestRun(second.registry);
    expect(process.env.TMPDIR).toBe(outer);
  });

  it('last-in first-out: releasing the second hands TMPDIR back to the live first, then the original', async () => {
    const outer = temp('tw-hold-outer-');
    const { first, second, firstDir } = await twoHolds(outer);

    await releaseTestRun(second.registry);
    expect(existsSync(firstDir)).toBe(true);
    expect(process.env.TMPDIR).toBe(firstDir);

    await releaseTestRun(first.registry);
    expect(process.env.TMPDIR).toBe(outer);
  });

  it.each([
    ['first-in first-out', false],
    ['last-in first-out', true],
  ])('leaves no TMPDIR behind when there was none before either hold (%s)', async (_order, reverse) => {
    const env: NodeJS.ProcessEnv = {};
    const first = harness({ slots: 2 }, env);
    const second = harness({ slots: 2, stateDir: first.stateDir, tmpRoot: first.tmpRoot }, env);
    await holdTestRun(first.opts);
    await holdTestRun(second.opts);
    for (const h of reverse ? [second, first] : [first, second]) await releaseTestRun(h.registry);
    expect('TMPDIR' in env).toBe(false);
  });

  it('releasing a middle hold leaves TMPDIR on the newest live one', async () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/outer/tmp' };
    const first = harness({ slots: 3 }, env);
    const shared = { slots: 3, stateDir: first.stateDir, tmpRoot: first.tmpRoot };
    const second = harness(shared, env);
    const third = harness(shared, env);
    const dirs: string[] = [];
    for (const h of [first, second, third]) {
      const o = await holdTestRun(h.opts);
      dirs.push(o.kind === 'held' ? o.tmpDir : '');
    }

    await releaseTestRun(second.registry);
    expect(env.TMPDIR).toBe(dirs[2]);
    await releaseTestRun(third.registry);
    expect(env.TMPDIR).toBe(dirs[0]);
    await releaseTestRun(first.registry);
    expect(env.TMPDIR).toBe('/outer/tmp');
  });

  it('roots a hold on an injected env beside a live process.env hold, not inside it', async () => {
    const outer = temp('tw-hold-outer-');
    vi.stubEnv('VITEST_WORKER_ID', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('TMPDIR', outer);
    const first = harness({ tmpRoot: undefined, env: process.env, slots: 2 });
    const second = harness({ tmpRoot: undefined, slots: 2, stateDir: first.stateDir }, {});
    open.push(first.registry, second.registry);
    await holdTestRun(first.opts);
    const b = await holdTestRun(second.opts);
    expect(path.dirname(b.kind === 'held' ? b.tmpDir : '')).toBe(path.join(outer, 'demo-test'));
  });

  it('never sweeps a live sibling hold’s run dir, however old it is', async () => {
    const env: NodeJS.ProcessEnv = {};
    const first = harness({ slots: 2 }, env);
    open.push(first.registry);
    const a = await holdTestRun(first.opts);
    const firstDir = a.kind === 'held' ? a.tmpDir : '';

    const later = Date.now() + 7 * 60 * 60_000; // past the default 6 h tmpTtlMs
    const second = harness({ slots: 2, stateDir: first.stateDir, tmpRoot: first.tmpRoot, now: () => later }, env);
    open.push(second.registry);
    await holdTestRun(second.opts);

    expect(existsSync(firstDir)).toBe(true);
  });

  it('a throwing registerExit leaves TMPDIR as it found it, and a later hold still restores the original', async () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/outer/tmp' };
    const broken = harness({ registerExit: () => { throw new Error('registerExit blew up'); } }, env);
    await expect(holdTestRun(broken.opts)).rejects.toThrow('registerExit blew up');
    expect(env.TMPDIR).toBe('/outer/tmp');

    const next = harness({ stateDir: broken.stateDir, tmpRoot: broken.tmpRoot }, env);
    await holdTestRun(next.opts);
    await releaseTestRun(next.registry);
    expect(env.TMPDIR).toBe('/outer/tmp');
  });
});
