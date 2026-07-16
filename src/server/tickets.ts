import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { STATUS_IDS, TYPES, PRIORITIES, BOARD_STATUSES, CREATE_STATUS_IDS, STATUS_STEP, isSource, type Ticket, type StatusId, type DashboardSummary, type Provenance } from '../shared/constants.js';
import { ticketsDir } from '../paths.js';
import { appendEvent } from './events.js';

// Service layer: the only module that touches the filesystem (Route -> Service).
// Source of truth: one markdown file per ticket in the board's /tickets dir.

// Board root comes from the consumer repo (paths.ts), not __dirname — the service
// runs from inside node_modules. Kept as an exported function for the watcher.
export function getTicketsDir() {
  return ticketsDir();
}

// Path-traversal guard: re-checked on every path build so a crafted :id can't escape TICKETS_DIR.
const ID_RE = /^[a-zA-Z0-9-]+$/;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ENOENT = "not found" (404); every other fs error is a real fault → 500, not a masked 404.
function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

type TicketPatch = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'order' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>>

// gray-matter parse output. js-yaml auto-parses unquoted ISO dates → Date objects.
interface RawFrontmatter {
  title?: string | Date
  type?: string
  priority?: string
  status?: string
  order?: number
  created?: string | Date
  updated?: string | Date
  project?: string | null
  blockers?: (string | number | boolean)[]
  parent?: string | null
  dueDate?: string | null
  assignee?: string | null
  source?: string | null
  runId?: string | null
}

interface SerializedFrontmatter {
  title: string
  type: string
  priority: string
  status: string
  order: number
  created: string
  updated: string
  project?: string
  blockers?: string[]
  parent?: string
  dueDate?: string
  assignee?: string
  source?: string
  runId?: string
}

async function ensureDir() {
  await fs.mkdir(getTicketsDir(), { recursive: true });
}

function ticketPath(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, `Invalid ticket id: ${id}`);
  return path.join(getTicketsDir(), `${id}.md`);
}

function validEnum<T extends string>(arr: readonly T[], val: string | null | undefined, fallback: T): T {
  const found = arr.find((item) => item === val);
  return found !== undefined ? found : fallback;
}

function assertEnum<T extends string>(arr: readonly T[], val: T | undefined | null, field: string) {
  if (val != null && arr.find((item) => item === val) === undefined)
    throw new HttpError(400, `Invalid ${field}: ${val}`);
}

// Coerce to string: js-yaml may yield a Date, and hand-edited YAML a number
// (title: 42) — neither must flow through as a non-string value.
function asString(v: string | Date | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return '';
}

// Normalize a parsed file to a stable ticket; invalid enums fall back to defaults
// so a hand-edited file can't crash the board.
function normalize(id: string, data: RawFrontmatter, body: string): Ticket {
  return {
    id,
    title: asString(data.title),
    type: validEnum(TYPES, data.type, 'task'),
    priority: validEnum(PRIORITIES, data.priority, 'medium'),
    status: validEnum(STATUS_IDS, data.status, 'backlog'),
    order: typeof data.order === 'number' ? data.order : 0,
    created: asString(data.created),
    updated: asString(data.updated),
    body: (body || '').trim(),
    project: typeof data.project === 'string' && data.project ? data.project : null,
    blockers: Array.isArray(data.blockers)
      ? data.blockers.filter((v): v is string => typeof v === 'string')
      : [],
    parent: typeof data.parent === 'string' && data.parent ? data.parent : null,
    dueDate: typeof data.dueDate === 'string' && data.dueDate ? data.dueDate : null,
    assignee: typeof data.assignee === 'string' && data.assignee ? data.assignee : null,
    source: typeof data.source === 'string' && isSource(data.source) ? data.source : null,
    runId: typeof data.runId === 'string' && data.runId ? data.runId : null,
  };
}

// Explicit key order -> deterministic, diff-friendly frontmatter.
function serialize(ticket: Ticket): string {
  const data: SerializedFrontmatter = {
    title: ticket.title,
    type: ticket.type,
    priority: ticket.priority,
    status: ticket.status,
    order: ticket.order,
    created: ticket.created,
    updated: ticket.updated,
  };
  if (ticket.project) data.project = ticket.project;
  if (ticket.blockers.length > 0) data.blockers = ticket.blockers;
  if (ticket.parent) data.parent = ticket.parent;
  if (ticket.dueDate) data.dueDate = ticket.dueDate;
  if (ticket.assignee) data.assignee = ticket.assignee;
  // Provenance keys are omitted for human/CLI writes (both null) → clean diffs.
  if (ticket.source) data.source = ticket.source;
  if (ticket.runId) data.runId = ticket.runId;
  return matter.stringify(`\n${ticket.body}\n`, data);
}

// Atomic temp-file + rename: a crash mid-write leaves the original intact.
// Per-call random suffix (not just pid) so two overlapping writes to the same id
// can't share a temp path and interleave. Temp cleaned up on rename failure.
async function writeTicket(ticket: Ticket) {
  await ensureDir();
  const file = ticketPath(ticket.id);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, serialize(ticket), 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

function validateEnums(patch: TicketPatch) {
  assertEnum(TYPES, patch.type, 'type');
  assertEnum(PRIORITIES, patch.priority, 'priority');
  assertEnum(STATUS_IDS, patch.status, 'status');
}

// Single write choke point for both the typed MCP path and the raw Express path
// (req.body is any). Runtime typeof guards → a bad HTTP body 400s instead of a
// 500 or a silent data-loss write.
function validateWritableTypes(patch: TicketPatch) {
  if (patch.title != null && typeof patch.title !== 'string')
    throw new HttpError(400, 'title must be a string');
  if (patch.body != null && typeof patch.body !== 'string')
    throw new HttpError(400, 'body must be a string');
  if (patch.order != null && (typeof patch.order !== 'number' || !Number.isFinite(patch.order)))
    // Infinity/NaN pass typeof 'number' but poison ordering (maxOrder+1 = Infinity) — reject non-finite.
    throw new HttpError(400, 'order must be a finite number');
  for (const field of ['project', 'parent', 'dueDate', 'assignee'] as const) {
    const value = patch[field];
    if (value != null && typeof value !== 'string')
      throw new HttpError(400, `${field} must be a string or null`);
  }
  if (patch.blockers != null &&
      (!Array.isArray(patch.blockers) || !patch.blockers.every((b) => typeof b === 'string')))
    throw new HttpError(400, 'blockers must be an array of strings');
}

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Enforce YYYY-MM-DD on write so a bad hand-edited value can't reach the UI or break the overdue comparison.
function assertDueDate(dueDate: string | null | undefined) {
  if (typeof dueDate !== 'string') return;
  if (!DUE_DATE_RE.test(dueDate))
    throw new HttpError(400, 'dueDate must be YYYY-MM-DD');
  // Regex admits impossible dates (2026-02-30); round-trip through Date to reject non-real calendar dates.
  const parsed = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dueDate)
    throw new HttpError(400, `dueDate is not a real calendar date: ${dueDate}`);
}

function newId(): string {
  return `tkt-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// Passing any options object bypasses gray-matter's content cache. Without it,
// bad YAML throws once then the cache returns an empty *success* — a corrupt
// ticket silently reappears as an empty ghost. Empty object = defaults, no cache.
const NO_CACHE: Parameters<typeof matter>[1] = {};


// --- Public API ------------------------------------------------------------

export async function listTickets(): Promise<Ticket[]> {
  await ensureDir();
  const files = await fs.readdir(getTicketsDir());
  const tickets: Ticket[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(getTicketsDir(), file), 'utf8');
    try {
      const { data, content } = matter(raw, NO_CACHE); // NO_CACHE → consistent throw on bad YAML
      tickets.push(normalize(file.slice(0, -3), data, content));
    } catch (err) {
      // Unparseable frontmatter must not take the whole board down — skip + warn so the rest stays up.
      console.warn(`[tickets] skipping unparseable ticket file ${file}:`, err instanceof Error ? err.message : err);
    }
  }
  return tickets.sort((a, b) => a.order - b.order);
}

export async function listProjects(): Promise<string[]> {
  const tickets = await listTickets();
  return [...new Set(tickets.map((t) => t.project).filter((p): p is string => Boolean(p)))].sort();
}

export async function getTicket(id: string): Promise<Ticket> {
  const file = ticketPath(id); // validate id before the try → bad id is 400, not a masked 404
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isENOENT(err)) throw new HttpError(404, `Ticket not found: ${id}`);
    throw err; // EACCES/EMFILE/… are real faults → 500, not a masked 404
  }
  try {
    const { data, content } = matter(raw, NO_CACHE); // see NO_CACHE: consistent throw on bad YAML
    return normalize(id, data, content);
  } catch (err) {
    // File exists but frontmatter won't parse — surface a clear error naming the ticket, not a raw YAMLException.
    throw new HttpError(500, `Ticket ${id} has unparseable frontmatter: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// provenance is a TRUSTED stamp — supplied only by the agent write path, never
// derived from `input`, so authorship can't be forged by an untrusted caller.
export async function createTicket(input: Partial<Ticket>, provenance?: Provenance): Promise<Ticket> {
  validateWritableTypes(input);
  assertEnum(TYPES, input.type, 'type');
  assertEnum(PRIORITIES, input.priority, 'priority');
  // Create restricted to pre-work columns — reject qa/archived (parity with the MCP create schema).
  if (input.status != null && !CREATE_STATUS_IDS.includes(input.status))
    throw new HttpError(400, `Invalid status: ${input.status} (allowed for create: ${CREATE_STATUS_IDS.join(', ')})`);
  assertDueDate(input.dueDate);
  if (!input.title || !input.title.trim())
    throw new HttpError(400, 'Title is required');

  const now = new Date().toISOString();
  const all = await listTickets();
  const maxOrder = all.reduce((m, t) => Math.max(m, t.order), 0);

  const ticket = normalize(
    newId(),
    {
      title: input.title.trim(),
      type: input.type ?? 'task',
      priority: input.priority ?? 'medium',
      status: input.status ?? 'backlog',
      order: maxOrder + 1,
      created: now,
      updated: now,
      blockers: input.blockers ?? [],
      project: input.project ?? null,
      parent: input.parent ?? null,
      dueDate: input.dueDate ?? null,
      assignee: input.assignee ?? null,
      source: provenance?.source,
      runId: provenance?.runId,
    },
    input.body ?? '',
  );
  await writeTicket(ticket);
  return ticket;
}

// Cycle guard: the new parent may not be `id` nor any descendant of it. Computed
// server-side so HTTP/MCP callers can't persist a cycle the UI already prevents.
function collectDescendants(id: string, all: Ticket[]): Set<string> {
  const descendants = new Set<string>();
  const queue: string[] = [id];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const t of all) {
      if (t.parent === cur && !descendants.has(t.id)) {
        descendants.add(t.id);
        queue.push(t.id);
      }
    }
  }
  return descendants;
}

// Best-effort telemetry: a transition into a tracked milestone records a 'reached'
// event. Single choke point for MCP + HTTP; a telemetry failure must never break
// the write (swallowed).
async function emitStatusStep(id: string, status: StatusId): Promise<void> {
  const step = STATUS_STEP[status];
  if (!step) return;
  try {
    await appendEvent({ ticketId: id, step, state: 'reached' });
  } catch (err) {
    console.error('[events] failed to record status step', err);
  }
}

export async function updateTicket(id: string, patch: TicketPatch, provenance?: Provenance): Promise<Ticket> {
  validateWritableTypes(patch);
  validateEnums(patch);
  assertDueDate(patch.dueDate);
  const existing = await getTicket(id);
  if (typeof patch.parent === 'string') {
    if (patch.parent === id) throw new HttpError(400, 'A ticket cannot be its own parent');
    if (collectDescendants(id, await listTickets()).has(patch.parent))
      throw new HttpError(400, 'parent would create a cycle');
  }
  // Explicit field-by-field merge: MCP callers bypass TicketPatch typing, so
  // reading only known fields drops unknown keys at runtime.
  const merged: Ticket = {
    id,
    title: patch.title ?? existing.title,
    type: patch.type ?? existing.type,
    priority: patch.priority ?? existing.priority,
    status: patch.status ?? existing.status,
    order: patch.order ?? existing.order,
    body: patch.body ?? existing.body,
    // null is a valid patch value (clears the field); undefined means no change
    project: patch.project !== undefined ? patch.project : existing.project,
    blockers: patch.blockers ?? existing.blockers,
    parent: patch.parent !== undefined ? patch.parent : existing.parent,
    dueDate: patch.dueDate !== undefined ? patch.dueDate : existing.dueDate,
    assignee: patch.assignee !== undefined ? patch.assignee : existing.assignee,
    // Authorship set once at CREATE, never reassigned — an agent edit of a human
    // ticket can't claim it. Only runId is refreshed by an agent write (the
    // cost-attribution join); a human/HTTP write preserves the existing runId.
    source: existing.source,
    runId: provenance ? provenance.runId : existing.runId,
    created: existing.created,
    updated: new Date().toISOString(),
  };
  if (!merged.title.trim()) throw new HttpError(400, 'Title is required');
  await writeTicket(merged);
  // Emit only on a real status change — body/priority/reorder patches must not record a milestone.
  if (merged.status !== existing.status) await emitStatusStep(id, merged.status);
  return merged;
}

const ARCHIVE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export async function archiveStaleTickets(): Promise<number> {
  const tickets = await listTickets();
  const now = Date.now();
  const stale = tickets.filter((ticket) => {
    if (ticket.status !== 'done') return false;
    const updatedAt = new Date(ticket.updated).getTime();
    return !isNaN(updatedAt) && now - updatedAt >= ARCHIVE_AGE_MS;
  });
  const archived = new Date().toISOString();
  await Promise.all(stale.map((ticket) => writeTicket({ ...ticket, status: 'archived', updated: archived })));
  console.log(`[archive] Archived ${stale.length} stale ticket(s)`);
  return stale.length;
}

export async function searchTickets(q: string): Promise<Ticket[]> {
  const term = q.toLowerCase();
  const tickets = await listTickets();
  return tickets.filter(
    (t) => t.title.toLowerCase().includes(term) || t.body.toLowerCase().includes(term),
  );
}

const RECENT_LIMIT = 8;

// Pure aggregation (no IO) behind the dashboard. Archived excluded; a project arg scopes every count.
export function summarize(tickets: Ticket[], project: string | null = null): DashboardSummary {
  const scoped = tickets.filter(
    (t) => t.status !== 'archived' && (project === null || t.project === project),
  );
  const byStatus = BOARD_STATUSES.map((s) => ({
    status: s.id,
    count: scoped.filter((t) => t.status === s.id).length,
  }));
  const byPriority = PRIORITIES.map((priority) => ({
    priority,
    count: scoped.filter((t) => t.priority === priority).length,
  }));
  const byType = TYPES.map((type) => ({
    type,
    count: scoped.filter((t) => t.type === type).length,
  }));
  // ISO timestamps sort lexicographically = chronologically; newest first.
  const recentlyUpdated = [...scoped]
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, RECENT_LIMIT)
    .map(({ id, title, status, priority, project: p, updated }) => ({
      id, title, status, priority, project: p, updated,
    }));
  return { project, total: scoped.length, byStatus, byPriority, byType, recentlyUpdated };
}

export async function summarizeBoard(project: string | null = null): Promise<DashboardSummary> {
  return summarize(await listTickets(), project);
}

export async function deleteTicket(id: string): Promise<void> {
  const file = ticketPath(id); // validate id before the try (see getTicket)
  try {
    await fs.unlink(file);
  } catch (err) {
    if (isENOENT(err)) throw new HttpError(404, `Ticket not found: ${id}`);
    throw err; // EACCES/EMFILE/… are real faults → 500, not a masked 404
  }
  // Best-effort referential cleanup: strip the deleted id from blocker edges and
  // orphan its children to top-level. Housekeeping, not part of delete's contract
  // — a sweep failure is logged, never propagated. Rewrites keep `updated`
  // untouched so cleanup isn't surfaced as an edit.
  try {
    const affected = (await listTickets()).filter((t) => t.blockers.includes(id) || t.parent === id);
    await Promise.all(
      affected.map((t) => writeTicket({
        ...t,
        blockers: t.blockers.filter((b) => b !== id),
        parent: t.parent === id ? null : t.parent,
      })),
    );
  } catch (err) {
    console.error(`[delete] referential cleanup for ${id} failed:`, err);
  }
}
