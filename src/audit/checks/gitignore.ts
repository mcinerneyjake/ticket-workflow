import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

export const gitignore: AuditCheck = {
  id: 'gitignore',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('.gitignore');
    if (file.kind === 'missing') return makeResult(this, 'fail', '.gitignore is absent');
    if (file.kind === 'error') return makeResult(this, 'blocked', `.gitignore could not be read: ${file.message}`);
    if (file.contents.trim() === '') return makeResult(this, 'fail', '.gitignore is empty');
    return makeResult(this, 'pass', '.gitignore present and non-empty');
  },
};
