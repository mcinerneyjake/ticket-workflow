import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gatherTicketFacts } from './gather.js';
import { buildReport } from './rules.js';
import { createTicket, updateTicket } from '../server/tickets.js';
import { appendEvent } from '../server/events.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';
import type { StatusId } from '../shared/constants.js';

// Drives the REAL service against a temp board, so the selection and the event read are exercised as
// they run in production. The pure suite cannot catch a defect here: it starts from facts already
// gathered, and every bug found on the live board so far has been in the gathering.
const dirs = setupTempTicketDirs('tw-verify');

async function seed(opts: {
  title: string;
  status?: StatusId;
  project?: string | null;
  summary?: string;
  steps?: [string, string][];
  /** Whether the seeded command milestones carry the fixed writer's provenance marker. Defaults to
   *  true so a case that is not ABOUT provenance still reaches the verdict it was written for. */
  trusted?: boolean;
}) {
  const t = await createTicket({ title: opts.title, type: 'task', priority: 'low', status: 'todo' });
  if (opts.summary !== undefined) await updateTicket(t.id, { appendBody: opts.summary });
  if (opts.project !== undefined) await updateTicket(t.id, { project: opts.project });
  if (opts.status) await updateTicket(t.id, { status: opts.status });
  for (const [step, state] of opts.steps ?? [])
    await appendEvent({ ticketId: t.id, step, state, ...(opts.trusted === false ? {} : { outcomeFrom: 'event' as const }) });
  return t.id;
}

const GATE: [string, string][] = [
  ['branch', 'passed'],
  ['typecheck', 'passed'],
  ['lint', 'passed'],
  ['test', 'passed'],
  ['commit', 'passed'],
];

describe('selecting which tickets to check', () => {
  it('considers closed tickets by default and ignores work still in flight', async () => {
    await seed({ title: 'Closed', status: 'done', summary: 'Tests: none — x', steps: GATE });
    await seed({ title: 'In flight', status: 'in-progress', summary: 'Tests: none — x', steps: GATE });
    const { facts } = await gatherTicketFacts();
    expect(facts.map((f) => f.title)).toEqual(['Closed']);
  });

  it('includes archived tickets, which are closed too', async () => {
    await seed({ title: 'Archived', status: 'archived', summary: 'Tests: none — x', steps: GATE });
    expect((await gatherTicketFacts()).facts).toHaveLength(1);
  });

  it('--all really widens the set — `null` is not the same as unspecified', async () => {
    // `opts.statuses ?? CLOSED` would collapse the two and make --all silently do nothing, with the
    // default-behaviour test above still green.
    await seed({ title: 'Closed', status: 'done', steps: GATE });
    await seed({ title: 'In flight', status: 'in-progress', steps: GATE });
    expect((await gatherTicketFacts({ statuses: null })).facts).toHaveLength(2);
    expect((await gatherTicketFacts({})).facts).toHaveLength(1);
  });

  it('filters by project, and by a single id', async () => {
    await seed({ title: 'A', status: 'done', project: 'alpha', steps: GATE });
    const bId = await seed({ title: 'B', status: 'done', project: 'beta', steps: GATE });
    expect((await gatherTicketFacts({ project: 'beta' })).facts.map((f) => f.title)).toEqual(['B']);
    expect((await gatherTicketFacts({ id: bId })).facts.map((f) => f.title)).toEqual(['B']);
  });

  it('checks a single ticket by id regardless of its status', async () => {
    // Asking about one ticket by name should answer about that ticket, not silently return nothing
    // because it happens to still be open.
    const id = await seed({ title: 'Open', status: 'in-progress', steps: GATE });
    expect((await gatherTicketFacts({ id })).facts).toHaveLength(1);
  });
});

describe('reading the record', () => {
  it('takes the LATEST state per step, as the pipeline reducer does', async () => {
    const id = await seed({
      title: 'Retried',
      status: 'done',
      summary: 'Tests: 2 added — x',
      steps: [['branch', 'passed'], ['test', 'failed'], ['test', 'passed']],
    });
    const { facts } = await gatherTicketFacts({ id });
    expect(facts[0].steps.test).toBe('passed');
    expect(buildReport(facts).ok).toBe(1);
  });

  // The round trip for tkt-31f693ac8bb0: a record written by the PRE-FIX writer carries no
  // provenance marker, and must reach an `unknown` verdict through the real chain — event file,
  // readEvents, gather, verifyTicket — not merely in a unit fixture.
  it('reports UNKNOWN for a record with no provenance marker, however green it looks', async () => {
    const id = await seed({
      title: 'Pre-fix',
      status: 'done',
      summary: 'Tests: 2 added — x',
      steps: [['branch', 'passed'], ['test', 'passed']],
      trusted: false,
    });
    const { facts } = await gatherTicketFacts({ id });
    expect(facts[0].steps.test).toBe('passed');       // the state is still read
    expect(facts[0].trustedSteps.test).toBe(false);   // but it is not evidence
    const report = buildReport(facts);
    expect(report.ok).toBe(0);
    expect(report.unknown).toBe(1);
  });

  // Positive control on the same path: identical facts WITH the marker do conclude, so the case
  // above is measuring provenance and not some unrelated reason the verdict came back unknown.
  it('reports OK for the same record once it carries the marker', async () => {
    const id = await seed({
      title: 'Post-fix',
      status: 'done',
      summary: 'Tests: 2 added — x',
      steps: [['branch', 'passed'], ['test', 'passed']],
    });
    const { facts } = await gatherTicketFacts({ id });
    expect(facts[0].trustedSteps.test).toBe(true);
    expect(buildReport(facts).ok).toBe(1);
  });

  it('a re-run that ends FAILING is a violation, not forgiven by the earlier pass', async () => {
    const id = await seed({
      title: 'Regressed',
      status: 'done',
      summary: 'Tests: 2 added — x',
      steps: [['branch', 'passed'], ['test', 'passed'], ['test', 'failed']],
    });
    expect(buildReport((await gatherTicketFacts({ id })).facts).violations).toBe(1);
  });

  it('carries the lost-line count through, so absence is not read as evidence', async () => {
    const id = await seed({ title: 'Damaged', status: 'done', summary: 'Tests: 3 added — x', steps: [['branch', 'passed']] });
    // Seeded directly: appendEvent cannot produce a corrupt line, so this is the only way to stage one.
    await fs.appendFile(path.join(dirs.events, `${id}.jsonl`), 'not json at all\n', 'utf8');
    const { facts } = await gatherTicketFacts({ id });
    expect(facts[0].skippedLines).toBeGreaterThan(0);
    // Would be a VIOLATION on a clean log; the damage makes it unjudgeable instead.
    expect(buildReport(facts).unknown).toBe(1);
  });

  it('honours a cleared marker, as the pipeline reducer does', async () => {
    // reducePipeline reverts a step whose latest event carries the cleared detail. Reading raw state
    // would report a step the board itself renders as pending.
    const id = await seed({ title: 'Cleared', status: 'done', summary: 'Tests: 2 added — x', steps: [['branch', 'passed']] });
    await appendEvent({ ticketId: id, step: 'review', state: 'reached' });
    await appendEvent({ ticketId: id, step: 'review', state: 'reached', detail: 'cleared' });
    const { facts } = await gatherTicketFacts({ id });
    expect(facts[0].steps.review).toBeUndefined();
  });

  it('carries the version-skew count separately from the lost-line count', async () => {
    const id = await seed({ title: 'Skewed', status: 'done', summary: 'Tests: 3 added — x', steps: [['branch', 'passed']] });
    // A well-formed record naming a step this build's vocabulary lacks: skew, not damage.
    await fs.appendFile(
      path.join(dirs.events, `${id}.jsonl`),
      `${JSON.stringify({ ticketId: id, step: 'deploy', state: 'passed', at: '2026-08-16T00:00:00.000Z' })}\n`,
      'utf8',
    );
    const { facts } = await gatherTicketFacts({ id });
    expect(facts[0].skippedLines).toBe(0);
    expect(facts[0].unrecognizedLines).toBe(1);
    expect(buildReport(facts).unknown).toBe(1); // NOT a violation
  });

  it('reads the claim out of the real ticket body', async () => {
    const id = await seed({
      title: 'Claimer',
      status: 'done',
      summary: '## Implementation summary\n\nDid the thing.\n\nTests: 5 added — parser cases\nRisk: low',
      steps: GATE,
    });
    const { facts } = await gatherTicketFacts({ id });
    expect(facts[0].claim).toEqual({ kind: 'added', text: '5 added — parser cases' });
  });
});

describe('asking about a ticket that is not there', () => {
  it('ERRORS on an unmatched id instead of reporting an empty clean run', async () => {
    // parseVerifyArgs already refuses an unrecognised flag for exactly this reason; a typo'd or
    // renamed id deserves the same, or it reads as "checked, nothing wrong".
    await expect(gatherTicketFacts({ id: 'tkt-doesnotexist' })).rejects.toThrow(/not found/i);
  });

  it('ERRORS on an empty id rather than silently checking the whole board', async () => {
    // `verify "$ID"` with an unset variable passes ''. A truthiness check drops the filter and
    // reports on every closed ticket — an answer to a question nobody asked.
    await seed({ title: 'Some other ticket', status: 'done', steps: GATE });
    await expect(gatherTicketFacts({ id: '' })).rejects.toThrow(/not found/i);
  });
});

describe('a log that cannot be read', () => {
  it('yields UNKNOWN for that ticket and still reports on the rest', async () => {
    // Letting readEvents throw discards the finished report for every other ticket on a 700-ticket
    // board because one log was unreadable; pretending it was empty is the permissive answer.
    const bad = await seed({ title: 'Unreadable', status: 'done', summary: 'Tests: 3 added — x', steps: [['branch', 'passed']] });
    await seed({ title: 'Fine', status: 'done', summary: 'Tests: none — x', steps: GATE });
    const log = path.join(dirs.events, `${bad}.jsonl`);
    await fs.chmod(log, 0o000);
    try {
      const { facts } = await gatherTicketFacts();
      const r = buildReport(facts);
      expect(r.considered).toBe(2); // the healthy ticket survived
      const verdict = r.verdicts[facts.findIndex((f) => f.title === 'Unreadable')];
      expect(verdict.outcome).toBe('unknown');
      expect(verdict.reason).toContain('could not be read');
    } finally {
      await fs.chmod(log, 0o644);
    }
  });
});

describe('the end-to-end shape the live board showed', () => {
  it('separates a real discrepancy from an unobserved ticket and a docs-only one', async () => {
    // The three cases that decide whether this command is usable, in one assertion. On the live
    // board these are 4, 598 and 153 respectively.
    await seed({ title: 'Discrepancy', status: 'done', summary: 'Tests: 7 added — x', steps: [['branch', 'passed'], ['commit', 'passed']] });
    await seed({ title: 'Unobserved', status: 'done', summary: 'Tests: 7 added — x', steps: [] });
    await seed({ title: 'Docs only', status: 'done', summary: 'Tests: none — docs only', steps: [['branch', 'passed'], ['commit', 'passed']] });

    const { facts } = await gatherTicketFacts();
    const r = buildReport(facts);
    expect({ ok: r.ok, violations: r.violations, unknown: r.unknown }).toEqual({ ok: 1, violations: 1, unknown: 1 });
    const byTitle = Object.fromEntries(facts.map((f, i) => [f.title, r.verdicts[i].outcome]));
    expect(byTitle).toEqual({ Discrepancy: 'violation', Unobserved: 'unknown', 'Docs only': 'ok' });
  });

  it('reports an empty board as unmeasured rather than clean', async () => {
    const r = buildReport((await gatherTicketFacts()).facts);
    expect(r.considered).toBe(0);
    expect(r.violations).toBe(0); // and this zero must never be read as a pass — see formatReport
    expect(r.unknownRate).toBe(1);
  });
});
