import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  listTickets, getTicket, createTicket, updateTicket, deleteTicket, HttpError,
} from '../server/tickets.js';
import { appendEvent, getTicketEvents } from '../server/events.js';
import {
  BOARD_STATUSES, STATUS_IDS, CREATE_STATUS_IDS, TYPES, PRIORITIES,
  isStatusId, isTicketType, isPriority,
  type Ticket, type StatusId, type Provenance,
} from '../shared/constants.js';

// MCP tool handlers — the testable core; mcp/server.ts is the thin transport entrypoint.

export type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

// Create/update status enums. Asymmetric: qa is a gate you transition INTO, never
// create in. Both derive from shared/constants so contract, MCP validator, and
// HTTP service can't drift on which statuses are creatable.
export const UPDATE_STATUS_ENUM = BOARD_STATUSES.map((s) => s.id);
export const CREATE_STATUS_ENUM = CREATE_STATUS_IDS;

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

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

// Validate a status against the per-call allowed set → narrowed StatusId. Shared
// by the field extractor and the list filter so the two paths can't drift.
function validatedStatus(value: string, allowedStatuses: readonly string[]): StatusId {
  if (!isStatusId(value) || !allowedStatuses.includes(value)) {
    throw new HttpError(400, `Invalid status: ${value} (allowed: ${allowedStatuses.join(', ')})`);
  }
  return value;
}

type TicketFields = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>>

// allowedStatuses is the per-operation set (create vs update), enforcing the
// advertised schema at runtime. Invalid values are rejected (parity with the HTTP
// 400), not silently dropped, so an impossible state (qa at create) surfaces.
export function extractTicketFields(
  args: Record<string, unknown> | undefined,
  allowedStatuses: readonly string[],
): TicketFields {
  const out: TicketFields = {};
  if (!args) return out;
  // Present-but-wrong-typed is REJECTED (400), not silently dropped (parity with
  // validateWritableTypes, #82) — else update_ticket {title:42} drops title and
  // reports a no-op success. !== undefined: absent (skip) vs present-malformed (throw).
  if (args.title !== undefined) {
    if (typeof args.title !== 'string') throw new HttpError(400, 'title must be a string');
    out.title = args.title;
  }
  if (args.type !== undefined) {
    if (typeof args.type !== 'string' || !isTicketType(args.type))
      throw new HttpError(400, `Invalid type: ${String(args.type)}`);
    out.type = args.type;
  }
  if (args.priority !== undefined) {
    if (typeof args.priority !== 'string' || !isPriority(args.priority))
      throw new HttpError(400, `Invalid priority: ${String(args.priority)}`);
    out.priority = args.priority;
  }
  if (args.status !== undefined) {
    if (typeof args.status !== 'string')
      throw new HttpError(400, `Invalid status: ${String(args.status)} (allowed: ${allowedStatuses.join(', ')})`);
    out.status = validatedStatus(args.status, allowedStatuses);
  }
  if (args.body !== undefined) {
    if (typeof args.body !== 'string') throw new HttpError(400, 'body must be a string');
    out.body = args.body;
  }
  if (args.project !== undefined) {
    if (typeof args.project === 'string' || args.project === null) out.project = args.project;
    else throw new HttpError(400, 'project must be a string or null');
  }
  if (args.parent !== undefined) {
    if (typeof args.parent === 'string' || args.parent === null) out.parent = args.parent;
    else throw new HttpError(400, 'parent must be a string or null');
  }
  if (args.dueDate !== undefined) {
    if (typeof args.dueDate === 'string' || args.dueDate === null) out.dueDate = args.dueDate;
    else throw new HttpError(400, 'dueDate must be a string or null');
  }
  if (args.assignee !== undefined) {
    if (typeof args.assignee === 'string' || args.assignee === null) out.assignee = args.assignee;
    else throw new HttpError(400, 'assignee must be a string or null');
  }
  if (args.blockers !== undefined) {
    if (!isStringArray(args.blockers)) throw new HttpError(400, 'blockers must be an array of strings');
    out.blockers = args.blockers;
  }
  return out;
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

type ListFilters = { status: StatusId | null; project: string | null; query: string | null }

// Trim a string filter arg; non-string/blank → null (matches the HTTP route's trim convention).
function normalizeFilter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  return { status, project: normalizeFilter(args?.project), query: normalizeFilter(args?.query) };
}

// AND-combine the optional filters. query is a case-insensitive title substring.
function applyListFilters(tickets: Ticket[], f: ListFilters): Ticket[] {
  const q = f.query?.toLowerCase();
  return tickets.filter((t) =>
    (f.status === null || t.status === f.status) &&
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
    description: 'List kanban tickets as a lightweight summary — id, title, status, priority, type, project, and a one-line summary of each body (NOT the full body; call get_ticket for that). Optionally filter by status, project, or a case-insensitive title substring (query). Use this first to find a ticket before working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUS_IDS, description: 'Only return tickets with this status (includes archived)' },
        project: { type: 'string', description: 'Only return tickets in this project' },
        query: { type: 'string', description: 'Case-insensitive substring match on the ticket title' },
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
        body: { type: 'string', description: 'Full markdown description of the ticket' },
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
        const filters = extractListFilters(args); // throws on a present-but-invalid status
        const summaries = applyListFilters(await listTickets(), filters).map(toSummary);
        // Compact (no indent): a large array's pretty-print whitespace is pure token cost. Single-object results stay pretty below.
        return { content: [textContent(JSON.stringify(summaries))] };
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
        return { content: [textContent(JSON.stringify(await createTicket(extractTicketFields(args, CREATE_STATUS_ENUM), provenance), null, 2))] };

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
