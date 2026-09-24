import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The JSON reporter drops unhandled errors, and vitest exits 1 for them as for a timeout, so only a reporter hook sees
// them (tkt-b1182a02fb14). Imports nothing from vitest: it loads under the consumer's vitest, not ours.

export const CONTENTION_EVIDENCE_ENV = 'TEST_CONTENTION_EVIDENCE';

export interface RunEvidence {
  readonly version: 2;
  readonly unhandledErrors: number;
  /** Thresholds are checked after a failed test only under `reportOnFailure`, and a breach exits 1 too. */
  readonly coverageAfterFailure: boolean;
  /**
   * globalSetup files other than ticket-workflow's own. Their teardown runs in close(), after this reporter, and Node's
   * exitCode accessor is non-configurable, so an exit code one sets there is unobservable (tkt-e51870afd0da).
   */
  readonly foreignGlobalSetup: readonly string[];
  /** Whether ticket-workflow's own globalSetup is declared. Without it a held slot is released by an exit hook, whose failure nothing logs. */
  readonly ownGlobalSetup: boolean;
}

interface CoverageConfig {
  readonly enabled?: boolean;
  readonly reportOnFailure?: boolean;
  readonly thresholds?: object;
}

const OWN_GLOBAL_SETUP = ['/src/test-run/globalSetup.ts', '/dist/test-run/globalSetup.js'];

/** Ours only where its package root says so: our failed release throws, so vitest logs it where the run log can see it. */
export function isOwnGlobalSetup(file: string): boolean {
  // vitest resolves globalSetup with forward slashes on every platform.
  const slashed = file.replaceAll('\\', '/');
  const own = OWN_GLOBAL_SETUP.find((suffix) => slashed.endsWith(suffix));
  if (own === undefined) return false;
  try {
    const pkg: unknown = JSON.parse(readFileSync(path.join(slashed.slice(0, -own.length), 'package.json'), 'utf8'));
    return typeof pkg === 'object' && pkg !== null && 'name' in pkg && pkg.name === 'ticket-workflow';
  } catch {
    return false;
  }
}

export default class ContentionEvidenceReporter {
  // null until onInit reads the config: evidence that never saw it must not claim coverage was clear.
  private coverageAfterFailure: boolean | null = null;
  private globalSetup: { readonly foreign: readonly string[]; readonly own: boolean } | null = null;

  onInit(ctx: {
    readonly config: { readonly coverage?: CoverageConfig; readonly globalSetup?: unknown };
    readonly projects?: readonly { readonly config: { readonly globalSetup?: unknown } }[];
  }): void {
    const c = ctx.config.coverage;
    this.coverageAfterFailure = c?.enabled === true && c.reportOnFailure === true && c.thresholds !== undefined && Object.keys(c.thresholds).length > 0;
    // Under a projects split a project's own globalSetup is on that project only, never on the root config.
    const declared = [ctx.config.globalSetup, ...(ctx.projects ?? []).map((p) => p.config.globalSetup)];
    const files = declared.flatMap((gs): unknown[] => (gs === undefined ? [] : Array.isArray(gs) ? gs : [gs]));
    // An entry this cannot name stays null: no evidence is written, and the run is undetermined.
    if (!files.every((f) => typeof f === 'string')) return;
    const unique = [...new Set(files)];
    this.globalSetup = { foreign: unique.filter((f) => !isOwnGlobalSetup(f)), own: unique.some(isOwnGlobalSetup) };
  }

  onTestRunEnd(_modules: readonly object[], unhandledErrors: readonly object[]): void {
    const file = process.env[CONTENTION_EVIDENCE_ENV];
    if (file === undefined || file === '' || this.coverageAfterFailure === null || this.globalSetup === null) return;
    const evidence: RunEvidence = {
      version: 2,
      unhandledErrors: unhandledErrors.length,
      coverageAfterFailure: this.coverageAfterFailure,
      foreignGlobalSetup: this.globalSetup.foreign,
      ownGlobalSetup: this.globalSetup.own,
    };
    writeFileSync(file, JSON.stringify(evidence));
  }
}
