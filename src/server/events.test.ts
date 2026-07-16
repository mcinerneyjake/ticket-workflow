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
    const events = await readEvents('tkt-abc');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ticketId: 'tkt-abc', step: 'typecheck', state: 'passed' });
    expect(typeof events[0]?.at).toBe('string');
  });

  it('preserves an explicit `at` and an optional `detail`', async () => {
    await appendEvent({ ticketId: 'tkt-abc', step: 'lint', state: 'failed', at: '2026-07-01T00:00:00.000Z', detail: '2 errors' });
    const [e] = await readEvents('tkt-abc');
    expect(e).toMatchObject({ at: '2026-07-01T00:00:00.000Z', detail: '2 errors' });
  });

  it('appends (never overwrites) across calls', async () => {
    await appendEvent({ ticketId: 'tkt-abc', step: 'branch', state: 'passed' });
    await appendEvent({ ticketId: 'tkt-abc', step: 'commit', state: 'passed' });
    expect(await readEvents('tkt-abc')).toHaveLength(2);
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
    expect(await readEvents('tkt-none')).toEqual([]);
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
    const events = await readEvents('tkt-abc');
    expect(events.map((e) => e.step)).toEqual(['lint', 'commit']);
  });

  it('rejects a path-traversal id with 400', async () => {
    const err = await httpError(readEvents('../../etc/passwd'));
    expect(err.status).toBe(400);
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
});
