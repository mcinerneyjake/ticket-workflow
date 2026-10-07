import { GLOSSARY_FILE } from '../../templates.js';
import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { lineCount } from './skills.js';

export const GLOSSARY_LINE_CAP = 120;

export const glossaryLineCap: AuditCheck = {
  id: 'glossary-line-cap',
  tier: 'core',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    const file = ctx.read(GLOSSARY_FILE);
    if (file.kind === 'missing') return makeResult(this, 'pass', `no ${GLOSSARY_FILE} to measure`);
    if (file.kind === 'error') return makeResult(this, 'blocked', `${GLOSSARY_FILE} could not be read: ${file.message}`);
    const lines = lineCount(file.contents);
    if (lines > GLOSSARY_LINE_CAP) {
      return makeResult(this, 'fail', `${GLOSSARY_FILE} (${lines}) is over ${GLOSSARY_LINE_CAP} lines — prune terms the code no longer uses, keep each entry to a line or two`);
    }
    return makeResult(this, 'pass', `${GLOSSARY_FILE} (${lines}) — ≤ ${GLOSSARY_LINE_CAP} lines`);
  },
};
