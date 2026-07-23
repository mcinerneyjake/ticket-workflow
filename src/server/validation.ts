import {
  BOARD_STATUSES, CREATE_STATUS_IDS,
  isStatusId, isTicketType, isPriority,
  type Ticket, type StatusId,
} from '../shared/constants.js';
import { HttpError } from './tickets.js';

// Protocol-neutral write validation — shared by the MCP handlers and a consumer's
// HTTP intake controller so neither has to depend on the other's layer (tkt-156c5c00149b).

// Create/update status enums. Asymmetric: qa is a gate you transition INTO, never
// create in. Both derive from shared/constants so contract, MCP validator, and
// HTTP service can't drift on which statuses are creatable.
export const UPDATE_STATUS_ENUM = BOARD_STATUSES.map((s) => s.id);
export const CREATE_STATUS_ENUM = CREATE_STATUS_IDS;

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

// Validate a status against the per-call allowed set → narrowed StatusId. Shared
// by the field extractor and the list filter so the two paths can't drift.
export function validatedStatus(value: string, allowedStatuses: readonly string[]): StatusId {
  if (!isStatusId(value) || !allowedStatuses.includes(value)) {
    throw new HttpError(400, `Invalid status: ${value} (allowed: ${allowedStatuses.join(', ')})`);
  }
  return value;
}

// appendBody is a transient instruction, not a Ticket field: it appends to the
// existing body (non-destructive) and is never persisted. Mutually exclusive with body.
type TicketFields = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>> & { appendBody?: string }

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
  if (args.appendBody !== undefined) {
    if (typeof args.appendBody !== 'string') throw new HttpError(400, 'appendBody must be a string');
    out.appendBody = args.appendBody;
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
