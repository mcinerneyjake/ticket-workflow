import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  listBoard, getTicket, createTicket, updateTicket, deleteTicket, HttpError,
  type UnreadableTicketFile,
} from '../server/tickets.js';
import { appendEvent, getTicketEvents } from '../server/events.js';
import {
  STATUS_IDS, TYPES, PRIORITIES,
  type Ticket, type StatusId, type Provenance,
} from '../shared/constants.js';
import {
  extractTicketFields, validatedStatus, CREATE_STATUS_ENUM, UPDATE_STATUS_ENUM,
} from '../server/validation.js';

// MCP tool handlers — the testable core; mcp/server.ts is the thin transport entrypoint.

export type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

function textContent(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

// Arg converters: Record<string, unknown> → typed objects, validated via typeof/predicate (no casts).

function extractId(args: Record<string, unknown> | undefined): string | null {
  return typeof args?.id === 'string' ? args.id : null;
}

// list_tickets returns a LIGHTWEIGHT summary, never the full body (belongs to
// get_ticket) — keeps results under the MCP token limit. The service still
// returns full Ticket[] for the agent's retrieval path.

type TicketSummary = Pick<Ticket, 'id' | 'title' | 'status' | 'priority' | 'type' | 'project'> & {
  summary: string
}

const SUMMARY_MAX = 100;

// First non-empty body line, stripping only proper leading markdown markers
// (marker + space, so "#1 priority" is preserved). Capped at SUMMARY_MAX by code
// point (Array.from) so the cut never splits a surrogate pair.
function summarize(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^(?:#{1,6}\s+|[-*>]\s+)+/, '').trim();
    if (line.length === 0) continue;
    const chars = Array.from(line);
    return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : line;
  }
  return '';
}

function toSummary(t: Ticket): TicketSummary {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    type: t.type,
    project: t.project,
    summary: summarize(t.body),
  };
}

type ListFilters = { status: StatusId | null; project: string | null; query: string | null; limit: number }

// Default cap on the unfiltered payload. The slim projection alone stopped scaling
// (~97KB / 442 tickets exceeds the MCP output cap → spills to a temp file every call,
// tkt-d6fb2ce5c780); a default limit keeps an unfiltered list_tickets usable at scale.
const DEFAULT_LIST_LIMIT = 100;

// Bounds the ids carried in the envelope. The full count still rides in `note`, so a
// truncated list can't read as the whole story (same contract as `omitted`).
const UNASSIGNED_LIMIT = 20;

// Statuses past work selection — a ticket here can't be "stranded out of the queue".
const SETTLED_STATUSES: readonly StatusId[] = ['done', 'archived'];

// A project of whitespace is worse than none: it is stored verbatim while
// `normalizeFilter` blanks the caller's filter, so NO filter value can ever match it.
function hasProject(t: Ticket): boolean {
  return t.project !== null && t.project.trim().length > 0;
}

// Silent on a board using no projects at all: nothing to partition, so every ticket
// would be reported on every call.
function findUnassigned(tickets: Ticket[]): string[] {
  if (!tickets.some(hasProject)) return [];
  return tickets.filter((t) => !hasProject(t) && !SETTLED_STATUSES.includes(t.status)).map((t) => t.id);
}

// Trim a string filter arg; non-string/blank → null (matches the HTTP route's trim convention).
function normalizeFilter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Present-but-invalid limit is REJECTED, not coerced (parity with the status filter) —
// a malformed limit must not silently fall back to a huge default and re-blow the cap.
function extractLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `Invalid limit: ${String(value)} (must be a positive integer)`);
  }
  return value;
}

// Status validated against all STATUS_IDS (incl. archived). Present-but-invalid is
// REJECTED, not coerced to "no filter", so a malformed scope can't silently return the whole board.
function extractListFilters(args: Record<string, unknown> | undefined): ListFilters {
  let status: StatusId | null = null;
  if (args?.status !== undefined && args.status !== null) {
    if (typeof args.status !== 'string') {
      throw new HttpError(400, `Invalid status: ${String(args.status)} (allowed: ${STATUS_IDS.join(', ')})`);
    }
    status = validatedStatus(args.status, STATUS_IDS);
  }
  return {
    status,
    project: normalizeFilter(args?.project),
    query: normalizeFilter(args?.query),
    limit: extractLimit(args?.limit),
  };
}

// AND-combine the optional filters. query is a case-insensitive title substring.
function applyListFilters(tickets: Ticket[], f: ListFilters): Ticket[] {
  const q = f.query?.toLowerCase();
  return tickets.filter((t) =>
    // Default view hides archived (~half the board, rarely wanted); an explicit
    // status:archived still reaches them (tkt-d6fb2ce5c780).
    (f.status === null ? t.status !== 'archived' : t.status === f.status) &&
    (f.project === null || t.project === f.project) &&
    (q === undefined || t.title.toLowerCase().includes(q)),
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: 'list_tickets',
    description: 'List kanban tickets as a lightweight summary — id, title, status, priority, type, project, and a one-line summary of each body (NOT the full body; call get_ticket for that). Returns an object { total, returned, omitted, unreadable, unassigned, tickets, note? }: total is the matched count, tickets is capped at limit, and note explains how to see the rest when omitted > 0. unreadable lists any ticket FILES that could not be parsed — they are skipped so one corrupt file cannot take the board down, and they are absent from every count, so a non-empty unreadable means the board is larger than total reports. unassigned lists the ids of OPEN tickets (not done, not archived) that have NO usable project: they are missing from every project-filtered view, so no work queue can select them until a project is set. It is capped at 20 ids — note carries the true total — and is empty on a board that uses no projects at all. unreadable and unassigned are both board-wide and are NOT narrowed by your filters, so their numbers stay comparable across calls. Archived tickets are EXCLUDED by default; pass status:"archived" to see them. Optionally filter by status, project, or a case-insensitive title substring (query). Use this first to find a ticket before working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUS_IDS, description: 'Only return tickets with this status. Archived is excluded by default — pass "archived" to see archived tickets.' },
        project: { type: 'string', description: 'Only return tickets in this project' },
        query: { type: 'string', description: 'Case-insensitive substring match on the ticket title' },
        limit: { type: 'integer', description: `Max tickets to return (default ${DEFAULT_LIST_LIMIT}). The response reports total/returned/omitted; raise this or filter to see more.` },
      },
      required: [],
    },
  },
  {
    name: 'get_ticket',
    description: 'Get full details of a specific ticket by ID, including its markdown body.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Ticket ID, e.g. tkt-abc123' } },
      required: ['id'],
    },
  },
  {
    name: 'update_ticket',
    description: 'Update one or more fields on a ticket. Omit fields you do not want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket ID' },
        title: { type: 'string' },
        status: { type: 'string', enum: UPDATE_STATUS_ENUM },
        priority: { type: 'string', enum: [...PRIORITIES] },
        type: { type: 'string', enum: [...TYPES] },
        body: { type: 'string', description: 'Full markdown description of the ticket — REPLACES the existing body. Use appendBody to add content without overwriting.' },
        appendBody: { type: 'string', description: 'Text to append to the existing body (non-destructive, blank-line separated). Use instead of body to add a section without overwriting; cannot be combined with body.' },
        project: { type: ['string', 'null'], description: 'Project name, or null to clear' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'List of blocking ticket IDs' },
        parent: { type: ['string', 'null'], description: 'Parent ticket ID, or null to clear' },
        dueDate: { type: ['string', 'null'], description: 'Due date YYYY-MM-DD, or null to clear' },
        assignee: { type: ['string', 'null'], description: 'Assignee name, or null to clear' },
      },
      required: ['id'],
    },
  },
  {
    name: 'start_ticket',
    description: 'Mark a ticket in-progress and return its full details including body. Use this when the user picks a ticket to work on — it sets the status and loads everything needed to begin implementation in one call.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Ticket ID' } },
      required: ['id'],
    },
  },
  {
    name: 'create_ticket',
    description: 'Create a new ticket on the kanban board.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: [...TYPES] },
        priority: { type: 'string', enum: [...PRIORITIES] },
        status: { type: 'string', enum: CREATE_STATUS_ENUM },
        body: { type: 'string', description: 'Markdown description' },
        project: { type: 'string', description: 'Project name' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'List of blocking ticket IDs' },
        parent: { type: 'string', description: 'Parent ticket ID' },
        dueDate: { type: 'string', description: 'Due date YYYY-MM-DD' },
        assignee: { type: 'string', description: 'Assignee name' },
      },
      required: ['title'],
    },
  },
  {
    name: 'record_review',
    description: 'Record the manual review milestone (the "Ready to commit?" gate) for a ticket — marks its Review step complete in the tracker. The commit hook records this automatically on a successful commit; use this tool to mark it explicitly (e.g. when the user confirms their review before you commit).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Ticket ID' } },
      required: ['id'],
    },
  },
  {
    name: 'archive_ticket',
    description: 'Archive a ticket by ID — retires it off the board: archived tickets are excluded from list_tickets by default. Use this for a superseded or abandoned ticket instead of deleting it. Archiving an already-archived ticket is a no-op. Find it again with list_tickets status "archived". Reversible, but the ticket\'s previous status is NOT recorded — restore it with update_ticket by setting the status the ticket should return to (a ticket archived while done should go back to "done", not "backlog"), and check its current status with get_ticket before archiving if you may need to restore it later.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Ticket ID' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_ticket',
    description: 'Permanently delete a ticket by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Ticket ID' } },
      required: ['id'],
    },
  },
];

// Dispatch: one tool call → one ToolResult. Errors normalized to an isError
// result (HttpError message passes through; anything else wrapped) so the client
// always gets structured content.

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  // Trusted authorship stamp — passed ONLY by the agent write path (human MCP/HTTP
  // call without it). Never from `args`, so the model can't forge or omit it.
  provenance?: Provenance,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_tickets': {
        const filters = extractListFilters(args); // throws on a present-but-invalid status/limit
        const { tickets, unreadable } = await listBoard();
        const matched = applyListFilters(tickets, filters);
        const shown = matched.slice(0, filters.limit);
        const omitted = matched.length - shown.length;
        // Board-wide, like `unreadable`: a project filter would hide the very tickets
        // being reported (tkt-88f229321ad9).
        const unassignedAll = findUnassigned(tickets);
        const unassigned = unassignedAll.slice(0, UNASSIGNED_LIMIT);
        // Envelope, not a bare array: total/returned/omitted let the caller see the cut
        // and page/filter; the bare array couldn't signal truncation (tkt-d6fb2ce5c780).
        // `unreadable` is board-wide and deliberately NOT run through the filters — a file
        // that won't parse has no status/project to match on, so a filter must never hide
        // it. Always present, even empty: an absent field reads as "nothing wrong".
        const result: { total: number; returned: number; omitted: number; unreadable: UnreadableTicketFile[]; unassigned: string[]; tickets: TicketSummary[]; note?: string } = {
          total: matched.length,
          returned: shown.length,
          omitted,
          unreadable,
          unassigned,
          tickets: shown.map(toSummary),
        };
        const notes: string[] = [];
        if (omitted > 0) {
          notes.push(`${omitted} more ticket(s) omitted by limit=${filters.limit}; narrow with status/project/query or raise limit.`);
        }
        if (unreadable.length > 0) {
          notes.push(`${unreadable.length} ticket file(s) could NOT be read and are missing from every count above: ${unreadable.map((u) => u.file).join(', ')}. Fix the frontmatter — an unquoted title containing a colon is the usual cause.`);
        }
        if (unassignedAll.length > 0) {
          const more = unassignedAll.length - unassigned.length;
          notes.push(`${unassignedAll.length} open ticket(s) have NO project and are therefore invisible to every project-filtered view: ${unassigned.join(', ')}${more > 0 ? `, and ${more} more (not listed in \`unassigned\`)` : ''}. Assign a project with update_ticket, or they can never be selected as work.`);
        }
        if (notes.length > 0) result.note = notes.join(' ');
        // Compact (no indent): pretty-print whitespace on a large array is pure token cost.
        return { content: [textContent(JSON.stringify(result))] };
      }

      case 'get_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await getTicket(id), null, 2))] };
      }

      case 'update_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await updateTicket(id, extractTicketFields(args, UPDATE_STATUS_ENUM), provenance), null, 2))] };
      }

      case 'start_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await updateTicket(id, { status: 'in-progress' }), null, 2))] };
      }

      case 'record_review': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        // Verify existence first (404) — else a typo'd id creates a ghost
        // events/<id>.jsonl. Writes via the service directly, so it works with no web server running.
        await getTicket(id);
        await appendEvent({ ticketId: id, step: 'review', state: 'reached' });
        return { content: [textContent(JSON.stringify(await getTicketEvents(id), null, 2))] };
      }

      case 'create_ticket':
        // allowAppendBody:false — appendBody is update-only; omit it on create so a
        // model that read the update schema can't hard-fail a create (tkt-aea35fa11c2d).
        return { content: [textContent(JSON.stringify(await createTicket(extractTicketFields(args, CREATE_STATUS_ENUM, { allowAppendBody: false }), provenance), null, 2))] };

      // A named tool, not a status value on update_ticket: `archived` is deliberately absent from
      // UPDATE_STATUS_ENUM so archiving can't be reached by mistyping a field on an ordinary edit,
      // and so it stays out of the intake agent's name-allowlisted toolset (tkt-f388cfc8ad4b).
      case 'archive_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await updateTicket(id, { status: 'archived' }), null, 2))] };
      }

      case 'delete_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        await deleteTicket(id);
        return { content: [textContent(JSON.stringify({ deleted: id }, null, 2))] };
      }

      default:
        return { content: [textContent(`Unknown tool: ${name}`)], isError: true };
    }
  } catch (err) {
    const message = err instanceof HttpError
      ? err.message
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [textContent(message)], isError: true };
  }
}
