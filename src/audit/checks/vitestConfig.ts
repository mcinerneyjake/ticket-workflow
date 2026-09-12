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

interface Delegation {
  readonly dirs: readonly string[];
  /** A segment that runs vitest itself, so the repo root is a collection root in its own right. */
  readonly directVitest: boolean;
}

/**
 * A delegated directory, or undefined when the token does not name one inside the repo.
 *
 * A self-referential prefix (`.`, `./`) is the repo ROOT, not a nested root. Admitting it set
 * `nested`, and the nested branch then certified a root config with no worktree exclude at all,
 * asserting that `.claude/worktrees` was outside a collection root that is precisely the repo root.
 * An unexpanded shell variable is equally not a directory name.
 */
function delegatedDir(token: string): string | undefined {
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

/** `--prefix`'s argument, or undefined when the flag carries none. A greedy `[=\s]+` swallowed an
 *  empty `--prefix=` and captured the NEXT word as the directory, which then suppressed the root
 *  candidates entirely — a false "no vitest config found" on a repo that has one. */
function prefixArg(segment: string): string | undefined {
  const hit = /(?:^|\s)--prefix(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S*))/.exec(segment);
  if (hit === null) return undefined;
  const raw = hit[1] ?? hit[2] ?? hit[3] ?? '';
  if (raw === '' || raw.startsWith('-')) return undefined;
  return raw;
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

/**
 * How the root `test` script drives vitest. Only `npm --prefix` is read as a delegation: it is the
 * one spelling that unambiguously names a directory, where `-C` is git's flag as often as npm's and
 * a bare path argument is not a delegation at all. A shape this misses leaves the root searched,
 * which is the answer the check already gave — never a pass.
 */
function analyseTestScript(script: string): Delegation {
  const dirs: string[] = [];
  let directVitest = false;
  for (const segment of segmentsOf(script)) {
    const arg = prefixArg(segment);
    if (arg !== undefined) {
      const dir = delegatedDir(arg);
      if (dir !== undefined) dirs.push(dir);
      continue;
    }
    if (runsVitestDirectly(segment)) directVitest = true;
  }
  return { dirs, directVitest };
}

function delegationOf(ctx: AuditContext): Delegation {
  const pkg = ctx.read('package.json');
  if (pkg.kind !== 'ok') return { dirs: [], directVitest: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkg.contents);
  } catch {
    // An unparseable package.json is package-scripts' finding to report, not this resolver's: it
    // costs the delegated shape only, and the root candidates are still searched.
    return { dirs: [], directVitest: false };
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return { dirs: [], directVitest: false };
  const script = parsed.scripts.test;
  if (typeof script !== 'string') return { dirs: [], directVitest: false };
  return analyseTestScript(script);
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
  const { dirs, directVitest } = delegationOf(ctx);
  if (dirs.length > 1 || (dirs.length === 1 && directVitest)) {
    // Answering from one of several roots would report a conforming sibling as the whole repo's
    // verdict — the fail-open this refuses. Splitting the audit or an exemption is the repair.
    const roots = [...(directVitest ? ['.'] : []), ...dirs].join(', ');
    return { kind: 'ambiguous', detail: `the root test script drives more than one vitest root (${roots}) — this check reads one, so it cannot answer for the repo` };
  }
  const dir = dirs[0] ?? '';
  if (dir !== '') {
    const delegated = searchDir(ctx, dir);
    if (delegated !== undefined) return delegated;
    if (isDirectory(ctx, dir)) return { kind: 'missing' };
  }
  return searchDir(ctx, '') ?? { kind: 'missing' };
}
