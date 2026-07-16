import { describe, it, expect } from 'vitest';
import { handleToolCall, TOOLS, CREATE_STATUS_ENUM, UPDATE_STATUS_ENUM } from './handlers.js';
import { createTicket, updateTicket, listTickets } from '../server/tickets.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

setupTempTicketDirs('kanban-mcp-test');

// ---------------------------------------------------------------------------
// Parsing helpers — narrow JSON.parse output with predicates, no casts.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(result: { content: { text: string }[] }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.content[0].text);
  if (!isRecord(parsed)) throw new Error(`Expected JSON object, got: ${result.content[0].text}`);
  return parsed;
}

function asRecordArray(result: { content: { text: string }[] }): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(result.content[0].text);
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new Error(`Expected JSON object array, got: ${result.content[0].text}`);
  }
  return parsed;
}

function statusEnumOf(toolName: string): string[] {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool || !isRecord(tool.inputSchema.properties)) return [];
  const status = tool.inputSchema.properties.status;
  if (!isRecord(status) || !Array.isArray(status.enum)) return [];
  return status.enum.filter((v): v is string => typeof v === 'string');
}

async function seed(fields: Parameters<typeof createTicket>[0] = {}): Promise<string> {
  const t = await createTicket({ title: 'Seed', ...fields });
  return t.id;
}

// ---------------------------------------------------------------------------

describe('TOOLS schema', () => {
  it('exposes exactly the seven kanban tools', () => {
    expect(new Set(TOOLS.map((t) => t.name))).toEqual(
      new Set(['list_tickets', 'get_ticket', 'update_ticket', 'start_ticket', 'create_ticket', 'record_review', 'delete_ticket']),
    );
  });

  // qa is transition-only: update into it, never create in it — the schemas reflect that asymmetry.
  it('advertises qa on update_ticket but not on create_ticket', () => {
    expect(statusEnumOf('create_ticket')).not.toContain('qa');
    expect(statusEnumOf('update_ticket')).toContain('qa');
    expect(CREATE_STATUS_ENUM).not.toContain('qa');
    expect(UPDATE_STATUS_ENUM).toContain('qa');
  });
});

describe('list_tickets', () => {
  it('returns a lightweight summary — no full body, includes a one-line summary (happy path)', async () => {
    await seed({ title: 'A', body: '## Heading\n\nFirst real line.' });
    await seed({ title: 'B' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', undefined));
    expect(tickets).toHaveLength(2);
    for (const t of tickets) {
      expect(t).not.toHaveProperty('body');
      expect(t).toHaveProperty('summary');
      expect(t).toMatchObject({ id: expect.any(String), title: expect.any(String), status: expect.any(String) });
    }
  });

  it('summary is the first non-empty body line, markdown-stripped', async () => {
    await seed({ title: 'MD', body: '## Title line\n\nbody text' });
    const [t] = asRecordArray(await handleToolCall('list_tickets', { query: 'MD' }));
    expect(t.summary).toBe('Title line');
  });

  it('summary caps a long first line at 100 chars with an ellipsis', async () => {
    await seed({ title: 'Cap', body: 'y'.repeat(200) });
    const [t] = asRecordArray(await handleToolCall('list_tickets', { query: 'Cap' }));
    expect(t.summary).toBe(`${'y'.repeat(99)}…`);
  });

  it('filters by status', async () => {
    await seed({ title: 'todo one', status: 'todo' });
    await seed({ title: 'backlog one', status: 'backlog' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', { status: 'todo' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('todo one');
  });

  it('filters by project', async () => {
    await seed({ title: 'in proj', project: 'Alpha' });
    await seed({ title: 'no proj' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', { project: 'Alpha' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('in proj');
  });

  it('filters by query (case-insensitive title substring)', async () => {
    await seed({ title: 'Fix the Login bug' });
    await seed({ title: 'Add dashboard' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', { query: 'login' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('Fix the Login bug');
  });

  it('combines filters with AND', async () => {
    await seed({ title: 'match', status: 'todo', project: 'Alpha' });
    await seed({ title: 'match', status: 'todo', project: 'Beta' });
    await seed({ title: 'match', status: 'backlog', project: 'Alpha' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', { status: 'todo', project: 'Alpha' }));
    expect(tickets).toHaveLength(1);
  });

  it('rejects an invalid status filter (does not silently return everything)', async () => {
    await seed({ title: 'A' });
    const res = await handleToolCall('list_tickets', { status: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid status');
  });

  it('rejects a non-string status filter rather than coercing it to no-filter', async () => {
    await seed({ title: 'A' });
    await seed({ title: 'B' });
    const res = await handleToolCall('list_tickets', { status: ['todo'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid status');
  });

  it('accepts archived as a status filter and returns archived tickets', async () => {
    await seed({ title: 'live', status: 'todo' });
    // `archived` isn't creatable/MCP-settable — reach it via the service updateTicket.
    const goneId = await seed({ title: 'gone', status: 'todo' });
    await updateTicket(goneId, { status: 'archived' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', { status: 'archived' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('gone');
  });

  it('trims surrounding whitespace on the query filter', async () => {
    await seed({ title: 'Trimmable Login' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', { query: '  login  ' }));
    expect(tickets).toHaveLength(1);
  });

  it('treats a blank project/query filter as no filter', async () => {
    await seed({ title: 'one' });
    await seed({ title: 'two' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', { project: '   ', query: '' }));
    expect(tickets).toHaveLength(2);
  });

  it('summary preserves leading content that is not a real markdown marker', async () => {
    await seed({ title: 'NotMarker', body: '#1 priority issue' });
    const [t] = asRecordArray(await handleToolCall('list_tickets', { query: 'NotMarker' }));
    expect(t.summary).toBe('#1 priority issue');
  });

  it('summary strips a real list marker', async () => {
    await seed({ title: 'ListItem', body: '- do the thing' });
    const [t] = asRecordArray(await handleToolCall('list_tickets', { query: 'ListItem' }));
    expect(t.summary).toBe('do the thing');
  });

  it('returns an empty array when the board is empty (edge)', async () => {
    const tickets = asRecordArray(await handleToolCall('list_tickets', undefined));
    expect(tickets).toHaveLength(0);
  });

  // The TOOL projection drops the body, but the SERVICE must still return full bodies — agent/retrieval embeds t.body.
  it('leaves the service returning full bodies (agent retrieval path intact)', async () => {
    await seed({ title: 'Has body', body: 'real body content' });
    const viaTool = asRecordArray(await handleToolCall('list_tickets', undefined));
    expect(viaTool[0]).not.toHaveProperty('body');
    const viaService = await listTickets();
    expect(viaService[0].body).toBe('real body content');
  });
});

describe('get_ticket', () => {
  it('returns the ticket by id (happy path)', async () => {
    const id = await seed({ title: 'Find me' });
    const ticket = asRecord(await handleToolCall('get_ticket', { id }));
    expect(ticket.title).toBe('Find me');
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('get_ticket', { id: 'tkt-doesnotexist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('errors when id is missing (edge)', async () => {
    const res = await handleToolCall('get_ticket', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Missing required field: id');
  });
});

describe('create_ticket', () => {
  it('creates and persists a ticket, defaulting status to backlog (happy path)', async () => {
    const created = asRecord(await handleToolCall('create_ticket', { title: 'Brand new' }));
    expect(created.title).toBe('Brand new');
    expect(created.status).toBe('backlog');
    const all = await listTickets();
    expect(all.map((t) => t.id)).toContain(created.id);
  });

  it('honors explicit fields (edge)', async () => {
    const created = asRecord(await handleToolCall('create_ticket', {
      title: 'Configured', type: 'bug', priority: 'urgent', status: 'todo', project: 'Acme',
    }));
    expect(created.type).toBe('bug');
    expect(created.priority).toBe('urgent');
    expect(created.status).toBe('todo');
    expect(created.project).toBe('Acme');
  });

  it('persists dueDate and assignee (edge)', async () => {
    const created = asRecord(await handleToolCall('create_ticket', {
      title: 'Scheduled', dueDate: '2026-07-01', assignee: 'Jordan',
    }));
    expect(created.dueDate).toBe('2026-07-01');
    expect(created.assignee).toBe('Jordan');
  });

  it('errors when title is missing (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { type: 'task' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Title is required');
  });

  it('rejects an invalid enum value instead of dropping it (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { title: 'X', type: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid type');
  });

  it('rejects an invalid priority instead of dropping it (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { title: 'X', priority: 'meh' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid priority');
  });

  // qa is transition-only — create advertises no qa, so the runtime must reject it.
  it('rejects status qa at creation (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { title: 'X', status: 'qa' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid status');
  });
});

describe('update_ticket', () => {
  it('transitions a ticket into qa (happy path)', async () => {
    const id = await seed();
    const updated = asRecord(await handleToolCall('update_ticket', { id, status: 'qa' }));
    expect(updated.status).toBe('qa');
    const reread = await listTickets();
    expect(reread.find((t) => t.id === id)?.status).toBe('qa');
  });

  it('clears the project when passed null (edge)', async () => {
    const id = await seed({ project: 'Acme' });
    const updated = asRecord(await handleToolCall('update_ticket', { id, project: null }));
    expect(updated.project).toBeNull();
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('update_ticket', { id: 'tkt-doesnotexist', status: 'done' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('rejects an invalid status instead of dropping it (rejection)', async () => {
    const id = await seed();
    const res = await handleToolCall('update_ticket', { id, status: 'inprogres' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid status');
    // the bad value must not have been persisted
    const reread = await listTickets();
    expect(reread.find((t) => t.id === id)?.status).toBe('backlog');
  });

  it('rejects an invalid type instead of dropping it (rejection)', async () => {
    const id = await seed();
    const res = await handleToolCall('update_ticket', { id, type: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid type');
  });

  it('rejects an invalid priority instead of dropping it (rejection)', async () => {
    const id = await seed();
    const res = await handleToolCall('update_ticket', { id, priority: 'wat' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid priority');
  });

  it('persists blockers, parent, and body fields (edge)', async () => {
    const parentId = await seed({ title: 'Parent' });
    const id = await seed();
    const updated = asRecord(await handleToolCall('update_ticket', {
      id, blockers: ['tkt-aaa', 'tkt-bbb'], parent: parentId, body: 'New body text',
    }));
    expect(updated.blockers).toEqual(['tkt-aaa', 'tkt-bbb']);
    expect(updated.parent).toBe(parentId);
    expect(updated.body).toBe('New body text');
    // rejects a non-string-array blockers value (400), leaving existing blockers untouched
    const rejected = await handleToolCall('update_ticket', { id, blockers: [1, 2] });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain('blockers must be an array of strings');
    expect(asRecord(await handleToolCall('get_ticket', { id })).blockers).toEqual(['tkt-aaa', 'tkt-bbb']);
  });

  it('rejects present-but-wrong-typed fields with 400, not a silent no-op (parity with #82)', async () => {
    const id = await seed();
    for (const [args, needle] of [
      [{ id, title: 42 }, 'title must be a string'],
      [{ id, body: {} }, 'body must be a string'],
      [{ id, status: 5 }, 'Invalid status'],
      [{ id, project: 42 }, 'project must be a string or null'],
      [{ id, parent: 7 }, 'parent must be a string or null'],
      [{ id, dueDate: 5 }, 'dueDate must be a string or null'],
      [{ id, assignee: true }, 'assignee must be a string or null'],
    ] as const) {
      const res = await handleToolCall('update_ticket', args);
      expect(res.isError, `${JSON.stringify(args)}`).toBe(true);
      expect(res.content[0].text).toContain(needle);
    }
    // the ticket is untouched — none of the rejected writes landed
    const now = asRecord(await handleToolCall('get_ticket', { id }));
    expect(now.title).toBe('Seed');
  });

  it('record_review rejects a nonexistent ticket id instead of ghost-writing an events file', async () => {
    const res = await handleToolCall('record_review', { id: 'tkt-does-not-exist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('clears the parent when passed null (edge)', async () => {
    const parentId = await seed({ title: 'Parent 2' });
    const id = await seed();
    await handleToolCall('update_ticket', { id, parent: parentId });
    const cleared = asRecord(await handleToolCall('update_ticket', { id, parent: null }));
    expect(cleared.parent).toBeNull();
  });

  it('sets and clears dueDate and assignee (edge)', async () => {
    const id = await seed();
    const set = asRecord(await handleToolCall('update_ticket', { id, dueDate: '2026-07-01', assignee: 'Jordan' }));
    expect(set.dueDate).toBe('2026-07-01');
    expect(set.assignee).toBe('Jordan');
    const cleared = asRecord(await handleToolCall('update_ticket', { id, dueDate: null, assignee: null }));
    expect(cleared.dueDate).toBeNull();
    expect(cleared.assignee).toBeNull();
  });
});

describe('start_ticket', () => {
  it('marks a backlog ticket in-progress (happy path)', async () => {
    const id = await seed({ status: 'backlog' });
    const started = asRecord(await handleToolCall('start_ticket', { id }));
    expect(started.status).toBe('in-progress');
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('start_ticket', { id: 'tkt-doesnotexist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});

describe('delete_ticket', () => {
  it('deletes the ticket (happy path)', async () => {
    const id = await seed();
    const res = asRecord(await handleToolCall('delete_ticket', { id }));
    expect(res.deleted).toBe(id);
    const all = await listTickets();
    expect(all.map((t) => t.id)).not.toContain(id);
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('delete_ticket', { id: 'tkt-doesnotexist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});

describe('unknown tool', () => {
  it('returns an isError result naming the tool', async () => {
    const res = await handleToolCall('frobnicate', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unknown tool: frobnicate');
  });
});

describe('record_review', () => {
  it('marks the review step reached and returns the pipeline', async () => {
    const id = await seed();
    const res = await handleToolCall('record_review', { id });
    expect(res.isError).toBeFalsy();
    const body = asRecord(res);
    expect(body.ticketId).toBe(id);
    const pipeline = body.pipeline;
    if (!Array.isArray(pipeline)) throw new Error('expected a pipeline array');
    const review = pipeline.find((p) => isRecord(p) && p.step === 'review');
    expect(isRecord(review) ? review.state : null).toBe('reached');
  });

  it('errors when id is missing', async () => {
    const res = await handleToolCall('record_review', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('id');
  });

  it('errors on an invalid ticket id', async () => {
    const res = await handleToolCall('record_review', { id: 'bad.id' });
    expect(res.isError).toBe(true);
  });

  it('is advertised in TOOLS with a required id', () => {
    const tool = TOOLS.find((t) => t.name === 'record_review');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(['id']);
  });
});

describe('provenance stamping', () => {
  it('stamps source + runId on create when provenance is passed', async () => {
    const created = asRecord(await handleToolCall('create_ticket', { title: 'By agent' }, { source: 'agent', runId: 'run-1' }));
    expect(created.source).toBe('agent');
    expect(created.runId).toBe('run-1');
  });

  it('leaves a create unstamped when no provenance is passed', async () => {
    const created = asRecord(await handleToolCall('create_ticket', { title: 'By human' }));
    expect(created.source).toBeNull();
    expect(created.runId).toBeNull();
  });

  it('ignores source/runId supplied in tool args (model cannot spoof provenance)', async () => {
    const created = asRecord(await handleToolCall('create_ticket', { title: 'Spoof attempt', source: 'agent', runId: 'forged' }));
    expect(created.source).toBeNull(); // args.source is not read; only the trusted param stamps
    expect(created.runId).toBeNull();
  });

  it('links runId on update but does not reassign a human ticket to the agent', async () => {
    const created = asRecord(await handleToolCall('create_ticket', { title: 'Start' })); // human
    const id = typeof created.id === 'string' ? created.id : '';
    const updated = asRecord(await handleToolCall('update_ticket', { id, title: 'Edited' }, { source: 'agent', runId: 'run-2' }));
    expect(updated.source).toBeNull(); // authorship unchanged
    expect(updated.runId).toBe('run-2'); // run linked
  });
});
