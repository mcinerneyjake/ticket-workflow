import { makeResult, type AuditCheck, type AuditResult } from '../types.js';

/**
 * Permanently BLOCKED, and says so on every run. The launcher file and its wiring are
 * version-controlled, but whether hooks actually RUN is machine-local state (~/.claude/) that a
 * fresh clone, a container, or CI cannot see — "the file existing ≠ armed". Reporting PASS here
 * would make the audit contain the exact fail-open check it exists to reject; reporting FAIL would
 * redden every conformant repo. So: advisory BLOCKED — excluded from the exit code, never from the
 * report. `ticket-workflow doctor` is the tool that CAN answer this, on the machine itself.
 */
export const hookArming: AuditCheck = {
  id: 'hook-arming',
  tier: 'core',
  advisory: true,
  run(): AuditResult {
    return makeResult(
      this,
      'blocked',
      'unverifiable from the repository — hook arming is machine-local; run `ticket-workflow doctor` on the machine to verify',
    );
  },
};
