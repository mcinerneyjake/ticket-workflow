import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, readEvents, reducePipeline, getTicketEvents } from './events.js';
import { HttpError } from './tickets.js';
import { STEP_IDS, type TicketEvent } from '../shared/constants.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-events-test-'));
  process.env.EVENTS_DIR_OVERRIDE = tmpDir;
});

afterAll(async () => {
  delete process.env.EVENTS_DIR_OVERRIDE;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const files = await fs.readdir(tmpDir);
  await Promise.all(files.map((f) => fs.unlink(path.join(tmpDir, f))));
});

async function httpError<T>(p: Promise<T>): Promise<HttpError> {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  if (!(err instanceof HttpError)) throw new Error('Expected HttpError');
  return err;
}

// Seed a raw JSONL file directly, bypassing appendEvent's validation.
async function writeRaw(ticketId: string, lines: string[]) {
  await fs.writeFile(path.join(tmpDir, `${ticketId}.jsonl`), lines.join('\n'), 'utf8');
}

describe('appendEvent', () => {
  it('appends a well-formed line and readEvents round-trips it', async () => {
    await appendEvent({ ticketId: 'tkt-abc', step: 'typecheck', state: 'passed' });
    const { events } = await readEvents('tkt-abc');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ticketId: 'tkt-abc', step: 'typecheck', state: 'passed' });
    expect(typeof events[0]?.at).toBe('string');
  });

  it('preserves an explicit `at` and an optional `detail`', async () => {
    await appendEvent({ ticketId: 'tkt-abc', step: 'lint', state: 'failed', at: '2026-07-01T00:00:00.000Z', detail: '2 errors' });
    const [e] = (await readEvents('tkt-abc')).events;
    expect(e).toMatchObject({ at: '2026-07-01T00:00:00.000Z', detail: '2 errors' });
  });

  it('appends (never overwrites) across calls', async () => {
    await appendEvent({ ticketId: 'tkt-abc', step: 'branch', state: 'passed' });
    await appendEvent({ ticketId: 'tkt-abc', step: 'commit', state: 'passed' });
    expect((await readEvents('tkt-abc')).events).toHaveLength(2);
  });

  it('rejects an invalid step with 400', async () => {
    const err = await httpError(appendEvent({ ticketId: 'tkt-abc', step: 'bogus', state: 'passed' }));
    expect(err.status).toBe(400);
  });

  it('rejects an invalid state with 400', async () => {
    const err = await httpError(appendEvent({ ticketId: 'tkt-abc', step: 'lint', state: 'exploded' }));
    expect(err.status).toBe(400);
  });

  it('rejects a path-traversal id with 400 (never writes outside the events dir)', async () => {
    const err = await httpError(appendEvent({ ticketId: '../escape', step: 'lint', state: 'passed' }));
    expect(err.status).toBe(400);
  });
});

describe('readEvents', () => {
  it('returns [] for a ticket that has never been worked (no file)', async () => {
    expect(await readEvents('tkt-none')).toEqual({ events: [], skipped: 0, unrecognized: 0 });
  });

  it('skips malformed / non-conforming lines instead of throwing', async () => {
    await writeRaw('tkt-abc', [
      'not json at all',
      JSON.stringify({ ticketId: 'tkt-abc', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
      JSON.stringify({ ticketId: 'tkt-abc', step: 'not-a-step', state: 'passed', at: 'x' }),
      JSON.stringify({ ticketId: 'tkt-abc', step: 'test', state: 'bad-state', at: 'x' }),
      '', // blank line
      JSON.stringify({ ticketId: 'tkt-abc', step: 'commit', state: 'passed', at: '2026-07-01T00:00:01.000Z' }),
    ]);
    const { events } = await readEvents('tkt-abc');
    expect(events.map((e) => e.step)).toEqual(['lint', 'commit']);
  });

  it('rejects a path-traversal id with 400', async () => {
    const err = await httpError(readEvents('../../etc/passwd'));
    expect(err.status).toBe(400);
  });

  // "I could not read this" must not return the same answer as "there is nothing here":
  // an unreadable log rendered as an empty pipeline (tkt-fc7c6846903d).
  //
  // skipIf, not an early return: root bypasses the mode bits and Windows chmod only toggles the
  // read-only bit, so the case cannot be staged there — and a test that silently REPORTS PASSED
  // where it never ran is the same fail-open this ticket exists to remove. Skipped is visible.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects an unreadable events file instead of returning [] like an absent one',
    async () => {
      await writeRaw('tkt-noperm', [
        JSON.stringify({ ticketId: 'tkt-noperm', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
      ]);
      const file = path.join(tmpDir, 'tkt-noperm.jsonl');
      await fs.chmod(file, 0o000);
      try {
        const err = await httpError(readEvents('tkt-noperm'));
        expect(err.status).toBe(500);
        expect(err.message).toContain('EACCES');
        // The absolute events dir must not ride along — consumers surface this message to clients.
        expect(err.message).not.toContain(tmpDir);
      } finally {
        await fs.chmod(file, 0o644);
      }
    },
  );

  it('still returns [] for a genuinely absent file (the ENOENT case stays permissive)', async () => {
    expect((await readEvents('tkt-absent')).events).toEqual([]);
  });

  // A discarded line is data loss the caller cannot see: the surviving events reduce to a shorter
  // pipeline that looks exactly like a ticket with fewer milestones (tkt-355581f9dab3).
  describe('skipped / unrecognized accounting', () => {
    it('counts structurally broken lines as skipped', async () => {
      await writeRaw('tkt-abc', [
        'not json at all',
        '{"unterminated',
        JSON.stringify({ ticketId: 'tkt-abc', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
        JSON.stringify({ ticketId: 'tkt-abc', step: 'commit', state: 'passed' }), // missing `at`
        JSON.stringify({ nope: 1 }), // missing every required key
        '', // blank — separator noise, not a skip
        JSON.stringify({ ticketId: 'tkt-abc', step: 'done', state: 'reached', at: '2026-07-01T00:00:09.000Z' }),
      ]);
      const { events, skipped, unrecognized } = await readEvents('tkt-abc');
      expect(events.map((e) => e.step)).toEqual(['lint', 'done']);
      expect(skipped).toBe(4);
      expect(unrecognized).toBe(0);
    });

    // The distinction that keeps the count honest. The track-steps hook is installed ONCE per
    // machine while readers are pinned per repo, so a newer hook writing a step id added after a
    // consumer's pin is routine — counting it as loss would report every healthy log as damaged
    // for as long as the pin lagged.
    it('counts well-formed lines with unknown vocabulary as unrecognized, not lost', async () => {
      await writeRaw('tkt-skew', [
        JSON.stringify({ ticketId: 'tkt-skew', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
        JSON.stringify({ ticketId: 'tkt-skew', step: 'deploy', state: 'passed', at: 'x' }), // future step
        JSON.stringify({ ticketId: 'tkt-skew', step: 'test', state: 'flaked', at: 'x' }), // future state
      ]);
      const { events, skipped, unrecognized } = await readEvents('tkt-skew');
      expect(events.map((e) => e.step)).toEqual(['lint']);
      expect(unrecognized).toBe(2);
      expect(skipped).toBe(0); // the load-bearing half: version skew must not read as damage
    });

    // The negative control. A counter wired to a constant, or incrementing unconditionally, passes
    // the tests above and fails this one.
    it('reports 0/0 for a clean log', async () => {
      await appendEvent({ ticketId: 'tkt-clean', step: 'lint', state: 'passed' });
      await appendEvent({ ticketId: 'tkt-clean', step: 'test', state: 'passed' });
      const { events, skipped, unrecognized } = await readEvents('tkt-clean');
      expect(events).toHaveLength(2);
      expect(skipped).toBe(0);
      expect(unrecognized).toBe(0);
    });

    it('blank lines are separators, not skips', async () => {
      await writeRaw('tkt-blank', [
        '',
        JSON.stringify({ ticketId: 'tkt-blank', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
        '   ',
        '',
      ]);
      const { events, skipped } = await readEvents('tkt-blank');
      expect(events).toHaveLength(1);
      expect(skipped).toBe(0);
    });

    // An append in flight leaves a partial final line. Counting it would flap 1 → 0 between polls
    // (kanban re-reads every 2s) and claim loss for a record that is merely mid-write.
    it('does not count a torn FINAL line — an append in flight is not a loss', async () => {
      await writeRaw('tkt-torn', [
        JSON.stringify({ ticketId: 'tkt-torn', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
        '{"ticketId":"tkt-torn","step":"co', // mid-write, no trailing newline
      ]);
      const { events, skipped } = await readEvents('tkt-torn');
      expect(events).toHaveLength(1);
      expect(skipped).toBe(0);
    });

    // ...but once anything lands after it, the same torn line is permanent damage and IS counted.
    // Without this, the rule above would be an unconditional exemption for broken tails.
    it('counts that same torn line once a later event follows it', async () => {
      await writeRaw('tkt-torn2', [
        JSON.stringify({ ticketId: 'tkt-torn2', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
        '{"ticketId":"tkt-torn2","step":"co',
        JSON.stringify({ ticketId: 'tkt-torn2', step: 'done', state: 'reached', at: '2026-07-01T00:00:09.000Z' }),
      ]);
      const { events, skipped } = await readEvents('tkt-torn2');
      expect(events.map((e) => e.step)).toEqual(['lint', 'done']);
      expect(skipped).toBe(1);
    });
  });
});

describe('reducePipeline', () => {
  it('yields every canonical step in order, pending when no event arrived', () => {
    const pipeline = reducePipeline([]);
    expect(pipeline.map((p) => p.step)).toEqual(STEP_IDS);
    expect(pipeline.every((p) => p.state === 'pending' && p.at === null)).toBe(true);
  });

  it('takes the LATEST event per step (failed-then-passed retry lands on passed)', () => {
    const events: TicketEvent[] = [
      { ticketId: 't', step: 'lint', state: 'failed', at: '2026-07-01T00:00:00.000Z' },
      { ticketId: 't', step: 'lint', state: 'passed', at: '2026-07-01T00:00:05.000Z' },
    ];
    const lint = reducePipeline(events).find((p) => p.step === 'lint');
    expect(lint).toMatchObject({ state: 'passed', at: '2026-07-01T00:00:05.000Z' });
  });

  it('reverts a step to pending when the latest event is a `cleared` marker (un-review)', () => {
    const events: TicketEvent[] = [
      { ticketId: 't', step: 'review', state: 'reached', at: '2026-07-01T00:00:00.000Z' },
      { ticketId: 't', step: 'review', state: 'reached', at: '2026-07-01T00:00:05.000Z', detail: 'cleared' },
    ];
    expect(reducePipeline(events).find((p) => p.step === 'review')?.state).toBe('pending');
  });

  it('re-reviews after a clear (latest wins)', () => {
    const events: TicketEvent[] = [
      { ticketId: 't', step: 'review', state: 'reached', at: '2026-07-01T00:00:00.000Z', detail: 'cleared' },
      { ticketId: 't', step: 'review', state: 'reached', at: '2026-07-01T00:00:05.000Z' },
    ];
    expect(reducePipeline(events).find((p) => p.step === 'review')?.state).toBe('reached');
  });
});

describe('getTicketEvents', () => {
  it('returns the raw events plus the reduced pipeline', async () => {
    await appendEvent({ ticketId: 'tkt-abc', step: 'started', state: 'reached' });
    const out = await getTicketEvents('tkt-abc');
    expect(out.ticketId).toBe('tkt-abc');
    expect(out.events).toHaveLength(1);
    expect(out.pipeline.find((p) => p.step === 'started')?.state).toBe('reached');
    expect(out.pipeline.find((p) => p.step === 'done')?.state).toBe('pending');
  });

  // The pipeline below is reduced from a log the reader already knows is incomplete, so the count
  // has to survive the aggregation — dropping it here hides the loss at the API boundary, which is
  // the only boundary any consumer sees.
  it('carries the skipped count through to the response, beside the pipeline it reduced', async () => {
    await writeRaw('tkt-abc', [
      'garbage',
      JSON.stringify({ ticketId: 'tkt-abc', step: 'lint', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
      JSON.stringify({ ticketId: 'tkt-abc', step: 'nope', state: 'passed', at: 'x' }),
    ]);
    const out = await getTicketEvents('tkt-abc');
    expect(out.skipped).toBe(1); // 'garbage'
    expect(out.unrecognized).toBe(1); // step 'nope' — shape is sound, vocabulary is not
    expect(out.pipeline.find((p) => p.step === 'lint')?.state).toBe('passed');
  });

  it('reports 0 skipped on a clean log', async () => {
    await appendEvent({ ticketId: 'tkt-ok', step: 'started', state: 'reached' });
    expect((await getTicketEvents('tkt-ok')).skipped).toBe(0);
  });
});
