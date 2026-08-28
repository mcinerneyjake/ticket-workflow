import fs from 'node:fs/promises';
import path from 'node:path';
import {
  STEPS,
  isStepId,
  isStepState,
  type StepId,
  type TicketEvent,
  type PipelineStep,
  type TicketEventsResponse,
} from '../shared/constants.js';
import { eventsDir } from '../paths.js';
import { HttpError, isENOENT, errnoCode } from './tickets.js';

// Workflow-step telemetry: append-only JSONL, one file per ticket, in events/
// (outside tickets/). Writers persist directly (appendEvent + PostToolUse hook);
// server only READS, so events survive with no web server running (tkt-512f9b15ddb8).
// Import cycle with tickets.ts (HttpError ↔ appendEvent) is safe: both use the
// binding only inside function bodies, so ESM resolves before either runs.

// Board root comes from the consumer repo (paths.ts) — see events dir resolution there.
function getEventsDir() {
  return eventsDir();
}

// Path-traversal guard (as tickets.ts): a crafted id can't escape the events dir.
const ID_RE = /^[a-zA-Z0-9-]+$/;

function eventsPath(ticketId: string): string {
  if (!ID_RE.test(ticketId)) throw new HttpError(400, `Invalid ticket id: ${ticketId}`);
  return path.join(getEventsDir(), `${ticketId}.jsonl`);
}

// Append one milestone event. step/state typed loosely so untyped callers can't
// smuggle an invalid value past the guards that narrow them.
export async function appendEvent(event: {
  ticketId: string
  step: string
  state: string
  at?: string
  detail?: string
  /** Only a writer that derived `state` from a delivered hook event may set this; `verify` reads it
   *  as provenance. The service's own status milestones carry no outcome and must leave it unset. */
  outcomeFrom?: 'event'
}): Promise<void> {
  const file = eventsPath(event.ticketId);
  if (!isStepId(event.step)) throw new HttpError(400, `Invalid step: ${event.step}`);
  if (!isStepState(event.state)) throw new HttpError(400, `Invalid state: ${event.state}`);
  const record: TicketEvent = {
    ticketId: event.ticketId,
    step: event.step,
    state: event.state,
    at: event.at ?? new Date().toISOString(),
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.outcomeFrom === 'event' ? { outcomeFrom: 'event' as const } : {}),
  };
  await fs.mkdir(getEventsDir(), { recursive: true });
  // flag 'a' = O_APPEND: line-atomic across the two writer processes.
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

// A JSONL line with keys present but not type-checked; in-narrowed, no cast.
type RawEvent = { ticketId: unknown; step: unknown; state: unknown; at: unknown; detail?: unknown; outcomeFrom?: unknown }

function asRawEvent(v: unknown): RawEvent | null {
  if (typeof v !== 'object' || v === null) return null;
  if (!('ticketId' in v) || !('step' in v) || !('state' in v) || !('at' in v)) return null;
  return v;
}

// Two ways a line fails, and conflating them makes the count lie. `malformed` is data loss — the
// record is unreadable by anyone. `unrecognized` is a well-formed record naming a step/state this
// reader's vocabulary lacks, which is version skew, not damage: the track-steps hook is installed
// ONCE per machine while readers are pinned per repo, so a newer hook writing a step id added after
// a consumer's pin is expected and healthy (tkt-355581f9dab3).
type ParseFailure = 'malformed' | 'unrecognized'
type ParsedLine = { ok: true; event: TicketEvent } | { ok: false; reason: ParseFailure }

function parseEventLine(line: string): ParsedLine {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const raw = asRawEvent(data);
  if (!raw) return { ok: false, reason: 'malformed' };
  if (typeof raw.ticketId !== 'string') return { ok: false, reason: 'malformed' };
  if (typeof raw.at !== 'string') return { ok: false, reason: 'malformed' };
  if (typeof raw.step !== 'string' || typeof raw.state !== 'string') return { ok: false, reason: 'malformed' };
  // Shape is sound; only the vocabulary is unknown.
  if (!isStepId(raw.step) || !isStepState(raw.state)) return { ok: false, reason: 'unrecognized' };
  return {
    ok: true,
    event: {
      ticketId: raw.ticketId,
      step: raw.step,
      state: raw.state,
      at: raw.at,
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
      // Whitelisted through deliberately: this is what lets `verify` tell a row whose state was
      // derived from the delivered event from a pre-fix row that said `passed` regardless. Any
      // other value is dropped, so a forged or unknown marker reads as absent — untrusted.
      ...(raw.outcomeFrom === 'event' ? { outcomeFrom: 'event' as const } : {}),
    },
  };
}

// Returned WITH the events rather than logged, so the caller that renders the pipeline is the one
// holding the evidence that it is incomplete: a discarded line reduces to a shorter pipeline,
// indistinguishable from a ticket with fewer milestones (tkt-355581f9dab3). Mirrors listBoard's
// `unreadable`, and follows the same rule the README states for it — reported to the caller, never
// only to stderr. Deliberately NOT logged here: this path is polled (kanban re-reads every 2s
// while a ticket is on screen), so one permanently bad line would emit ~1800 stderr lines an hour.
//
// `skipped` is data loss. `unrecognized` is version skew and is NOT loss — keeping them apart is
// the point, since only `skipped > 0` should ever be read as "this log is damaged".
export type ReadEventsResult = { events: TicketEvent[]; skipped: number; unrecognized: number }

// All events for a ticket in file order. No file (never worked) → empty list, not an error.
// Only ENOENT may read as "no events": an unreadable log (EACCES/EIO/EMFILE) returning []
// is the permissive answer to "I could not check", and renders as an empty pipeline
// indistinguishable from a ticket nobody has worked (tkt-fc7c6846903d).
export async function readEvents(ticketId: string): Promise<ReadEventsResult> {
  const file = eventsPath(ticketId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isENOENT(err)) return { events: [], skipped: 0, unrecognized: 0 };
    // The path and stack stay server-side; the thrown message carries only the errno, because
    // consumers surface HttpError messages to clients and a raw fs error embeds the events dir.
    console.error('[events] read failed', file, err);
    const code = errnoCode(err);
    throw new HttpError(500, `Could not read events for ${ticketId}${code ? ` (${code})` : ''}`);
  }
  const events: TicketEvent[] = [];
  let skipped = 0;
  let unrecognized = 0;
  const lines = raw.split('\n');
  for (const [i, line] of lines.entries()) {
    // Blank lines are separator noise from the trailing newline, not lost records — counting them
    // would report every healthy log as damaged.
    if (!line.trim()) continue;
    const parsed = parseEventLine(line);
    if (parsed.ok) { events.push(parsed.event); continue; }
    // appendEvent terminates every complete record with \n, so a non-empty LAST chunk is a write in
    // flight, not a lost one — this path is polled during active work, and counting it would flap
    // 1 → 0 between reads. Residual, accepted: if the writer died mid-append and no further event
    // ever lands, that torn tail stays uncounted. Once anything else appends it is no longer last,
    // and it is counted from then on.
    if (i === lines.length - 1 && parsed.reason === 'malformed') continue;
    if (parsed.reason === 'unrecognized') unrecognized++;
    else skipped++;
  }
  return { events, skipped, unrecognized };
}

// Marker to un-set the toggleable review milestone. Appended (not deleting the
// prior line) so the log stays append-only and race-free with the hook's
// concurrent writes; the reducer maps a cleared-latest back to pending.
export const REVIEW_CLEARED = 'cleared';

// Reduce events to the pipeline: each step's LATEST state (last-write-wins), or
// pending if none. A latest 'cleared' event reverts that step to pending.
export function reducePipeline(events: TicketEvent[]): PipelineStep[] {
  const latest = new Map<StepId, TicketEvent>();
  for (const e of events) latest.set(e.step, e);
  return STEPS.map((s) => {
    const e = latest.get(s.id);
    const active = e && e.detail !== REVIEW_CLEARED ? e : undefined;
    return {
      step: s.id,
      label: s.label,
      state: active ? active.state : 'pending',
      at: active ? active.at : null,
    };
  });
}

// Read-side aggregation: raw events + reduced pipeline. Validates the id (400 on bad shape).
// `skipped` is carried through untouched — the pipeline below is reduced from a log the reader
// already knows is incomplete, and a consumer judging that pipeline needs to know it.
export async function getTicketEvents(ticketId: string): Promise<TicketEventsResponse> {
  const { events, skipped, unrecognized } = await readEvents(ticketId);
  return { ticketId, pipeline: reducePipeline(events), events, skipped, unrecognized };
}
