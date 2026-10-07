import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { lineCount } from './skills.js';

export const CLAUDE_MD_LINE_CAP = 60;

// The two tracked CLAUDE.md locations only: @imports and .claude/rules/ are NOT measured, and
// CLAUDE.local.md is gitignored, so CI could never agree with a local run on it.
const CLAUDE_MD_PATHS = ['CLAUDE.md', '.claude/CLAUDE.md'] as const;

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

export const claudeMdLineCap: AuditCheck = {
  id: 'claude-md-line-cap',
  tier: 'core',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    const over: string[] = [];
    const measured: string[] = [];
    const unreadable: string[] = [];
    for (const rel of CLAUDE_MD_PATHS) {
      const file = ctx.read(rel);
      if (file.kind === 'missing') continue;
      if (file.kind === 'error') {
        unreadable.push(`${rel} could not be read: ${file.message}`);
        continue;
      }
      const lines = lineCount(file.contents);
      const label = `${rel} (${lines})`;
      measured.push(label);
      if (lines > CLAUDE_MD_LINE_CAP) over.push(label);
    }
    // A known violation outranks an unreadable sibling, which would otherwise hide it behind BLOCKED.
    if (over.length > 0) {
      const also = unreadable.length > 0 ? `; also ${unreadable.join('; ')}` : '';
      return makeResult(this, 'fail', `over ${CLAUDE_MD_LINE_CAP} lines: ${over.join(', ')} — move detail into skills, reference docs or checks loaded on demand${also}`);
    }
    if (unreadable.length > 0) return makeResult(this, 'blocked', unreadable.join('; '));
    if (measured.length === 0) return makeResult(this, 'pass', 'no CLAUDE.md or .claude/CLAUDE.md to measure');
    return makeResult(this, 'pass', `${measured.join(', ')} — all ≤ ${CLAUDE_MD_LINE_CAP} lines`);
  },
};
