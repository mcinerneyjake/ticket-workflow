import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';

const CANDIDATES = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'];

export const vitestCoverage: AuditCheck = {
  id: 'vitest-coverage',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    for (const candidate of CANDIDATES) {
      const file = ctx.read(candidate);
      if (file.kind === 'error') return makeResult(this, 'blocked', `${candidate} could not be read: ${file.message}`);
      if (file.kind === 'missing') continue;
      // Comments stripped first, and the thresholds object must carry a non-zero number: a
      // commented-out block, `thresholds: {}` and all-zero floors each certify a coverage gate
      // that asserts nothing. (A threshold inherited through mergeConfig from a shared base is a
      // known false FAIL — declare the exemption if that is the real shape.)
      const uncommented = file.contents.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const thresholdsBlock = /thresholds\s*:\s*\{([^}]*)\}/.exec(uncommented)?.[1];
      if (thresholdsBlock === undefined) {
        return makeResult(this, 'fail', `${candidate} declares no coverage thresholds — the coverage gate asserts nothing`);
      }
      if (!/[1-9]/.test(thresholdsBlock)) {
        return makeResult(this, 'fail', `${candidate} has a thresholds block with no non-zero floor — it gates nothing`);
      }
      return makeResult(this, 'pass', `${candidate} declares non-zero coverage thresholds`);
    }
    return makeResult(this, 'fail', 'no vitest config found — the test gate has no configuration');
  },
};
