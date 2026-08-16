import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

// The standard requires CLAUDE.md to carry the gate commands and the branch/PR workflow —
// presence alone is not the guardrail, a session actually being instructed is. Anchored to the
// actual command spellings: bare substrings let 'latest' satisfy 'test' and certify a CLAUDE.md
// with zero workflow content.
const REQUIRED_MARKERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'npm run typecheck', pattern: /npm run typecheck/ },
  { label: 'npm run lint', pattern: /npm run lint/ },
  { label: 'npm test', pattern: /npm (run )?test/ },
  { label: 'branch workflow', pattern: /\bbranch\b/ },
];

export const claudeMd: AuditCheck = {
  id: 'claude-md',
  tier: 'core',
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read('CLAUDE.md');
    if (file.kind === 'missing') return makeResult(this, 'fail', 'CLAUDE.md is absent — sessions here get no workflow instructions');
    if (file.kind === 'error') return makeResult(this, 'blocked', `CLAUDE.md could not be read: ${file.message}`);
    const lower = file.contents.toLowerCase();
    const missing = REQUIRED_MARKERS.filter((m) => !m.pattern.test(lower)).map((m) => m.label);
    if (missing.length > 0) {
      return makeResult(this, 'fail', `CLAUDE.md never mentions: ${missing.join(', ')} — the gate commands and branch workflow belong in it`);
    }
    return makeResult(this, 'pass', 'CLAUDE.md present and names the gate commands and branch workflow');
  },
};
