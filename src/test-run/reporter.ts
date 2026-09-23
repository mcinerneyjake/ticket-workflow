import { holdTestRun, releaseTestRun, type HoldTestRunOptions } from './hold.js';
import { TestRunRefusal } from './slots.js';

// The per-run entry (tkt-43881f6840ad). holdTestRun is taken once at config resolution, which vitest
// does NOT repeat on a watch re-run — so without this the slot a watcher takes on launch is held for
// the whole interactive session, idle or not, and two watchers exhaust the default pool of two.
//
// Watch mode only, deliberately: under `vitest run` the release belongs at globalSetup teardown,
// after coverage has been written, and firing it at onTestRunEnd would remove TMPDIR out from under
// the reporters that follow. Measured on vitest 4.1: onTestRunStart/onTestRunEnd fire once per
// re-run and onTestRunStart is AWAITED before any spec executes.
//
// Every branch here fails toward KEEPING the slot. Releasing without a re-acquire would let a run
// execute unguarded, which is the one outcome this whole mechanism exists to prevent.

/** A re-acquire runs on every save, so it waits seconds rather than `TEST_SLOTS_WAIT_MS`'s ten minutes. */
export const INTERACTIVE_WAIT_MS = 30_000;

/** The slice of vitest's context this reads, structural so the package needs no vitest types. */
export interface TestRunReporterContext {
  readonly config: { readonly watch?: boolean };
}

export class TestRunSlotReporter {
  readonly #opts: HoldTestRunOptions;
  #watching = false;
  #initSeen = false;
  #holding = false;
  #warnedNoInit = false;

  constructor(opts: HoldTestRunOptions = {}) {
    this.#opts = opts;
  }

  #say(line: string): void {
    (this.#opts.log ?? ((l: string) => console.error(l)))(line);
  }

  /**
   * A re-run is interactive, so it must not inherit the ten-minute budget a once-per-process hold
   * could afford. An explicit `waitMs`, or an explicit `TEST_SLOTS_WAIT_MS`, still wins.
   */
  #reacquireOpts(): HoldTestRunOptions {
    if (this.#opts.waitMs !== undefined) return this.#opts;
    const env = this.#opts.env ?? process.env;
    if (env.TEST_SLOTS_WAIT_MS !== undefined) return this.#opts;
    return { ...this.#opts, waitMs: INTERACTIVE_WAIT_MS };
  }

  onInit(ctx: TestRunReporterContext): void {
    this.#initSeen = true;
    this.#watching = ctx.config.watch === true;
  }

  async onTestRunStart(): Promise<void> {
    // Only three call sites dispatch onInit (Vitest.start, .standalone, .mergeReports), so an
    // embedder driving runTestSpecifications directly never reaches us with watch state. Silently
    // doing nothing there would restore the very bug this fixes, so say so rather than guess.
    if (!this.#initSeen && !this.#warnedNoInit) {
      this.#warnedNoInit = true;
      this.#say(
        '[test-run] WARNING: onInit never fired, so watch mode cannot be determined; this process will hold its test slot until it exits.',
      );
    }
    if (!this.#watching) return;
    try {
      await holdTestRun(this.#reacquireOpts());
    } catch (err) {
      if (err instanceof TestRunRefusal) {
        this.#say(
          `[test-run] no slot came free for this re-run, so it will not run unguarded — vitest treats this as fatal and the watcher stops. Restart it, or raise TEST_SLOTS_WAIT_MS. (${err.message})`,
        );
      }
      throw err;
    }
    this.#holding = true;
  }

  async onTestRunEnd(): Promise<void> {
    if (!this.#watching) return;
    // An END with no START of ours is not this reporter's run to release: in typecheck watch mode a
    // TSC-triggered rebuild dispatches onTestRunEnd on its own, with no onTestRunStart before it
    // (vitest 4.1 cli-api, `triggered by TSC watcher, not Vitest watcher`). Releasing there would
    // hand back a slot that nothing re-acquires, leaving every later TSC run unguarded.
    if (!this.#holding) return;
    this.#holding = false;
    await releaseTestRun(this.#opts.registry);
  }
}
