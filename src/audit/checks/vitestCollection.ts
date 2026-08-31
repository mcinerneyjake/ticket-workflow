import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const CANDIDATES = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'];

/** Where `ticket-workflow worktree` puts a session's isolated checkout — a full second copy of the
 *  repo, suites and all, nested INSIDE the tree vitest collects from. */
const WORKTREE_DIR = '.claude/worktrees';
const RECURSIVE = `${WORKTREE_DIR}/**`;

interface Literal {
  readonly start: number;
  /** Index one past the closing quote. */
  readonly end: number;
  readonly value: string;
}

interface Masked {
  /**
   * The source with every comment, string body and regex literal blanked to spaces — SAME LENGTH,
   * so every index taken from it still addresses the original.
   */
  readonly masked: string;
  readonly literals: readonly Literal[];
}

/** Where a `/` can open a regex literal rather than divide. Anything else preceding it is a value. */
function regexCanStart(prev: string): boolean {
  return prev === '' || '(,=:[!&|?{};+-*%~^<>\n'.includes(prev);
}

/**
 * One masking pass, because every delimiter this check counts also occurs inside the things it must
 * ignore — and a glob is the worst offender: it is the one string that reliably contains BOTH
 * comment delimiters, so a leading `dist/` glob opens a block comment that the first recursive
 * coverage glob closes, deleting the arrays and INVERTING the verdict (measured). Masking to equal
 * length means the scan can stay index-based without ever re-deriving those positions.
 */
function maskSource(src: string): Masked {
  const out = src.split('');
  const literals: Literal[] = [];
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? src.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close === -1 ? src.length : close + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let value = '';
      while (j < src.length) {
        const c = src.charAt(j);
        if (c === '\\') {
          value += src.charAt(j + 1);
          j += 2;
          continue;
        }
        if (c === ch) break;
        value += c;
        j += 1;
      }
      // An unterminated string swallows the rest of the file. That can only HIDE an exclude, which
      // fails the repo — never the permissive direction.
      const end = j < src.length ? j + 1 : src.length;
      literals.push({ start: i, end, value });
      blank(i, end);
      i = end;
      prev = '"';
      continue;
    }
    if (ch === '/' && regexCanStart(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const c = src.charAt(j);
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
        j += 1;
      }
      if (j < src.length && src.charAt(j) === '/') {
        blank(i, j + 1);
        i = j + 1;
        prev = 'x';
        continue;
      }
    }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return { masked: out.join(''), literals };
}

/** Index of the delimiter closing the one at `openIndex` in MASKED source, or -1. */
function matchDelimiter(masked: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    const ch = masked.charAt(i);
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Net nesting between two indices of MASKED source. Parens counted too, so a call wrapping an
 *  object (`coverage: makeCov({ exclude: … })`) never reads as a direct child. */
function depthBetween(masked: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const ch = masked.charAt(i);
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
  }
  return depth;
}

/** Every `<key>: {` and `'<key>': {` object body, as [interiorStart, interiorEnd). */
function objectBodies(m: Masked, key: string): Array<readonly [number, number]> {
  const bodies: Array<readonly [number, number]> = [];
  const opens: number[] = [];
  const bare = new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g');
  let hit = bare.exec(m.masked);
  while (hit !== null) {
    opens.push(m.masked.indexOf('{', hit.index));
    hit = bare.exec(m.masked);
  }
  // A quoted key is blanked in the mask, so it has to be recovered from the literal table — the
  // spelling `"coverage": { … }` is otherwise invisible, which was a live fail-open.
  for (const lit of m.literals) {
    if (lit.value !== key) continue;
    const after = /^\s*:\s*\{/.exec(m.masked.slice(lit.end));
    if (after !== null) opens.push(lit.end + after[0].length - 1);
  }
  for (const open of opens) {
    const close = matchDelimiter(m.masked, open, '{', '}');
    bodies.push([open + 1, close === -1 ? m.masked.length : close]);
  }
  return bodies;
}

interface Collection {
  /** Whether a test-level `exclude` array exists at all — absent and empty are different repairs. */
  readonly declared: boolean;
  readonly globs: readonly string[];
}

/**
 * The globs of every `exclude` that is a DIRECT child of a `test` object.
 *
 * Positive identification, not subtraction. Excluding "anything inside a `coverage` block" was the
 * first shape and it fails open on every spelling not anticipated — a quoted key, a hoisted object,
 * a call-wrapped one — and on vitest's OTHER nested excludes (`typecheck`, `benchmark`), none of
 * which govern collection either. Depth-0 admits only the array that actually does.
 */
function collectionExcludes(m: Masked): Collection {
  let declared = false;
  const globs: string[] = [];
  for (const [start, end] of objectBodies(m, 'test')) {
    const opens: number[] = [];
    const bare = /\bexclude\s*:\s*\[/g;
    const body = m.masked.slice(start, end);
    let hit = bare.exec(body);
    while (hit !== null) {
      opens.push(start + hit.index);
      hit = bare.exec(body);
    }
    for (const lit of m.literals) {
      if (lit.value !== 'exclude' || lit.start < start || lit.end > end) continue;
      const after = /^\s*:\s*\[/.exec(m.masked.slice(lit.end));
      if (after !== null) opens.push(lit.start);
    }
    for (const at of opens) {
      if (depthBetween(m.masked, start, at) !== 0) continue;
      declared = true;
      const open = m.masked.indexOf('[', at);
      const close = matchDelimiter(m.masked, open, '[', ']');
      const stop = close === -1 ? m.masked.length : close;
      for (const lit of m.literals) {
        if (lit.start > open && lit.end <= stop) globs.push(lit.value);
      }
    }
  }
  return { declared, globs };
}

/** A leading globstar segment, or a `./`, changes nothing about what a glob reaches. */
function normalize(glob: string): string {
  return glob.replace(/^\.\//, '').replace(/^\*\*\//, '');
}

/**
 * Whole-glob, never substring. `includes()` certified three globs that do NOT prevent the doubled
 * run: one narrowed after the globstar (a `.snap` suffix), one re-rooted under another parent
 * (`foo/.claude/worktrees/**`), and a NEGATION (`!.claude/worktrees/**`) — the exact opposite of an
 * exclusion.
 */
function covers(glob: string): boolean {
  if (glob.startsWith('!')) return false;
  const n = normalize(glob);
  return n === RECURSIVE || n === `${RECURSIVE}/*`;
}

/** A blanket `.claude/**` reaches the effect by excluding more than was asked. Anything narrower
 *  than the whole subtree does not, however much of the prefix it shares. */
function coversViaClaude(glob: string): boolean {
  if (glob.startsWith('!')) return false;
  const n = normalize(glob);
  return n === '.claude/**' || n === '.claude/**/*';
}

export const vitestCollection: AuditCheck = {
  id: 'vitest-collection',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    for (const candidate of CANDIDATES) {
      const file = ctx.read(candidate);
      if (file.kind === 'error') return makeResult(this, 'blocked', `${candidate} could not be read: ${file.message}`);
      if (file.kind === 'missing') continue;

      const { declared, globs } = collectionExcludes(maskSource(file.contents));
      if (!declared) {
        return makeResult(this, 'fail', `${candidate} declares no test-level exclude — vitest's defaults do not cover ${WORKTREE_DIR}, so a worktree's suites are collected twice`);
      }
      if (globs.some(covers)) {
        return makeResult(this, 'pass', `${candidate} excludes ${RECURSIVE} from test collection`);
      }
      const broad = globs.find(coversViaClaude);
      if (broad !== undefined) {
        // The doubled collection IS prevented, so this is reported rather than failed — the same
        // call the gitignore check makes for a blanket `.claude/`. Stricter is not a defect.
        return makeResult(this, 'pass', `${candidate} excludes ${WORKTREE_DIR} via \`${broad}\` — WARNING: that glob is over-broad and also drops any suite kept under .claude/`);
      }
      const named = globs.find((g) => g.includes(WORKTREE_DIR));
      if (named !== undefined) {
        // tkt-17d81c74b662 measured the `/*` form: it matches the worktree DIRECTORY but not the
        // suites nested inside it, so the doubled run survives a glob that reads as present.
        return makeResult(this, 'fail', `${candidate} excludes \`${named}\`, which does not reach the suites NESTED in a worktree — it must be exactly ${RECURSIVE}`);
      }
      return makeResult(this, 'fail', `${candidate} does not exclude ${WORKTREE_DIR} from test collection — add \`${RECURSIVE}\`, or a worktree's full second checkout doubles every suite and reddens the local gate`);
    }
    // No config means vitest's own defaults, which collect `**/*.test.*` from the root — the
    // worktree included. Absent configuration is the vulnerable state, not an unknown one.
    return makeResult(this, 'fail', `no vitest config found — the default collection is recursive from the repo root, so a worktree under ${WORKTREE_DIR} is collected twice`);
  },
};
