import { describe, it, expect } from 'vitest';
import {
  parseTestsClaim,
  verifyTicket,
  wasObserved,
  buildReport,
  formatReport,
  HOOK_ONLY_STEPS,
  type TicketFacts,
} from './rules.js';
import { STEP_IDS } from '../shared/constants.js';

// Facts are total, so every case states the whole world; a field left out cannot default to the
// answer that happens to make the test pass.
const BASE: TicketFacts = {
  id: 'tkt-000000000000',
  title: 'A ticket',
  status: 'done',
  steps: { branch: 'passed', commit: 'passed', pr_opened: 'passed', test: 'passed' },
  skippedLines: 0,
  unrecognizedLines: 0,
  unreadableLog: false,
  claim: { kind: 'added', text: '3 added — covers the parser' },
};
const facts = (over: Partial<TicketFacts> = {}): TicketFacts => ({ ...BASE, ...over });

describe('the evidence base', () => {
  it('counts only steps the hook alone can write', () => {
    expect([...HOOK_ONLY_STEPS].sort()).toEqual(['branch', 'commit', 'lint', 'pr_opened', 'test', 'typecheck']);
  });

  it('excludes review, which has two writers, and the service-written statuses', () => {
    // `review` is derived by the hook from a passing commit AND appended by record_review, so its
    // presence witnesses neither. started/qa/done are pure status transitions.
    for (const s of ['review', 'started', 'qa', 'done']) expect(HOOK_ONLY_STEPS).not.toContain(s);
  });

  it('is derived from STEP_IDS, so a step added upstream cannot go unclassified', () => {
    expect(HOOK_ONLY_STEPS.every((s) => STEP_IDS.includes(s))).toBe(true);
  });

  it('treats a ticket with only service-written steps as unobserved', () => {
    expect(wasObserved(facts({ steps: { started: 'reached', qa: 'reached', done: 'reached' } }))).toBe(false);
    expect(wasObserved(facts({ steps: { branch: 'passed' } }))).toBe(true);
  });
});

describe('reading the Tests: claim', () => {
  it('reads the plain, bulleted and bolded forms real tickets use', () => {
    expect(parseTestsClaim('Tests: 4 added — x')).toEqual({ kind: 'added', text: '4 added — x' });
    expect(parseTestsClaim('- Tests: 4 added — x').kind).toBe('added');
    expect(parseTestsClaim('**Tests:** 4 added — x').kind).toBe('added');
    expect(parseTestsClaim('  Tests: 4 added — x').kind).toBe('added');
  });

  it('recognises a "none" claim, which the workflow explicitly permits', () => {
    expect(parseTestsClaim('Tests: none — pure UI change').kind).toBe('none');
    expect(parseTestsClaim('Tests: None — docs only').kind).toBe('none');
  });

  it('reports an ABSENT line rather than inventing a claim', () => {
    // The whole three-outcome scheme rests on this: no claim must become UNKNOWN, never a pass.
    expect(parseTestsClaim('## Implementation summary\n\nDid some work.').kind).toBe('absent');
    expect(parseTestsClaim('').kind).toBe('absent');
  });

  it('does not mistake prose mentioning tests for the claim line', () => {
    expect(parseTestsClaim('We should add Tests eventually.').kind).toBe('absent');
  });

  it('takes the LAST claim, because bodies only ever grow', () => {
    // The workflow appends and never rewrites, so a reopened ticket carries two summaries. Taking
    // the first judges the newer work against the older claim — and a leading `none` short-circuits
    // to OK without consulting the record at all.
    const body = [
      '## Implementation summary',
      'Tests: none — docs only',
      '',
      '## Implementation summary',
      'Tests: 4 added — the real work',
    ].join('\n');
    expect(parseTestsClaim(body)).toEqual({ kind: 'added', text: '4 added — the real work' });
  });

  it('ignores a Tests: line inside a fenced code block', () => {
    // Not hypothetical: a live ticket's summary quotes a transcript containing
    // `Tests: 1303  # npx vitest run`, which the parser would otherwise read as the claim.
    const body = ['Tests: none — docs only', '', '```', 'Tests: 1303  # npx vitest run', '```'].join('\n');
    expect(parseTestsClaim(body)).toEqual({ kind: 'none', text: 'none — docs only' });
  });

  it('still finds a claim that FOLLOWS a fenced block', () => {
    // The fence is blanked, not deleted, so line structure after it is preserved.
    const body = ['```', 'some transcript', '```', 'Tests: 4 added — real'].join('\n');
    expect(parseTestsClaim(body).kind).toBe('added');
  });

  it('is not fooled by a quoted template line above the real claim', () => {
    const body = '- `Tests: N added — <what they cover>`\n\n## Implementation summary\nTests: none — pure UI change';
    expect(parseTestsClaim(body).kind).toBe('none');
  });
});

describe('verdicts', () => {
  it('is OK when the claim and the record agree', () => {
    expect(verifyTicket(BASE).outcome).toBe('ok');
  });

  it('flags a claim of tests with no passing test milestone', () => {
    const v = verifyTicket(facts({ steps: { branch: 'passed', commit: 'passed', pr_opened: 'passed' } }));
    expect(v.outcome).toBe('violation');
    // The reason must carry BOTH sides: a bare "violation" is unactionable, and the reader needs to
    // see the claim it is being asked to doubt.
    expect(v.reason).toContain('3 added');
    expect(v.reason).toContain('branch, commit, pr_opened');
  });

  it('flags a FAILING test milestone too — "it ran" is not "it passed"', () => {
    expect(verifyTicket(facts({ steps: { branch: 'passed', test: 'failed' } })).outcome).toBe('violation');
  });

  it('is OK for a claim of none — the docs-only case the workflow excuses', () => {
    // This single rule is what takes the finding set from ~20 mostly-false to 4 precise ones on the
    // live board: a docs ticket asserts nothing the record can contradict.
    const v = verifyTicket(
      facts({ claim: { kind: 'none', text: 'none — docs only' }, steps: { branch: 'passed', commit: 'passed' } }),
    );
    expect(v.outcome).toBe('ok');
  });

  it('is UNKNOWN when telemetry never observed the ticket, EVEN IF the claim looks unsupported', () => {
    // Ordering is the design. Checked before the contradiction, so an unobserved ticket can never be
    // reported as a violation — which is the 79.9%-false-positive result this exists to avoid.
    const v = verifyTicket(facts({ steps: { started: 'reached', done: 'reached' } }));
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toContain('never observed');
  });

  it('is UNKNOWN when the ticket\'s own log lost lines', () => {
    // A missing milestone may have been lost rather than never written, so absence proves nothing.
    const v = verifyTicket(facts({ skippedLines: 2, steps: { branch: 'passed' } }));
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toContain('unreadable');
  });

  it('is UNKNOWN on version skew — a newer writer is not a missing milestone', () => {
    // parseEventLine drops a well-formed record whose step/state this build's vocabulary lacks, and
    // it lands in `unrecognized`, NOT `skipped`. So a `test` event in a newer state vocabulary
    // vanishes from `steps` while skipped stays 0 — turning ordinary skew into a false violation.
    const v = verifyTicket(facts({ unrecognizedLines: 1, steps: { branch: 'passed' } }));
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toContain('newer ticket-workflow');
  });

  it('is UNKNOWN when the log could not be READ, with a reason that says so', () => {
    // Distinct from "never observed": an unreadable log has no steps either, so without its own
    // branch this reports a confident, specific and wrong reason.
    const v = verifyTicket(facts({ unreadableLog: true, steps: {} }));
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toContain('could not be read');
  });

  it('ranks a damaged log ABOVE the missing-claim case', () => {
    const v = verifyTicket(facts({ skippedLines: 1, claim: { kind: 'absent' }, steps: { branch: 'passed' } }));
    expect(v.reason).toContain('unreadable');
  });

  it('is UNKNOWN when there is no claim to check', () => {
    const v = verifyTicket(facts({ claim: { kind: 'absent' } }));
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toContain('no `Tests:` line');
  });
});

describe('the report', () => {
  const mixed: TicketFacts[] = [
    BASE,
    facts({ id: 'tkt-violation000', steps: { branch: 'passed' } }),
    facts({ id: 'tkt-unknown00000', steps: { done: 'reached' } }),
    facts({ id: 'tkt-unknown00001', claim: { kind: 'absent' } }),
  ];

  it('counts each outcome and reports the share it could not judge', () => {
    const r = buildReport(mixed);
    expect({ ok: r.ok, violations: r.violations, unknown: r.unknown }).toEqual({ ok: 1, violations: 1, unknown: 2 });
    expect(r.judged).toBe(2);
    expect(r.considered).toBe(4);
    expect(r.unknownRate).toBe(0.5);
  });

  it('leads with COVERAGE, before any finding', () => {
    // A findings list printed above its own coverage invites reading absence-of-findings as
    // compliance. The boundary on what is vouched for is the deliverable, so it goes first.
    const out = formatReport(buildReport(mixed)).split('\n');
    expect(out[0]).toContain('could NOT be judged');
    expect(out[0]).toContain('vouched for by nothing');
    expect(out.indexOf('VIOLATIONS')).toBeGreaterThan(0);
  });

  it('states that a violation is a discrepancy, not proof', () => {
    expect(formatReport(buildReport(mixed))).toContain('not proof of misconduct');
  });

  it('refuses to present an empty run as a clean one', () => {
    // Zero tickets checked and zero violations found look identical in any count-based summary.
    const out = formatReport(buildReport([]));
    expect(out).toContain('not a clean result');
    expect(buildReport([]).unknownRate).toBe(1);
  });

  it('surfaces unparseable ticket files, which are absent from every count', () => {
    expect(formatReport(buildReport(mixed), 3)).toContain('3 ticket file(s) could not be parsed');
  });

  it('STILL surfaces them when nothing matched — the case where it matters most', () => {
    // A board whose every file has corrupt frontmatter yields zero tickets AND a non-zero unreadable
    // count. Reporting "nothing matched" there, with no reason, describes a broken board as an empty
    // one — and --json carried the count all along, so text and JSON disagreed.
    const out = formatReport(buildReport([]), 7);
    expect(out).toContain('7 ticket file(s) could not be parsed');
    expect(out).toContain('not a clean result');
  });

  it('says nothing about unparseable files when there are none', () => {
    expect(formatReport(buildReport(mixed), 0)).not.toContain('could not be parsed');
  });
});
