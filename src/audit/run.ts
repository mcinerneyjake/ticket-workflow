import path from 'node:path';
import { claudeMd } from './checks/claudeMd.js';
import { gitignore } from './checks/gitignore.js';
import { ciGateJob, ciBranchNameJob } from './checks/workflowJobs.js';
import { dependabot } from './checks/dependabot.js';
import { hookLauncher } from './checks/hookLauncher.js';
import { hookSettings } from './checks/hookSettings.js';
import { hookArming } from './checks/hookArming.js';
import { branchProtection } from './checks/branchProtection.js';
import { packageScripts } from './checks/packageScripts.js';
import { huskyPreCommit } from './checks/huskyPreCommit.js';
import { eslintRules } from './checks/eslintRules.js';
import { tsconfigStrict } from './checks/tsconfigStrict.js';
import { vitestCoverage } from './checks/vitestCoverage.js';
import { vitestCollection } from './checks/vitestCollection.js';
import { nodeVersionSync } from './checks/nodeVersionSync.js';
import { loadRepoConfig, CONFIG_FILE } from './config.js';
import { tierIncludes } from '../templates.js';
import { defaultExec, makeResult, readRepoFile, type AuditCheck, type AuditContext, type AuditResult, type Exec } from './types.js';

/** The registry IS the standard: core applies to every repo, node adds on top. */
export const AUDIT_CHECKS: readonly AuditCheck[] = [
  claudeMd,
  gitignore,
  ciGateJob,
  ciBranchNameJob,
  dependabot,
  hookLauncher,
  hookSettings,
  hookArming,
  branchProtection,
  packageScripts,
  huskyPreCommit,
  eslintRules,
  tsconfigStrict,
  vitestCoverage,
  vitestCollection,
  nodeVersionSync,
];

/** Prefixes the detail of a check that THREW (as opposed to one that answered BLOCKED). One shared
 *  constant so auditExitCode's tolerance test and the crash containment cannot drift apart. */
export const CRASH_MARKER = 'check crashed';

export interface AuditReport {
  readonly repoDir: string;
  readonly tier: string;
  readonly tierDeclared: boolean;
  readonly results: readonly AuditResult[];
}

export function runAudit(repoDirInput: string, exec: Exec = defaultExec): AuditReport {
  // Resolved ONCE: checks join binaries onto repoDir AND pass cwd: repoDir to spawn, and a relative
  // path double-resolves through that pair (projects/foo/projects/foo/…) into a false BLOCKED.
  const repoDir = path.resolve(repoDirInput);
  const ctx: AuditContext = { repoDir, read: (rel) => readRepoFile(repoDir, rel), exec };
  const config = loadRepoConfig(ctx);
  if (config.kind === 'invalid') {
    // A config that cannot be trusted blocks EVERY check rather than silently defaulting the tier:
    // a corrupt exemption map read as "no exemptions declared" would flip EXEMPTs to FAILs and vice
    // versa depending on which way the parse fell over.
    return {
      repoDir,
      tier: 'unknown',
      tierDeclared: false,
      results: AUDIT_CHECKS.map((c) => makeResult(c, 'blocked', config.detail)),
    };
  }
  const applicable = AUDIT_CHECKS.filter((c) => tierIncludes(config.tier, c.tier));
  const results = applicable.map((check) => {
    const reason = config.exempt[check.id];
    if (reason !== undefined) {
      if (reason.trim() === '') {
        return makeResult(check, 'fail', `${CONFIG_FILE} exempts ${check.id} with NO reason — an exemption nobody can justify is a hole, not a waiver`);
      }
      return makeResult(check, 'exempt', `exempt: ${reason}`);
    }
    try {
      return check.run(ctx);
    } catch (err) {
      // A crashing check must surface as BLOCKED, never vanish from the report — an uncaught throw
      // that aborts the audit mid-list reports nothing about the checks after it.
      return makeResult(check, 'blocked', `${CRASH_MARKER}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { repoDir, tier: config.tier, tierDeclared: config.declared, results };
}

/** 0 only when every gating check is PASS or EXEMPT. FAIL beats BLOCKED in the code so a red gate
 *  names the worse problem; advisory results never move it (see hookArming for why).
 *  `tolerateBlocked` lets init accept the KNOWN fresh-scaffold BLOCKEDs by id — an allowlist, so an
 *  unexpected BLOCKED (a crashed check, git off PATH) still moves the exit code. */
export function auditExitCode(report: AuditReport, tolerateBlocked?: ReadonlySet<string>): number {
  const gating = report.results.filter((r) => !r.advisory);
  if (gating.some((r) => r.status === 'fail')) return 2;
  // A crash is never tolerated, even under a tolerated id: "the check did not run" and "the check
  // ran and reported its known fresh-repo state" must not share an exit code.
  const tolerated = (r: AuditResult): boolean => (tolerateBlocked?.has(r.id) ?? false) && !r.detail.startsWith(CRASH_MARKER);
  if (gating.some((r) => r.status === 'blocked' && !tolerated(r))) return 1;
  return 0;
}

const LABEL: Record<string, string> = {
  pass: 'PASS   ',
  fail: 'FAIL   ',
  blocked: 'BLOCKED',
  exempt: 'EXEMPT ',
};

export function formatAudit(report: AuditReport): string {
  const tierLine = `tier: ${report.tier}${report.tierDeclared ? '' : ' (inferred — declare it in .ticket-workflow.json)'}`;
  const lines = report.results.map((r) => `${LABEL[r.status]}  ${r.id.padEnd(20)} ${r.detail}${r.advisory ? ' [advisory]' : ''}`);
  const gating = report.results.filter((r) => !r.advisory);
  const counts = `pass ${gating.filter((r) => r.status === 'pass').length} · fail ${gating.filter((r) => r.status === 'fail').length} · blocked ${gating.filter((r) => r.status === 'blocked').length} · exempt ${gating.filter((r) => r.status === 'exempt').length}`;
  return [`audit ${report.repoDir}`, tierLine, '', ...lines, '', counts].join('\n');
}
