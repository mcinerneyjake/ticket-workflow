import { fileURLToPath } from 'node:url';

export { holdTestRun, releaseTestRun } from './hold.js';
export type { HoldOutcome, HoldTestRunOptions, Registry, SkipReason } from './hold.js';
export { TestRunSlotReporter } from './reporter.js';
export type { TestRunReporterContext } from './reporter.js';
export { EXIT, TestRunRefusal, clearStaleSlots, formatSlot, listSlots, pidLiveness } from './slots.js';
export type { Liveness, SlotRecord, SlotView } from './slots.js';

/** Absolute path of the globalSetup that releases the slot — pass it in a consumer's `test.globalSetup`. */
export const TEST_RUN_GLOBAL_SETUP = fileURLToPath(new URL('./globalSetup.js', import.meta.url));
