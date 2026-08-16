import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

export const dependabot: AuditCheck = {
  id: 'dependabot',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('.github/dependabot.yml');
    if (file.kind === 'missing') return makeResult(this, 'fail', '.github/dependabot.yml is absent — no scheduled dependency updates');
    if (file.kind === 'error') return makeResult(this, 'blocked', `.github/dependabot.yml could not be read: ${file.message}`);
    if (file.contents.trim() === '') return makeResult(this, 'fail', '.github/dependabot.yml is empty');
    return makeResult(this, 'pass', '.github/dependabot.yml present');
  },
};
