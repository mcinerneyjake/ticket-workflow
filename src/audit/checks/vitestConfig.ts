import { isRecord, type AuditContext } from '../types.js';
import { maskSource, objectBodies } from './configSource.js';

const DEDICATED = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'];
const SHARED = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];

export type VitestConfig =
  /**
   * `file` is repo-relative, so a detail line names the file the reader has to open. `nested` says
   * the config sits below the repo root, which moves vitest's collection root with it.
   */
  | { readonly kind: 'found'; readonly file: string; readonly dir: string; readonly nested: boolean; readonly contents: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly file: string; readonly message: string }
  /** More than one vitest root: a verdict read off one of them would not describe the repo. */
  | { readonly kind: 'ambiguous'; readonly detail: string }
  /** The config was found but could not be parsed far enough to answer. Never a pass. */
  | { readonly kind: 'undeterminable'; readonly detail: string };

type ConfigChoice = { readonly kind: 'default' } | { readonly kind: 'none' } | { readonly kind: 'file'; readonly file: string };

interface Delegation {
  readonly dirs: readonly string[];
  /** A segment that runs vitest itself, so the repo root is a collection root in its own right. */
  readonly directVitest: boolean;
  readonly configs: readonly ConfigChoice[];
  /** A config flag this cannot attribute. Never resolved to the default in its place. */
  readonly unfollowable: string | undefined;
}

const NO_DELEGATION: Delegation = { dirs: [], directVitest: false, configs: [], unfollowable: undefined };

/** A path inside the repo, or undefined. `.`/`./` is the root itself — read as a nested root it
 *  certified a root config with no worktree exclude — and `$VAR` names nothing. */
function repoRelative(token: string): string | undefined {
  if (token.startsWith('/') || token.startsWith('~')) return undefined;
  if (/[$`*?]/.test(token)) return undefined;
  const trimmed = token.replace(/\/+$/, '').replace(/^\.\//, '');
  if (trimmed === '' || trimmed === '.') return undefined;
  if (trimmed.split(/[\\/]/).includes('..')) return undefined;
  return trimmed;
}

/** Quoted regions blanked, same length. A `--reporter='a|b'` otherwise split mid-argument and the
 *  fragments read as extra commands. */
function maskQuotes(s: string): string {
  const out = s.split('');
  let quote = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (quote === '') {
      if (ch === "'" || ch === '"') quote = ch;
    } else if (ch === quote) {
      quote = '';
    } else {
      out[i] = ' ';
    }
  }
  return out.join('');
}

function segmentsOf(script: string): string[] {
  const masked = maskQuotes(script);
  const out: string[] = [];
  const sep = /&&|\|\||;|\|/g;
  let start = 0;
  let hit = sep.exec(masked);
  while (hit !== null) {
    out.push(script.slice(start, hit.index));
    start = hit.index + hit[0].length;
    hit = sep.exec(masked);
  }
  out.push(script.slice(start));
  return out;
}

interface FlagHit {
  readonly flag: string;
  /** '' when nothing follows the flag. */
  readonly raw: string;
}

const FLAG_VALUE = /^(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S*))/;

/** Every unquoted occurrence of `flags`, with its argument. One grammar for --prefix and --config. */
function flagHits(segment: string, flags: readonly string[]): FlagHit[] {
  const pattern = new RegExp(`(?:^|\\s)(${flags.join('|')})(?==|\\s|$)`, 'g');
  return [...maskQuotes(segment).matchAll(pattern)].map((hit) => {
    const value = FLAG_VALUE.exec(segment.slice(hit.index + hit[0].length));
    return { flag: hit[1] ?? '', raw: value === null ? '' : (value[1] ?? value[2] ?? value[3] ?? '') };
  });
}

/** An argument, or undefined when the flag carries none: an empty `--prefix=` once captured the
 *  NEXT word as the directory and hid the root config — a false "no vitest config found". */
function argOf(hit: FlagHit | undefined): string | undefined {
  if (hit === undefined || hit.raw === '' || hit.raw.startsWith('-')) return undefined;
  return hit.raw;
}

function prefixArg(segment: string): string | undefined {
  return argOf(flagHits(segment, ['--prefix'])[0]);
}

/** `vitest` as the COMMAND, never as a filename. A bare `\bvitest\b` matched `--config
 *  vitest.ci.config.ts`, flipping a single-root repo to an ambiguous BLOCK. Leading `VAR=value`
 *  assignments and `env`/`cross-env` are skipped first: they occupy the command position without
 *  being the command, which hid a root-level `vitest run` from the ambiguity guard entirely. */
function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter((w) => w !== '');
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === 'env' || w === 'cross-env') {
      i += 1;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function runsVitestDirectly(segment: string): boolean {
  const words = commandWords(segment);
  return words.some((w, i) => {
    if (w !== 'vitest' && !w.endsWith('/vitest')) return false;
    const prev = i === 0 ? undefined : words[i - 1];
    return prev === undefined || prev === 'npx' || prev === 'exec' || prev === 'run' || prev === 'pnpm' || prev === 'yarn';
  });
}

const CONFIG_FLAGS = ['--config', '-c', '--no-config'];

/** Each config a direct vitest segment names, or why one cannot be followed — never the default in
 *  place of a value it could not read: that is the wrong-file PASS of tkt-c9f680c783a6. */
function configChoicesOf(segment: string): ConfigChoice[] | string {
  const hits = flagHits(segment, CONFIG_FLAGS);
  if (hits.length === 0) return [{ kind: 'default' }];
  const out: ConfigChoice[] = [];
  for (const hit of hits) {
    if (hit.flag === '--no-config') {
      out.push({ kind: 'none' });
      continue;
    }
    const arg = argOf(hit);
    const file = arg === undefined ? undefined : repoRelative(arg);
    if (file === undefined) {
      return `the root test script passes vitest \`${hit.flag}\` a value this check cannot resolve to a file in the repo (\`${hit.raw}\`) — check that config by hand`;
    }
    out.push({ kind: 'file', file });
  }
  return out;
}

function choiceKey(c: ConfigChoice): string {
  return c.kind === 'file' ? `file:${c.file}` : c.kind;
}

function distinctChoices(choices: readonly ConfigChoice[]): ConfigChoice[] {
  const seen = new Map<string, ConfigChoice>();
  for (const c of choices) seen.set(choiceKey(c), c);
  return [...seen.values()];
}

/** `vitest` as a program anywhere in the text — `npx vitest@4`, `bunx vitest`, `sh -c 'vitest'` —
 *  but not a `vitest.*config*` filename. */
const MENTIONS_VITEST = /(?<![\w.-])vitest(?![\w-]|\.[\w.-]*config)/;
const CONFIG_TOKEN = /(?:^|[\s'"(])(?:--config|-c|--no-config)(?==|\s|$|['")])/;

/** The script an `npm|pnpm|yarn run <name>` segment hands off to. */
function runTarget(segment: string, scripts: Readonly<Record<string, unknown>>): string {
  const [tool, verb, name] = commandWords(segment);
  if (tool === undefined || !['npm', 'pnpm', 'yarn'].includes(tool)) return '';
  if (verb !== 'run' && verb !== 'run-script') return '';
  const target = name === undefined ? undefined : scripts[name];
  return typeof target === 'string' ? target : '';
}

/** Args after a bare `--`, which npm hands to the delegate's script — so `-c` there is vitest's. */
function passedThrough(segment: string): string {
  const sep = /(?:^|\s)--(?=\s|$)/.exec(maskQuotes(segment));
  return sep === null ? '' : segment.slice(sep.index + sep[0].length);
}

/**
 * How the root `test` script drives vitest. Only `npm --prefix` is read as a delegation: it is the
 * one spelling that unambiguously names a directory, where `-C` is git's flag as often as npm's and
 * a bare path argument is not a delegation at all. A shape this misses leaves the root searched,
 * which is the answer the check already gave — never a pass.
 */
function analyseTestScript(script: string, scripts: Readonly<Record<string, unknown>>): Delegation {
  const dirs: string[] = [];
  const configs: ConfigChoice[] = [];
  let directVitest = false;
  let unfollowable: string | undefined;
  for (const segment of segmentsOf(script)) {
    const arg = prefixArg(segment);
    if (arg !== undefined) {
      const dir = repoRelative(arg);
      if (dir !== undefined) dirs.push(dir);
      // A bare `-c` before `--` is as likely npm's own flag; after it, it is vitest's.
      if (flagHits(segment, ['--config', '--no-config']).length > 0 || flagHits(passedThrough(segment), ['-c']).length > 0) {
        unfollowable ??= 'the root test script passes a config flag through an `npm --prefix` delegation, which this check does not resolve against the delegate — check it by hand';
      }
      continue;
    }
    if (runsVitestDirectly(segment)) {
      directVitest = true;
      const choices = configChoicesOf(segment);
      if (typeof choices === 'string') unfollowable ??= choices;
      else configs.push(...choices);
      continue;
    }
    const text = `${segment}\n${runTarget(segment, scripts)}`;
    if (MENTIONS_VITEST.test(text) && CONFIG_TOKEN.test(text)) {
      unfollowable ??= `the root test script runs vitest with a config flag through \`${segment.trim()}\`, which this check cannot follow — check that config by hand`;
    }
  }
  return { dirs, directVitest, configs, unfollowable };
}

function delegationOf(ctx: AuditContext): Delegation {
  const pkg = ctx.read('package.json');
  if (pkg.kind !== 'ok') return NO_DELEGATION;
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkg.contents);
  } catch {
    // An unparseable package.json is package-scripts' finding to report, not this resolver's: it
    // costs the delegated shape only, and the root candidates are still searched.
    return NO_DELEGATION;
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return NO_DELEGATION;
  const script = parsed.scripts.test;
  if (typeof script !== 'string') return NO_DELEGATION;
  return analyseTestScript(script, parsed.scripts);
}

/** Whether a shared vite config configures vitest at all — being a vite config is not being one. */
function testBlockOf(contents: string): { readonly declared: boolean; readonly unbalanced: boolean } {
  const scan = objectBodies(maskSource(contents), 'test', { directChildOnly: true });
  return { declared: scan.bodies.length > 0, unbalanced: scan.unbalanced };
}

/**
 * Whether the config sets vitest's collection root explicitly. A delegated config carrying
 * `root: '..'` collects the whole repo again, putting the worktree tree back inside a root the
 * nested branch would otherwise assume it was outside.
 */
export function declaresRoot(contents: string): boolean {
  const m = maskSource(contents);
  if (/(?:^|[{,\s])root\s*:/.test(m.masked)) return true;
  return m.literals.some((l) => l.value === 'root' && /^\s*:/.test(m.masked.slice(l.end)));
}

/** Whether `rel` names a directory. `read` on one fails EISDIR, ENOENT reads `missing`, and a FILE
 *  reads `ok` — so only the error case makes a delegation real. */
function isDirectory(ctx: AuditContext, rel: string): boolean {
  const r = ctx.read(rel);
  return r.kind === 'error' && /EISDIR|illegal operation on a directory/i.test(r.message);
}

function searchDir(ctx: AuditContext, dir: string): VitestConfig | undefined {
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const candidate of [...DEDICATED, ...SHARED]) {
    const rel = `${prefix}${candidate}`;
    const file = ctx.read(rel);
    if (file.kind === 'error') {
      // A delegated prefix naming a FILE reads as ENOTDIR here. Blocking both vitest checks on it
      // would be the unactionable noise this ticket removes; there is simply no config there.
      if (dir !== '') continue;
      return { kind: 'error', file: rel, message: file.message };
    }
    if (file.kind === 'missing') continue;
    if (SHARED.includes(candidate)) {
      const { declared, unbalanced } = testBlockOf(file.contents);
      if (unbalanced) {
        return { kind: 'undeterminable', detail: `${rel} has an unclosed \`{\`, so its \`test\` block cannot be delimited — this check cannot answer for the repo` };
      }
      if (!declared) continue;
    }
    return { kind: 'found', file: rel, dir, nested: dir !== '', contents: file.contents };
  }
  return undefined;
}

const EXTENDS_LOCAL = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]*config[^'"/]*)['"]/;

/** A named file is loaded whatever it contains, so no test-block filter applies; and `--config`
 *  does not move vitest's root, so it is never `nested`. */
function namedConfig(ctx: AuditContext, file: string): VitestConfig {
  const r = ctx.read(file);
  if (r.kind === 'error') return { kind: 'error', file, message: r.message };
  if (r.kind === 'missing') return { kind: 'error', file, message: 'the root test script names it with --config, but no such file exists' };
  // A mergeConfig/re-export base supplies settings this file alone does not show: judging it alone
  // was a false FAIL on a correctly configured repo.
  const base = EXTENDS_LOCAL.exec(r.contents);
  if (base !== null) {
    return { kind: 'undeterminable', detail: `${file} builds on ${base[1] ?? 'another config'}, so the file alone does not show what vitest runs — check the merged config by hand` };
  }
  return { kind: 'found', file, dir: '', nested: false, contents: r.contents };
}

/**
 * The file that actually configures vitest, which is not always `<root>/vitest.config.ts`: the
 * commonest setup puts the `test` block in `vite.config.ts`, and a root that delegates with
 * `npm --prefix <dir>` keeps it under that directory. Searching only the dedicated root names made
 * all three of those report "no vitest config found" — false, and it sends the reader to create a
 * file that is already there (tkt-5c0e00fae59d).
 *
 * A dedicated name wins over a shared one in the same directory: the more specific declaration is
 * the one someone chose. Where the root delegates to a REAL directory, the delegate's config is the
 * one `npm test` runs, so the root's is not consulted; where the delegated token names nothing on
 * disk, the delegation is not real and the root is searched rather than reported empty.
 */
export function resolveVitestConfig(ctx: AuditContext): VitestConfig {
  const { dirs, directVitest, configs, unfollowable } = delegationOf(ctx);
  if (dirs.length > 1 || (dirs.length === 1 && directVitest)) {
    // Answering from one of several roots would report a conforming sibling as the whole repo's
    // verdict — the fail-open this refuses. Splitting the audit or an exemption is the repair.
    const roots = [...(directVitest ? ['.'] : []), ...dirs].join(', ');
    return { kind: 'ambiguous', detail: `the root test script drives more than one vitest root (${roots}) — this check reads one, so it cannot answer for the repo` };
  }
  if (unfollowable !== undefined) return { kind: 'undeterminable', detail: unfollowable };
  const distinct = distinctChoices(configs);
  if (distinct.length > 1) {
    return { kind: 'ambiguous', detail: 'the root test script runs vitest with more than one config — this check reads one, so it cannot answer for the repo' };
  }
  const chosen = distinct[0];
  if (chosen?.kind === 'none') return { kind: 'missing' };
  if (chosen?.kind === 'file') return namedConfig(ctx, chosen.file);
  const dir = dirs[0] ?? '';
  if (dir !== '') {
    const delegated = searchDir(ctx, dir);
    if (delegated !== undefined) return delegated;
    if (isDirectory(ctx, dir)) return { kind: 'missing' };
  }
  return searchDir(ctx, '') ?? { kind: 'missing' };
}
