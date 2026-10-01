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

const RELEASE_ID = /\bTEST_RUN_GLOBAL_SETUP\b/;
// This package's own config cannot import itself by name, so the path spelling is first-class, not
// a fallback — an identifier-only test reported `fail` on the repo that ships the check.
const RELEASE_PATH = /(?:^|[/\\])test-run[/\\]globalSetup\.[cm]?[jt]s$/;
// "add to", not "use": a repo with its own global setup must keep it, and this check deliberately
// does not open the referenced file, so it cannot tell that one already releases the slot.
const RELEASE_ADVICE = '`TEST_RUN_GLOBAL_SETUP` to the `test.globalSetup` array (keeping any entry already there)';

// `new` is required: vitest wants an instance, and a bare class reference has no hooks to fire.
const REPORTER_INSTANCE = /\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?TestRunSlotReporter\b/;
// Any of these in the value means the instance may never reach vitest; an optional chain is not one.
const CONDITIONAL = /\?(?!\.)|&&|\|\||=>/;
const REPORTER_ADVICE = "`new TestRunSlotReporter()` to the root `test.reporters` array (keeping 'default' and any others)";

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

/** [start, end) of the key's value whose colon ends at `after`, or null when its extent is
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

/** Where each direct-child `<name>:` key of the body [start, end) ends, bare or quoted. */
function keyEnds(m: Masked, start: number, end: number, name: string): number[] {
  const ends: number[] = [];
  // Stops at the colon: a masked string is all spaces, so a trailing `\s*` would skip the very
  // literal the path spelling lives in and land on the property's terminator.
  for (const hit of m.masked.slice(start, end).matchAll(new RegExp(`\\b${name}\\s*:`, 'g'))) {
    const at = start + hit.index;
    if (atKeyPosition(m.masked, at) && depthBetween(m.masked, start, at) === 0) ends.push(at + hit[0].length);
  }
  // A quoted key is blanked in the mask, so `'globalSetup': […]` is only visible in the literals.
  for (const lit of m.literals) {
    if (lit.value !== name || lit.start < start || lit.end > end) continue;
    if (!atKeyPosition(m.masked, lit.start) || depthBetween(m.masked, start, lit.start) !== 0) continue;
    const colon = /^\s*:/.exec(m.masked.slice(lit.end));
    if (colon !== null) ends.push(lit.end + colon[0].length);
  }
  return ends;
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
    const starts = keyEnds(m, start, end, 'globalSetup');
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

type Reporting = 'wired' | 'missing' | 'overridden' | 'undeterminable';

/** Whether `name` appears as a shorthand property (`{ reporter }`) directly in the body. */
function shorthand(m: Masked, start: number, end: number, name: string): boolean {
  for (const hit of m.masked.slice(start, end).matchAll(new RegExp(`\\b${name}(?=\\s*(?:,|$))`, 'g'))) {
    const at = start + hit.index;
    if (atKeyPosition(m.masked, at) && depthBetween(m.masked, start, at) === 0) return true;
  }
  return false;
}

/** Whether the body has a computed key (`[k]: …`), which could name anything. */
function computedKey(m: Masked, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (m.masked.charAt(i) !== '[' || !atKeyPosition(m.masked, i) || depthBetween(m.masked, start, i) !== 0) continue;
    const close = matchDelimiter(m.masked, i, '[', ']');
    if (close === -1 || /^\s*:/.test(m.masked.slice(close + 1, end))) return true;
  }
  return false;
}

/** Whether watch mode gets the reporter (tkt-8060fdaeb366): vitest reads only the ROOT `test` block's
 *  reporters, and a singular `test.reporter` replaces them. Anything else ambiguous is undeterminable. */
function reports(m: Masked, src: string): Reporting {
  const scan = objectBodies(m, 'test', { directChildOnly: true });
  if (scan.unbalanced) return 'undeterminable';
  // A projects entry's `test` sits inside the root's. A second root — a hoisted project, a dead
  // object, a branch on CI — may be the one vitest receives, so it is never taken on trust.
  const roots = scan.bodies.filter(([s, e]) => !scan.bodies.some(([os, oe]) => os < s && e <= oe));
  const [root, ...others] = roots;
  if (root === undefined) return 'missing';
  if (others.length > 0) return 'undeterminable';
  const [start, end] = root;
  if (keyEnds(m, start, end, 'reporter').length > 0 || shorthand(m, start, end, 'reporter')) return 'overridden';
  if (computedKey(m, start, end)) return 'undeterminable';
  const starts = keyEnds(m, start, end, 'reporters');
  if (starts.length === 0) return 'missing';
  const span = valueSpan(m.masked, src, Math.max(...starts), end);
  if (span === null) return 'undeterminable';
  const value = m.masked.slice(span[0], span[1]);
  if (!REPORTER_INSTANCE.test(value)) return 'missing';
  // valueSpan stops at an array's `]`, so `[…].slice(0, 1)` would otherwise read as the whole value.
  const rest = m.masked.slice(span[1], end).trimStart();
  if (CONDITIONAL.test(value) || !(rest === '' || rest.startsWith(','))) return 'undeterminable';
  return 'wired';
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

function reporterResult(check: AuditCheck, where: string, reporting: Reporting): AuditResult {
  switch (reporting) {
    case 'undeterminable':
      return makeResult(check, 'blocked', `${where} holds and releases the slot, but whether TestRunSlotReporter reaches vitest could not be determined (several candidate test blocks, a computed key, or a conditional or chained reporters value)`);
    case 'overridden':
      return makeResult(
        check,
        'fail',
        `${where} sets test.reporter, which vitest uses in place of test.reporters whenever it is non-empty, so TestRunSlotReporter may never run and a \`vitest\` watcher would keep its slot while idle; move every reporter into test.reporters`,
      );
    case 'missing':
      return makeResult(
        check,
        'fail',
        `${where} holds and releases the slot, but test.reporters has no TestRunSlotReporter — the config resolves once, so a \`vitest\` watch session keeps its slot while idle; add ${REPORTER_ADVICE}`,
      );
    case 'wired':
      return makeResult(
        check,
        'pass',
        `${where} awaits holdTestRun at the top level, releases it in test.globalSetup, and registers TestRunSlotReporter in test.reporters`,
      );
  }
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
            return reporterResult(this, where, reports(masked, config.contents));
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
