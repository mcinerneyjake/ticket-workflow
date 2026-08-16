import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

export const huskyPreCommit: AuditCheck = {
  id: 'husky-pre-commit',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('.husky/pre-commit');
    if (file.kind === 'missing') return makeResult(this, 'fail', '.husky/pre-commit is absent — no local gate before commits');
    if (file.kind === 'error') return makeResult(this, 'blocked', `.husky/pre-commit could not be read: ${file.message}`);
    // The scrub must come first: git exports an absolute GIT_DIR in worktrees, and every child
    // inherits it — a gate that skips the scrub points its suites at the real repo. Comments are
    // stripped before the offset comparison so a header merely NAMING the gate cannot invert it.
    const body = file.contents.replace(/^\s*#.*$/gm, '');
    const scrubAt = body.indexOf('unset GIT_DIR');
    const gateAt = body.search(/npm run typecheck|npm test/);
    if (gateAt === -1) return makeResult(this, 'fail', '.husky/pre-commit never runs the gate commands');
    if (scrubAt === -1) return makeResult(this, 'fail', '.husky/pre-commit is missing the GIT_DIR scrub — the gate breaks from any worktree');
    if (scrubAt > gateAt) return makeResult(this, 'fail', '.husky/pre-commit scrubs GIT_DIR after the gate has already run');
    return makeResult(this, 'pass', '.husky/pre-commit runs the gate behind the GIT_DIR scrub');
  },
};
