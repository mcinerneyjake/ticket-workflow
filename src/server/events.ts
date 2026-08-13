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
  };
  await fs.mkdir(getEventsDir(), { recursive: true });
  // flag 'a' = O_APPEND: line-atomic across the two writer processes.
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

// A JSONL line with keys present but not type-checked; in-narrowed, no cast.
type RawEvent = { ticketId: unknown; step: unknown; state: unknown; at: unknown; detail?: unknown }

function asRawEvent(v: unknown): RawEvent | null {
  if (typeof v !== 'object' || v === null) return null;
  if (!('ticketId' in v) || !('step' in v) || !('state' in v) || !('at' in v)) return null;
  return v;
}

// Parse+validate one JSONL line → TicketEvent, or null (a corrupt line is skipped, never fatal).
function parseEventLine(line: string): TicketEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  const raw = asRawEvent(data);
  if (!raw) return null;
  if (typeof raw.ticketId !== 'string') return null;
  if (typeof raw.step !== 'string' || !isStepId(raw.step)) return null;
  if (typeof raw.state !== 'string' || !isStepState(raw.state)) return null;
  if (typeof raw.at !== 'string') return null;
  return {
    ticketId: raw.ticketId,
    step: raw.step,
    state: raw.state,
    at: raw.at,
    ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
  };
}

// All events for a ticket in file order. No file (never worked) → empty list, not an error.
// Only ENOENT may read as "no events": an unreadable log (EACCES/EIO/EMFILE) returning []
// is the permissive answer to "I could not check", and renders as an empty pipeline
// indistinguishable from a ticket nobody has worked (tkt-fc7c6846903d).
export async function readEvents(ticketId: string): Promise<TicketEvent[]> {
  const file = eventsPath(ticketId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isENOENT(err)) return [];
    // The path and stack stay server-side; the thrown message carries only the errno, because
    // consumers surface HttpError messages to clients and a raw fs error embeds the events dir.
    console.error('[events] read failed', file, err);
    const code = errnoCode(err);
    throw new HttpError(500, `Could not read events for ${ticketId}${code ? ` (${code})` : ''}`);
  }
  const events: TicketEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseEventLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
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
export async function getTicketEvents(ticketId: string): Promise<TicketEventsResponse> {
  const events = await readEvents(ticketId);
  return { ticketId, pipeline: reducePipeline(events), events };
}
