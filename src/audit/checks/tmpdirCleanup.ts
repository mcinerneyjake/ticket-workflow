import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const JS_TS = /\.[cm]?[jt]sx?$/;
/** `*.test.*`/`*.spec.*` plus the directory layouts that hold fixtures without that suffix. A repo
 *  naming its suites some other way is NOT covered, which is why the empty result says so rather
 *  than reporting a clean board. */
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|__tests__|test-support)\//;

/** The match starts at the whole call expression, receiver chain included (`fs.promises.mkdtemp`),
 *  so the text BEFORE it is the binding rather than the receiver — `root = fs.mkdtempSync(` would
 *  otherwise read as unbound because the preceding text ends in `fs.`. */
const CREATION = /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)*mkdtemp(?:Sync)?\s*\(/g;
const REMOVAL = /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:rmSync|rmdirSync|rm|rmdir)\s*\(/g;
/** `tempDirs.push(dir)` — the collector idiom, where the root is removed through an array. */
const COLLECT = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:push|add|unshift)\s*\(/g;
/** A binding whose right-hand side is captured, for resolving tmpdir aliases. */
const ASSIGNMENT = /(?:^|[^\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=([^\n]*)/g;

/** Wrappers returning the SAME directory they are handed, so a binding through one still names the
 *  temp root. `path.join` is deliberately NOT here: it yields a child, and removing the child
 *  leaves the root — measured as 336 leaked `tw-orphan-` directories from one such call site. */
const IDENTITY_WRAPPER = /(?:[A-Za-z_$][\w$]*\s*\.\s*)*realpath(?:Sync)?\s*\(\s*$/;
/** The assignment operator, excluding every compound and comparison form that also ends in `=`. */
const ASSIGN_OP = /(?:^|[^=!<>+\-*/%&|^])=\s*$/;
/** The declared name, with any TypeScript type annotation after it. Without the annotation arm a
 *  `const dir: string =` bound the TYPE — reporting clean code as a leak named `string`, in every
 *  consumer, since they are all TypeScript.
 *  The annotation may contain neither `=` nor a newline, and that is load-bearing rather than
 *  tidiness: written `[\s\S]*` it reached back over earlier lines, so a file opening with
 *  `const tempDirs: string[] = []` bound EVERY later creation to `tempDirs` and falsely flagged
 *  three suites that clean up correctly. */
const DECLARED = /(?:^|[^\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?$/;
const REASSIGNED = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*$/;

/** How far above a removal its drain site may sit: the one-line
 *  `for (const d of dirs.splice(0)) rmSync(d, …)` and the same loop with a block body. */
const DRAIN_LOOKBACK = 2;
const IDENT = /[A-Za-z_$][\w$]*/g;
const NOT_A_BINDING = new Set(['true', 'false', 'null', 'undefined', 'this', 'new', 'await', 'recursive', 'force', 'maxRetries']);

export interface Leak {
  readonly file: string;
  readonly line: number;
  /** The identifier the temp root was bound to, or undefined when nothing named it. */
  readonly binding?: string;
}

/**
 * Comment bodies and string-literal text replaced by spaces, preserving every index and newline so
 * positions computed on the result still address the original source.
 *
 * Not cosmetic: without it a comment reading `call rmSync(root) yourself`, or an assertion string
 * `toContain('rmSync(root)')`, registers `root` as removed and silences a real leak for the whole
 * file — the fail-open direction this check exists to prevent. Template `${}` interpolations stay
 * visible because `mkdtempSync(\`${tmpdir()}/x\`)` is a real shape.
 *
 * LIMIT: a regex literal is recognised by the usual previous-token heuristic, which cannot
 * distinguish `}` ending a block from `}` ending an object literal. A misread literal containing an
 * unpaired quote desyncs the scan from there on; a test pins the recognised cases.
 */
export function maskLiterals(source: string): string {
  const out = source.split('');
  const blank = (i: number): void => {
    if (out[i] !== '\n' && i < out.length) out[i] = ' ';
  };
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex';
  let mode: Mode = 'code';
  let prev = '';
  let inClass = false;
  // Each `${` inside a template pushes; the matching `}` pops back into the template.
  const templates: number[] = [];
  let depth = 0;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : '';

    if (mode === 'line') {
      if (ch === '\n') mode = 'code';
      else blank(i);
      continue;
    }
    if (mode === 'block') {
      blank(i);
      if (ch === '*' && next === '/') {
        blank(i + 1);
        i++;
        mode = 'code';
      }
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      if (ch === '\\') {
        blank(i);
        blank(i + 1);
        i++;
        continue;
      }
      if (ch === (mode === 'single' ? "'" : '"')) {
        mode = 'code';
        prev = 'x';
        continue;
      }
      blank(i);
      continue;
    }
    if (mode === 'regex') {
      if (ch === '\\') {
        blank(i);
        blank(i + 1);
        i++;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        mode = 'code';
        prev = 'x';
        continue;
      }
      blank(i);
      continue;
    }
    if (mode === 'template') {
      if (ch === '\\') {
        blank(i);
        blank(i + 1);
        i++;
        continue;
      }
      if (ch === '`') {
        mode = 'code';
        prev = 'x';
        continue;
      }
      if (ch === '$' && next === '{') {
        templates.push(depth);
        depth++;
        mode = 'code';
        prev = '{';
        i++;
        continue;
      }
      blank(i);
      continue;
    }

    // code
    if (ch === '/' && next === '/') {
      mode = 'line';
      blank(i);
      blank(i + 1);
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = 'block';
      blank(i);
      blank(i + 1);
      i++;
      continue;
    }
    if (ch === "'") { mode = 'single'; continue; }
    if (ch === '"') { mode = 'double'; continue; }
    if (ch === '`') { mode = 'template'; continue; }
    if (ch === '/' && !/[\w$)\]]/.test(prev)) {
      mode = 'regex';
      inClass = false;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        mode = 'template';
        continue;
      }
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  return out.join('');
}

/**
 * The argument text of a call whose `(` sits at `openParen`.
 *
 * Run on masked source, so a paren or quote inside a comment or string cannot steer it. An
 * unterminated call yields the rest of the file; for a CREATION that over-reports (more leaks), but
 * for a REMOVAL it would under-report, which is why masking rather than this function carries the
 * safety of the removal scan.
 */
export function argumentsOf(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1);
}

/** Identifiers in an argument list, minus object KEYS (`{ recursive: true }`) and literals, so
 *  option noise cannot excuse a binding that happens to share a name with one. */
function identifiersIn(text: string): readonly string[] {
  const found: string[] = [];
  IDENT.lastIndex = 0;
  for (let m = IDENT.exec(text); m !== null; m = IDENT.exec(text)) {
    const after = text.slice(m.index + m[0].length);
    if (/^\s*:/.test(after)) continue;
    if (NOT_A_BINDING.has(m[0])) continue;
    found.push(m[0]);
  }
  return found;
}

/** The name a creation's result is bound to, or undefined when the call is not the direct
 *  right-hand side of an assignment — an object-property value, or an argument to a wrapper that is
 *  not identity-preserving. Both mean nothing in the file names the root. */
export function bindingBefore(before: string): string | undefined {
  let head = before;
  for (;;) {
    const stripped = head.replace(IDENTITY_WRAPPER, '');
    if (stripped === head) break;
    head = stripped;
  }
  head = head.replace(/\bawait\s*$/, '');
  if (!ASSIGN_OP.test(head)) return undefined;
  head = head.replace(/=\s*$/, '');
  const declared = DECLARED.exec(head);
  if (declared?.[1] !== undefined) return declared[1];
  const reassigned = REASSIGNED.exec(head);
  if (reassigned?.[1] !== undefined) return reassigned[1];
  return undefined;
}

function escapeIdent(name: string): string {
  return name.replace(/\$/g, '\\$');
}

function lineNeighbourhood(source: string, at: number, back: number): string {
  let start = source.lastIndexOf('\n', at) + 1;
  for (let i = 0; i < back && start > 0; i++) start = source.lastIndexOf('\n', start - 2) + 1;
  const end = source.indexOf('\n', at);
  return source.slice(start, end === -1 ? source.length : end);
}

/**
 * Identifiers a removal call reaches, directly or through a collector array that is actually
 * DRAINED near it.
 *
 * The collector hop is not a nicety: a root pushed into `tempDirs` and drained by
 * `for (const d of tempDirs) rmSync(d)` is removed, but the removal names `d`, never the binding.
 * Without it the two genuinely clean suites in this repo pass only because they happen to name that
 * loop variable `dir` — the same identifier as the binding, i.e. by coincidence.
 *
 * The hop requires a DRAIN site (`of c`, `c.splice(`, `c.forEach(`, …), not merely the collector's
 * name: keyed on the name alone, an unrelated `rmSync(someFile)` two lines under a `kept.push(dir)`
 * excused `dir` although nothing ever drains `kept`.
 *
 * File-scoped on purpose: matching a binding to its own removal needs scope analysis this check
 * does not do. The cost is that a name removed in one function excuses the same name created in
 * another — an UNDER-report, so a leak this check names is a leak, and silence is not proof.
 */
export function removedNames(masked: string): ReadonlySet<string> {
  const collected = new Map<string, Set<string>>();
  COLLECT.lastIndex = 0;
  for (let m = COLLECT.exec(masked); m !== null; m = COLLECT.exec(masked)) {
    const bucket = collected.get(m[1]) ?? new Set<string>();
    for (const id of identifiersIn(argumentsOf(masked, m.index + m[0].length - 1))) bucket.add(id);
    collected.set(m[1], bucket);
  }

  const names = new Set<string>();
  REMOVAL.lastIndex = 0;
  for (let m = REMOVAL.exec(masked); m !== null; m = REMOVAL.exec(masked)) {
    for (const id of identifiersIn(argumentsOf(masked, m.index + m[0].length - 1))) names.add(id);
    const near = lineNeighbourhood(masked, m.index, DRAIN_LOOKBACK);
    for (const [collector, pushed] of collected) {
      const c = escapeIdent(collector);
      const drained = new RegExp(`\\bof\\s+${c}\\b|\\b${c}\\s*\\.\\s*(?:splice|pop|shift|forEach|map|flatMap|values|entries|reverse)\\s*\\(`);
      if (drained.test(near)) for (const id of pushed) names.add(id);
    }
  }
  return names;
}

/** Identifiers holding a path under os.tmpdir(), transitively. `const base = os.tmpdir()` followed
 *  by `mkdtempSync(path.join(base, …))` accumulates in the shared machine tmpdir exactly as a
 *  literal call does, and a substring test for `tmpdir(` alone reports it clean. */
export function tmpdirAliases(masked: string): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    ASSIGNMENT.lastIndex = 0;
    for (let m = ASSIGNMENT.exec(masked); m !== null; m = ASSIGNMENT.exec(masked)) {
      if (aliases.has(m[1])) continue;
      const rhs = m[2];
      if (rhs.includes('tmpdir(') || identifiersIn(rhs).some((id) => aliases.has(id))) {
        aliases.add(m[1]);
        changed = true;
      }
    }
  }
  return aliases;
}

export function leaksIn(file: string, source: string): readonly Leak[] {
  const masked = maskLiterals(source);
  const removed = removedNames(masked);
  const aliases = tmpdirAliases(masked);
  const leaks: Leak[] = [];
  CREATION.lastIndex = 0;
  for (let m = CREATION.exec(masked); m !== null; m = CREATION.exec(masked)) {
    const args = argumentsOf(masked, m.index + m[0].length - 1);
    // A mkdtemp rooted elsewhere is already inside a directory whose owner removes it; only the
    // shared machine tmpdir accumulates across runs.
    if (!args.includes('tmpdir(') && !identifiersIn(args).some((id) => aliases.has(id))) continue;
    const binding = bindingBefore(masked.slice(0, m.index));
    if (binding !== undefined && removed.has(binding)) continue;
    const line = masked.slice(0, m.index).split('\n').length;
    leaks.push(binding === undefined ? { file, line } : { file, line, binding });
  }
  return leaks;
}

function describe(leak: Leak): string {
  return `${leak.file}:${String(leak.line)} (${leak.binding ?? 'unbound'})`;
}

/**
 * Test suites whose `os.tmpdir()` fixtures are never removed.
 *
 * ADVISORY, and this one is the exception to the rule stated in types.ts rather than an instance of
 * it: whether a repo cleans its own fixtures IS a conformance fact about that repo. It lands
 * advisory for blast radius (tkt-91002085c4fd) — every node-tier consumer is non-conformant today,
 * so gating would redden every open PR in the fleet on a diff that changed nothing. Promoting it to
 * gating is a separate, deliberate decision once the fleet is known clean.
 *
 * Scope is test files: they own their fixtures' lifecycle. Production code that creates a tmpdir
 * scratch directory (this repo's own gitignore and tsconfig-strict checks do) is deliberately out,
 * because a library returning a temp directory for its CALLER to remove is not a leak.
 *
 * A PASS is not "this repo leaks nothing": only `mkdtemp`/`mkdtempSync` is matched, so a directory
 * built by `mkdirSync` under a computed name is invisible here. That is not hypothetical — the
 * fleet's single largest pile is hardpack's pid-keyed `mkdirSync` in test-support/vitest.setup.ts
 * (11,277 directories, measured 2026-09-22), which this check cannot see. Weigh that before reading
 * a clean fleet as grounds for promoting this to gating (tkt-5d922d998de4).
 */
export const tmpdirCleanup: AuditCheck = {
  id: 'tmpdir-cleanup',
  tier: 'node',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    // The index, not a directory walk: it excludes node_modules/, dist/ and .claude/worktrees/ by
    // construction rather than by an ignore list that would drift from .gitignore.
    const listed = ctx.exec('git', ['ls-files', '-z'], { cwd: ctx.repoDir });
    if (listed.kind === 'absent') return makeResult(this, 'blocked', 'git is not on PATH, so the tracked test files cannot be enumerated');
    if (listed.kind === 'error') return makeResult(this, 'blocked', `git ls-files failed: ${listed.message}`);
    if (!listed.ok) return makeResult(this, 'blocked', `git ls-files exited non-zero: ${listed.stderr.trim().split('\n')[0] ?? ''}`);

    const files = listed.stdout.split('\0').filter((f) => f !== '' && JS_TS.test(f) && TEST_PATH.test(f));
    if (files.length === 0) {
      return makeResult(this, 'pass', 'no tracked file matched *.test.*, *.spec.*, tests/, __tests__/ or test-support/ — a suite named some other way is NOT covered');
    }

    const leaks: Leak[] = [];
    for (const file of files) {
      const read = ctx.read(file);
      // A tracked file that cannot be read makes the scan PARTIAL, so silence about it would be a
      // clean verdict nobody measured.
      if (read.kind === 'missing') return makeResult(this, 'blocked', `${file} is tracked but absent, so the scan would be partial`);
      if (read.kind === 'error') return makeResult(this, 'blocked', `${file} could not be read: ${read.message}`);
      leaks.push(...leaksIn(file, read.contents));
    }

    if (leaks.length === 0) {
      return makeResult(this, 'pass', `${String(files.length)} test files create no os.tmpdir() directory that nothing removes`);
    }
    const shown = leaks.slice(0, 4).map(describe).join(', ');
    const more = leaks.length > 4 ? `, +${String(leaks.length - 4)} more` : '';
    const where = new Set(leaks.map((l) => l.file)).size;
    return makeResult(
      this,
      'fail',
      `${String(leaks.length)} os.tmpdir() directories in ${String(where)} test files are never removed: ${shown}${more} — bind each mkdtemp result and rmSync it in an afterEach`,
    );
  },
};
