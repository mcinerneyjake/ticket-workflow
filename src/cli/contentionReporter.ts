import { writeFileSync } from 'node:fs';

// The JSON reporter drops unhandled errors, and vitest exits 1 for them as for a timeout, so only a reporter hook sees
// them (tkt-b1182a02fb14). Imports nothing from vitest: it loads under the consumer's vitest, not ours.

export const CONTENTION_EVIDENCE_ENV = 'TEST_CONTENTION_EVIDENCE';

export interface RunEvidence {
  readonly version: 1;
  readonly unhandledErrors: number;
  /** Thresholds are checked after a failed test only under `reportOnFailure`, and a breach exits 1 too. */
  readonly coverageAfterFailure: boolean;
}

interface CoverageConfig {
  readonly enabled?: boolean;
  readonly reportOnFailure?: boolean;
  readonly thresholds?: object;
}

export default class ContentionEvidenceReporter {
  // null until onInit reads the config: evidence that never saw it must not claim coverage was clear.
  private coverageAfterFailure: boolean | null = null;

  onInit(ctx: { readonly config: { readonly coverage?: CoverageConfig } }): void {
    const c = ctx.config.coverage;
    this.coverageAfterFailure = c?.enabled === true && c.reportOnFailure === true && c.thresholds !== undefined && Object.keys(c.thresholds).length > 0;
  }

  onTestRunEnd(_modules: readonly object[], unhandledErrors: readonly object[]): void {
    const file = process.env[CONTENTION_EVIDENCE_ENV];
    if (file === undefined || file === '' || this.coverageAfterFailure === null) return;
    const evidence: RunEvidence = { version: 1, unhandledErrors: unhandledErrors.length, coverageAfterFailure: this.coverageAfterFailure };
    writeFileSync(file, JSON.stringify(evidence));
  }
}
