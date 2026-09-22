import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { depthBetween, maskSource } from './configSource.js';
import { resolveVitestConfig } from './vitestConfig.js';

const CALL = /\bholdTestRun\s*\(/g;
// A namespace import (`tw.holdTestRun`) is the same call; misreading it as un-awaited named the wrong defect.
const AWAITED = /\bawait\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?$/;
// Depth 0 is not unconditional: an arrow body never runs, `&&`/`?`/`else`/`,` run it sometimes. A
// `{` at depth 0 only follows a mis-masked template literal, so it reads as guarded too.
const GUARDED_BY = /(?:=>|&&|\|\||\?\?|[?:{,]|\belse|\bdo)\s*$/;
const CONTROL_HEAD = /\b(?:if|while|for(?:\s+await)?|with)\s*$/;
const WIRING = '`await holdTestRun()` unconditionally at the top level of the config, released by `globalSetup: [TEST_RUN_GLOBAL_SETUP]`';

type Placement = 'top-level' | 'unawaited' | 'nested' | 'absent';

/** A `)` guards only when it closes a control head, so an ASI-style `setup()` line is not an `if`. */
function guarded(before: string): boolean {
  if (GUARDED_BY.test(before)) return true;
  const trimmed = before.trimEnd();
  if (!trimmed.endsWith(')')) return false;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const ch = trimmed.charAt(i);
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) return CONTROL_HEAD.test(trimmed.slice(0, i));
    }
  }
  return true;
}

/** Read off MASKED source so a commented-out or quoted call never counts. Un-awaited, the hold
 *  races the worker-env snapshot it exists to precede. */
function placement(contents: string): Placement {
  const { masked } = maskSource(contents);
  let best: Placement = 'absent';
  for (const hit of masked.matchAll(CALL)) {
    const before = masked.slice(0, hit.index);
    const awaitAt = AWAITED.exec(before);
    if (depthBetween(masked, 0, hit.index) !== 0 || (awaitAt !== null && guarded(before.slice(0, awaitAt.index)))) {
      if (best === 'absent') best = 'nested';
    } else if (awaitAt !== null) {
      return 'top-level';
    } else {
      best = 'unawaited';
    }
  }
  return best;
}

export const testRunHold: AuditCheck = {
  id: 'test-run-hold',
  tier: 'node',
  advisory: true,
  run(ctx: AuditContext): AuditResult {
    const config = resolveVitestConfig(ctx);
    if (config.kind === 'error') return makeResult(this, 'blocked', `${config.file} could not be read: ${config.message}`);
    if (config.kind === 'ambiguous' || config.kind === 'undeterminable') return makeResult(this, 'blocked', config.detail);
    if (config.kind === 'missing') {
      return makeResult(this, 'fail', `no vitest config found — nothing takes a machine-wide test-run slot, so concurrent runs contend; add one with ${WIRING}`);
    }
    const where = config.file;
    switch (placement(config.contents)) {
      case 'top-level':
        return makeResult(this, 'pass', `${where} awaits holdTestRun at the top level`);
      case 'unawaited':
        return makeResult(this, 'fail', `${where} calls holdTestRun without \`await\` — vitest resolves the config before the slot is held; use ${WIRING}`);
      case 'nested':
        return makeResult(this, 'fail', `${where} calls holdTestRun only inside a block, call or condition, which may not run before vitest starts — use ${WIRING}`);
      case 'absent':
        return makeResult(this, 'fail', `${where} does not call holdTestRun — this repo's test runs take no machine-wide slot; add ${WIRING} (ticket-workflow/test-run)`);
    }
  },
};
