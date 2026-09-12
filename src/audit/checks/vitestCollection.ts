import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { depthBetween, matchDelimiter, maskSource, objectBodies, type Masked } from './configSource.js';
import { declaresRoot, resolveVitestConfig } from './vitestConfig.js';

/** Where `ticket-workflow worktree` puts a session's isolated checkout — a full second copy of the
 *  repo, suites and all, nested INSIDE the tree vitest collects from. */
const WORKTREE_DIR = '.claude/worktrees';
const RECURSIVE = `${WORKTREE_DIR}/**`;

interface Collection {
  /** Whether a test-level `exclude` array exists at all — absent and empty are different repairs. */
  readonly declared: boolean;
  readonly globs: readonly string[];
  /** An unclosed `{` left a body undelimitable, so `declared` under-reports and cannot be trusted. */
  readonly unbalanced: boolean;
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
  // directChildOnly: a `test` object nested under another key is not the vitest block, and adopting
  // one let `build: { rollupOptions: { test: { exclude: [...] } } }` certify the whole repo.
  const scan = objectBodies(m, 'test', { directChildOnly: true });
  for (const [start, end] of scan.bodies) {
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
  return { declared, globs, unbalanced: scan.unbalanced };
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
    const config = resolveVitestConfig(ctx);
    if (config.kind === 'error') return makeResult(this, 'blocked', `${config.file} could not be read: ${config.message}`);
    if (config.kind === 'ambiguous' || config.kind === 'undeterminable') return makeResult(this, 'blocked', config.detail);
    if (config.kind === 'missing') {
      // No config means vitest's own defaults, which collect `**/*.test.*` from the root — the
      // worktree included. Absent configuration is the vulnerable state, not an unknown one.
      return makeResult(this, 'fail', `no vitest config found — the default collection is recursive from the repo root, so a worktree under ${WORKTREE_DIR} is collected twice`);
    }
    const where = config.file;
    if (config.nested) {
      // vitest roots at its config's own directory, so `<repo>/.claude/worktrees` is not merely
      // un-excluded — it is outside collection entirely, and a root-relative glob asked for here
      // could never match. The doubling this check exists to prevent cannot arise.
      //
      // Unless the config moves that root itself: `root: '..'` collects the whole repo again, which
      // this branch cannot see past, so it declines to answer rather than assert the opposite.
      if (declaresRoot(config.contents)) {
        return makeResult(this, 'blocked', `${where} sets its own \`root\`, so whether ${WORKTREE_DIR} falls inside its collection root cannot be read off the file — check it by hand`);
      }
      return makeResult(this, 'pass', `${where} collects from ${config.dir}/, so ${WORKTREE_DIR} at the repo root is outside its collection root`);
    }
    const { declared, globs, unbalanced } = collectionExcludes(maskSource(config.contents));
    if (unbalanced) {
      return makeResult(this, 'blocked', `${where} has an unclosed \`{\` — its \`test\` block cannot be delimited, so no exclude can be attributed to it`);
    }
    if (!declared) {
      return makeResult(this, 'fail', `${where} declares no test-level exclude — vitest's defaults do not cover ${WORKTREE_DIR}, so a worktree's suites are collected twice`);
    }
    if (globs.some(covers)) {
      return makeResult(this, 'pass', `${where} excludes ${RECURSIVE} from test collection`);
    }
    const broad = globs.find(coversViaClaude);
    if (broad !== undefined) {
      // The doubled collection IS prevented, so this is reported rather than failed — the same
      // call the gitignore check makes for a blanket `.claude/`. Stricter is not a defect.
      return makeResult(this, 'pass', `${where} excludes ${WORKTREE_DIR} via \`${broad}\` — WARNING: that glob is over-broad and also drops any suite kept under .claude/`);
    }
    const named = globs.find((g) => g.includes(WORKTREE_DIR));
    if (named !== undefined) {
      // tkt-17d81c74b662 measured the `/*` form: it matches the worktree DIRECTORY but not the
      // suites nested inside it, so the doubled run survives a glob that reads as present.
      return makeResult(this, 'fail', `${where} excludes \`${named}\`, which does not reach the suites NESTED in a worktree — it must be exactly ${RECURSIVE}`);
    }
    return makeResult(this, 'fail', `${where} does not exclude ${WORKTREE_DIR} from test collection — add \`${RECURSIVE}\`, or a worktree's full second checkout doubles every suite and reddens the local gate`);
  },
};
