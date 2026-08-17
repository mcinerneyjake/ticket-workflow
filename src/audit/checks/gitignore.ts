import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

/** Where `ticket-workflow worktree` puts a session's isolated checkout. */
const WORKTREE_ENTRY = '.claude/worktrees/';

/**
 * True when the file ignores the worktree directory — either by naming it, or by ignoring all of
 * `.claude/`, which is stricter and therefore also satisfies the intent. Reading only the exact
 * string would fail a repo that had done MORE than asked, which is how a check teaches people to
 * work around it.
 */
export function ignoresWorktrees(contents: string): boolean {
  return contents
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .some((l) => {
      const entry = l.replace(/^\//, '');
      return entry === WORKTREE_ENTRY || entry === '.claude/worktrees' || entry === '.claude/' || entry === '.claude';
    });
}

export const gitignore: AuditCheck = {
  id: 'gitignore',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('.gitignore');
    if (file.kind === 'missing') return makeResult(this, 'fail', '.gitignore is absent');
    if (file.kind === 'error') return makeResult(this, 'blocked', `.gitignore could not be read: ${file.message}`);
    if (file.contents.trim() === '') return makeResult(this, 'fail', '.gitignore is empty');
    // Concurrent sessions need one worktree each, and a worktree that is not ignored shows up as a
    // mountain of untracked files in the main checkout — which is exactly when someone reaches for
    // `git add -A` and commits another session's in-flight work.
    if (!ignoresWorktrees(file.contents)) {
      return makeResult(this, 'fail', `.gitignore does not ignore ${WORKTREE_ENTRY} — add it so per-session worktrees stay untracked`);
    }
    return makeResult(this, 'pass', `.gitignore present, non-empty, and ignores ${WORKTREE_ENTRY}`);
  },
};
