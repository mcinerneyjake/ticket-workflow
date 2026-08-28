// Single source of truth for domain enums (server validation + React form options) — prevents UI/API drift.

export const BOARD_STATUSES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'qa', label: 'QA' },
  { id: 'done', label: 'Done' },
] as const;

// All statuses incl. archived (API validation + modal dropdown).
export const STATUSES = [
  ...BOARD_STATUSES,
  { id: 'archived', label: 'Archived' },
] as const;

export const STATUS_IDS = STATUSES.map((s) => s.id);

// Statuses a ticket may be CREATED in: board columns minus qa (a gate you
// transition INTO) and archived (an end-state). Shared so the HTTP service and
// MCP create schema can't diverge.
export const CREATE_STATUS_IDS: readonly StatusId[] = BOARD_STATUSES
  .map((s) => s.id)
  .filter((s) => s !== 'qa');

export const TYPES = ['bug', 'feature', 'task', 'chore'] as const;

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

// Provenance authorship: agent = autonomous CLI write; assisted = human-reviewed
// agent draft. Human/MCP/HTTP write leaves source null. Distinct from
// Document.source (a retrieval connector); this names the WRITER.
export const SOURCES = ['agent', 'assisted'] as const;

// Trusted provenance stamp — threaded only through the agent write path, never
// from HTTP bodies or tool args, so authorship can't be spoofed.
export type Provenance = { source: TicketSource; runId: string }

export type StatusId = (typeof STATUSES)[number]['id']
export type TicketType = (typeof TYPES)[number]
export type Priority = (typeof PRIORITIES)[number]
export type TicketSource = (typeof SOURCES)[number]

// Type predicates — find() narrows to the literal union without a cast.
export function isStatusId(val: string): val is StatusId {
  return STATUS_IDS.find((s) => s === val) !== undefined;
}
export function isTicketType(val: string): val is TicketType {
  return TYPES.find((t) => t === val) !== undefined;
}
export function isPriority(val: string): val is Priority {
  return PRIORITIES.find((p) => p === val) !== undefined;
}
export function isSource(val: string): val is TicketSource {
  return SOURCES.find((s) => s === val) !== undefined;
}

export type Ticket = {
  id: string
  title: string
  type: TicketType
  priority: Priority
  status: StatusId
  order: number
  created: string
  updated: string
  body: string
  project: string | null
  blockers: string[]
  parent: string | null
  dueDate: string | null
  assignee: string | null
  // Provenance — non-null only for agent-authored tickets. Optional so test
  // literals can omit it; normalize() always emits an explicit value. runId links
  // to the run log for per-ticket usage lookup.
  source?: TicketSource | null
  runId?: string | null
}

// --- Dashboard aggregation -------------------------------------------------
// Shared server/client so they can't drift; counts exclude archived, canonical enum order.

export type StatusCount = { status: StatusId; count: number }
export type PriorityCount = { priority: Priority; count: number }
export type TypeCount = { type: TicketType; count: number }

// --- Workflow-step telemetry ----------------------------------------------
// Ordered milestones a ticket passes through. Shared so emitters + reader can't drift (tkt-512f9b15ddb8).
// Split: started/qa/done are STATUS transitions (updateTicket); the rest are shell commands (PostToolUse hook).

export const STEPS = [
  { id: 'started', label: 'Started' },
  { id: 'branch', label: 'Branch' },
  { id: 'typecheck', label: 'Typecheck' },
  { id: 'lint', label: 'Lint' },
  { id: 'test', label: 'Tests' },
  { id: 'review', label: 'Review' },
  { id: 'commit', label: 'Commit' },
  { id: 'pr_opened', label: 'PR opened' },
  { id: 'qa', label: 'QA' },
  { id: 'done', label: 'Done' },
] as const;

export const STEP_IDS = STEPS.map((s) => s.id);
export type StepId = (typeof STEPS)[number]['id']

// The ticket-id shape embedded in a <type>/<id>-<slug> branch name — the single
// source of truth for the pattern newId() mints and the track-steps hook greps
// for. A parity test asserts the hook's inline regex matches this .source.
export const BRANCH_TICKET_ID_RE = /tkt-[0-9a-f]{12}/;

// reached = status milestone hit (no pass/fail); passed/failed = command milestone resolved via exit code.
export const STEP_STATES = ['reached', 'passed', 'failed'] as const;
export type StepState = (typeof STEP_STATES)[number]

// Status transitions that map to a tracked milestone; others emit nothing.
export const STATUS_STEP: Partial<Record<StatusId, StepId>> = {
  'in-progress': 'started',
  qa: 'qa',
  done: 'done',
};

export type TicketEvent = {
  ticketId: string
  step: StepId
  state: StepState
  at: string
  detail?: string
  /** `'event'` when the writer derived `state` from the delivered hook event. Absent on rows written
   *  before tkt-31f693ac8bb0, whose state was `passed` regardless of how the command went, and on
   *  service-written status milestones, which carry no outcome at all. */
  outcomeFrom?: 'event'
}

// A reduced pipeline node: latest state per step, or pending if none arrived.
export type PipelineStep = {
  step: StepId
  label: string
  state: StepState | 'pending'
  at: string | null
}

export function isStepId(val: string): val is StepId {
  return STEP_IDS.find((s) => s === val) !== undefined;
}
export function isStepState(val: string): val is StepState {
  return STEP_STATES.find((s) => s === val) !== undefined;
}

// GET /api/tickets/:id/events payload. Shared server/client to prevent drift.
// Both counts are REQUIRED, not optional: a consumer defaulting with `?? 0` would report a damaged
// log as healthy, which is the one failure they exist to make visible (tkt-355581f9dab3).
// `skipped` = lines lost. `unrecognized` = lines this reader's vocabulary is too old to parse —
// version skew, not damage. Only `skipped > 0` means the pipeline below is missing history.
export type TicketEventsResponse = {
  ticketId: string
  pipeline: PipelineStep[]
  events: TicketEvent[]
  skipped: number
  unrecognized: number
}

// Trimmed ticket for the "recently updated" widget — avoids shipping every body.
export type RecentTicket = Pick<Ticket, 'id' | 'title' | 'status' | 'priority' | 'project' | 'updated'>

export type DashboardSummary = {
  project: string | null // null = all projects
  total: number
  byStatus: StatusCount[]
  byPriority: PriorityCount[]
  byType: TypeCount[]
  recentlyUpdated: RecentTicket[]
}
