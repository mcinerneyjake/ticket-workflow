import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { depthBetween, maskSource, objectBodies, type Masked } from './configSource.js';
import { resolveVitestConfig } from './vitestConfig.js';

interface Bodies {
  readonly bodies: ReadonlyArray<readonly [number, number]>;
  readonly unbalanced: boolean;
}

/** Bodies of `<key>: {` that are DIRECT children of `within`. */
function childBodies(m: Masked, key: string, within: readonly [number, number]): Bodies {
  const scan = objectBodies(m, key);
  const [start, end] = within;
  return {
    bodies: scan.bodies.filter(([s]) => s > start && s <= end && depthBetween(m.masked, start, s - 1) === 0),
    unbalanced: scan.unbalanced,
  };
}

type Thresholds =
  | { readonly kind: 'found'; readonly interior: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'undeterminable' };

/**
 * The coverage `thresholds` interior, delimited structurally rather than by a regex over
 * comment-stripped text.
 *
 * The stripping this replaces deleted from a `//` INSIDE a string — a proxy target or a docs URL,
 * both routine in the `vite.config.ts` this check now reads — which removed the brace closing
 * `thresholds`; the trailing-`}` search then ran on into the next block and read an unrelated digit
 * as a floor, passing a gate whose only threshold was 0.
 *
 * Read off the MASKED source, so a digit inside a string can no longer count as a floor either.
 */
function thresholdsOf(contents: string): Thresholds {
  const m = maskSource(contents);
  // test -> coverage -> thresholds, each a DIRECT child. Searching `coverage` anywhere kept exactly
  // the depth-blind fail-open that `directChildOnly` closed for `test`: a nested
  // `build.rollupOptions.coverage.thresholds` outranked the real block and passed a floor of 0.
  const test = objectBodies(m, 'test', { directChildOnly: true });
  if (test.unbalanced) return { kind: 'undeterminable' };
  for (const body of test.bodies) {
    const coverage = childBodies(m, 'coverage', body);
    if (coverage.unbalanced) return { kind: 'undeterminable' };
    for (const cov of coverage.bodies) {
      const th = childBodies(m, 'thresholds', cov);
      if (th.unbalanced) return { kind: 'undeterminable' };
      const first = th.bodies[0];
      if (first !== undefined) return { kind: 'found', interior: m.masked.slice(first[0], first[1]) };
    }
  }
  return { kind: 'absent' };
}

export const vitestCoverage: AuditCheck = {
  id: 'vitest-coverage',
  tier: 'node',
  run(ctx: AuditContext): AuditResult {
    const config = resolveVitestConfig(ctx);
    if (config.kind === 'error') return makeResult(this, 'blocked', `${config.file} could not be read: ${config.message}`);
    if (config.kind === 'ambiguous' || config.kind === 'undeterminable') return makeResult(this, 'blocked', config.detail);
    if (config.kind === 'missing') return makeResult(this, 'fail', 'no vitest config found — the test gate has no configuration');
    const where = config.file;
    const thresholds = thresholdsOf(config.contents);
    if (thresholds.kind === 'undeterminable') {
      return makeResult(this, 'blocked', `${where} has an unclosed \`{\`, so its coverage thresholds cannot be delimited — check it by hand`);
    }
    // A commented-out block, `thresholds: {}` and all-zero floors each certify a coverage gate that
    // asserts nothing. (A threshold inherited through mergeConfig from a shared base is a known
    // false FAIL — declare the exemption if that is the real shape.)
    if (thresholds.kind === 'absent') {
      return makeResult(this, 'fail', `${where} declares no coverage thresholds — the coverage gate asserts nothing`);
    }
    if (!/[1-9]/.test(thresholds.interior)) {
      return makeResult(this, 'fail', `${where} has a thresholds block with no non-zero floor — it gates nothing`);
    }
    return makeResult(this, 'pass', `${where} declares non-zero coverage thresholds`);
  },
};
