import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleToolCall, TOOLS } from './handlers.js';
import { CREATE_STATUS_ENUM, UPDATE_STATUS_ENUM } from '../server/validation.js';
import { createTicket, updateTicket, listTickets, getTicket } from '../server/tickets.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

const dirs = setupTempTicketDirs('kanban-mcp-test');

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

// list_tickets returns an envelope { total, returned, omitted, tickets, note? }.
// asList unwraps the tickets array; asEnvelope exposes the metadata (tkt-d6fb2ce5c780).
function asEnvelope(result: { content: { text: string }[] }): Record<string, unknown> {
  return asRecord(result);
}

function asList(result: { content: { text: string }[] }): Record<string, unknown>[] {
  const tickets = asEnvelope(result).tickets;
  if (!Array.isArray(tickets) || !tickets.every(isRecord)) {
    throw new Error(`Expected envelope.tickets array, got: ${result.content[0].text}`);
  }
  return tickets;
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
  it('exposes exactly the eight kanban tools', () => {
    expect(new Set(TOOLS.map((t) => t.name))).toEqual(
      new Set(['list_tickets', 'get_ticket', 'update_ticket', 'start_ticket', 'create_ticket', 'record_review', 'archive_ticket', 'delete_ticket']),
    );
  });

  // tkt-f388cfc8ad4b — archive_ticket exists BECAUSE archived is not an update_ticket status.
  // If a later change adds it to the enum, archiving becomes reachable by mistyping a field on an
  // ordinary edit and this tool's reason for existing is gone — so pin the absence, not just the tool.
  it('keeps archived off the update_ticket status enum', () => {
    expect(statusEnumOf('update_ticket')).not.toContain('archived');
    expect(UPDATE_STATUS_ENUM).not.toContain('archived');
    expect(statusEnumOf('create_ticket')).not.toContain('archived');
  });

  // qa is transition-only: update into it, never create in it — the schemas reflect that asymmetry.
  it('advertises qa on update_ticket but not on create_ticket', () => {
    expect(statusEnumOf('create_ticket')).not.toContain('qa');
    expect(statusEnumOf('update_ticket')).toContain('qa');
    expect(CREATE_STATUS_ENUM).not.toContain('qa');
    expect(UPDATE_STATUS_ENUM).toContain('qa');
  });

  // tkt-b49ec09e97ff — the schema must advertise the same integer contract the runtime
  // enforces (extractLimit rejects non-integers), or a model passing limit:2.5 gets a
  // 400 the schema said was valid.
  it('advertises list_tickets limit as an integer, matching the runtime check', () => {
    const tool = TOOLS.find((t) => t.name === 'list_tickets');
    const props = tool && isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    const limit = isRecord(props.limit) ? props.limit : {};
    expect(limit.type).toBe('integer');
  });
});

describe('list_tickets', () => {
  it('returns a lightweight summary — no full body, includes a one-line summary (happy path)', async () => {
    await seed({ title: 'A', body: '## Heading\n\nFirst real line.' });
    await seed({ title: 'B' });
    const tickets = asList(await handleToolCall('list_tickets', undefined));
    expect(tickets).toHaveLength(2);
    for (const t of tickets) {
      expect(t).not.toHaveProperty('body');
      expect(t).toHaveProperty('summary');
      expect(t).toMatchObject({ id: expect.any(String), title: expect.any(String), status: expect.any(String) });
    }
  });

  it('summary is the first non-empty body line, markdown-stripped', async () => {
    await seed({ title: 'MD', body: '## Title line\n\nbody text' });
    const [t] = asList(await handleToolCall('list_tickets', { query: 'MD' }));
    expect(t.summary).toBe('Title line');
  });

  it('summary caps a long first line at 100 chars with an ellipsis', async () => {
    await seed({ title: 'Cap', body: 'y'.repeat(200) });
    const [t] = asList(await handleToolCall('list_tickets', { query: 'Cap' }));
    expect(t.summary).toBe(`${'y'.repeat(99)}…`);
  });

  it('filters by status', async () => {
    await seed({ title: 'todo one', status: 'todo' });
    await seed({ title: 'backlog one', status: 'backlog' });
    const tickets = asList(await handleToolCall('list_tickets', { status: 'todo' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('todo one');
  });

  it('filters by project', async () => {
    await seed({ title: 'in proj', project: 'Alpha' });
    await seed({ title: 'no proj' });
    const tickets = asList(await handleToolCall('list_tickets', { project: 'Alpha' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('in proj');
  });

  it('filters by query (case-insensitive title substring)', async () => {
    await seed({ title: 'Fix the Login bug' });
    await seed({ title: 'Add dashboard' });
    const tickets = asList(await handleToolCall('list_tickets', { query: 'login' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('Fix the Login bug');
  });

  it('combines filters with AND', async () => {
    await seed({ title: 'match', status: 'todo', project: 'Alpha' });
    await seed({ title: 'match', status: 'todo', project: 'Beta' });
    await seed({ title: 'match', status: 'backlog', project: 'Alpha' });
    const tickets = asList(await handleToolCall('list_tickets', { status: 'todo', project: 'Alpha' }));
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
    const tickets = asList(await handleToolCall('list_tickets', { status: 'archived' }));
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe('gone');
  });

  it('trims surrounding whitespace on the query filter', async () => {
    await seed({ title: 'Trimmable Login' });
    const tickets = asList(await handleToolCall('list_tickets', { query: '  login  ' }));
    expect(tickets).toHaveLength(1);
  });

  it('treats a blank project/query filter as no filter', async () => {
    await seed({ title: 'one' });
    await seed({ title: 'two' });
    const tickets = asList(await handleToolCall('list_tickets', { project: '   ', query: '' }));
    expect(tickets).toHaveLength(2);
  });

  it('summary preserves leading content that is not a real markdown marker', async () => {
    await seed({ title: 'NotMarker', body: '#1 priority issue' });
    const [t] = asList(await handleToolCall('list_tickets', { query: 'NotMarker' }));
    expect(t.summary).toBe('#1 priority issue');
  });

  it('summary strips a real list marker', async () => {
    await seed({ title: 'ListItem', body: '- do the thing' });
    const [t] = asList(await handleToolCall('list_tickets', { query: 'ListItem' }));
    expect(t.summary).toBe('do the thing');
  });

  it('returns an empty array when the board is empty (edge)', async () => {
    const tickets = asList(await handleToolCall('list_tickets', undefined));
    expect(tickets).toHaveLength(0);
  });

  // The TOOL projection drops the body, but the SERVICE must still return full bodies — agent/retrieval embeds t.body.
  it('leaves the service returning full bodies (agent retrieval path intact)', async () => {
    await seed({ title: 'Has body', body: 'real body content' });
    const viaTool = asList(await handleToolCall('list_tickets', undefined));
    expect(viaTool[0]).not.toHaveProperty('body');
    const viaService = await listTickets();
    expect(viaService[0].body).toBe('real body content');
  });

  // tkt-d6fb2ce5c780 — scale fixes so an unfiltered list fits the MCP output cap.
  describe('limit + archived-default (envelope)', () => {
    it('wraps results in an envelope with total/returned/omitted and no note when nothing is cut', async () => {
      await seed({ title: 'A' });
      await seed({ title: 'B' });
      const env = asEnvelope(await handleToolCall('list_tickets', undefined));
      expect(env).toMatchObject({ total: 2, returned: 2, omitted: 0 });
      expect(env).not.toHaveProperty('note');
    });

    it('caps the returned array at limit and reports the omitted count + a note', async () => {
      for (let i = 0; i < 5; i++) await seed({ title: `T${i}` });
      const res = await handleToolCall('list_tickets', { limit: 2 });
      const env = asEnvelope(res);
      expect(env).toMatchObject({ total: 5, returned: 2, omitted: 3 });
      expect(asList(res)).toHaveLength(2);
      expect(String(env.note)).toContain('3 more');
    });

    it('excludes archived from the default (unfiltered) view', async () => {
      await seed({ title: 'live', status: 'todo' });
      const goneId = await seed({ title: 'gone', status: 'todo' });
      await updateTicket(goneId, { status: 'archived' });
      const tickets = asList(await handleToolCall('list_tickets', undefined));
      expect(tickets.map((t) => t.title)).toEqual(['live']); // archived hidden by default
    });

    it('still returns archived when status:archived is explicit', async () => {
      const goneId = await seed({ title: 'gone', status: 'todo' });
      await updateTicket(goneId, { status: 'archived' });
      const tickets = asList(await handleToolCall('list_tickets', { status: 'archived' }));
      expect(tickets.map((t) => t.title)).toEqual(['gone']);
    });

    it('rejects an invalid limit rather than coercing it (400)', async () => {
      await seed({ title: 'A' });
      for (const bad of [0, -1, 2.5, 'ten']) {
        const res = await handleToolCall('list_tickets', { limit: bad });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('Invalid limit');
      }
    });
  });

  // tkt-6cd916608a2f — a file that won't parse is skipped so the board survives, but the
  // caller must be told, or a short list reads as the whole board.
  describe('unreadable files (envelope)', () => {
    const UNQUOTED_COLON = '---\ntitle: Fix the seam: stale tabs\ntype: task\n---\n';

    async function writeCorrupt() {
      await fs.writeFile(path.join(dirs.tickets, 'tkt-colon.md'), UNQUOTED_COLON, 'utf8');
    }

    it('reports an unparseable file in the envelope and the note, still returning the good tickets', async () => {
      await seed({ title: 'Good' });
      await writeCorrupt();

      const res = await handleToolCall('list_tickets', undefined);
      const env = asEnvelope(res);

      expect(res.isError).toBeUndefined();             // board still renders (tkt-cd9d5026c34f)
      expect(asList(res).map((t) => t.title)).toEqual(['Good']);
      expect(env.unreadable).toEqual([{ file: 'tkt-colon.md', reason: expect.any(String) }]);
      expect(String(env.note)).toContain('tkt-colon.md');
    });

    it('reports unreadable files even when a filter excludes every readable ticket', async () => {
      // A file that won't parse has no status to filter on — a filter must not hide it.
      await seed({ title: 'Good', status: 'todo' });
      await writeCorrupt();

      const env = asEnvelope(await handleToolCall('list_tickets', { status: 'done' }));

      expect(env).toMatchObject({ total: 0, returned: 0 });
      expect(env.unreadable).toHaveLength(1);
    });

    it('reports an empty unreadable list on a healthy board', async () => {
      await seed({ title: 'A' });
      const env = asEnvelope(await handleToolCall('list_tickets', undefined));
      expect(env.unreadable).toEqual([]);
      expect(env).not.toHaveProperty('note');
    });
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

  // tkt-aea35fa11c2d (seam) — a model that read the update schema may send appendBody
  // on create. Before the fix this hard-failed with 400, which under a metered intake
  // run would bill energy and file NO ticket. It must now succeed and drop appendBody.
  it('succeeds (does not 400) when create_ticket is given appendBody, and does not persist it', async () => {
    const created = asRecord(await handleToolCall('create_ticket', { title: 'With stray append', appendBody: '## Note' }));
    expect(created.title).toBe('With stray append');
    expect('appendBody' in created).toBe(false);
    const all = await listTickets();
    const persisted = all.find((t) => t.id === created.id);
    expect(persisted?.body).toBe(''); // appendBody was omitted, not written into the body
    expect(persisted).not.toHaveProperty('appendBody');
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

  // tkt-81b4d35e95e5 — appendBody seam: MCP args → extractTicketFields → updateTicket → persisted file
  it('appendBody appends non-destructively across the full MCP round-trip (seam)', async () => {
    const id = await seed({ body: 'Original body' });
    const updated = asRecord(await handleToolCall('update_ticket', { id, appendBody: '## Added\ntext' }));
    expect(updated.body).toBe('Original body\n\n## Added\ntext');
    // source input == persisted output: read back through get_ticket, not the return value
    const reread = asRecord(await handleToolCall('get_ticket', { id }));
    expect(reread.body).toBe('Original body\n\n## Added\ntext');
  });

  it('rejects body and appendBody in the same call (400), body untouched', async () => {
    const id = await seed({ body: 'Original' });
    const res = await handleToolCall('update_ticket', { id, body: 'Replace', appendBody: 'Add' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not both');
    expect(asRecord(await handleToolCall('get_ticket', { id })).body).toBe('Original');
  });

  it('rejects a non-string appendBody with 400', async () => {
    const id = await seed({ body: 'Original' });
    const res = await handleToolCall('update_ticket', { id, appendBody: 42 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('appendBody must be a string');
    expect(asRecord(await handleToolCall('get_ticket', { id })).body).toBe('Original');
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

describe('archive_ticket', () => {
  it('archives an active ticket (happy path)', async () => {
    const id = await seed({ status: 'backlog' });
    const res = await handleToolCall('archive_ticket', { id });
    expect(res.isError).toBeFalsy();
    expect(asRecord(res).status).toBe('archived');
    const stored = await getTicket(id);
    expect(stored.status).toBe('archived');
  });

  it('archives from any board status, not just done (unlike archiveStaleTickets)', async () => {
    for (const status of ['todo', 'in-progress', 'qa', 'done'] as const) {
      const id = await seed({ status: status === 'qa' ? 'todo' : status });
      if (status === 'qa') await updateTicket(id, { status: 'qa' });
      expect(asRecord(await handleToolCall('archive_ticket', { id })).status).toBe('archived');
    }
  });

  it('is a no-op on an already-archived ticket (edge case)', async () => {
    const id = await seed();
    const first = asRecord(await handleToolCall('archive_ticket', { id }));
    const file = path.join(dirs.tickets, `${id}.md`);
    const before = await fs.stat(file, { bigint: true });
    const second = await handleToolCall('archive_ticket', { id });
    expect(second.isError).toBeFalsy();
    expect(asRecord(second).updated).toBe(first.updated);
    // mtime at ns resolution, not the `updated` stamp alone: `updated` is millisecond-resolution, so
    // two writes inside one millisecond make that equality pass vacuously — reporting the service's
    // no-change short-circuit as held while every repeat archive is in fact rewriting the file.
    expect((await fs.stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  });

  it('records no pipeline milestone — archived is deliberately unmapped in STATUS_STEP', async () => {
    const id = await seed();
    await updateTicket(id, { status: 'in-progress' }); // emits the `started` milestone
    const file = path.join(dirs.events, `${id}.jsonl`);
    const before = await fs.readFile(file, 'utf8');
    await handleToolCall('archive_ticket', { id });
    // STATUS_STEP is a Partial<Record<StatusId, StepId>>, so mapping `archived` is a one-line change
    // away; without this assertion it would silently start counting abandoned work as reaching done.
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('is the ONLY archive path — update_ticket rejects status archived at runtime (not just in the schema)', async () => {
    const id = await seed();
    // Pins the enforcement, not the constant: the advertised enums could stay correct while a
    // refactor widened the extractor's allowed set, silently handing the intake agent (which holds
    // update_ticket) the ability to make tickets vanish — the thing this tool exists to prevent.
    const res = await handleToolCall('update_ticket', { id, status: 'archived' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid status: archived');
    expect((await getTicket(id)).status).not.toBe('archived');
  });

  it('leaves the ticket recoverable — update_ticket sets it back to backlog (round-trip)', async () => {
    const id = await seed({ status: 'todo', body: 'original body' });
    // Assert the archive leg landed before restoring: without it the restore alone passes even
    // when archiving is a no-op, and the test stops proving a round-trip (caught by red-control).
    expect(asRecord(await handleToolCall('archive_ticket', { id })).status).toBe('archived');
    const restored = asRecord(await handleToolCall('update_ticket', { id, status: 'backlog' }));
    expect(restored.status).toBe('backlog');
    expect(restored.body).toContain('original body');
  });

  it('stays findable while archived via list_tickets status:archived', async () => {
    const id = await seed({ title: 'Superseded work' });
    await handleToolCall('archive_ticket', { id });
    expect(asList(await handleToolCall('list_tickets', {})).map((t) => t.id)).not.toContain(id);
    expect(asList(await handleToolCall('list_tickets', { status: 'archived' })).map((t) => t.id)).toContain(id);
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('archive_ticket', { id: 'tkt-doesnotexist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('errors when id is missing (rejection)', async () => {
    const res = await handleToolCall('archive_ticket', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Missing required field: id');
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

// tkt-18d53c0c7cd8 — MCP → service → file round-trip: a destructive update_ticket
// leaves a recoverable prior-body snapshot on disk under .history/<id>/.
describe('update_ticket backup-on-write round-trip (tkt-18d53c0c7cd8)', () => {
  it('a body-replacing update_ticket leaves a recoverable prior-body snapshot', async () => {
    const created = await createTicket({ title: 'Doc', body: 'ORIGINAL BODY' });
    await handleToolCall('update_ticket', { id: created.id, body: 'REPLACED BODY' });
    const histDir = path.join(dirs.tickets, '.history', created.id);
    const files = await fs.readdir(histDir);
    expect(files).toHaveLength(1);
    const snap = await fs.readFile(path.join(histDir, files[0]), 'utf8');
    expect(snap).toContain('ORIGINAL BODY'); // prior body recoverable
    expect(snap).not.toContain('REPLACED BODY');
  });
});
