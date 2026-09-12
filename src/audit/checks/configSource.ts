export interface Literal {
  readonly start: number;
  /** Index one past the closing quote. */
  readonly end: number;
  readonly value: string;
}

export interface Masked {
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
 * One masking pass, because every delimiter a config scan counts also occurs inside the things it
 * must ignore — and a glob is the worst offender: it is the one string that reliably contains BOTH
 * comment delimiters, so a leading `dist/` glob opens a block comment that the first recursive
 * coverage glob closes, deleting the arrays and INVERTING the verdict (measured). Masking to equal
 * length means the scan can stay index-based without ever re-deriving those positions.
 */
export function maskSource(src: string): Masked {
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
export function matchDelimiter(masked: string, openIndex: number, open: string, close: string): number {
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
export function depthBetween(masked: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const ch = masked.charAt(i);
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
  }
  return depth;
}

/** Whether the key token starting at `start` sits where an object KEY can sit: at the start of an
 *  object body, or after a comma. `x ? 'test' : { … }` put a ternary branch where a key was read. */
function atKeyPosition(masked: string, start: number): boolean {
  for (let i = start - 1; i >= 0; i -= 1) {
    const ch = masked.charAt(i);
    if (/\s/.test(ch)) continue;
    return ch === '{' || ch === ',';
  }
  return false;
}

/** The `{` of the object CONTAINING the body that opens at `open`, or -1 when the container is not
 *  an object literal — a call argument, an array element, or the module top level. */
function enclosingObjectOpen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open - 1; i >= 0; i -= 1) {
    const ch = masked.charAt(i);
    if (ch === '}' || ch === ')' || ch === ']') {
      depth += 1;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      if (depth === 0) return ch === '{' ? i : -1;
      depth -= 1;
    }
  }
  return -1;
}

/** Whether the object opening at `open` is itself some OTHER key's value. A depth-blind scan adopted
 *  `build: { rollupOptions: { test: { exclude: [...] } } }` as the vitest block and certified a repo
 *  whose real config excludes nothing. */
function nestedUnderAnotherKey(masked: string, open: number): boolean {
  const container = enclosingObjectOpen(masked, open);
  if (container === -1) return false;
  return /:\s*$/.test(masked.slice(0, container));
}

export interface BodyScan {
  readonly bodies: ReadonlyArray<readonly [number, number]>;
  /**
   * An unclosed `{`, so a body's extent is undeterminable. Callers must report rather than guess:
   * widening it to end-of-file let an `exclude` from OUTSIDE the block read as a direct child.
   */
  readonly unbalanced: boolean;
}

/** Every `<key>: {` and `'<key>': {` object body, as [interiorStart, interiorEnd). */
export function objectBodies(m: Masked, key: string, opts?: { readonly directChildOnly?: boolean }): BodyScan {
  const opens: number[] = [];
  const bare = new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g');
  let hit = bare.exec(m.masked);
  while (hit !== null) {
    if (atKeyPosition(m.masked, hit.index)) opens.push(m.masked.indexOf('{', hit.index));
    hit = bare.exec(m.masked);
  }
  // A quoted key is blanked in the mask, so it has to be recovered from the literal table — the
  // spelling `"coverage": { … }` is otherwise invisible, which was a live fail-open.
  for (const lit of m.literals) {
    if (lit.value !== key || !atKeyPosition(m.masked, lit.start)) continue;
    const after = /^\s*:\s*\{/.exec(m.masked.slice(lit.end));
    if (after !== null) opens.push(lit.end + after[0].length - 1);
  }
  const bodies: Array<readonly [number, number]> = [];
  let unbalanced = false;
  for (const open of opens) {
    if (opts?.directChildOnly === true && nestedUnderAnotherKey(m.masked, open)) continue;
    const close = matchDelimiter(m.masked, open, '{', '}');
    if (close === -1) {
      unbalanced = true;
      continue;
    }
    bodies.push([open + 1, close]);
  }
  return { bodies, unbalanced };
}
