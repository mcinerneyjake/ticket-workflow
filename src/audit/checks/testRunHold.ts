import { makeResult, type AuditCheck, type AuditContext, type AuditResult } from '../types.js';
import { atKeyPosition, depthBetween, maskSource, matchDelimiter, objectBodies, type Masked } from './configSource.js';
import { resolveVitestConfig } from './vitestConfig.js';

const CALL = /\bholdTestRun\s*\(/g;
// A namespace import (`tw.holdTestRun`) is the same call; misreading it as un-awaited named the wrong defect.
const AWAITED = /\bawait\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?$/;
// Depth 0 is not unconditional: an arrow body never runs, `&&`/`?`/`else`/`,` run it sometimes. A
// `{` at depth 0 only follows a mis-masked template literal, so it reads as guarded too.
const GUARDED_BY = /(?:=>|&&|\|\||\?\?|[?:{,]|\belse|\bdo)\s*$/;
const CONTROL_HEAD = /\b(?:if|while|for(?:\s+await)?|with)\s*$/;
const WIRING = '`await holdTestRun()` unconditionally at the top level of the config, released by `globalSetup: [TEST_RUN_GLOBAL_SETUP]`';

// Stops at the colon: a masked string is all spaces, so a trailing `\s*` would skip the very
// literal the path spelling lives in and land on the property's terminator.
const RELEASE_KEY = /\bglobalSetup\s*:/g;
const RELEASE_ID = /\bTEST_RUN_GLOBAL_SETUP\b/;
// This package's own config cannot import itself by name, so the path spelling is first-class, not
// a fallback — an identifier-only test reported `fail` on the repo that ships the check.
const RELEASE_PATH = /(?:^|[/\\])test-run[/\\]globalSetup\.[cm]?[jt]s$/;
// "add to", not "use": a repo with its own global setup must keep it, and this check deliberately
// does not open the referenced file, so it cannot tell that one already releases the slot.
const RELEASE_ADVICE = '`TEST_RUN_GLOBAL_SETUP` to the `test.globalSetup` array (keeping any entry already there)';

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

/** [start, end) of the `globalSetup` value whose colon ends at `after`, or null when its extent is
 *  undeterminable. Leading space is skipped in the SOURCE and the terminator found in the MASK:
 *  only the source still distinguishes a blanked literal from the whitespace around it. Widening an
 *  unbalanced value to end-of-file instead let `coverage.exclude`'s path — which this repo's own
 *  config carries, one property away — satisfy the release. */
function valueSpan(masked: string, src: string, after: number, limit: number): readonly [number, number] | null {
  let from = after;
  while (from < limit && /\s/.test(src.charAt(from))) from += 1;
  if (src.charAt(from) === '[') {
    const close = matchDelimiter(masked, from, '[', ']');
    return close === -1 || close >= limit ? null : [from, close + 1];
  }
  let depth = 0;
  for (let i = from; i < limit; i += 1) {
    const ch = masked.charAt(i);
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return [from, i];
      depth -= 1;
    } else if (ch === ',' && depth === 0) return [from, i];
  }
  // Reaching the block's end balanced is the last property; still open is undeterminable.
  return depth === 0 ? [from, limit] : null;
}

type Release = 'released' | 'unreleased' | 'undeterminable';

/** Whether the config gives the slot back. The hold alone does not prove it: without this,
 *  `await holdTestRun()` plus no globalSetup was certified, and a run killed by a signal — which
 *  the best-effort `process.on('exit')` backstop never sees — held its slot until the TTL.
 *
 *  Positive identification, like `vitestCollection`: only a DIRECT child of the vitest `test` block
 *  releases, because vitest reads `test.globalSetup` and nothing else. Mere presence admitted a
 *  config-top-level key, `typecheck: { globalSetup }` and a dead object beside the config.
 *
 *  Two known gaps, both pinned by tests: a consumer's OWN globalSetup file calling `releaseTestRun()`
 *  reads as unreleased, since this never follows the reference; and a `test.projects` entry's
 *  globalSetup is not a direct child, so it reads as unreleased too. */
function releases(m: Masked, src: string): Release {
  const scan = objectBodies(m, 'test', { directChildOnly: true });
  if (scan.unbalanced) return 'undeterminable';
  let verdict: Release = 'unreleased';
  for (const [start, end] of scan.bodies) {
    const starts: number[] = [];
    for (const hit of m.masked.slice(start, end).matchAll(RELEASE_KEY)) {
      const at = start + hit.index;
      if (atKeyPosition(m.masked, at) && depthBetween(m.masked, start, at) === 0) starts.push(at + hit[0].length);
    }
    // A quoted key is blanked in the mask, so `'globalSetup': […]` is only visible in the literals.
    for (const lit of m.literals) {
      if (lit.value !== 'globalSetup' || lit.start < start || lit.end > end) continue;
      if (!atKeyPosition(m.masked, lit.start) || depthBetween(m.masked, start, lit.start) !== 0) continue;
      const colon = /^\s*:/.exec(m.masked.slice(lit.end));
      if (colon !== null) starts.push(lit.end + colon[0].length);
    }
    if (starts.length === 0) continue;
    // JS keeps the LAST duplicate key, so that is the one that actually runs.
    const span = valueSpan(m.masked, src, Math.max(...starts), end);
    if (span === null) return 'undeterminable';
    const [from, to] = span;
    const wired =
      RELEASE_ID.test(m.masked.slice(from, to)) ||
      m.literals.some((lit) => lit.start >= from && lit.end <= to && RELEASE_PATH.test(lit.value));
    if (wired) verdict = 'released';
  }
  return verdict;
}

/** Read off MASKED source so a commented-out or quoted call never counts. Un-awaited, the hold
 *  races the worker-env snapshot it exists to precede. */
function placement({ masked }: Masked): Placement {
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
    const masked = maskSource(config.contents);
    switch (placement(masked)) {
      case 'top-level':
        switch (releases(masked, config.contents)) {
          case 'undeterminable':
            return makeResult(this, 'blocked', `${where} awaits holdTestRun, but its test.globalSetup value could not be delimited`);
          case 'unreleased':
            return makeResult(
              this,
              'fail',
              `${where} awaits holdTestRun but nothing in test.globalSetup releases the slot — a run killed by a signal then holds it until its TTL; add ${RELEASE_ADVICE}`,
            );
          case 'released':
            return makeResult(this, 'pass', `${where} awaits holdTestRun at the top level and releases it in test.globalSetup`);
        }
        break;
      case 'unawaited':
        return makeResult(this, 'fail', `${where} calls holdTestRun without \`await\` — vitest resolves the config before the slot is held; use ${WIRING}`);
      case 'nested':
        return makeResult(this, 'fail', `${where} calls holdTestRun only inside a block, call or condition, which may not run before vitest starts — use ${WIRING}`);
      case 'absent':
        return makeResult(this, 'fail', `${where} does not call holdTestRun — this repo's test runs take no machine-wide slot; add ${WIRING} (ticket-workflow/test-run)`);
    }
  },
};
