/**
 * Definition-of-Done verification — the PURE half (tkt-ec7743588066).
 *
 * The idea, and the reason this is worth having at all: every ticket ends with an agent-authored
 * `## Implementation summary` asserting `Tests: N added` and a green gate. Nothing checks that
 * assertion. The events log **can** — it is written by a PostToolUse hook that fires on actual
 * command execution, so an agent cannot produce a `test: passed` event by claiming tests passed.
 *
 * So this does not ask "did the gate run". It asks the narrower, answerable question: **does what the
 * ticket SAYS match what was OBSERVED?** Measured on this board, that is the difference between 4
 * precise findings and 603 noisy ones (see the ticket).
 *
 * Three outcomes, and UNKNOWN is the important one: with telemetry covering ~23% of closed tickets
 * and falling, most tickets simply cannot be judged, and a tool that reported those as OK would be
 * vouching for work it never saw.
 */

import { STEP_IDS, STATUS_STEP, type StepId } from '../shared/constants.js';

export type Outcome = 'ok' | 'violation' | 'unknown';

export interface Verdict {
  readonly id: string;
  readonly outcome: Outcome;
  /** One line. For a violation, state the claim AND the record, never just the conclusion. */
  readonly reason: string;
}

/** What the ticket's own summary claims about tests. */
export type TestsClaim =
  | { readonly kind: 'added'; readonly text: string }
  | { readonly kind: 'none'; readonly text: string }
  | { readonly kind: 'absent' };

export interface TicketFacts {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** Steps observed for this ticket, with the state of each latest event. */
  readonly steps: Readonly<Record<string, string>>;
  /** Lines lost from this ticket's log. Non-zero means the record is incomplete, so nothing may be
   *  concluded from its absence — the same reason `unreadable` exists on the board listing. */
  readonly skippedLines: number;
  /** Well-formed lines naming a step or state this reader's vocabulary lacks. NOT data loss, but
   *  equally disqualifying here: the hook is installed once per machine while readers are pinned per
   *  repo, so a `test` event in a newer state vocabulary is dropped from `steps` while `skipped`
   *  stays 0 — turning ordinary version skew into a reported violation. */
  readonly unrecognizedLines: number;
  /** This ticket's log could not be read at all (EACCES/EIO). Distinct from "no events": one means
   *  nothing happened, the other means we could not look, and only the second must never be judged. */
  readonly unreadableLog: boolean;
  readonly claim: TestsClaim;
}

/** Steps the MCP service writes on a status transition — derived from the mapping it uses. */
const SERVICE_WRITTEN: readonly StepId[] = Object.values(STATUS_STEP).filter(
  (s): s is StepId => s !== undefined,
);

/** `review` has two writers (the hook derives it from a passing commit; `record_review` appends it
 *  directly), so its presence witnesses neither one. */
const AMBIGUOUS: readonly StepId[] = ['review'];

/**
 * Steps ONLY the PostToolUse hook can produce — the evidence base.
 *
 * Derived rather than listed: a transcribed set would silently stop covering a step added upstream,
 * and this set is what decides whether a ticket is judgeable at all.
 */
export const HOOK_ONLY_STEPS: readonly StepId[] = STEP_IDS.filter(
  (s): s is StepId => !SERVICE_WRITTEN.includes(s) && !AMBIGUOUS.includes(s),
);

/** Was telemetry demonstrably alive while this ticket was worked? */
export function wasObserved(facts: TicketFacts): boolean {
  return HOOK_ONLY_STEPS.some((s) => facts.steps[s] !== undefined);
}

/**
 * Read the `Tests:` line the workflow mandates in every implementation summary.
 *
 * Tolerant of the bullet/bold variants that appear on real tickets; deliberately NOT tolerant of its
 * absence, which is reported as `absent` so the caller returns UNKNOWN rather than assuming.
 *
 * The LAST occurrence wins, not the first. Bodies only ever grow — the workflow appends and never
 * rewrites — so a reopened ticket carries two summaries, and taking the first would judge the newer
 * work against the older claim. That is not merely stale: a first `Tests: none` short-circuits to OK
 * *without consulting the record at all*, which is the permissive answer arrived at from a claim
 * that no longer describes the ticket.
 */
export function parseTestsClaim(body: string): TestsClaim {
  // Fenced blocks are stripped first. Summaries routinely quote command transcripts, and a real
  // ticket on this board carries `Tests: 1303  # npx vitest run` inside one — a line the parser
  // would otherwise read as the claim. Replaced with blank lines rather than removed so nothing
  // outside a fence can be joined to its neighbour.
  const prose = body.replace(/^```[\s\S]*?^```/gm, (m) => m.replace(/[^\n]/g, ''));
  const all = [...prose.matchAll(/^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?Tests:(?:\*\*)?[ \t]*(.+)$/gim)];
  const m = all[all.length - 1];
  if (!m) return { kind: 'absent' };
  const text = m[1].trim();
  // "none — pure UI change" is a claim in good standing: the workflow explicitly allows it, and it
  // asserts nothing the record could contradict.
  return /^none\b/i.test(text) ? { kind: 'none', text } : { kind: 'added', text };
}

const MAX_REASON = 90;
const clip = (s: string): string => (s.length > MAX_REASON ? `${s.slice(0, MAX_REASON - 1)}…` : s);

/**
 * Compare one ticket's claim against its record.
 *
 * Order matters and is the whole design: every way of NOT knowing is checked before the one way of
 * concluding, so a violation can only be reported when the record is complete enough to contradict.
 */
export function verifyTicket(facts: TicketFacts): Verdict {
  const { id } = facts;
  // Checked before observation: an unreadable log has no steps, so it would otherwise be reported as
  // "telemetry never observed this ticket" — a confident, specific and wrong reason.
  if (facts.unreadableLog) {
    return { id, outcome: 'unknown', reason: "this ticket's event log could not be read, so nothing about it is known" };
  }
  if (!wasObserved(facts)) {
    return {
      id,
      outcome: 'unknown',
      reason: 'telemetry never observed this ticket — no hook-written step exists, so nothing can be checked',
    };
  }
  if (facts.skippedLines > 0) {
    return {
      id,
      outcome: 'unknown',
      reason: `${facts.skippedLines} line(s) unreadable in this ticket's log — a missing milestone may have been lost rather than never recorded`,
    };
  }
  if (facts.unrecognizedLines > 0) {
    return {
      id,
      outcome: 'unknown',
      reason: `${facts.unrecognizedLines} line(s) written by a newer ticket-workflow than this one — a milestone may be present in a vocabulary this build cannot read`,
    };
  }
  if (facts.claim.kind === 'absent') {
    return {
      id,
      outcome: 'unknown',
      reason: 'no `Tests:` line in the body, so there is no claim to check the record against',
    };
  }
  if (facts.claim.kind === 'none') {
    // Nothing to contradict. This is what makes docs-only tickets land as OK instead of being flagged
    // for skipping a gate the workflow explicitly excuses them from — the single change that takes
    // the finding set from ~20 mostly-false to 4 precise ones.
    return { id, outcome: 'ok', reason: `claims no tests ("${clip(facts.claim.text)}"); nothing in the record contradicts it` };
  }
  if (facts.steps.test === 'passed') {
    return { id, outcome: 'ok', reason: 'claims tests were added, and a passing test milestone was recorded' };
  }
  const observed = HOOK_ONLY_STEPS.filter((s) => facts.steps[s] !== undefined);
  return {
    id,
    outcome: 'violation',
    reason:
      `claims "${clip(facts.claim.text)}" but no passing test milestone was recorded, ` +
      `while telemetry WAS live for this ticket (observed: ${observed.join(', ')})`,
  };
}

export interface Report {
  readonly verdicts: readonly Verdict[];
  readonly considered: number;
  readonly judged: number;
  readonly ok: number;
  readonly violations: number;
  readonly unknown: number;
  /** Share of considered tickets this run could not speak to, 0–1. */
  readonly unknownRate: number;
}

export function buildReport(facts: readonly TicketFacts[]): Report {
  const verdicts = facts.map(verifyTicket);
  const unknown = verdicts.filter((v) => v.outcome === 'unknown').length;
  const violations = verdicts.filter((v) => v.outcome === 'violation').length;
  const ok = verdicts.filter((v) => v.outcome === 'ok').length;
  return {
    verdicts,
    considered: verdicts.length,
    judged: ok + violations,
    ok,
    violations,
    unknown,
    unknownRate: verdicts.length === 0 ? 1 : unknown / verdicts.length,
  };
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

/**
 * The coverage statement comes FIRST, always.
 *
 * A findings list printed above its own coverage invites reading absence-of-findings as compliance.
 * What this tool can honestly offer is a stated boundary on what it vouches for, so that boundary is
 * the headline rather than a footnote.
 */
export function formatReport(report: Report, boardUnreadable = 0): string {
  const lines: string[] = [];
  // Pushed BEFORE the empty-board return, not after: a board whose every file has corrupt
  // frontmatter yields zero tickets AND a non-zero unreadable count, and that is precisely when
  // reporting "nothing matched" without saying why is most misleading.
  if (boardUnreadable > 0) {
    lines.push(`! ${boardUnreadable} ticket file(s) could not be parsed at all — they are absent from every count below.`);
  }
  if (report.considered === 0) {
    lines.push('No tickets matched, so nothing was checked. This is not a clean result — it is an empty one.');
    return lines.join('\n');
  }
  lines.push(
    `Judged ${report.judged} of ${report.considered} tickets (${pct(report.judged, report.considered)}). ` +
      `${report.unknown} could NOT be judged (${pct(report.unknown, report.considered)}) and are vouched for by nothing here.`,
  );
  lines.push('');
  lines.push(`  ok         ${String(report.ok).padStart(4)}   claim and record agree`);
  lines.push(`  violation  ${String(report.violations).padStart(4)}   the summary claims tests the record does not show`);
  lines.push(`  unknown    ${String(report.unknown).padStart(4)}   not judgeable`);
  const violations = report.verdicts.filter((v) => v.outcome === 'violation');
  if (violations.length > 0) {
    lines.push('');
    lines.push('VIOLATIONS');
    for (const v of violations) lines.push(`  ${v.id}  ${v.reason}`);
    lines.push('');
    lines.push(
      'A violation is a DISCREPANCY, not proof of misconduct: the gate may have run under a command the',
    );
    lines.push(
      'hook does not recognise. It says the claim is unsupported by the record, which is all it can say.',
    );
  }
  return lines.join('\n');
}
