import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

/** Where `ticket-workflow worktree` puts a session's isolated checkout. */
const WORKTREE_DIR = '.claude/worktrees';
const PROBE_NESTED = `${WORKTREE_DIR}/session/file.txt`;
/** The guardrail files a conforming repo must be able to COMMIT — see the bare-`.claude/` warning. */
const PROBE_SETTINGS = '.claude/settings.json';

/**
 * Git consults one ignore file per PARENT directory of a path, so exactly these two can decide
 * `.claude/worktrees`. Copying them — and nothing else — into a scratch repository is what makes
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

/** Materialises `.claude/worktrees` as a symlink, then as a real directory — a `dir/` pattern
 *  matches only the second, and git reads the shape off the filesystem rather than the path string. */
function shapeWorktree(dir: string, as: 'symlink' | 'directory'): string | null {
  const at = path.join(dir, WORKTREE_DIR);
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
      symlinkSync(path.join(dir, 'no-such-worktree-target'), at);
      return null;
    }
    mkdirSync(path.join(at, 'session'), { recursive: true });
    writeFileSync(path.join(dir, PROBE_NESTED), '');
    return null;
  } catch (err) {
    return `the ${as} probe could not be materialised: ${message(err)}`;
  }
}

export const gitignore: AuditCheck = {
  id: 'gitignore',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('.gitignore');
    if (file.kind === 'missing') return makeResult(this, 'fail', '.gitignore is absent');
    if (file.kind === 'error') return makeResult(this, 'blocked', `.gitignore could not be read: ${file.message}`);
    if (file.contents.trim() === '') return makeResult(this, 'fail', '.gitignore is empty');

    const scratch = buildScratch(ctx);
    if ('failed' in scratch) return makeResult(this, 'blocked', scratch.failed);
    try {
      const asSymlink = shapeWorktree(scratch.dir, 'symlink');
      if (asSymlink !== null) return makeResult(this, 'blocked', asSymlink);
      const asLink = probe(ctx, scratch.dir, [WORKTREE_DIR]);
      if ('undetermined' in asLink) return makeResult(this, 'blocked', asLink.undetermined);

      // A second shape, because a `dir/` pattern matches only this one — and git reads the shape off
      // the filesystem, never off the path string.
      const asDirectory = shapeWorktree(scratch.dir, 'directory');
      if (asDirectory !== null) return makeResult(this, 'blocked', asDirectory);
      const asDir = probe(ctx, scratch.dir, [PROBE_NESTED, PROBE_SETTINGS]);
      if ('undetermined' in asDir) return makeResult(this, 'blocked', asDir.undetermined);

      const symlink = asLink.get(WORKTREE_DIR) ?? { kind: 'undetermined', why: `no verdict for ${WORKTREE_DIR}` };
      const nested = asDir.get(PROBE_NESTED) ?? { kind: 'undetermined', why: `no verdict for ${PROBE_NESTED}` };
      const settings = asDir.get(PROBE_SETTINGS) ?? { kind: 'undetermined', why: `no verdict for ${PROBE_SETTINGS}` };
      for (const v of [symlink, nested, settings]) {
        if (v.kind === 'undetermined') return makeResult(this, 'blocked', v.why);
      }
      // Concurrent sessions need one worktree each, and a worktree that is not ignored shows up as a
      // mountain of untracked files in the main checkout — which is exactly when someone reaches for
      // `git add -A` and commits another session's in-flight work.
      if (symlink.kind !== 'ignored' || nested.kind !== 'ignored') {
        const negated = (symlink.kind === 'not-ignored' ? symlink.negatedBy : null) ?? (nested.kind === 'not-ignored' ? nested.negatedBy : null);
        if (negated !== null) {
          return makeResult(this, 'fail', `${WORKTREE_DIR} is re-included by \`${negated}\`, so it is not ignored after all — drop that negation`);
        }
        if (nested.kind === 'ignored') {
          return makeResult(
            this,
            'fail',
            `the rule ignoring ${WORKTREE_DIR} matches DIRECTORIES only, so a SYMLINKED worktree is left untracked-but-visible — drop the trailing slash: ${WORKTREE_DIR}`,
          );
        }
        return makeResult(this, 'fail', `.gitignore does not ignore ${WORKTREE_DIR} — add \`${WORKTREE_DIR}\` (no trailing slash, so it covers a symlinked worktree too)`);
      }

      const conforms = `.gitignore present, non-empty, and ignores ${WORKTREE_DIR} as a directory AND as a symlink`;
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
