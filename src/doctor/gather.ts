/**
 * Machine-wiring diagnostics — the IMPURE half (tkt-1baab0ae07f4).
 *
 * Every read here is best-effort and every failure becomes a `null` fact, because `checks.ts` turns
 * a null into UNKNOWN rather than a green. Nothing in this file may throw: doctor must still run on
 * a machine with no ~/.claude at all, which is exactly the CI case its UNKNOWNs exist to describe.
 *
 * It reads MACHINE-LOCAL config (settings.json, .claude.json) and, where present, the settings of
 * the repo it was run from. It requires no repository file — every repo-scoped read degrades to
 * UNKNOWN, so the command runs from anywhere.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveBoardRoot } from '../paths.js';
import { HOOK_ONLY_STEPS, type DoctorFacts, type PostToolUseHook, type WiredHook } from './checks.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function sha(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Settings files
// ---------------------------------------------------------------------------------------------

interface HookEntry {
  readonly event: string;
  readonly command: string;
  readonly source: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : null;
}

/** Flatten a settings file's `hooks` map to one row per wired command. */
function hookEntries(settings: unknown, source: string): HookEntry[] {
  const root = asRecord(settings);
  const hooks = root ? asRecord(root.hooks) : null;
  if (!hooks) return [];
  const out: HookEntry[] = [];
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const m = asRecord(matcher);
      const list = m && Array.isArray(m.hooks) ? m.hooks : [];
      for (const entry of list) {
        const e = asRecord(entry);
        if (e && typeof e.command === 'string') out.push({ event, command: e.command, source });
      }
    }
  }
  return out;
}

/**
 * Where a session running in `cwd` loads project settings from.
 *
 * The REPO ROOT, not the cwd: Claude Code resolves project scope from the project root, so reading
 * `cwd/.claude` makes every run from a subdirectory blind to project-scope wiring — and because
 * user scope still answers, the result is not UNKNOWN but a confident wrong OK. A second writer
 * wired at project scope would read as "exactly one", which is the one defect this must not miss.
 *
 * The git root wins over CLAUDE_PROJECT_DIR: doctor's promise is that it diagnoses the repo you run
 * it from, and inside a session that variable names the SESSION's project, so preferring it would
 * silently report on a different repo than the one in the prompt.
 */
function projectRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  return git(['rev-parse', '--show-toplevel'], cwd) ?? env.CLAUDE_PROJECT_DIR ?? cwd;
}

/** Settings files that apply to a session running in `cwd`, most-global first. */
function settingsFiles(home: string, root: string): { file: string; label: string }[] {
  return [
    { file: path.join(home, '.claude', 'settings.json'), label: 'user scope' },
    { file: path.join(root, '.claude', 'settings.json'), label: 'project scope' },
    { file: path.join(root, '.claude', 'settings.local.json'), label: 'local scope' },
  ];
}

// ---------------------------------------------------------------------------------------------
// Hook command → the file it actually runs
// ---------------------------------------------------------------------------------------------

/**
 * The hooks this package ships, READ from the shipped directory rather than listed here.
 *
 * A transcribed list is the drift this command exists to find, one level up: a hook added upstream
 * would keep passing the wiring check by being invisible to it. Null when the directory cannot be
 * read, which becomes UNKNOWN rather than an empty — and therefore clean — list.
 */
function shippedHooks(): string[] | null {
  try {
    return fs
      .readdirSync(path.join(PKG_ROOT, 'hooks'))
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .map((f) => f.replace(/\.mjs$/, ''));
  } catch {
    return null;
  }
}

/** Expand the variables Claude Code substitutes into a hook command before running it. */
function expand(text: string, home: string, cwd: string): string {
  return text
    .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, cwd)
    .replace(/\$\{?HOME\}?/g, home)
    .replace(/(^|\s)~\//g, `$1${home}/`);
}

const SCRIPT_EXT = /\.(mjs|cjs|js|sh|bash|zsh|py)$/;

/**
 * The file a hook command actually runs.
 *
 * Script-like tokens are preferred over merely-existing ones, because the FIRST existing path in
 * `/usr/bin/env node …/run-hook.mjs guard-bash closed` is `/usr/bin/env` — which then gets hashed as
 * the wired hook and reported as a drifted vendored copy on perfectly correct wiring.
 */
function commandTarget(command: string, home: string, cwd: string): string | null {
  const tokens = expand(command, home, cwd)
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t.includes('/'));
  const isFile = (t: string): boolean => {
    try {
      return fs.statSync(t).isFile();
    } catch {
      return false;
    }
  };
  return tokens.find((t) => SCRIPT_EXT.test(t) && isFile(t)) ?? tokens.find(isFile) ?? null;
}

/**
 * Which shipped hook a wired command ultimately runs, or null when it names none.
 *
 * Matched against the command text AND, for a shell wrapper, the script's contents — the machine's
 * telemetry writer is a one-line `.sh` that execs the launcher, so stopping at the `.sh` would
 * classify the real writer as unrecognised.
 */
function hookName(command: string, target: string | null, shipped: readonly string[]): string | null {
  // The command alone for a .mjs target: a launcher's own source names the hook only through a
  // template literal, so reading it would match nothing while the command says exactly which hook.
  const text = target && /\.(sh|bash|zsh)$/.test(target) ? resolvedText(command, target) : command;
  const viaLauncher = /run-hook\.mjs\s+(\S+)/.exec(text);
  if (viaLauncher && shipped.includes(viaLauncher[1])) return viaLauncher[1];
  return shipped.find((h) => text.includes(`${h}.mjs`)) ?? null;
}

/**
 * The command text PLUS the file it runs — one level deep, and always both.
 *
 * Returning only the file's contents for a non-shell target loses everything the command itself
 * says: a writer wired inline as `BOARD_DIR_OVERRIDE=/board node …/run-hook.mjs track-steps open`
 * has its board root in the command, not in `run-hook.mjs`, so dropping it silently yielded no board
 * target at all and fell back to cwd.
 */
function resolvedText(command: string, target: string | null): string {
  if (!target) return command;
  try {
    return `${command}\n${fs.readFileSync(target, 'utf8')}`;
  } catch {
    return command;
  }
}

/**
 * A launcher delegates to the installed package; a vendored copy carries the hook's own source.
 *
 * Both spellings count, and the second is not hypothetical: the machine's telemetry writer is a
 * one-line `.sh` that execs `run-hook.mjs`, which the bare-specifier test alone classified as a
 * vendored copy and then reported as drifted against a hook it does not contain.
 */
function isLauncher(command: string, target: string | null): boolean {
  const text = resolvedText(command, target);
  return text.includes('ticket-workflow/hooks/') || /run-hook\.mjs\s+\S+/.test(text);
}

/** A board root pinned into a hook's own wiring, e.g. `BOARD_DIR_OVERRIDE=/path exec node …`. */
function boardOverrideIn(text: string): string | null {
  const m = /BOARD_DIR_OVERRIDE=["']?([^"'\s]+)/.exec(text);
  return m ? m[1] : null;
}

/** Walk up from a launcher to the ticket-workflow install its bare specifier would resolve to. */
function installRootFor(file: string): { root: string; version: string | null } | null {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    const pkg = path.join(dir, 'node_modules', 'ticket-workflow', 'package.json');
    if (fs.existsSync(pkg)) {
      const json = asRecord(readJson(pkg));
      return { root: dir, version: typeof json?.version === 'string' ? json.version : null };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------

interface McpFact {
  probed: boolean;
  configured: boolean;
  resolved: boolean;
  version: string | null;
  /** Board root pinned in the server's env, so it can be compared with the writer's. */
  boardRoot: string | null;
}

/**
 * Start the configured MCP server and ask it to `initialize`.
 *
 * This deliberately does NOT claim to observe a running server — a session's server is not visible
 * from here. It answers the weaker, checkable question: would a new session's server start and
 * speak? A timeout resolves to `resolved: false`, which is a MISMATCH, not a silent pass.
 */
async function probeMcp(home: string, root: string, timeoutMs = 8000): Promise<McpFact | null> {
  const config = asRecord(readJson(path.join(home, '.claude.json')));
  const projectConfig = asRecord(readJson(path.join(root, '.mcp.json')));
  if (!config && !projectConfig) return null;
  // Three places a server can be declared, and a session sees all of them. Reading only the first
  // reports a correctly-wired repo as having no server — which --strict turns into a gate failure.
  const perProject = config ? asRecord(asRecord(config.projects)?.[root]) : null;
  const servers = [
    asRecord(projectConfig?.mcpServers),
    asRecord(perProject?.mcpServers),
    config ? asRecord(config.mcpServers) : null,
  ];
  const absent: McpFact = { probed: true, configured: false, resolved: false, version: null, boardRoot: null };

  const entry = servers
    .filter((s): s is Record<string, unknown> => s !== null)
    .flatMap((s) => Object.values(s))
    .map(asRecord)
    .find((s) => s !== null && JSON.stringify(s).includes('ticket-workflow'));
  const command = entry?.command;
  if (!entry || typeof command !== 'string') return absent;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
  const env = asRecord(entry.env) ?? {};
  const extraEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') extraEnv[k] = v;
  const boardRoot = extraEnv.BOARD_DIR_OVERRIDE ?? null;
  const dead: McpFact = { probed: true, configured: true, resolved: false, version: null, boardRoot };

  return new Promise<McpFact>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...extraEnv },
      });
    } catch {
      resolve(dead);
      return;
    }
    let settled = false;
    let buffer = '';
    const done = (fact: McpFact): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(fact);
    };
    const timer = setTimeout(() => done(dead), timeoutMs);
    // A spawn that fails emits 'error', never 'exit'; with no listener the promise would hang until
    // the timeout and report a working server as merely slow.
    child.on('error', () => done(dead));
    // 'close', not 'exit': exit fires before stdio has drained, so a server that answers and then
    // exits would be settled as dead while its reply sat unread in the pipe.
    child.on('close', () => done(dead));
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n')) {
        const body = asRecord(readJsonText(line));
        const result = body ? asRecord(body.result) : null;
        const info = result ? asRecord(result.serverInfo) : null;
        if (info) {
          done({ probed: true, configured: true, resolved: true, version: typeof info.version === 'string' ? info.version : null, boardRoot });
        }
      }
    });
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ticket-workflow-doctor', version: '0' },
        },
      })}\n`,
    );
  });
}

function readJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

type ProtectedBranches = (cwd: string) => string[] | null
type HasRemote = (cwd: string) => boolean

function asProtectedBranches(mod: unknown): ProtectedBranches | null {
  const rec = asRecord(mod);
  const fn = rec?.protectedBranches;
  if (typeof fn !== 'function') return null;
  return (dir: string) => {
    const out: unknown = fn(dir);
    if (out === null) return null;
    return Array.isArray(out) ? out.filter((b): b is string => typeof b === 'string') : [];
  };
}

function asHasRemote(mod: unknown): HasRemote | null {
  const fn = asRecord(mod)?.hasRemote;
  if (typeof fn !== 'function') return null;
  return (dir: string) => fn(dir) === true;
}

async function gitFacts(cwd: string): Promise<DoctorFacts['protectedBranch']> {
  // The guard's OWN resolver, imported rather than reimplemented: a second ladder here would
  // eventually disagree with the one that decides, and report on a repo the guard treats differently.
  let protectedBranches: ProtectedBranches | null;
  let hasRemote: HasRemote | null;
  try {
    const mod: unknown = await import(
      pathToFileURL(path.join(PKG_ROOT, 'hooks', 'lib', 'default-branch.mjs')).href
    );
    protectedBranches = asProtectedBranches(mod);
    hasRemote = asHasRemote(mod);
  } catch {
    return null;
  }
  if (!protectedBranches || !hasRemote) return null;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (current === null) return null; // not a git repo
  const protects = protectedBranches(cwd);
  const existing = (protects ?? []).filter(
    (b) =>
      git(['rev-parse', '--verify', '--quiet', `${b}^{commit}`], cwd) !== null ||
      git(['rev-parse', '--verify', '--quiet', `origin/${b}^{commit}`], cwd) !== null,
  );
  // Read from the guard's own helper: guard-bash gates its commit rule on this, so a report that
  // omits it names a branch as protected while commits on it are allowed.
  return { current, protects, existing, hasRemote: hasRemote(cwd) };
}

function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/**
 * The newest event written by a step ONLY the hook can produce.
 *
 * Reads the whole board's logs rather than one ticket's: liveness is a property of the machine's
 * writer, not of whatever ticket happens to be open.
 */
async function lastHookEvent(eventsDir: string): Promise<string | null> {
  let files: string[];
  try {
    files = (await fsp.readdir(eventsDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let latest: string | null = null;
  for (const file of files) {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(eventsDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const rec = asRecord(readJsonText(line));
      if (!rec || typeof rec.step !== 'string' || typeof rec.at !== 'string') continue;
      if (!HOOK_ONLY_STEPS.some((s) => s === rec.step)) continue;
      if (latest === null || rec.at > latest) latest = rec.at;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------

export interface GatherOptions {
  readonly home?: string;
  readonly cwd?: string;
  readonly now?: string;
  readonly probeMcpServer?: boolean;
  /** Injectable so a test can drive a fixture machine free of the session's own variables. */
  readonly env?: NodeJS.ProcessEnv;
}

export async function gatherFacts(opts: GatherOptions = {}): Promise<DoctorFacts> {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const shipped = shippedHooks();
  const root = projectRoot(cwd, env);
  const files = settingsFiles(home, root);
  const present = files.filter((f) => fs.existsSync(f.file));
  const entries = present.flatMap((f) => hookEntries(readJson(f.file), f.label));

  // Resolved ONCE per entry and carried, never looked up again by path. Every launcher-based hook
  // shares one run-hook.mjs, so a find()-by-path would hand the writer some other hook's command —
  // and with it some other hook's BOARD_DIR_OVERRIDE.
  const wired = entries.map((e) => {
    const target = commandTarget(e.command, home, root);
    return {
      entry: e,
      hook: hookName(e.command, target, shipped ?? []),
      wiredHook: {
        source: e.source,
        hook: hookName(e.command, target, shipped ?? []),
        path: target ?? e.command,
        sha: target ? sha(target) : null,
        isLauncher: isLauncher(e.command, target),
      },
      text: resolvedText(e.command, target),
    };
  });

  const postToolUse: PostToolUseHook[] | null =
    present.length === 0
      ? null
      : wired
          .filter((w) => w.entry.event === 'PostToolUse')
          .map((w) => ({ command: w.entry.command, kind: w.hook === 'track-steps' ? 'writer' : 'unknown' }));

  const guardCopies: WiredHook[] | null = present.length === 0 ? null : wired.map((w) => w.wiredHook);

  // A board root pinned into the telemetry writer's own wiring. Read from the writer rather than
  // from this process's env, because the writer runs with its own and the two can differ silently.
  const writerBoards = wired
    .filter((w) => w.hook === 'track-steps')
    .flatMap((w) => {
      const found = boardOverrideIn(w.text);
      return found ? [{ source: `writer (${w.entry.source})`, root: found }] : [];
    });

  const canonicalShas: Record<string, string> = {};
  let canonicalReadable = shipped !== null;
  for (const h of shipped ?? []) {
    const digest = sha(path.join(PKG_ROOT, 'hooks', `${h}.mjs`));
    if (digest === null) canonicalReadable = false;
    else canonicalShas[h] = digest;
  }

  // Only installs the WIRING reaches. Counting doctor's own copy conflates "this machine has two
  // versions wired" with "I was invoked from a different one" — which `npx` (fetches latest) and any
  // run from a source checkout ahead of the install both do, making every development run MISMATCH.
  // The self version is reported alongside, informationally.
  const roots = new Map<string, string | null>();
  for (const h of guardCopies ?? []) {
    if (!h.isLauncher) continue;
    const install = installRootFor(h.path);
    if (install) roots.set(install.root, install.version);
  }
  const selfPkg = asRecord(readJson(path.join(PKG_ROOT, 'package.json')));
  const selfVersion = typeof selfPkg?.version === 'string' ? selfPkg.version : null;

  const mcp: McpFact | null =
    opts.probeMcpServer === false
      ? { probed: false, configured: false, resolved: false, version: null, boardRoot: null }
      : await probeMcp(home, root);
  const targets = [
    ...writerBoards,
    ...(mcp?.boardRoot ? [{ source: 'mcp server', root: mcp.boardRoot }] : []),
  ];

  // Read the board the machine's WIRING names, falling back to this process's resolution. Without
  // this, running doctor from any repo but the board's own reads that repo's (absent) events dir and
  // reports UNKNOWN liveness — a dead-writer answer produced entirely by where the command was run.
  const resolved = resolveBoardRoot();
  const board = targets.length > 0 ? { root: targets[0].root, source: `${targets[0].source} wiring` } : resolved;
  const eventsDir = env.EVENTS_DIR_OVERRIDE || path.join(board.root, 'events');
  const ticketsDir = env.TICKETS_DIR_OVERRIDE || path.join(board.root, 'tickets');

  const pkg = asRecord(readJson(path.join(root, 'package.json')));
  const scripts = pkg ? asRecord(pkg.scripts) : null;

  return {
    postToolUse,
    guardCopies,
    canonicalShas: canonicalReadable ? canonicalShas : null,
    installs: [...roots].map(([installRoot, version]) => ({ root: installRoot, version })),
    selfVersion,
    mcp,
    // ticketsDir is reported, not just its existence: TICKETS_DIR_OVERRIDE can point somewhere other
    // than <board.root>/tickets, and naming only the board root describes a directory never stat'd.
    board: { root: board.root, via: board.source, ticketsDir, ticketsDirExists: fs.existsSync(ticketsDir), targets },
    protectedBranch: await gitFacts(cwd),
    lastHookEventAt: await lastHookEvent(eventsDir),
    now: opts.now ?? new Date().toISOString(),
    gateScripts: scripts === null ? null : { [path.basename(root)]: Object.keys(scripts) },
  };
}
