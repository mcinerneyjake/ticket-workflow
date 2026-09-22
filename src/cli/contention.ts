import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRepoName } from '../test-run/hold.js';
import { provisionFailed, provisionWorktree } from '../worktree/provision.js';

// tkt-98cdd3b87020. The bounded arm's verdict needs a same-day red control: a green run on a machine
// that cannot show contention is not evidence the bound works.

export const CONTENTION_EXIT = { PASS: 0, FAIL: 1, NO_VERDICT: 2 } as const;

export type Arm = 'control' | 'bounded';

export interface ContentionArgs {
  readonly runs: number;
  readonly control: boolean;
}

export const CONTENTION_USAGE = 'usage: ticket-workflow test-contention [--runs <N>=4] [--control]';

export function parseContentionArgs(args: readonly string[]): ContentionArgs | { readonly error: string } {
  let runs = 4;
  let control = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--control') {
      control = true;
    } else if (a === '--runs') {
      const raw = args[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 2) return { error: `--runs needs an integer >= 2, got ${JSON.stringify(raw ?? null)}` };
      runs = n;
    } else {
      return { error: `unknown argument ${JSON.stringify(a)}` };
    }
  }
  return { runs, control };
}

// The vitest entrypoint and its fork/thread workers, by path; a bare `vitest` substring would also
// match any shell whose command text merely mentions the word.
const VITEST_PROCESS = /node_modules\/(?:\.bin\/vitest\b|vitest\/)/;

/**
 * Vitest processes in `ps -axo pid=,ppid=,command=` output that are not `own` or its descendants.
 * `null` when `own` is absent from the list: a list that cannot see this process cannot vouch for others.
 */
export function foreignVitest(psOutput: string, own: number): string[] | null {
  const rows = psOutput.split('\n').flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? '', line: l.trim() }] : [];
  });
  if (!rows.some((r) => r.pid === own)) return null;
  const ours = new Set([own]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (!ours.has(r.pid) && ours.has(r.ppid)) {
        ours.add(r.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => !ours.has(r.pid) && VITEST_PROCESS.test(r.cmd)).map((r) => r.line);
}

export interface FileFailure {
  readonly file: string;
  readonly failed: number;
  readonly timeouts: number;
}

export type RunOutcome =
  | { readonly kind: 'determined'; readonly index: number; readonly exitCode: number | null; readonly green: boolean; readonly files: readonly FileFailure[]; readonly slots: number | null }
  | { readonly kind: 'undetermined'; readonly index: number; readonly exitCode: number | null; readonly reason: string; readonly slots: number | null };

const TIMED_OUT = /timed out/i;

function isObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null;
}

/** Reads vitest's JSON reporter output. A string return is the reason it could not be read. */
export function parseReport(text: string, root: readonly string[]): { readonly success: boolean; readonly files: readonly FileFailure[] } | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'report is not JSON';
  }
  if (!isObject(raw) || !('success' in raw) || typeof raw.success !== 'boolean' || !('testResults' in raw) || !Array.isArray(raw.testResults)) {
    return 'report has no boolean `success` and `testResults` array';
  }
  const results: unknown[] = raw.testResults;
  const files: FileFailure[] = [];
  for (const tr of results) {
    if (!isObject(tr) || !('name' in tr) || typeof tr.name !== 'string' || !('status' in tr) || typeof tr.status !== 'string') {
      return 'report has a test file entry without a string `name` and `status`';
    }
    if (tr.status !== 'failed') continue;
    const assertions: unknown[] = 'assertionResults' in tr && Array.isArray(tr.assertionResults) ? tr.assertionResults : [];
    let failed = 0;
    let timeouts = 0;
    for (const a of assertions) {
      if (!isObject(a) || !('status' in a) || a.status !== 'failed') continue;
      failed++;
      const messages: unknown[] = 'failureMessages' in a && Array.isArray(a.failureMessages) ? a.failureMessages : [];
      if (messages.some((m) => typeof m === 'string' && TIMED_OUT.test(m))) timeouts++;
    }
    // A file can fail with no failing test: an import error, or a hook that timed out.
    if (failed === 0) {
      failed = 1;
      if ('message' in tr && typeof tr.message === 'string' && TIMED_OUT.test(tr.message)) timeouts = 1;
    }
    files.push({ file: relativeTo(tr.name, root), failed, timeouts });
  }
  return { success: raw.success, files };
}

function relativeTo(file: string, roots: readonly string[]): string {
  for (const r of roots) {
    const prefix = r.endsWith(path.sep) ? r : r + path.sep;
    if (file.startsWith(prefix)) return file.slice(prefix.length);
  }
  return file;
}

const SLOT_LINE = /\[test-run\] slot \d+\/(\d+)/;

export function slotBound(log: string): number | null {
  const m = SLOT_LINE.exec(log);
  return m ? Number(m[1]) : null;
}

export function summarizeRun(input: {
  readonly index: number;
  readonly exitCode: number | null;
  readonly report: string | null;
  readonly log: string;
  readonly roots: readonly string[];
}): RunOutcome {
  const { index, exitCode } = input;
  const slots = slotBound(input.log);
  if (input.report === null) {
    return { kind: 'undetermined', index, exitCode, slots, reason: `no JSON report (exit ${exitCode ?? 'signal'})` };
  }
  const parsed = parseReport(input.report, input.roots);
  if (typeof parsed === 'string') return { kind: 'undetermined', index, exitCode, slots, reason: parsed };
  // A non-zero exit with every file passing (a coverage threshold, a teardown error) is still red.
  const files =
    exitCode !== 0 && parsed.files.length === 0 ? [{ file: `<run exited ${exitCode ?? 'by signal'} with no failing file>`, failed: 1, timeouts: 0 }] : parsed.files;
  return { kind: 'determined', index, exitCode, slots, files, green: exitCode === 0 && parsed.success && files.length === 0 };
}

export interface TableRow {
  readonly file: string;
  readonly runsFailed: number;
  readonly timeouts: number;
}

export function aggregate(runs: readonly RunOutcome[]): TableRow[] {
  const byFile = new Map<string, { runsFailed: number; timeouts: number }>();
  for (const r of runs) {
    if (r.kind !== 'determined') continue;
    for (const f of r.files) {
      const row = byFile.get(f.file) ?? { runsFailed: 0, timeouts: 0 };
      row.runsFailed++;
      row.timeouts += f.timeouts;
      byFile.set(f.file, row);
    }
  }
  return [...byFile.entries()]
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.runsFailed - a.runsFailed || b.timeouts - a.timeouts || a.file.localeCompare(b.file));
}

export function formatTable(runs: readonly RunOutcome[]): string[] {
  const lines: string[] = [];
  for (const r of runs) {
    const slot = r.slots === null ? 'no slot' : `K=${r.slots}`;
    const state = r.kind === 'undetermined' ? `UNDETERMINED — ${r.reason}` : r.green ? 'green' : 'red';
    lines.push(`run ${r.index + 1}  exit ${r.exitCode ?? 'signal'}  ${slot}  ${state}`);
  }
  const rows = aggregate(runs);
  if (rows.length === 0) return lines;
  const width = Math.max(4, ...rows.map((r) => r.file.length));
  lines.push('', `${'file'.padEnd(width)}  failed  timeouts`);
  for (const r of rows) lines.push(`${r.file.padEnd(width)}  ${`${r.runsFailed}/${runs.length}`.padStart(6)}  ${String(r.timeouts).padStart(8)}`);
  return lines;
}

export type ArmResult = 'red' | 'green' | 'undetermined';

export function armResult(runs: readonly RunOutcome[]): ArmResult {
  // `every` is true on an empty list; zero runs must never read as green.
  if (runs.length === 0 || runs.some((r) => r.kind === 'undetermined')) return 'undetermined';
  return runs.every((r) => r.kind === 'determined' && r.green) ? 'green' : 'red';
}

/** Every failure a timeout — the contention signature. An assertion failure means HEAD is red on its own. */
export function contentionShaped(runs: readonly RunOutcome[]): boolean {
  const files = runs.flatMap((r) => (r.kind === 'determined' ? r.files : []));
  return files.length > 0 && files.every((f) => f.failed > 0 && f.timeouts === f.failed);
}

export interface HistoryEntry {
  readonly version: 1;
  readonly repo: string;
  readonly root: string;
  readonly arm: Arm;
  readonly runs: number;
  readonly day: string;
  readonly at: string;
  readonly head: string;
  readonly result: ArmResult;
}

export function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Malformed lines are skipped: a lost control record can only withhold a verdict, never grant one. */
export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      isObject(e) &&
      'version' in e && e.version === 1 &&
      'repo' in e && typeof e.repo === 'string' &&
      'root' in e && typeof e.root === 'string' &&
      'arm' in e && (e.arm === 'control' || e.arm === 'bounded') &&
      'runs' in e && typeof e.runs === 'number' &&
      'day' in e && typeof e.day === 'string' &&
      'at' in e && typeof e.at === 'string' &&
      'head' in e && typeof e.head === 'string' &&
      'result' in e && (e.result === 'red' || e.result === 'green' || e.result === 'undetermined')
    ) {
      out.push({ version: 1, repo: e.repo, root: e.root, arm: e.arm, runs: e.runs, day: e.day, at: e.at, head: e.head, result: e.result });
    }
  }
  return out;
}

/** `recorded` is what history keeps: only a control this function accepted is ever stored `red`. */
export type Decision = { readonly exit: number; readonly lines: readonly string[]; readonly recorded: ArmResult };

const noVerdict = (line: string): Decision => ({ exit: CONTENTION_EXIT.NO_VERDICT, lines: [line], recorded: 'undetermined' });

export function decide(input: {
  readonly arm: Arm;
  readonly runs: readonly RunOutcome[];
  readonly n: number;
  readonly root: string;
  readonly head: string;
  readonly today: string;
  readonly history: readonly HistoryEntry[];
  readonly contaminated: readonly string[];
}): Decision {
  const { runs, n } = input;
  if (input.contaminated.length > 0) {
    return noVerdict(`NO VERDICT: a foreign vitest ran during the arm, or the process list went unreadable:\n  ${input.contaminated.join('\n  ')}`);
  }
  const result = armResult(runs);
  if (result === 'undetermined') return noVerdict('NO VERDICT: at least one run produced no readable report — see its log.');
  const bounds = new Set(runs.map((r) => r.slots));
  if (input.arm === 'control') {
    if ([...bounds].some((k) => k !== null && k < n)) {
      return noVerdict(`NO VERDICT: a control run was still bounded (${[...bounds].join(', ')} < ${n}); TEST_SLOTS did not take effect.`);
    }
    if (result === 'green') {
      return {
        exit: CONTENTION_EXIT.NO_VERDICT,
        recorded: 'green',
        lines: [`CONTROL GREEN: ${n} unbounded runs did not collide, so this machine cannot show contention at N=${n} right now. Raise --runs, or retry under load.`],
      };
    }
    if (!contentionShaped(runs)) {
      return noVerdict('NO VERDICT: the control failed on something other than timeouts, so HEAD is red on its own — fix that first.');
    }
    return { exit: CONTENTION_EXIT.PASS, recorded: 'red', lines: [`CONTROL RED: contention reproduced at N=${n}. Now run the bounded arm: test-contention --runs ${n}`] };
  }

  const k = bounds.size === 1 ? [...bounds][0] : undefined;
  if (k === undefined || k === null) {
    return noVerdict('NO VERDICT: not every run held a test-run slot, so the bound was not in force. Is holdTestRun wired in this repo’s vitest config?');
  }
  if (k >= n) return noVerdict(`NO VERDICT: K=${k} slots admit all ${n} runs at once, so nothing was bounded.`);
  // Same checkout and same commit: a control at another HEAD measured different code.
  const control = input.history.find(
    (h) => h.arm === 'control' && h.root === input.root && h.head === input.head && h.runs === n && h.day === input.today && h.result === 'red',
  );
  if (control === undefined) {
    return {
      exit: CONTENTION_EXIT.NO_VERDICT,
      recorded: result,
      lines: [`NO VERDICT: no control arm at N=${n} for this checkout at ${input.head.slice(0, 7)} went red today (${input.today}). Run test-contention --runs ${n} --control first.`],
    };
  }
  const against = `against control red at ${control.at}`;
  return result === 'green'
    ? { exit: CONTENTION_EXIT.PASS, recorded: result, lines: [`PASS: ${n} runs green at K=${k}, ${against}.`] }
    : { exit: CONTENTION_EXIT.FAIL, recorded: result, lines: [`FAIL: runs still failed at K=${k}, ${against}.`] };
}

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type Signal = 'SIGINT' | 'SIGTERM';

export interface ContentionDeps {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tmpRoot: string;
  readonly stateDir: string;
  readonly pid: number;
  readonly pollMs: number;
  readonly now: () => Date;
  readonly git: (args: readonly string[], cwd: string) => GitResult;
  /** `null` when the process list cannot be read — which refuses the run, never passes it. */
  readonly processList: () => string | null;
  readonly runTest: (opts: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly reportFile: string; readonly logFile: string }) => Promise<number | null>;
  /** Registers `fn` for the signals; returns the unregister. */
  readonly onSignal: (fn: (signal: Signal) => void) => () => void;
  readonly exit: (code: number) => void;
  readonly log: (line: string) => void;
  readonly err: (line: string) => void;
}

export function contentionStateDir(env: NodeJS.ProcessEnv): string {
  return env.TEST_CONTENTION_DIR ?? path.join(homedir(), '.claude', 'state', 'test-contention');
}

export function defaultGit(args: readonly string[], cwd: string): GitResult {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0 && r.error === undefined, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
}

export function defaultProcessList(): string | null {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return r.status === 0 && r.error === undefined ? r.stdout : null;
}

export function defaultOnSignal(fn: (signal: Signal) => void): () => void {
  const onInt = (): void => fn('SIGINT');
  const onTerm = (): void => fn('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}

export function defaultRunTest(opts: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly reportFile: string; readonly logFile: string }): Promise<number | null> {
  return new Promise((resolve) => {
    const fd = openSync(opts.logFile, 'a');
    const child = spawn('npm', ['test', '--', '--reporter=json', `--outputFile=${opts.reportFile}`], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', fd, fd] });
    const done = (code: number | null): void => {
      closeSync(fd);
      resolve(code);
    };
    // Without an 'error' listener a spawn failure also loses 'close', and the run would never settle.
    child.once('error', (e) => {
      appendFileSync(opts.logFile, `\n[test-contention] spawn failed: ${e.message}\n`);
      done(null);
    });
    child.once('close', (code) => done(code));
  });
}

function removeWorktree(deps: ContentionDeps, root: string, dir: string): boolean {
  const link = path.join(dir, 'node_modules');
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    // no link to remove
  }
  // --force: a run may leave untracked output (coverage/, reports) in a tree nobody else owns.
  if (deps.git(['worktree', 'remove', '--force', dir], root).ok) return true;
  rmSync(dir, { recursive: true, force: true });
  return deps.git(['worktree', 'prune'], root).ok && !existsSync(dir);
}

function provision(root: string, dir: string, modules: string): void {
  const outcome = provisionWorktree({ repoDir: root, worktreeDir: dir });
  if (provisionFailed(outcome)) {
    const why = outcome.kind === 'refused' ? outcome.reason : outcome.entries.flatMap((e) => (e.kind === 'failed' ? [`${e.path}: ${e.reason}`] : [])).join('; ');
    throw new Error(`could not provision ${dir}: ${why}`);
  }
  try {
    lstatSync(path.join(dir, 'node_modules'));
  } catch {
    symlinkSync(modules, path.join(dir, 'node_modules'));
  }
}

export async function runContention(args: ContentionArgs, deps: ContentionDeps): Promise<number> {
  const top = deps.git(['rev-parse', '--show-toplevel'], deps.cwd);
  if (!top.ok) {
    deps.err(`refused: ${deps.cwd} is not inside a git work tree`);
    return CONTENTION_EXIT.NO_VERDICT;
  }
  const root = top.stdout.trim();
  const ps = deps.processList();
  const foreign = ps === null ? null : foreignVitest(ps, deps.pid);
  if (foreign === null) {
    deps.err('refused: could not read the process list, so a foreign vitest run cannot be ruled out');
    return CONTENTION_EXIT.NO_VERDICT;
  }
  if (foreign.length > 0) {
    deps.err(`refused: vitest is already running, which would contaminate both arms:\n  ${foreign.join('\n  ')}`);
    return CONTENTION_EXIT.NO_VERDICT;
  }
  const modules = path.join(root, 'node_modules');
  if (!existsSync(modules)) {
    deps.err(`refused: ${modules} does not exist; run npm ci first`);
    return CONTENTION_EXIT.NO_VERDICT;
  }
  const rev = deps.git(['rev-parse', 'HEAD'], root);
  if (!rev.ok) {
    deps.err('refused: could not resolve HEAD');
    return CONTENTION_EXIT.NO_VERDICT;
  }
  const head = rev.stdout.trim();
  if (deps.git(['status', '--porcelain', '--untracked-files=no'], root).stdout.trim() !== '') {
    deps.log('note: uncommitted changes are NOT in the runs — each worktree is a checkout of HEAD');
  }

  const arm: Arm = args.control ? 'control' : 'bounded';
  const repo = defaultRepoName(root);
  const started = deps.now();
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const artifacts = path.join(deps.stateDir, 'runs', `${repo}-${stamp}-${arm}`);
  mkdirSync(artifacts, { recursive: true });
  const base = mkdtempSync(path.join(deps.tmpRoot, `${repo}-contention-`));
  const trees: string[] = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    const stranded = trees.filter((dir) => !removeWorktree(deps, root, dir));
    rmSync(base, { recursive: true, force: true });
    for (const dir of stranded) deps.err(`WARNING: could not remove worktree ${dir}; \`git worktree prune\` after deleting it`);
  };
  const unregister = deps.onSignal((signal) => {
    cleanup();
    deps.err(`test-contention: interrupted by ${signal}; worktrees removed, nothing recorded`);
    deps.exit(signal === 'SIGINT' ? 130 : 143);
  });
  const contaminated = new Set<string>();
  const watch = (): void => {
    const list = deps.processList();
    const found = list === null ? null : foreignVitest(list, deps.pid);
    if (found === null) contaminated.add('(process list unreadable)');
    else for (const line of found) contaminated.add(line);
  };
  let outcomes: RunOutcome[];
  try {
    for (let i = 0; i < args.runs; i++) {
      const dir = path.join(base, `run-${i + 1}`);
      // The resolved sha, not `HEAD`: a concurrent commit must not split the runs across two commits.
      const added = deps.git(['worktree', 'add', '--detach', dir, head], root);
      if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr.trim()}`);
      trees.push(dir);
      provision(root, dir, modules);
    }
    // Queued runs wait up to ceil(N/K) suite durations; the helper's 10-minute default would refuse them.
    const env: NodeJS.ProcessEnv = { ...deps.env, TEST_SLOTS_WAIT_MS: deps.env.TEST_SLOTS_WAIT_MS ?? String(args.runs * 30 * 60_000) };
    if (args.control) env.TEST_SLOTS = String(args.runs);
    deps.log(`${arm} arm: ${args.runs} concurrent npm test runs of ${head.slice(0, 7)} (logs: ${artifacts})`);
    const timer = setInterval(watch, deps.pollMs);
    let exits: (number | null)[];
    try {
      exits = await Promise.all(
        trees.map((dir, i) =>
          deps.runTest({ cwd: dir, env, reportFile: path.join(artifacts, `run-${i + 1}.json`), logFile: path.join(artifacts, `run-${i + 1}.log`) }),
        ),
      );
    } finally {
      clearInterval(timer);
    }
    watch();
    outcomes = trees.map((dir, i) => {
      const read = (f: string): string | null => {
        try {
          return readFileSync(f, 'utf8');
        } catch {
          return null;
        }
      };
      let real = dir;
      try {
        real = realpathSync(dir);
      } catch {
        // keep the given path
      }
      return summarizeRun({
        index: i,
        exitCode: exits[i] ?? null,
        report: read(path.join(artifacts, `run-${i + 1}.json`)),
        log: read(path.join(artifacts, `run-${i + 1}.log`)) ?? '',
        roots: [dir, real],
      });
    });
  } finally {
    unregister();
    cleanup();
  }

  for (const line of formatTable(outcomes)) deps.log(line);
  const historyFile = path.join(deps.stateDir, 'history.jsonl');
  const history = existsSync(historyFile) ? parseHistory(readFileSync(historyFile, 'utf8')) : [];
  const today = localDay(started);
  const decision = decide({ arm, runs: outcomes, n: args.runs, root, head, today, history, contaminated: [...contaminated] });
  const entry: HistoryEntry = { version: 1, repo, root, arm, runs: args.runs, day: today, at: started.toISOString(), head, result: decision.recorded };
  appendFileSync(historyFile, `${JSON.stringify(entry)}\n`);
  deps.log('');
  for (const line of decision.lines) deps.log(line);
  return decision.exit;
}

export async function cmdTestContention(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const parsed = parseContentionArgs(args);
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${CONTENTION_USAGE}`);
    process.exitCode = CONTENTION_EXIT.NO_VERDICT;
    return;
  }
  try {
    process.exitCode = await runContention(parsed, {
      cwd: process.cwd(),
      env,
      tmpRoot: tmpdir(),
      stateDir: contentionStateDir(env),
      pid: process.pid,
      pollMs: 5_000,
      now: () => new Date(),
      git: defaultGit,
      processList: defaultProcessList,
      runTest: defaultRunTest,
      onSignal: defaultOnSignal,
      exit: (code) => process.exit(code),
      log: (l) => console.log(l),
      err: (l) => console.error(l),
    });
  } catch (e) {
    // Exit 1 means FAIL here; a probe that broke has no verdict to give.
    console.error(`test-contention: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = CONTENTION_EXIT.NO_VERDICT;
  }
}
