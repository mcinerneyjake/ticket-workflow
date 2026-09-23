import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as testRun from './index.js';

// The `ticket-workflow/test-run` subpath is what consumers import; this pins its surface and loads
// the barrel, which is otherwise never executed by a test and reads as 0 % under the coverage floor.

describe('the test-run export surface', () => {
  it('exports the consumer entry points by name', () => {
    const names = Object.keys(testRun).sort();
    expect(names).toEqual(['EXIT', 'TEST_RUN_GLOBAL_SETUP', 'TestRunRefusal', 'TestRunSlotReporter', 'clearStaleSlots', 'formatSlot', 'holdTestRun', 'listSlots', 'pidLiveness', 'releaseTestRun']);
    expect(typeof testRun.TestRunSlotReporter).toBe('function');
    expect(typeof testRun.holdTestRun).toBe('function');
    expect(typeof testRun.releaseTestRun).toBe('function');
    expect(testRun.EXIT).toEqual({ SLOTS_FULL: 75, STATE_UNREADABLE: 78, TMPDIR_UNAVAILABLE: 74 });
  });

  it('names the globalSetup beside itself as an absolute path a consumer can pass to vitest', () => {
    expect(path.isAbsolute(testRun.TEST_RUN_GLOBAL_SETUP)).toBe(true);
    expect(path.basename(testRun.TEST_RUN_GLOBAL_SETUP)).toBe('globalSetup.js');
    expect(path.dirname(testRun.TEST_RUN_GLOBAL_SETUP)).toBe(path.dirname(new URL(import.meta.url).pathname));
  });
});
