import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { appendEvent } from '../server/events.js';
import { errnoCode } from '../server/tickets.js';
import { ticketsDir } from '../paths.js';
import { type TestCounts } from '../shared/constants.js';

export const GATE_STEPS = ['typecheck', 'lint', 'test'] as const;
export type GateStep = (typeof GATE_STEPS)[number]

export const GATE_EXIT = { OK: 0, GATE_FAILED: 1, NOT_CHECKED: 2, RECORD_FAILED: 3 } as const;

// Read by `gate` alone, so pointing it at a central board never leaks into the suites it runs — an
// exported BOARD_DIR_OVERRIDE would aim every consumer test that sets only TICKETS_DIR_OVERRIDE at it.
export const GATE_BOARD_ENV = 'TICKET_WORKFLOW_BOARD_DIR';
const BOARD_ENV = [GATE_BOARD_ENV, 'BOARD_DIR_OVERRIDE', 'TICKETS_DIR_OVERRIDE', 'EVENTS_DIR_OVERRIDE', 'CLAUDE_PROJECT_DIR'];

export interface ScriptRun {
  exitCode: number | null
  /** The `Tests` summary lines only; the rest of the output is streamed, never held. */
  summaries: string[]
  durationMs: number
  /** Set when the script never ran, so its outcome is unknown rather than failed. */
  startError?: string
}
export type RunScript = (step: GateStep) => Promise<ScriptRun>
export type Append = typeof appendEvent

export type Recording =
  | { kind: 'record'; ticketId: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'error'; reason: string }

// Git exports repo context into hook environments, and a suite driving temp repos then acts on the
// REAL repo. Asked of git itself so a variable git adds is covered; the fallback is its 2.4x list.
const FALLBACK_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

export function gitLocalEnvVars(): string[] {
  try {
    const out = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set([...out.split('\n').filter(Boolean), ...FALLBACK_GIT_ENV])];
  } catch {
    return FALLBACK_GIT_ENV;
  }
}

export function childEnv(env: NodeJS.ProcessEnv, gitVars: readonly string[] = gitLocalEnvVars()): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const v of [...gitVars, ...BOARD_ENV]) delete out[v];
  return out;
}

const SUMMARY_RE = /^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/;
const FILES_RE = /^\s*Test Files\s/;
const PART_RE = /^(\d+) (passed|failed|skipped|todo|expected fail)$/;

// Summed across every run a chained script makes. A line counts only when every part is a known
// category and the parts add up to vitest's own total — otherwise it is not a summary we understand.
export function parseTestCounts(lines: readonly string[]): TestCounts | null {
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0 };
  let found = false;
  for (const raw of lines) {
    const m = SUMMARY_RE.exec(stripVTControlCharacters(raw));
    if (!m) continue;
    const line: TestCounts = { passed: 0, failed: 0, skipped: 0 };
    let sum = 0;
    let understood = true;
    for (const part of m[1].split('|')) {
      const p = PART_RE.exec(part.trim());
      if (!p) { understood = false; break; }
      const n = Number(p[1]);
      sum += n;
      if (p[2] === 'passed' || p[2] === 'expected fail') line.passed += n;
      else if (p[2] === 'failed') line.failed += n;
      else line.skipped += n;
    }
    if (!understood || sum !== Number(m[2])) continue;
    found = true;
    counts.passed += line.passed;
    counts.failed += line.failed;
    counts.skipped += line.skipped;
  }
  return found ? counts : null;
}

export function currentBranch(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Bounded on both sides, so a 13-hex typo never resolves to a real 12-hex ticket; two different ids
// name no single ticket.
export function ticketIdFromBranch(branch: string): string | null {
  const ids = new Set([...branch.matchAll(/(?<![0-9a-f])tkt-[0-9a-f]{12}(?![0-9a-f])/g)].map((m) => m[0]));
  return ids.size === 1 ? [...ids][0] : null;
}

// Writes only where the board demonstrably holds the ticket: from a shell or a git hook the board
// env is usually unset, and the cwd fallback would otherwise land the events in a wrong board.
export async function resolveRecording(branch: string | null): Promise<Recording> {
  if (branch === null) return { kind: 'skip', reason: 'could not read the current branch' };
  const id = ticketIdFromBranch(branch);
  if (!id) return { kind: 'skip', reason: `branch ${branch} names no single ticket` };
  const env = process.env;
  const overrides = [env.TICKETS_DIR_OVERRIDE, env.EVENTS_DIR_OVERRIDE].filter(Boolean).length;
  // Misconfigurations, not absences — so they fail rather than skip: one override alone splits the
  // check from the write, and the gate-only board would be silently outranked by the overrides.
  if (overrides === 1) return { kind: 'error', reason: 'only one of TICKETS_DIR_OVERRIDE and EVENTS_DIR_OVERRIDE is set, so the check and the write would hit different boards' };
  if (env[GATE_BOARD_ENV] && overrides > 0) return { kind: 'error', reason: `${GATE_BOARD_ENV} is set but TICKETS_DIR_OVERRIDE/EVENTS_DIR_OVERRIDE would override it` };
  const explicit = Boolean(env[GATE_BOARD_ENV] || env.BOARD_DIR_OVERRIDE || overrides === 2);
  const dir = ticketsDir();
  try {
    if (!(await fs.stat(dir)).isDirectory()) return absent(`${dir} is not a directory`, explicit);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return absent(`no tickets directory at ${dir}`, explicit);
    return { kind: 'error', reason: `could not check ${dir}${code ? ` (${code})` : ''}` };
  }
  const file = path.join(dir, `${id}.md`);
  try {
    if ((await fs.stat(file)).isFile()) return { kind: 'record', ticketId: id };
    return { kind: 'error', reason: `${file} is not a file` };
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return { kind: 'skip', reason: `${id} is not on the board at ${dir}` };
    return { kind: 'error', reason: `could not check ${file}${code ? ` (${code})` : ''}` };
  }
}

// No board is normal for a repo that never configured one; a configured board that is not there is
// a typo that would otherwise silently record nothing forever.
function absent(what: string, explicit: boolean): Recording {
  return explicit
    ? { kind: 'error', reason: `the configured board has ${what}` }
    : { kind: 'skip', reason: `${what} — set ${GATE_BOARD_ENV} to the board's root` };
}

// Collects complete `Tests` lines from a stream, only directly after vitest's `Test Files` line so a
// test echoing a summary-shaped line is not counted. StringDecoder keeps split UTF-8 intact.
const MAX_PENDING = 64 * 1024;
function summaryCollector(into: string[]) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let afterFiles = false;
  const take = (text: string) => {
    const lines = (pending + text).split('\n');
    pending = (lines.pop() ?? '').slice(-MAX_PENDING);
    for (const l of lines) {
      const plain = stripVTControlCharacters(l);
      if (!plain.trim()) continue;
      if (afterFiles && SUMMARY_RE.test(plain)) into.push(l);
      afterFiles = FILES_RE.test(plain);
    }
  };
  return { write: (c: Buffer) => take(decoder.write(c)), end: () => { take(decoder.end()); take('\n'); } };
}

const DRAIN_MS = 2000;

export function spawnScript(cwd: string): RunScript {
  const env = childEnv(process.env);
  return (step) => new Promise((resolve) => {
    const started = performance.now();
    const summaries: string[] = [];
    const out = summaryCollector(summaries);
    const err = summaryCollector(summaries);
    // stdin ignored: an inherited TTY puts a bare `vitest` script into watch mode, which never exits.
    const child = spawn('npm', ['run', step], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c: Buffer) => { process.stdout.write(c); out.write(c); });
    child.stderr.on('data', (c: Buffer) => { process.stderr.write(c); err.write(c); });
    // Both listeners: without 'error' a spawn failure never emits 'close' and the gate hangs.
    child.on('error', (e) => resolve({ exitCode: null, summaries: [], durationMs: performance.now() - started, startError: e.message }));
    // 'close' waits for every holder of the pipes, so a script leaving a background process behind
    // would never close; npm's own 'exit' decides, with a grace period to drain what it printed.
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      out.end();
      err.end();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode: code, summaries, durationMs: performance.now() - started });
    };
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => { setTimeout(() => finish(code), DRAIN_MS).unref(); });
  });
}

function describeRun(step: GateStep, run: ScriptRun, tests: TestCounts | null): string {
  const exit = run.exitCode === null ? 'killed' : `exit ${run.exitCode}`;
  const counts = tests ? `, ${tests.passed} passed · ${tests.failed} failed · ${tests.skipped} skipped` : '';
  return `gate: ${step} ${run.exitCode === 0 ? 'passed' : 'FAILED'} (${exit}, ${(run.durationMs / 1000).toFixed(1)}s${counts})`;
}

export interface GateOptions {
  scripts: ReadonlySet<string>
  recording: Recording
  run: RunScript
  append?: Append
  print?: (line: string) => void
}

// Runs every defined gate even after one fails: a step skipped after a failure would leave its
// previous `passed` row as the latest, vouching for code that was never checked.
export async function runGate(opts: GateOptions): Promise<number> {
  const { scripts, recording, run, append = appendEvent, print = console.log } = opts;
  const defined = GATE_STEPS.filter((s) => scripts.has(s));
  for (const s of GATE_STEPS) if (!scripts.has(s)) print(`gate: ${s} — no "${s}" script defined, not run`);
  if (defined.length === 0) {
    print('gate: no gate scripts defined — nothing was checked');
    return GATE_EXIT.NOT_CHECKED;
  }

  if (recording.kind === 'record') print(`gate: recording results on ${recording.ticketId}`);
  else print(`gate: NOT RECORDED — ${recording.reason}`);

  let recordFailed = recording.kind === 'error';
  let notStarted = false;
  let failed = false;
  for (const step of defined) {
    const result = await run(step);
    const tests = step === 'test' ? parseTestCounts(result.summaries) : null;
    // Unattributed, not skipped: writing nothing would leave an earlier `passed` row as the latest.
    let state: 'passed' | 'failed' | 'unattributed';
    if (result.startError !== undefined) {
      notStarted = true;
      state = 'unattributed';
      print(`gate: ${step} could not be started, outcome unknown — ${result.startError}`);
    } else {
      // An exit 0 over a summary reporting failures (`vitest run || true`) is not a pass.
      state = result.exitCode === 0 && !(tests && tests.failed > 0) ? 'passed' : 'failed';
      if (state === 'failed') failed = true;
      print(describeRun(step, result, tests));
    }
    if (recording.kind !== 'record') continue;
    try {
      await append({
        ticketId: recording.ticketId,
        step,
        state,
        outcomeFrom: 'event',
        ...(result.startError === undefined ? { durationMs: Math.round(result.durationMs) } : {}),
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        ...(tests ? { tests } : {}),
      });
    } catch (err) {
      recordFailed = true;
      print(`gate: NOT RECORDED — ${step} could not be appended: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Ranked by how invisible each is downstream: a lost record, then a gate that never ran, then a
  // failure whose own output already printed.
  if (recordFailed) return GATE_EXIT.RECORD_FAILED;
  if (notStarted) return GATE_EXIT.NOT_CHECKED;
  return failed ? GATE_EXIT.GATE_FAILED : GATE_EXIT.OK;
}

export async function readScripts(cwd: string): Promise<ReadonlySet<string>> {
  const file = path.join(cwd, 'package.json');
  const pkg: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('scripts' in pkg)) return new Set();
  const { scripts } = pkg;
  return typeof scripts === 'object' && scripts !== null ? new Set(Object.keys(scripts)) : new Set();
}

// The gate-only board var wins, and is applied to this process alone (childEnv strips it).
export function applyGateBoard(env: NodeJS.ProcessEnv = process.env): void {
  const board = env[GATE_BOARD_ENV];
  if (board) env.BOARD_DIR_OVERRIDE = board;
}
