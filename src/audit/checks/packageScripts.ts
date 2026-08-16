import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const REQUIRED_SCRIPTS = ['typecheck', 'lint', 'test', 'test:coverage', 'build'];

export const packageScripts: AuditCheck = {
  id: 'package-scripts',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('package.json');
    if (file.kind === 'missing') return makeResult(this, 'fail', 'package.json is absent in a node-tier repo');
    if (file.kind === 'error') return makeResult(this, 'blocked', `package.json could not be read: ${file.message}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.contents);
    } catch (err) {
      return makeResult(this, 'blocked', `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const scripts =
      typeof parsed === 'object' && parsed !== null && 'scripts' in parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null
        ? Object.keys(parsed.scripts)
        : [];
    const missing = REQUIRED_SCRIPTS.filter((s) => !scripts.includes(s));
    if (missing.length > 0) {
      return makeResult(this, 'fail', `package.json scripts missing: ${missing.join(', ')} — the gate cannot run what does not exist`);
    }
    return makeResult(this, 'pass', `all gate scripts declared (${REQUIRED_SCRIPTS.join(', ')})`);
  },
};
