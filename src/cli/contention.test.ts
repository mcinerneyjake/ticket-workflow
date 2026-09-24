import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armResult,
  cmdTestContention,
  CONTENTION_EXIT,
  contentionStateDir,
  decide,
  contentionShaped,
  defaultGit,
  defaultOnSignal,
  defaultProcessList,
  defaultRunTest,
  foreignVitest,
  formatTable,
  localDay,
  mixedTests,
  parseContentionArgs,
  parseHistory,
  parseReport,
  runContention,
  summarizeRun,
  type ContentionDeps,
  type GitResult,
  type HistoryEntry,
  type RunOutcome,
} from './contention.js';

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// One entry per failing test; an array is one test carrying several messages (a retry, a throwing afterEach).
function report(files: { name: string; failed?: (string | string[])[]; fileMessage?: string }[]): string {
  return JSON.stringify({
    success: files.every((f) => (f.failed ?? []).length === 0 && f.fileMessage === undefined),
    testResults: files.map((f) => ({
      name: f.name,
      status: (f.failed ?? []).length > 0 || f.fileMessage !== undefined ? 'failed' : 'passed',
      message: f.fileMessage ?? '',
      assertionResults: (f.failed ?? []).map((m, i) => ({ status: 'failed', fullName: `t${i}`, failureMessages: Array.isArray(m) ? m : [m] })),
    })),
  });
}

const evidence = (over: { unhandledErrors?: number; coverageAfterFailure?: boolean; foreignGlobalSetup?: string[]; ownGlobalSetup?: boolean } = {}): string =>
  JSON.stringify({ version: 2, unhandledErrors: 0, coverageAfterFailure: false, foreignGlobalSetup: [], ownGlobalSetup: true, ...over });
const CLEAN = evidence();

const green = (index: number, slots: number | null = 2): RunOutcome => ({ kind: 'determined', index, exitCode: 0, green: true, files: [], slots });
const red = (index: number, slots: number | null = 2): RunOutcome => ({
  kind: 'determined',
  index,
  exitCode: 1,
  green: false,
  files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 1, mixed: [] }],
  slots,
});

const control = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  version: 1,
  repo: 'r',
  root: '/r',
  arm: 'control',
  runs: 4,
  day: '2026-09-22',
  at: '2026-09-22T10:00:00.000Z',
  head: 'abcdef1234',
  result: 'red',
  ...over,
});

describe('parseContentionArgs', () => {
  it('defaults to four bounded runs', () => {
    expect(parseContentionArgs([])).toEqual({ runs: 4, control: false });
  });
  it('reads --runs and --control', () => {
    expect(parseContentionArgs(['--runs', '3', '--control'])).toEqual({ runs: 3, control: true });
  });
  it.each([[['--runs']], [['--runs', '1']], [['--runs', '2.5']], [['--runs', 'x']], [['--verbose']], [['4']]])('rejects %j', (args) => {
    expect(parseContentionArgs(args)).toHaveProperty('error');
  });
});

describe('foreignVitest', () => {
  const self = '    1     0 node ticket-workflow test-contention';
  it('matches the vitest entrypoint and its workers outside our process tree', () => {
    const ps = [
      self,
      '  101    50 node /repo/node_modules/.bin/vitest run',
      '  102   101 /usr/bin/node /repo/node_modules/vitest/dist/workers/forks.js',
      '  103    50 node /repo/node_modules/vitest/vitest.mjs run',
    ].join('\n');
    expect(foreignVitest(ps, 1)).toHaveLength(3);
  });
  it('ignores our own descendants, however deep', () => {
    const ps = [self, '   10     1 npm test', '   11    10 sh -c vitest run', '   12    11 node /wt/node_modules/.bin/vitest run', '   13    12 node /p/node_modules/vitest/dist/workers/forks.js'].join('\n');
    expect(foreignVitest(ps, 1)).toEqual([]);
  });
  it('ignores processes that merely mention vitest', () => {
    const ps = [self, '  201     5 /bin/zsh -c pgrep -fl vitest', '  202     5 rg vitest src', '  203     5 node /repo/node_modules/.bin/vitestish', ''].join('\n');
    expect(foreignVitest(ps, 1)).toEqual([]);
  });
  it('cannot vouch for a list that does not contain this process', () => {
    expect(foreignVitest('  101    50 node /repo/node_modules/.bin/vitest run', 1)).toBeNull();
    expect(foreignVitest('', 1)).toBeNull();
  });
});

describe('parseReport', () => {
  it('counts failing tests and timeouts per file, relative to the worktree', () => {
    const text = report([
      { name: '/wt/run-1/src/a.test.ts', failed: ['Error: Test timed out in 20000ms.', 'AssertionError: expected 1'] },
      { name: '/wt/run-1/src/b.test.ts' },
    ]);
    expect(parseReport(text, ['/wt/run-1'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 2, timeouts: 1, mixed: [] }] });
  });
  it('counts a file that failed with no failing test, e.g. a hook timeout', () => {
    const text = report([{ name: '/private/wt/src/c.test.ts', fileMessage: 'Hook timed out in 10000ms.' }]);
    expect(parseReport(text, ['/wt', '/private/wt'])).toEqual({ success: false, files: [{ file: 'src/c.test.ts', failed: 1, timeouts: 1, mixed: [] }] });
  });
  // Verbatim shape of a vitest 4.1 test timeout in the JSON report: the stack is all that survives (tkt-366b0bf01713).
  const VITEST4_TIMEOUT = [
    'Error: STACK_TRACE_ERROR',
    '    at task (file:///wt/node_modules/@vitest/runner/dist/chunk-artifact.js:1784:27)',
    '    at /wt/run-1/src/a.test.ts:179:3',
  ].join('\n');
  it('counts a vitest 4 timeout, whose report carries only the STACK_TRACE_ERROR stack', () => {
    const text = report([{ name: '/wt/run-1/src/a.test.ts', failed: [VITEST4_TIMEOUT, VITEST4_TIMEOUT] }]);
    expect(parseReport(text, ['/wt/run-1'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 2, timeouts: 2, mixed: [] }] });
  });
  it('counts a vitest 4 timeout with CRLF line endings, and a bare header', () => {
    const text = report([{ name: '/wt/run-1/src/a.test.ts', failed: [VITEST4_TIMEOUT.replaceAll('\n', '\r\n'), 'Error: STACK_TRACE_ERROR'] }]);
    expect(parseReport(text, ['/wt/run-1'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 2, timeouts: 2, mixed: [] }] });
  });
  it('counts a file-level vitest 4 timeout header', () => {
    const text = report([{ name: '/wt/src/c.test.ts', fileMessage: VITEST4_TIMEOUT }]);
    expect(parseReport(text, ['/wt'])).toEqual({ success: false, files: [{ file: 'src/c.test.ts', failed: 1, timeouts: 1, mixed: [] }] });
  });
  it.each([
    ['a plain assertion', 'AssertionError: expected 1 to be 2\n    at /wt/run-1/src/a.test.ts:1:1'],
    ['STACK_TRACE_ERROR below the first line', 'Error: fixture failed\n    at Error: STACK_TRACE_ERROR\n    at x'],
    ['STACK_TRACE_ERROR with more on the first line', 'Error: STACK_TRACE_ERROR in my own code\n    at x'],
    ['STACK_TRACE_ERROR not at the start', 'TypeError: Error: STACK_TRACE_ERROR\n    at x'],
    ['an assertion quoting the phrase', "AssertionError: expected 'request timed out' to be 'ok'\n    at x"],
    ['a connection timeout', 'Error: Connection timed out\n    at x'],
    ["vi.waitFor's own timeout", 'Error: Timed out in waitFor!\n    at x'],
    ['a vitest header below the first line', 'Error: fetch failed\n    Caused by: Error: Test timed out in 5000ms.\n    at x'],
  ])('does not count %s as a timeout', (_label, message) => {
    const text = report([{ name: '/wt/run-1/src/a.test.ts', failed: [message] }]);
    expect(parseReport(text, ['/wt/run-1'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 0, mixed: [] }] });
  });
  it.each([
    ['connection timeout', 'Connection timed out'],
    ['vi.waitFor timeout', 'Timed out in waitFor!'],
    ['message quoting a vitest header mid-text', 'fetch failed: Hook timed out in 5ms.'],
  ])('does not count a file-level %s as a timeout', (_label, message) => {
    const text = report([{ name: '/wt/src/c.test.ts', fileMessage: message }]);
    expect(parseReport(text, ['/wt'])).toEqual({ success: false, files: [{ file: 'src/c.test.ts', failed: 1, timeouts: 0, mixed: [] }] });
  });
  it('counts a file-level aroundAll setup timeout', () => {
    const text = report([{ name: '/wt/src/c.test.ts', fileMessage: 'The setup phase of "aroundAll" hook timed out after 10000ms.' }]);
    expect(parseReport(text, ['/wt'])).toEqual({ success: false, files: [{ file: 'src/c.test.ts', failed: 1, timeouts: 1, mixed: [] }] });
  });
  // vitest's `message` is file.result.errors[0].message, set beside failing tests too (tkt-a9c71c324ac7).
  it.each([
    ['cleanup error', "Cannot read properties of undefined (reading 'close')"],
    ['hook timeout, which may hide a later error,', 'Hook timed out in 10000ms.'],
  ])('names a file-level %s beside a timed-out test as mixed, so the file is not contention-shaped', (_label, fileMessage) => {
    const text = report([{ name: '/wt/src/a.test.ts', failed: [VITEST4_TIMEOUT], fileMessage }]);
    expect(parseReport(text, ['/wt'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 1, mixed: ['<file-level error>'] }] });
    const runs = [summarizeRun({ evidence: CLEAN, index: 0, exitCode: 1, report: text, log: '', roots: ['/wt'] })];
    expect(contentionShaped(runs)).toBe(false);
    expect(mixedTests(runs)).toEqual(['src/a.test.ts › <file-level error>']);
  });
  it('does not name a file-level error beside only assertion failures as mixed', () => {
    const text = report([{ name: '/wt/src/a.test.ts', failed: ['AssertionError: expected 1 to be 2'], fileMessage: 'boom' }]);
    expect(parseReport(text, ['/wt'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 0, mixed: [] }] });
  });
  it('does not read an empty file-level message beside a timed-out test as an error', () => {
    const text = report([{ name: '/wt/src/a.test.ts', failed: [VITEST4_TIMEOUT], fileMessage: '' }]);
    expect(parseReport(text, ['/wt'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 1, mixed: [] }] });
  });
  it('does not count a vitest header behind a class vitest never uses for it', () => {
    const text = report([{ name: '/wt/run-1/src/a.test.ts', failed: ['AssertionError: Test timed out in 5ms.\n    at x'] }]);
    expect(parseReport(text, ['/wt/run-1'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 0, mixed: [] }] });
  });
  // 4.1 grafts STACK_TRACE_ERROR onto test and hook timeout stacks, so these prefixed headers are vitest ≤3 or a
  // stackless error; an around-hook timeout keeps its header, with the subclass name only when no stack was grafted.
  it.each([
    ['a vitest 3 test timeout stack', 'Error: Test timed out in 20000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".\n    at x'],
    ['a vitest 3 hook timeout stack', 'Error: Hook timed out in 10000ms.\n    at x'],
    ['a computed, non-integer timeout', 'Error: Test timed out in 5500.000000000001ms.\n    at x'],
    ['an aroundEach setup timeout with a grafted stack', 'Error: The setup phase of "aroundEach" hook timed out after 10000ms.\n    at x'],
    ['an aroundAll teardown timeout with no grafted stack', 'AroundHookTeardownError: The teardown phase of "aroundAll" hook timed out after 10000ms.\n    at x'],
  ])('counts %s', (_label, message) => {
    const text = report([{ name: '/wt/run-1/src/a.test.ts', failed: [message] }]);
    expect(parseReport(text, ['/wt/run-1'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 1, mixed: [] }] });
  });
  // Shapes measured on vitest 4.1.11: a beforeEach timeout then an afterEach cleanup error; a retry's timeout then its assertion.
  it.each([
    ['a cleanup error', [VITEST4_TIMEOUT, "TypeError: Cannot read properties of undefined (reading 'close')\n    at x"]],
    ['a retried assertion', [VITEST4_TIMEOUT, 'AssertionError: expected 2 to be 1\n    at x']],
    ['a vitest 3 timeout and an assertion', ['Error: Test timed out in 20000ms.', 'AssertionError: expected 1 to be 2\n    at x']],
  ])('names a timeout beside %s as mixed, still counting the timeout', (_label, messages) => {
    expect(parseReport(report([{ name: '/wt/src/a.test.ts', failed: [messages] }]), ['/wt'])).toEqual({
      success: false,
      files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 1, mixed: ['t0'] }],
    });
  });
  it.each([
    ['vitest 4', [VITEST4_TIMEOUT, VITEST4_TIMEOUT]],
    ['vitest 3', ['Error: Test timed out in 20000ms.', 'Error: Test timed out in 20000ms.']],
  ])('does not call a %s test that timed out on every retry mixed', (_label, messages) => {
    expect(parseReport(report([{ name: '/wt/src/a.test.ts', failed: [messages] }]), ['/wt'])).toEqual({
      success: false,
      files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 1, mixed: [] }],
    });
  });
  const raw = (assertion: object): string =>
    JSON.stringify({ success: false, testResults: [{ name: '/wt/src/a.test.ts', status: 'failed', message: '', assertionResults: [{ status: 'failed', ...assertion }] }] });
  it('treats a non-string entry beside a timeout as mixed, and names an unnamed test', () => {
    expect(parseReport(raw({ failureMessages: [VITEST4_TIMEOUT, null] }), ['/wt'])).toEqual({
      success: false,
      files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 1, mixed: ['<unnamed test>'] }],
    });
  });
  it.each([
    ['an empty list', { failureMessages: [] }],
    ['a missing key', {}],
    ['a non-array', { failureMessages: 'Error: Test timed out in 20000ms.' }],
    ['a timeout header nested in an array', { failureMessages: [['Test timed out in 5ms.']] }],
  ])('counts a failed test whose failureMessages is %s as neither timeout nor mixed', (_label, assertion) => {
    expect(parseReport(raw(assertion), ['/wt'])).toEqual({ success: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 0, mixed: [] }] });
  });
  it.each([
    ['not JSON', '{'],
    ['no success', JSON.stringify({ testResults: [] })],
    ['no testResults', JSON.stringify({ success: true })],
    ['a nameless entry', JSON.stringify({ success: true, testResults: [{ status: 'passed' }] })],
  ])('refuses %s', (_label, text) => {
    expect(typeof parseReport(text, [])).toBe('string');
  });
});

describe('summarizeRun', () => {
  it('is undetermined with no report', () => {
    expect(summarizeRun({ evidence: CLEAN, index: 0, exitCode: 75, report: null, log: '', roots: [] }).kind).toBe('undetermined');
  });
  it('reads the slot bound from the hold line', () => {
    const r = summarizeRun({ evidence: CLEAN, index: 0, exitCode: 0, report: report([]), log: '[test-run] slot 2/3 · TMPDIR=/t', roots: [] });
    expect(r).toMatchObject({ kind: 'determined', green: true, slots: 3 });
  });
  it('is red when the run exits non-zero with every file passing', () => {
    const r = summarizeRun({ evidence: CLEAN, index: 0, exitCode: 1, report: report([{ name: '/a.test.ts' }]), log: '', roots: [] });
    expect(r).toMatchObject({ kind: 'determined', green: false, slots: null });
    expect(formatTable([r]).join('\n')).toContain('<run exited 1 with no failing file>');
  });

  // The JSON report drops unhandled errors, and vitest exits 1 for them exactly as for a timeout (tkt-b1182a02fb14).
  const timedOut = report([{ name: '/wt/src/a.test.ts', failed: ['Error: STACK_TRACE_ERROR'] }, { name: '/wt/src/b.test.ts' }]);
  const run = (ev: string | null, text = timedOut, exitCode: number | null = 1, log: string | null = ''): RunOutcome =>
    summarizeRun({ evidence: ev, index: 0, exitCode, report: text, log, roots: ['/wt'] });
  it('names an unhandled error beside a timed-out test as mixed, so the run is not contention-shaped', () => {
    const runs = [run(evidence({ unhandledErrors: 2 }))];
    expect(contentionShaped(runs)).toBe(false);
    expect(mixedTests(runs)).toEqual(['src/a.test.ts › <unhandled errors in the run: 2>']);
  });
  it('names coverage checked after a failure as mixed: its threshold may be what exited non-zero', () => {
    const runs = [run(evidence({ coverageAfterFailure: true }))];
    expect(contentionShaped(runs)).toBe(false);
    expect(mixedTests(runs)).toEqual(['src/a.test.ts › <coverage thresholds checked after the failure>']);
  });
  it('keeps a timed-out run contention-shaped when the evidence is clean', () => {
    expect(contentionShaped([run(CLEAN)])).toBe(true);
  });
  // A globalSetup teardown runs after the evidence is written (tkt-e51870afd0da).
  it("names vitest's close error beside a timed-out test as mixed: a failed teardown may have set the exit code", () => {
    const runs = [run(CLEAN, timedOut, 1, '[test-run] slot 1/2\nerror during close Error: late release\n    at teardown (/wt/gs.mjs:1:1)\n')];
    expect(contentionShaped(runs)).toBe(false);
    expect(mixedTests(runs)).toEqual(['src/a.test.ts › <error during vitest close>']);
  });
  it('matches the close error after a partial line too: stdout and stderr share one fd, and a false match only withholds', () => {
    expect(mixedTests([run(CLEAN, timedOut, 1, 'partial stdout...error during close Error: late\n')])).toEqual(['src/a.test.ts › <error during vitest close>']);
  });
  it('is undetermined when a timed-out run left no readable log, which alone can show a close error', () => {
    expect(run(CLEAN, timedOut, 1, null)).toMatchObject({ kind: 'undetermined', reason: expect.stringContaining('log') });
    expect(run(null, report([{ name: '/wt/src/a.test.ts' }]), 0, null).kind).toBe('determined');
  });
  it("names a held slot with no ticket-workflow globalSetup to release it: the exit hook's failure is unobservable", () => {
    const held = '[test-run] slot 1/2 · TMPDIR=/t\n';
    expect(mixedTests([run(evidence({ ownGlobalSetup: false }), timedOut, 1, held)])).toEqual(['src/a.test.ts › <slot released by an exit hook, whose failure is unobservable>']);
    expect(contentionShaped([run(CLEAN, timedOut, 1, held)])).toBe(true);
    expect(contentionShaped([run(evidence({ ownGlobalSetup: false }), timedOut, 1, '')])).toBe(true);
  });
  it.each([
    [75, "<run exited 75, not vitest's 1>"],
    [0, "<run exited 0, not vitest's 1>"],
    [null, "<run exited by signal, not vitest's 1>"],
  ])('names a timed-out run exiting %s as mixed: vitest itself only ever sets 1', (exitCode, marker) => {
    expect(mixedTests([run(CLEAN, timedOut, exitCode)])).toEqual([`src/a.test.ts › ${marker}`]);
  });
  it('names each foreign globalSetup beside a timed-out test as mixed, even with a clean log', () => {
    const runs = [run(evidence({ foreignGlobalSetup: ['/wt/vitest.globalSetup.ts', '/elsewhere/gs.mjs'] }))];
    expect(contentionShaped(runs)).toBe(false);
    expect(mixedTests(runs)).toEqual([
      'src/a.test.ts › <globalSetup with an unobservable exit code: vitest.globalSetup.ts>',
      'src/a.test.ts › <globalSetup with an unobservable exit code: /elsewhere/gs.mjs>',
    ]);
  });
  it.each([
    ['no evidence', null],
    ['evidence that is not JSON', '{'],
    ['evidence of the previous version, which never saw globalSetup', JSON.stringify({ version: 1, unhandledErrors: 0, coverageAfterFailure: false })],
    ['a negative count', evidence({ unhandledErrors: -1 })],
    ['a fractional count', evidence({ unhandledErrors: 0.5 })],
    ['a missing coverage flag', JSON.stringify({ version: 2, unhandledErrors: 0, foreignGlobalSetup: [] })],
    ['a missing globalSetup list', JSON.stringify({ version: 2, unhandledErrors: 0, coverageAfterFailure: false })],
    ['a globalSetup list that is not an array', JSON.stringify({ version: 2, unhandledErrors: 0, coverageAfterFailure: false, foreignGlobalSetup: '/wt/gs.mjs' })],
    ['a globalSetup entry that is not a string', JSON.stringify({ version: 2, unhandledErrors: 0, coverageAfterFailure: false, foreignGlobalSetup: [7], ownGlobalSetup: true })],
    ['a missing own-globalSetup flag', JSON.stringify({ version: 2, unhandledErrors: 0, coverageAfterFailure: false, foreignGlobalSetup: [] })],
  ])('is undetermined on a non-zero run with a timeout and %s', (_label, ev) => {
    expect(run(ev)).toMatchObject({ kind: 'undetermined', reason: expect.stringContaining('evidence') });
    expect(run(ev, timedOut, null).kind).toBe('undetermined');
    expect(run(ev, timedOut, 0).kind).toBe('undetermined');
  });
  it.each([
    ['a green run', report([{ name: '/wt/src/a.test.ts' }]), 0],
    ['a run with only an assertion failure', report([{ name: '/wt/src/a.test.ts', failed: ['AssertionError: x'] }]), 1],
    ['a run exiting non-zero with every file passing', report([{ name: '/wt/src/a.test.ts' }]), 1],
  ])('needs no evidence for %s, where no test timed out', (_label, text, exitCode) => {
    expect(run(null, text, exitCode).kind).toBe('determined');
  });
});

describe('armResult', () => {
  it('never reads zero runs as green', () => {
    expect(armResult([])).toBe('undetermined');
  });
  it('is undetermined if any run is', () => {
    expect(armResult([green(0), { kind: 'undetermined', index: 1, exitCode: null, reason: 'x', slots: null }])).toBe('undetermined');
  });
});

describe('decide — bounded arm', () => {
  const base = { arm: 'bounded' as const, n: 4, root: '/r', head: 'abcdef1234', today: '2026-09-22', contaminated: [] };
  const allGreen = [0, 1, 2, 3].map((i) => green(i));
  const oneRed = [green(0), green(1), green(2), red(3)];

  it('passes green runs against a same-day red control', () => {
    const d = decide({ ...base, runs: allGreen, history: [control()] });
    expect(d.exit).toBe(CONTENTION_EXIT.PASS);
    expect(d.lines.join('\n')).toContain('PASS');
  });
  it('fails red runs against a same-day red control', () => {
    expect(decide({ ...base, runs: oneRed, history: [control()] })).toMatchObject({ exit: CONTENTION_EXIT.FAIL, recorded: 'red' });
  });
  const bounded = (index: number, text: string, ev = CLEAN): RunOutcome =>
    summarizeRun({ evidence: ev, index, exitCode: 1, report: text, log: '[test-run] slot 1/2', roots: ['/wt'] });
  it.each([
    ['a file-level error', report([{ name: '/wt/src/a.test.ts', failed: ['Error: Test timed out in 20000ms.'], fileMessage: 'TypeError: x' }]), CLEAN, '<file-level error>'],
    ['another message on the test', report([{ name: '/wt/src/a.test.ts', failed: [['Error: Test timed out in 20000ms.', 'TypeError: x']] }]), CLEAN, 't0'],
    ['an unhandled error', report([{ name: '/wt/src/a.test.ts', failed: ['Error: Test timed out in 20000ms.'] }]), evidence({ unhandledErrors: 1 }), '<unhandled errors in the run: 1>'],
  ])('withholds the verdict, never recording red, when a bounded timeout sat beside %s', (_label, text, ev, marker) => {
    const runs = [green(0), green(1), bounded(2, text, ev), bounded(3, text, ev)];
    const d = decide({ ...base, runs, history: [control()] });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
    const out = d.lines.join('\n');
    expect(out).toContain('timed out beside another error');
    expect(out.split(`src/a.test.ts › ${marker}`)).toHaveLength(2);
  });
  const mixedText = report([{ name: '/wt/src/a.test.ts', failed: [['Error: Test timed out in 20000ms.', 'TypeError: x']] }]);
  it('asks for a control first when a mixed bounded arm has none, naming the mixed test and never recording red', () => {
    const d = decide({ ...base, runs: [green(0), green(1), green(2), bounded(3, mixedText)], history: [] });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
    expect(d.lines[0]).toContain('Run test-contention --runs 4 --control first');
    expect(d.lines.join('\n')).toContain('src/a.test.ts › t0');
  });
  it('still records a plain red bounded arm with no control as red', () => {
    expect(decide({ ...base, runs: oneRed, history: [] })).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'red' });
  });
  it('fails when a clean timeout in another run shows the bound failed, whatever a mixed run says', () => {
    const d = decide({ ...base, runs: [green(0), green(1), red(2), bounded(3, mixedText)], history: [control()] });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.FAIL, recorded: 'red' });
  });
  it('names a plain assertion failure beside a mixed test instead of hiding it', () => {
    const text = report([
      { name: '/wt/src/a.test.ts', failed: [['Error: Test timed out in 20000ms.', 'TypeError: x']] },
      { name: '/wt/src/b.test.ts', failed: ['AssertionError: expected 1 to be 2'] },
    ]);
    const d = decide({ ...base, runs: [green(0), green(1), green(2), bounded(3, text)], history: [control()] });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
    expect(d.lines[0]).toContain('the bounded arm failed on something other than timeouts');
    expect(d.lines[1]).toContain('src/a.test.ts › t0');
  });
  it('still fails a bounded arm red only on an assertion, with no mixed test', () => {
    const broken: RunOutcome = { kind: 'determined', index: 3, exitCode: 1, green: false, files: [{ file: 'src/b.test.ts', failed: 1, timeouts: 0, mixed: [] }], slots: 2 };
    expect(decide({ ...base, runs: [green(0), green(1), green(2), broken], history: [control()] })).toMatchObject({ exit: CONTENTION_EXIT.FAIL, recorded: 'red' });
  });
  it.each([
    ['no control at all', []],
    ['a control from yesterday', [control({ day: '2026-09-21' })]],
    ['a control at a different N', [control({ runs: 2 })]],
    ['a control for another checkout', [control({ root: '/other' })]],
    ['a control at another commit', [control({ head: '0123456789' })]],
    ['a green control', [control({ result: 'green' })]],
    ['an undetermined control', [control({ result: 'undetermined' })]],
    ['only a bounded record', [control({ arm: 'bounded' })]],
  ])('withholds the verdict with %s', (_label, history) => {
    expect(decide({ ...base, runs: allGreen, history }).exit).toBe(CONTENTION_EXIT.NO_VERDICT);
    expect(decide({ ...base, runs: oneRed, history }).exit).toBe(CONTENTION_EXIT.NO_VERDICT);
  });
  it('withholds the verdict when a foreign vitest ran during the arm', () => {
    const d = decide({ ...base, runs: allGreen, history: [control()], contaminated: ['  9 1 node /x/node_modules/.bin/vitest run'] });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
  });
  it('withholds the verdict when a run held no slot', () => {
    const runs = [green(0), green(1), green(2), green(3, null)];
    expect(decide({ ...base, runs, history: [control()] }).exit).toBe(CONTENTION_EXIT.NO_VERDICT);
  });
  it('withholds the verdict when K admits every run', () => {
    const runs = [0, 1, 2, 3].map((i) => green(i, 4));
    expect(decide({ ...base, runs, history: [control()] }).exit).toBe(CONTENTION_EXIT.NO_VERDICT);
  });
  it('withholds the verdict when runs disagree on K', () => {
    const runs = [green(0, 2), green(1, 2), green(2, 3), green(3, 2)];
    expect(decide({ ...base, runs, history: [control()] }).exit).toBe(CONTENTION_EXIT.NO_VERDICT);
  });
  it('withholds the verdict when a run is undetermined', () => {
    const runs: RunOutcome[] = [green(0), green(1), green(2), { kind: 'undetermined', index: 3, exitCode: 75, reason: 'no report', slots: 2 }];
    expect(decide({ ...base, runs, history: [control()] }).exit).toBe(CONTENTION_EXIT.NO_VERDICT);
  });
});

describe('decide — control arm', () => {
  const base = { arm: 'control' as const, n: 2, root: '/r', head: 'abcdef1234', today: '2026-09-22', history: [], contaminated: [] };
  it('exits 0 and records red when the control reproduces contention', () => {
    expect(decide({ ...base, runs: [red(0, null), green(1, null)] })).toMatchObject({ exit: CONTENTION_EXIT.PASS, recorded: 'red' });
  });
  it('rejects a control red on an assertion: HEAD is broken, not contended', () => {
    const broken: RunOutcome = { kind: 'determined', index: 0, exitCode: 1, green: false, files: [{ file: 'src/a.test.ts', failed: 1, timeouts: 0, mixed: [] }], slots: null };
    const d = decide({ ...base, runs: [broken, red(1, null)] });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
    expect(d.lines.join('\n')).toContain('HEAD is red on its own');
  });
  it('refuses a control red only on timeouts beside another error, naming each test once', () => {
    const text = report([{ name: '/wt/src/a.test.ts', failed: [['Error: Test timed out in 20000ms.', 'TypeError: x']] }]);
    const runs = [0, 1].map((index) => summarizeRun({ evidence: CLEAN, index, exitCode: 1, report: text, log: '', roots: ['/wt'] }));
    const d = decide({ ...base, runs });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
    expect(d.lines).toHaveLength(1);
    expect(d.lines.join('\n')).toContain('timed out beside another error');
    expect(d.lines.join('\n').match(/src\/a\.test\.ts › t0/g)).toHaveLength(1);
  });
  it('reports HEAD red as well when a plain assertion failure sits beside a mixed test', () => {
    const text = report([
      { name: '/wt/src/a.test.ts', failed: [['Error: Test timed out in 20000ms.', 'TypeError: x']] },
      { name: '/wt/src/b.test.ts', failed: ['AssertionError: expected 1 to be 2'] },
    ]);
    const d = decide({ ...base, runs: [0, 1].map((index) => summarizeRun({ evidence: CLEAN, index, exitCode: 1, report: text, log: '', roots: ['/wt'] })) });
    expect(d).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
    expect(d.lines[0]).toContain('HEAD is red on its own');
    expect(d.lines[1]).toContain('src/a.test.ts › t0');
  });
  it('exits 2 when the control stays green: no instrument', () => {
    expect(decide({ ...base, runs: [green(0, 2), green(1, 2)] }).lines.join('')).toContain('CONTROL GREEN');
    expect(decide({ ...base, runs: [green(0, 2), green(1, 2)] }).exit).toBe(CONTENTION_EXIT.NO_VERDICT);
  });
  it('exits 2, and never records red, when a control run was still bounded below N', () => {
    expect(decide({ ...base, runs: [red(0, 1), red(1, 1)] })).toMatchObject({ exit: CONTENTION_EXIT.NO_VERDICT, recorded: 'undetermined' });
  });
});

describe('contentionShaped', () => {
  it('needs at least one failure, all of them timeouts', () => {
    expect(contentionShaped([red(0)])).toBe(true);
    expect(contentionShaped([green(0)])).toBe(false);
    expect(contentionShaped([{ kind: 'determined', index: 0, exitCode: 1, green: false, files: [{ file: 'x', failed: 2, timeouts: 1, mixed: [] }], slots: null }])).toBe(false);
    expect(contentionShaped([{ kind: 'determined', index: 0, exitCode: 1, green: false, files: [{ file: 'x', failed: 1, timeouts: 1, mixed: ['t'] }], slots: null }])).toBe(false);
  });
});

describe('mixedTests', () => {
  const run = (index: number, ...files: { file: string; mixed: string[] }[]): RunOutcome => ({
    kind: 'determined',
    index,
    exitCode: 1,
    green: false,
    files: files.map((f) => ({ ...f, failed: f.mixed.length, timeouts: f.mixed.length })),
    slots: null,
  });
  it('names a test once however many runs it failed in', () => {
    expect(mixedTests([run(0, { file: 'a', mixed: ['t'] }), run(1, { file: 'a', mixed: ['t'] })])).toEqual(['a › t']);
  });
  it('keeps distinct tests that share a name in one run apart, by count', () => {
    expect(mixedTests([run(0, { file: 'a', mixed: ['<unnamed test>', '<unnamed test>'] }), run(1, { file: 'a', mixed: ['<unnamed test>'] })])).toEqual(['a › <unnamed test> (×2)']);
  });
  it('keeps one test per line when a name carries a newline', () => {
    expect(mixedTests([run(0, { file: 'a', mixed: ['row\nsplit', 'crlf\r\nrow'] })])).toEqual(['a › row\\nsplit', 'a › crlf\\nrow']);
  });
  it('ignores undetermined runs and files with no mixed test', () => {
    expect(mixedTests([{ kind: 'undetermined', index: 0, exitCode: null, reason: 'x', slots: null }, run(1, { file: 'a', mixed: [] })])).toEqual([]);
  });
});

describe('parseHistory and localDay', () => {
  it('keeps well-formed entries and skips the rest', () => {
    const rootless = { ...control(), root: undefined }; // JSON.stringify drops the key
    const text = [JSON.stringify(control()), '{', JSON.stringify({ ...control(), result: 'maybe' }), JSON.stringify(rootless), '', JSON.stringify(control({ runs: 2 }))].join('\n');
    expect(parseHistory(text).map((h) => h.runs)).toEqual([4, 2]);
  });
  it('uses the local calendar day, not UTC', () => {
    expect(localDay(new Date(2026, 8, 22, 23, 59))).toBe('2026-09-22');
    expect(localDay(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});

// End to end over real git worktrees and a real `npm test`, which runs a stub instead of vitest: it
// logs a hold line, writes a vitest-shaped JSON report and exits per STUB_* env.
const STUB = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const out = process.argv.find((a) => a.startsWith('--outputFile='))?.slice('--outputFile='.length);
const control = process.env.TEST_SLOTS !== undefined;
const mode = (control ? process.env.STUB_CONTROL : process.env.STUB_BOUNDED) ?? 'green';
if (process.env.STUB_TRACE) appendFileSync(process.env.STUB_TRACE, process.cwd() + ' ' + existsSync('node_modules/marker') + '\\n');
console.error('[test-run] slot 1/' + (process.env.TEST_SLOTS ?? '1') + ' · TMPDIR=x');
await new Promise((r) => setTimeout(r, 100));
if (mode === 'noreport') process.exit(75);
const bad = mode === 'red' || mode === 'unhandled';
const file = (n, failed) => ({ name: path.join(process.cwd(), n), status: failed ? 'failed' : 'passed', message: '',
  assertionResults: [{ status: failed ? 'failed' : 'passed', failureMessages: failed ? ['Error: Test timed out in 20000ms.'] : [] }] });
writeFileSync(out, JSON.stringify({ success: !bad, testResults: [file('src/a.test.ts', bad), file('src/b.test.ts', false)] }));
const evidence = process.env.TEST_CONTENTION_EVIDENCE;
if (evidence) writeFileSync(evidence, JSON.stringify({ version: 2, unhandledErrors: mode === 'unhandled' ? 1 : 0, coverageAfterFailure: false, foreignGlobalSetup: [], ownGlobalSetup: true }));
process.exit(bad ? 1 : 0);
`;

/** Inherited env minus hook-exported git state and ambient slot config; `extra` may still set either (tkt-947fdf0a6d73). */
function scrubbedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'TEST_SLOTS', 'TEST_SLOTS_WAIT_MS', 'CI']) delete env[k];
  return { ...env, ...extra };
}

function git(args: readonly string[], cwd: string): GitResult {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: scrubbedEnv() });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function stubRepo(): string {
  const repo = tempDir('tw-contention-repo-');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'stub-repo', private: true, scripts: { test: 'node stub.mjs' } }));
  writeFileSync(path.join(repo, 'stub.mjs'), STUB);
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  mkdirSync(path.join(repo, 'node_modules'));
  writeFileSync(path.join(repo, 'node_modules', 'marker'), '');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']]) {
    const r = git(args, repo);
    if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
  return repo;
}

const SELF = '    1     0 node ticket-workflow test-contention';
const FOREIGN = `${SELF}\n    9     2 node /x/node_modules/.bin/vitest run`;

function deps(repo: string, stateDir: string, over: Partial<ContentionDeps> & { stub?: NodeJS.ProcessEnv } = {}): ContentionDeps & { out: string[] } {
  const out: string[] = [];
  return {
    cwd: repo,
    env: scrubbedEnv(over.stub),
    tmpRoot: tempDir('tw-contention-wt-'),
    stateDir,
    pid: 1,
    pollMs: 20,
    now: () => new Date(2026, 8, 22, 12, 0),
    git,
    processList: () => SELF,
    runTest: defaultRunTest,
    onSignal: () => () => {},
    exit: () => {},
    log: (l) => out.push(l),
    err: (l) => out.push(`ERR ${l}`),
    ...over,
    out,
  };
}

function worktreeCount(repo: string): number {
  return git(['worktree', 'list', '--porcelain'], repo).stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
}

describe('runContention end to end (stub npm test)', () => {
  it('records a red control, then passes a green bounded arm against it, leaving no worktree behind', async () => {
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    const trace = path.join(stateDir, 'trace');
    const stub = { STUB_CONTROL: 'red', STUB_BOUNDED: 'green', STUB_TRACE: trace };

    const gitCalls: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const spy = {
      git: (args: readonly string[], cwd: string) => {
        gitCalls.push([...args]);
        return git(args, cwd);
      },
      runTest: (o: Parameters<ContentionDeps['runTest']>[0]) => {
        envs.push(o.env);
        return defaultRunTest(o);
      },
    };
    const sha = git(['rev-parse', 'HEAD'], repo).stdout.trim();

    const c = deps(repo, stateDir, { stub, ...spy });
    expect(await runContention({ runs: 2, control: true }, c)).toBe(CONTENTION_EXIT.PASS);
    expect(c.out.join('\n')).toContain('CONTROL RED');
    expect(c.out.join('\n')).toMatch(/src\/a\.test\.ts\s+2\/2\s+2/);

    const b = deps(repo, stateDir, { stub, ...spy });
    expect(await runContention({ runs: 2, control: false }, b)).toBe(CONTENTION_EXIT.PASS);
    expect(b.out.join('\n')).toContain('PASS: 2 runs green at K=1');

    const adds = gitCalls.filter((a) => a[0] === 'worktree' && a[1] === 'add');
    expect(adds).toHaveLength(4);
    expect(adds.every((a) => a.at(-1) === sha)).toBe(true);
    expect(envs.map((e) => e.TEST_SLOTS)).toEqual(['2', '2', undefined, undefined]);
    expect(envs.every((e) => e.TEST_SLOTS_WAIT_MS === String(2 * 30 * 60_000))).toBe(true);

    const cwds = readFileSync(trace, 'utf8').trim().split('\n');
    expect(cwds).toHaveLength(4);
    expect(new Set(cwds).size).toBe(4);
    expect(cwds.every((l) => l.endsWith(' true'))).toBe(true);
    expect(worktreeCount(repo)).toBe(1);
    expect(parseHistory(readFileSync(path.join(stateDir, 'history.jsonl'), 'utf8')).map((h) => `${h.arm}:${h.result}`)).toEqual(['control:red', 'bounded:green']);
  });

  it('never records a control red whose runs reported an unhandled error beside the timeouts', async () => {
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    const d = deps(repo, stateDir, { stub: { STUB_CONTROL: 'unhandled' } });
    expect(await runContention({ runs: 2, control: true }, d)).toBe(CONTENTION_EXIT.NO_VERDICT);
    expect(d.out.join('\n')).toContain('src/a.test.ts › <unhandled errors in the run: 1>');
    expect(parseHistory(readFileSync(path.join(stateDir, 'history.jsonl'), 'utf8')).map((h) => h.result)).toEqual(['undetermined']);
  });

  const floor = (runs: number): number => runs * 30 * 60_000;
  it.each([
    ['a caller value below the derived wait is floored to it', 2, false, { TEST_SLOTS_WAIT_MS: '4321' }, String(floor(2)), true],
    ['a floor that scales with --runs', 3, false, { TEST_SLOTS_WAIT_MS: String(floor(2)) }, String(floor(3)), true],
    ['a control-arm caller value below the derived wait is floored to it', 2, true, { TEST_SLOTS_WAIT_MS: '4321' }, String(floor(2)), true],
    ['an empty caller value is floored like zero', 2, false, { TEST_SLOTS_WAIT_MS: '' }, String(floor(2)), true],
    ['a caller value equal to the derived wait reaches every run', 2, false, { TEST_SLOTS_WAIT_MS: String(floor(2)) }, String(floor(2)), false],
    ['a caller value above the derived wait is kept', 2, false, { TEST_SLOTS_WAIT_MS: String(floor(2) + 1) }, String(floor(2) + 1), false],
    ['an ambient shell value is scrubbed, so the wait is derived', 2, false, {}, String(floor(2)), false],
  ])('TEST_SLOTS_WAIT_MS: %s', async (_label, runs, control, stub, expected, noted) => {
    vi.stubEnv('TEST_SLOTS_WAIT_MS', '777');
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    const envs: NodeJS.ProcessEnv[] = [];
    const runTest = async (o: Parameters<ContentionDeps['runTest']>[0]) => {
      envs.push(o.env);
      return 0;
    };
    const d = deps(repo, stateDir, { stub, runTest });
    await runContention({ runs, control }, d);
    expect(envs.map((e) => e.TEST_SLOTS_WAIT_MS)).toEqual(Array(runs).fill(expected));
    expect(d.out.some((l) => l.includes(`raised to ${expected}`))).toBe(noted);
  });

  it('withholds the verdict when a run writes no report, and still removes every worktree', async () => {
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    const d = deps(repo, stateDir, { stub: { STUB_BOUNDED: 'noreport' } });
    expect(await runContention({ runs: 2, control: false }, d)).toBe(CONTENTION_EXIT.NO_VERDICT);
    expect(d.out.join('\n')).toContain('UNDETERMINED');
    expect(worktreeCount(repo)).toBe(1);
  });

  it.each([
    ['a live foreign vitest', () => FOREIGN],
    ['an unreadable process list', () => null],
    ['a process list without this process', () => '    9     2 node something'],
  ])('refuses to start with %s, creating nothing', async (_label, processList) => {
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    const d = deps(repo, stateDir, { processList });
    expect(await runContention({ runs: 2, control: false }, d)).toBe(CONTENTION_EXIT.NO_VERDICT);
    expect(d.out.join('\n')).toContain('ERR refused');
    expect(worktreeCount(repo)).toBe(1);
    expect(existsSync(path.join(stateDir, 'history.jsonl'))).toBe(false);
  });

  it.each([
    ['abc', false],
    ['-1', false],
    ['1.5', false],
    ['Infinity', false],
    ['abc', true],
  ])('refuses TEST_SLOTS_WAIT_MS=%j (control: %s) before running anything', async (raw, control) => {
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    let started = 0;
    const runTest = async () => {
      started++;
      return 0;
    };
    const d = deps(repo, stateDir, { stub: { TEST_SLOTS_WAIT_MS: raw }, runTest });
    expect(await runContention({ runs: 2, control }, d)).toBe(CONTENTION_EXIT.NO_VERDICT);
    expect(d.out.join('\n')).toContain(`ERR refused: TEST_SLOTS_WAIT_MS=${JSON.stringify(raw)}`);
    expect(started).toBe(0);
    expect(worktreeCount(repo)).toBe(1);
    expect(existsSync(path.join(stateDir, 'history.jsonl'))).toBe(false);
  });
});

describe('runContention mid-run', () => {
  it('withholds the verdict when a foreign vitest appears during the runs', async () => {
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    let calls = 0;
    const d = deps(repo, stateDir, { processList: () => (++calls === 1 ? SELF : FOREIGN) });
    expect(await runContention({ runs: 2, control: true }, d)).toBe(CONTENTION_EXIT.NO_VERDICT);
    expect(d.out.join('\n')).toContain('foreign vitest ran during the arm');
    expect(parseHistory(readFileSync(path.join(stateDir, 'history.jsonl'), 'utf8')).map((h) => h.result)).toEqual(['undetermined']);
  });

  it('removes every worktree on SIGINT and exits 130', async () => {
    const repo = stubRepo();
    const stateDir = tempDir('tw-contention-state-');
    let handler: ((s: 'SIGINT' | 'SIGTERM') => void) | undefined;
    let unregistered = false;
    const exits: number[] = [];
    let atSignal = -1;
    const d = deps(repo, stateDir, {
      onSignal: (fn) => {
        handler = fn;
        return () => {
          unregistered = true;
        };
      },
      exit: (code) => exits.push(code),
      runTest: async () => {
        handler?.('SIGINT');
        atSignal = worktreeCount(repo);
        return null;
      },
    });
    await runContention({ runs: 2, control: false }, d);
    expect(atSignal).toBe(1);
    expect(exits).toEqual([130, 130]);
    expect(unregistered).toBe(true);
    expect(d.out.join('\n')).toContain('interrupted by SIGINT');
  });
});

describe('the real process list, git and CLI entry', () => {
  it('registers and removes its signal handlers', () => {
    const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    const off = defaultOnSignal(() => {});
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before + 2);
    off();
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before);
  });
  it('reads a real process list that foreignVitest can vouch for', () => {
    const ps = defaultProcessList();
    expect(ps).not.toBeNull();
    expect(foreignVitest(ps ?? '', process.pid)).not.toBeNull();
  });
  it('reports a git failure outside a work tree', () => {
    expect(defaultGit(['rev-parse', '--show-toplevel'], tempDir('tw-contention-nogit-')).ok).toBe(false);
  });
  it('keeps its state under ~/.claude/state unless TEST_CONTENTION_DIR says otherwise', () => {
    expect(contentionStateDir({})).toMatch(/\.claude[\\/]state[\\/]test-contention$/);
    expect(contentionStateDir({ TEST_CONTENTION_DIR: '/x' })).toBe('/x');
  });
  it('exits 2 on a usage error without running anything', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    try {
      await cmdTestContention(['--runs', '1']);
      expect(process.exitCode).toBe(CONTENTION_EXIT.NO_VERDICT);
      expect(errSpy.mock.calls.flat().join('')).toContain('usage: ticket-workflow test-contention');
    } finally {
      process.exitCode = before;
      errSpy.mockRestore();
    }
  });
});

// The seam this ticket's evidence crosses: spawn args, per-run env, the reporter vitest loads, summarizeRun (tkt-b1182a02fb14).
describe('defaultRunTest over a real vitest run', () => {
  const LATE_REJECTION = [
    "import { it } from 'vitest';",
    "it('times out', async () => { setTimeout(() => { void Promise.reject(new TypeError('late boom')); }, 150); await new Promise(() => {}); }, 100);",
    "it('outlives the rejection', async () => { await new Promise((r) => setTimeout(r, 400)); });",
  ].join('\n');
  const TIMEOUT_ONLY = ["import { it } from 'vitest';", "it('times out', async () => { await new Promise(() => {}); }, 100);"].join('\n');

  async function realRun(test: string, config: object = {}, extra: Record<string, string> = {}): Promise<RunOutcome> {
    const repo = tempDir('tw-contention-vitest-');
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'v', private: true, type: 'module', scripts: { test: 'vitest run' } }));
    writeFileSync(path.join(repo, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: { include: ['a.t.mjs'], ...config } })};`);
    writeFileSync(path.join(repo, 'a.t.mjs'), test);
    for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(repo, name), text);
    symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(repo, 'node_modules'));
    const files = { reportFile: path.join(repo, 'r.json'), logFile: path.join(repo, 'r.log'), evidenceFile: path.join(repo, 'e.json') };
    const exitCode = await defaultRunTest({ cwd: repo, env: scrubbedEnv(), ...files });
    const read = (f: string): string | null => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    return summarizeRun({ index: 0, exitCode, report: read(files.reportFile), evidence: read(files.evidenceFile), log: read(files.logFile), roots: [repo, realpathSync(repo)] });
  }

  const REAL_RUN_MS = 60_000;
  it('sees the unhandled rejection the JSON report drops, so the timeout is not contention', { timeout: REAL_RUN_MS }, async () => {
    const r = await realRun(LATE_REJECTION);
    expect(r).toMatchObject({ kind: 'determined', exitCode: 1 });
    expect(contentionShaped([r])).toBe(false);
    expect(mixedTests([r])).toEqual(['a.t.mjs › <unhandled errors in the run: 1>']);
  });
  it('marks a timeout mixed when coverage thresholds are still checked after a failure', { timeout: REAL_RUN_MS }, async () => {
    const r = await realRun(TIMEOUT_ONLY, { coverage: { enabled: true, reportOnFailure: true, provider: 'v8', include: ['a.t.mjs'], thresholds: { lines: 1 } } });
    expect(mixedTests([r])).toEqual(['a.t.mjs › <coverage thresholds checked after the failure>']);
  });
  it('still reads a lone timeout as contention (control)', { timeout: REAL_RUN_MS }, async () => {
    const r = await realRun(TIMEOUT_ONLY);
    expect(r).toMatchObject({ kind: 'determined', exitCode: 1 });
    expect(contentionShaped([r])).toBe(true);
  });
  // Teardown runs in close(), after onTestRunEnd wrote the evidence: hold.ts's own failed release is this shape (tkt-e51870afd0da).
  it('sees a globalSetup teardown that sets the exit code after the evidence was written', { timeout: REAL_RUN_MS }, async () => {
    const r = await realRun(TIMEOUT_ONLY, { globalSetup: ['./gs.mjs'] }, { 'gs.mjs': "export default () => () => { process.exitCode = 1; throw new Error('late release'); };" });
    expect(r).toMatchObject({ kind: 'determined', exitCode: 1 });
    expect(contentionShaped([r])).toBe(false);
    expect(mixedTests([r])).toEqual(['a.t.mjs › <error during vitest close>', 'a.t.mjs › <globalSetup with an unobservable exit code: gs.mjs>']);
  });
  it('sees a globalSetup that only a project under a projects split declares', { timeout: REAL_RUN_MS }, async () => {
    const r = await realRun(TIMEOUT_ONLY, { projects: [{ test: { name: 'p', include: ['a.t.mjs'], globalSetup: ['./gs.mjs'] } }] }, { 'gs.mjs': 'export default () => () => {};' });
    expect(r).toMatchObject({ kind: 'determined', exitCode: 1 });
    expect(mixedTests([r])).toEqual(['a.t.mjs › <globalSetup with an unobservable exit code: gs.mjs>']);
  });
  it("still reads a lone timeout as contention when the only globalSetup is ticket-workflow's own (control)", { timeout: REAL_RUN_MS }, async () => {
    const own = fileURLToPath(new URL('../test-run/globalSetup.ts', import.meta.url));
    const r = await realRun(TIMEOUT_ONLY, { globalSetup: [own] });
    expect(r).toMatchObject({ kind: 'determined', exitCode: 1 });
    expect(contentionShaped([r])).toBe(true);
  });
  it('removes a leftover report and evidence file before the run, so a silent run cannot inherit them', async () => {
    const repo = tempDir('tw-contention-stale-');
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'v', private: true, scripts: { test: 'node noop.mjs' } }));
    writeFileSync(path.join(repo, 'noop.mjs'), '');
    const files = { reportFile: path.join(repo, 'r.json'), logFile: path.join(repo, 'r.log'), evidenceFile: path.join(repo, 'e.json') };
    writeFileSync(files.reportFile, report([{ name: path.join(repo, 'a.t.mjs'), failed: ['Error: STACK_TRACE_ERROR'] }]));
    writeFileSync(files.evidenceFile, CLEAN);
    expect(await defaultRunTest({ cwd: repo, env: scrubbedEnv(), ...files })).toBe(0);
    expect(existsSync(files.reportFile)).toBe(false);
    expect(existsSync(files.evidenceFile)).toBe(false);
  });
});
