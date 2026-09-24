import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

interface Target {
  readonly path: string;
  /** A file inside it, probed once the target is a real directory. */
  readonly nested: string;
}

/**
 * Each must be ignored as a directory AND as a symlink. A session's worktree may be a symlink, and a
 * worktree's node_modules is a symlink to the primary's rather than a fresh install
 * (tkt-6b1ad6b887fe) — a `dir/` rule misses either link and leaves it for `git add -A` to commit.
 */
const WORKTREES: Target = { path: '.claude/worktrees', nested: '.claude/worktrees/session/file.txt' };
/** Required only beside a root package.json — the same signal config.ts infers the node tier from. */
const NODE_MODULES: Target = { path: 'node_modules', nested: 'node_modules/pkg/index.js' };
/** The guardrail files a conforming repo must be able to COMMIT — see the bare-`.claude/` warning. */
const PROBE_SETTINGS = '.claude/settings.json';

/**
 * Git consults one ignore file per PARENT directory of a path, so exactly these two can decide
 * every target. Copying them — and nothing else — into a scratch repository is what makes
 * the verdict a property of the REPOSITORY rather than of the machine running the audit.
 */
const RULE_FILES = ['.gitignore', '.claude/.gitignore'] as const;

type Verdict =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'not-ignored'; readonly negatedBy: string | null }
  | { readonly kind: 'undetermined'; readonly why: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Asks git whether each path is ignored, in the scratch tree, in ONE invocation.
 *
 * `--no-index` keeps the answer a property of the RULES rather than of what happens to be committed.
 * `-c core.excludesFile=` because a rule in the auditor's own global ignore file would otherwise
 * decide the answer, passing a repository that fails for everyone who clones it — this machine has
 * such a file, and `.claude/` in it is a realistic Claude Code setting. `--stdin -z` because the
 * default `-v` format is `source:line:pattern\tpath`, which has no unambiguous parse;
 * `--non-matching` so every input path gets a record and the results can be matched back by path
 * rather than by position alone.
 */
function probe(ctx: AuditContext, cwd: string, paths: readonly string[]): Map<string, Verdict> | { readonly undetermined: string } {
  const res = ctx.exec('git', ['-c', 'core.excludesFile=', 'check-ignore', '-v', '-z', '--no-index', '--non-matching', '--stdin'], {
    cwd,
    input: paths.map((p) => `${p}\0`).join(''),
  });
  if (res.kind === 'absent') return { undetermined: 'git is not on PATH, so the ignore rules cannot be evaluated' };
  if (res.kind === 'error') return { undetermined: `git check-ignore could not be spawned: ${res.message}` };
  // Death by signal reports a null status, and an injected exec may report none at all. Both are
  // "no verdict", and an unknown verdict must never resolve to the permissive one.
  if (typeof res.status !== 'number') return { undetermined: 'git check-ignore produced no exit code, so its answer is unknown' };
  // With --non-matching, 0 and 1 both mean it RAN (1 is "nothing matched"); 128 is fatal. Collapsing
  // that into "not ignored" would report a broken probe as a repository defect.
  if (res.status !== 0 && res.status !== 1) {
    const why = res.stderr.trim().split('\n')[0] ?? '';
    return { undetermined: `git check-ignore exited ${res.status}${why === '' ? '' : ` — ${why}`}` };
  }
  const fields = res.stdout.split('\0');
  const verdicts = new Map<string, Verdict>();
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const pattern = fields[i + 2] ?? '';
    const forPath = fields[i + 3] ?? '';
    // Exit 0 means a rule MATCHED, not that the path is ignored: a negation matches too, and with
    // --non-matching an empty pattern is a path no rule touched at all.
    if (pattern === '') verdicts.set(forPath, { kind: 'not-ignored', negatedBy: null });
    else if (pattern.startsWith('!')) verdicts.set(forPath, { kind: 'not-ignored', negatedBy: pattern });
    else verdicts.set(forPath, { kind: 'ignored' });
  }
  // Reading a record back for every path asked about is the instrument's own control: a short or
  // misaligned answer must not silently leave a path unjudged.
  for (const p of paths) {
    if (!verdicts.has(p)) return { undetermined: `git check-ignore returned no verdict for ${p}` };
  }
  return verdicts;
}

interface Scratch {
  readonly dir: string;
  readonly cleanup: () => void;
}

/**
 * A throwaway repository holding only this repo's ignore rules.
 *
 * The audit's question is what a FRESH CLONE does, and asking git in the audited checkout answers a
 * different one: `check-ignore` resolves a `dir/` pattern against the WORKING TREE, so the broken
 * trailing-slash rule reads as conforming wherever `.claude/worktrees` already exists as a real
 * directory — which `worktree` itself creates and leaves behind (tkt-45ddb02e4280). Here the shape
 * is chosen deliberately instead of inherited.
 */
function buildScratch(ctx: AuditContext): Scratch | { readonly failed: string } {
  let dir: string;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'tw-gitignore-'));
  } catch (err) {
    return { failed: `a scratch repository could not be created: ${message(err)}` };
  }
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leaked temp directory must not turn a real verdict into a blocked one.
    }
  };
  // `--template=`: a custom init.templateDir can ship its own info/exclude, which would put the
  // machine back in the answer.
  const init = ctx.exec('git', ['init', '-q', '--template=', dir]);
  if (init.kind !== 'ran' || init.status !== 0) {
    cleanup();
    const why = init.kind === 'ran' ? `git init exited ${String(init.status)}` : init.kind === 'absent' ? 'git is not on PATH' : init.message;
    return { failed: `a scratch repository could not be initialised: ${why}` };
  }
  try {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    for (const rel of RULE_FILES) {
      const rule = ctx.read(rel);
      if (rule.kind === 'ok') writeFileSync(path.join(dir, rel), rule.contents);
    }
    writeFileSync(path.join(dir, PROBE_SETTINGS), '{}\n');
  } catch (err) {
    cleanup();
    return { failed: `the scratch repository could not be populated: ${message(err)}` };
  }
  return { dir, cleanup };
}

/** Materialises a target as a symlink, then as a real directory — a `dir/` pattern matches only
 *  the second, and git reads the shape off the filesystem rather than the path string. */
function shape(dir: string, target: Target, as: 'symlink' | 'directory'): string | null {
  const at = path.join(dir, target.path);
  try {
    // The previous shape leaves a DANGLING symlink, which `rmSync(force)` stats through and treats
    // as already gone — so the swap silently kept the symlink and mkdir then failed with ENOENT.
    try {
      unlinkSync(at);
    } catch {
      // Nothing there, or a real directory: rmSync below handles both.
    }
    rmSync(at, { recursive: true, force: true });
    if (as === 'symlink') {
      // Deliberately dangling: git lstats it, so the target need not exist.
      symlinkSync(path.join(dir, 'no-such-link-target'), at);
      return null;
    }
    const nested = path.join(dir, target.nested);
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, '');
    return null;
  } catch (err) {
    return `the ${as} probe of ${target.path} could not be materialised: ${message(err)}`;
  }
}

/** Null when the target is ignored in both shapes; otherwise what is wrong and how to fix it. */
function defect(target: Target, symlink: Verdict, directory: Verdict, nested: Verdict): string | null {
  if (symlink.kind === 'ignored' && nested.kind === 'ignored') return null;
  // The directory's own verdict only names a negation: a file under a re-included directory reports
  // no rule at all, so `!dir/` would otherwise go unnamed.
  const negated = [symlink, directory, nested].map((v) => (v.kind === 'not-ignored' ? v.negatedBy : null)).find((n) => n !== null) ?? null;
  if (negated !== null) return `${target.path} is re-included by \`${negated}\`, so it is not ignored after all — drop that negation`;
  if (nested.kind === 'ignored') {
    // Also reached by `dir/*` and `dir/**`, which match only the contents — so the fix names the
    // rule to write, not just the slash to drop.
    return `the rule ignoring ${target.path} matches it only as a DIRECTORY (a trailing slash, or a /* or /** glob), so a SYMLINKED ${target.path} is left untracked-but-visible — write it bare: ${target.path}`;
  }
  return `.gitignore does not ignore ${target.path} — add \`${target.path}\` (no trailing slash, so it covers a symlink too)`;
}

export const gitignore: AuditCheck = {
  id: 'gitignore',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('.gitignore');
    if (file.kind === 'missing') return makeResult(this, 'fail', '.gitignore is absent');
    if (file.kind === 'error') return makeResult(this, 'blocked', `.gitignore could not be read: ${file.message}`);
    if (file.contents.trim() === '') return makeResult(this, 'fail', '.gitignore is empty');

    const pkg = ctx.read('package.json');
    if (pkg.kind === 'error') return makeResult(this, 'blocked', `package.json could not be read, so whether node_modules must be ignored is unknown: ${pkg.message}`);
    const TARGETS = pkg.kind === 'ok' ? [WORKTREES, NODE_MODULES] : [WORKTREES];

    const scratch = buildScratch(ctx);
    if ('failed' in scratch) return makeResult(this, 'blocked', scratch.failed);
    try {
      for (const t of TARGETS) {
        const failed = shape(scratch.dir, t, 'symlink');
        if (failed !== null) return makeResult(this, 'blocked', failed);
      }
      const asLink = probe(ctx, scratch.dir, TARGETS.map((t) => t.path));
      if ('undetermined' in asLink) return makeResult(this, 'blocked', asLink.undetermined);

      // A second shape, because a `dir/` pattern matches only this one — and git reads the shape off
      // the filesystem, never off the path string.
      for (const t of TARGETS) {
        const failed = shape(scratch.dir, t, 'directory');
        if (failed !== null) return makeResult(this, 'blocked', failed);
      }
      const asDir = probe(ctx, scratch.dir, [...TARGETS.flatMap((t) => [t.path, t.nested]), PROBE_SETTINGS]);
      if ('undetermined' in asDir) return makeResult(this, 'blocked', asDir.undetermined);

      const verdictOf = (m: Map<string, Verdict>, p: string): Verdict => m.get(p) ?? { kind: 'undetermined', why: `no verdict for ${p}` };
      const settings = verdictOf(asDir, PROBE_SETTINGS);
      const defects: string[] = [];
      for (const t of TARGETS) {
        const symlink = verdictOf(asLink, t.path);
        const directory = verdictOf(asDir, t.path);
        const nested = verdictOf(asDir, t.nested);
        for (const v of [symlink, directory, nested]) {
          if (v.kind === 'undetermined') return makeResult(this, 'blocked', v.why);
        }
        const d = defect(t, symlink, directory, nested);
        if (d !== null) defects.push(d);
      }
      if (settings.kind === 'undetermined') return makeResult(this, 'blocked', settings.why);
      // Every defect, not the first: reporting one at a time sends someone round the re-audit loop twice.
      if (defects.length > 0) return makeResult(this, 'fail', defects.join('; '));

      const conforms = `.gitignore present, non-empty, and ignores ${TARGETS.map((t) => t.path).join(' and ')} as a directory AND as a symlink`;
      if (settings.kind === 'ignored') {
        // A blanket `.claude/` reaches the worktree effect by ignoring far more than was asked, and
        // the settings and hooks the standard requires can then never be committed. Reported rather
        // than failed: the effect this check exists for IS achieved, and stricter is not a defect.
        return makeResult(this, 'pass', `${conforms} — WARNING: ${PROBE_SETTINGS} is ignored too, so the guardrail files cannot be committed`);
      }
      return makeResult(this, 'pass', conforms);
    } finally {
      scratch.cleanup();
    }
  },
};
