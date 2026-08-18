import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listTickets, listBoard, listProjects, getTicket, createTicket, updateTicket, deleteTicket, archiveStaleTickets, searchTickets, summarize, summarizeBoard, HttpError } from './tickets.js';
import { readEvents } from './events.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';
import type { Ticket } from '../shared/constants.js';

const dirs = setupTempTicketDirs('kanban-test');

async function httpError<T>(p: Promise<T>): Promise<HttpError> {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  if (!(err instanceof HttpError)) throw new Error('Expected HttpError');
  return err;
}

function makeRaw(title: string, order: number, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    title,
    type: 'task',
    priority: 'medium',
    status: 'backlog',
    order: String(order),
    created: "'2026-01-01T00:00:00.000Z'",
    updated: "'2026-01-01T00:00:00.000Z'",
    ...overrides,
  };
  return ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
}

async function writeRaw(id: string, content: string) {
  await fs.writeFile(path.join(dirs.tickets, `${id}.md`), content, 'utf8');
}

// ---------------------------------------------------------------------------

describe('dueDate format validation', () => {
  it('rejects a malformed dueDate on update with 400', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, { dueDate: 'garbage' }));
    expect(err.status).toBe(400);
  });

  it('rejects a malformed dueDate on create with 400', async () => {
    const err = await httpError(createTicket({ title: 'A', dueDate: 'nope' }));
    expect(err.status).toBe(400);
  });

  it('accepts a valid YYYY-MM-DD and allows null to clear', async () => {
    const t = await createTicket({ title: 'A', dueDate: '2026-07-01' });
    expect(t.dueDate).toBe('2026-07-01');
    const cleared = await updateTicket(t.id, { dueDate: null });
    expect(cleared.dueDate).toBeNull();
  });

  it('rejects an impossible date that matches the YYYY-MM-DD shape', async () => {
    // Pass the regex but aren't real calendar dates — would NaN the overdue comparison.
    for (const bad of ['2026-99-99', '2026-13-01', '2026-02-30', '2026-00-10']) {
      const err = await httpError(createTicket({ title: 'A', dueDate: bad }));
      expect(err.status).toBe(400);
    }
  });

  it('accepts a real leap day', async () => {
    const t = await createTicket({ title: 'A', dueDate: '2028-02-29' });
    expect(t.dueDate).toBe('2028-02-29');
  });
});

describe('order finite guard', () => {
  it('rejects a non-finite order (Infinity) on update with 400 and does not persist it', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, { order: Infinity }));
    expect(err.status).toBe(400);
    expect((await getTicket(t.id)).order).not.toBe(Infinity);
  });

  it('rejects a NaN order on update with 400', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, { order: NaN }));
    expect(err.status).toBe(400);
  });

  it('still accepts a finite order', async () => {
    const t = await createTicket({ title: 'A' });
    const updated = await updateTicket(t.id, { order: 42 });
    expect(updated.order).toBe(42);
  });
});

describe('fs error mapping (getTicket)', () => {
  it('maps a genuinely missing file to 404', async () => {
    const err = await httpError(getTicket('tkt-doesnotexist'));
    expect(err.status).toBe(404);
  });

  it('rethrows a non-ENOENT fs error instead of masking it as a 404', async () => {
    // A dir where the .md is expected makes readFile throw EISDIR, not ENOENT — must surface (→ 500).
    const dir = path.join(dirs.tickets, 'tkt-isdir.md');
    await fs.mkdir(dir);
    try {
      const err = await getTicket('tkt-isdir').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(HttpError);
      expect(err.code).toBe('EISDIR');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parent cycle guard (updateTicket)', () => {
  it('rejects a ticket being set as its own parent', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, { parent: t.id }));
    expect(err.status).toBe(400);
  });

  it('rejects setting a descendant as the parent (would cycle)', async () => {
    const a = await createTicket({ title: 'A' });
    const b = await createTicket({ title: 'B', parent: a.id });
    const c = await createTicket({ title: 'C', parent: b.id });
    // A -> B -> C; making A a child of C closes the loop.
    const err = await httpError(updateTicket(a.id, { parent: c.id }));
    expect(err.status).toBe(400);
    // the cycle must not have been persisted
    expect((await getTicket(a.id)).parent).toBeNull();
  });

  it('allows a valid (acyclic) reparent', async () => {
    const a = await createTicket({ title: 'A' });
    const b = await createTicket({ title: 'B' });
    const updated = await updateTicket(b.id, { parent: a.id });
    expect(updated.parent).toBe(a.id);
  });
});

describe('path-traversal guard', () => {
  it('rejects ../ paths with 400', async () => {
    const err = await httpError(getTicket('../../../etc/passwd'));
    expect(err.status).toBe(400);
  });

  it('rejects ids with slashes with 400', async () => {
    const err = await httpError(getTicket('tkt-abc/def'));
    expect(err.status).toBe(400);
  });

  it('returns 404 for valid-format but missing id', async () => {
    const err = await httpError(getTicket('tkt-doesnotexist'));
    expect(err.status).toBe(404);
  });
});

describe('createTicket validation', () => {
  it('rejects empty title with 400', async () => {
    const err = await httpError(createTicket({ title: '' }));
    expect(err.status).toBe(400);
  });

  it('rejects whitespace-only title with 400', async () => {
    const err = await httpError(createTicket({ title: '   ' }));
    expect(err.status).toBe(400);
  });

  it('rejects invalid type with 400 mentioning "type"', async () => {
    // @ts-expect-error — testing runtime rejection of an invalid enum value
    const err = await httpError(createTicket({ title: 'T', type: 'invalid' }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('type');
  });

  it('rejects invalid priority with 400 mentioning "priority"', async () => {
    // @ts-expect-error — testing runtime rejection of an invalid enum value
    const err = await httpError(createTicket({ title: 'T', priority: 'invalid' }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('priority');
  });

  it('rejects invalid status with 400 mentioning "status"', async () => {
    // @ts-expect-error — testing runtime rejection of an invalid enum value
    const err = await httpError(createTicket({ title: 'T', status: 'invalid' }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('status');
  });

  // tkt-aea35fa11c2d — appendBody is update-only and now gated OUT at the extractor
  // (see validation.test.ts + the create_ticket seam in handlers.test.ts), so
  // createTicket no longer advertises or rejects it. A stray runtime appendBody is
  // ignored, not persisted, rather than hard-failing a (metered) create.
  it('ignores a stray appendBody on create instead of throwing', async () => {
    // @ts-expect-error — createTicket's signature no longer includes appendBody
    const t = await createTicket({ title: 'Stray append on create', appendBody: 'nope' });
    expect(t.title).toBe('Stray append on create');
    expect('appendBody' in t).toBe(false);
  });
});

describe('createTicket defaults', () => {
  it('applies type/priority/status defaults when omitted', async () => {
    const t = await createTicket({ title: 'Hello' });
    expect(t.type).toBe('task');
    expect(t.priority).toBe('medium');
    expect(t.status).toBe('backlog');
  });
});

describe('normalize coercion', () => {
  it('falls back to "task" for invalid type enum in raw file', async () => {
    await writeRaw('tkt-badtype', makeRaw('Bad type', 1, { type: 'invalid-enum' }));
    const t = await getTicket('tkt-badtype');
    expect(t.type).toBe('task');
  });

  it('coerces a numeric title (unquoted number in YAML) to empty string', async () => {
    // js-yaml parses `title: 42` as a number; asString() returns '' as a safe fallback.
    const raw = [
      '---',
      'title: 42',
      'type: task',
      'priority: medium',
      'status: backlog',
      'order: 1',
      "created: '2026-01-01T00:00:00.000Z'",
      "updated: '2026-01-01T00:00:00.000Z'",
      '---',
      '',
    ].join('\n');
    await writeRaw('tkt-numtitle', raw);
    const t = await getTicket('tkt-numtitle');
    expect(typeof t.title).toBe('string');
    expect(t.title).toBe('');
  });

  it('coerces unquoted YAML Date fields to ISO strings', async () => {
    // js-yaml auto-parses unquoted ISO timestamps as Date objects; asString() coerces back
    await writeRaw('tkt-datecoerce', [
      '---',
      'title: Date ticket',
      'type: task',
      'priority: medium',
      'status: backlog',
      'order: 1',
      'created: 2026-01-15T10:00:00.000Z',
      'updated: 2026-01-15T10:00:00.000Z',
      '---',
      '',
    ].join('\n'));
    const t = await getTicket('tkt-datecoerce');
    expect(typeof t.created).toBe('string');
    expect(typeof t.updated).toBe('string');
    expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('order assignment', () => {
  it('assigns order 1 on an empty board', async () => {
    const t = await createTicket({ title: 'First' });
    expect(t.order).toBe(1);
  });

  it('assigns maxOrder + 1 when tickets already exist', async () => {
    await writeRaw('tkt-ord1', makeRaw('A', 3));
    await writeRaw('tkt-ord2', makeRaw('B', 7));
    const t = await createTicket({ title: 'New' });
    expect(t.order).toBe(8);
  });
});

describe('updateTicket', () => {
  it('rejects empty title with 400', async () => {
    const t = await createTicket({ title: 'Original' });
    const err = await httpError(updateTicket(t.id, { title: '' }));
    expect(err.status).toBe(400);
  });

  it('returns 404 for nonexistent id', async () => {
    const err = await httpError(updateTicket('tkt-doesnotexist', { title: 'X' }));
    expect(err.status).toBe(404);
  });

  it('partial patch leaves other fields unchanged', async () => {
    const t = await createTicket({ title: 'Keep me', priority: 'high' });
    const updated = await updateTicket(t.id, { status: 'done' });
    expect(updated.title).toBe('Keep me');
    expect(updated.priority).toBe('high');
    expect(updated.status).toBe('done');
  });

  it('advances the updated timestamp', async () => {
    vi.useFakeTimers();
    try {
      const t = await createTicket({ title: 'Timestamp test' });
      vi.advanceTimersByTime(1000);
      const updated = await updateTicket(t.id, { title: 'Changed' });
      expect(new Date(updated.updated).getTime()).toBeGreaterThan(new Date(t.updated).getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears project by passing null, leaving it set when omitted', async () => {
    const t = await createTicket({ title: 'Has project', project: 'Acme' });
    const cleared = await updateTicket(t.id, { project: null });
    expect(cleared.project).toBeNull();
    // omitting project on a later patch must not resurrect or alter it
    const renamed = await updateTicket(t.id, { title: 'Renamed' });
    expect(renamed.project).toBeNull();
  });

  it('sets then clears parent via null', async () => {
    const t = await createTicket({ title: 'Child', parent: 'tkt-parent' });
    expect(t.parent).toBe('tkt-parent');
    const cleared = await updateTicket(t.id, { parent: null });
    expect(cleared.parent).toBeNull();
  });

  // tkt-81b4d35e95e5 — appendBody appends non-destructively, never overwrites
  it('appendBody appends to an existing body with a blank-line separator', async () => {
    const t = await createTicket({ title: 'Has body', body: 'Original content' });
    const updated = await updateTicket(t.id, { appendBody: '## Note\nmore' });
    expect(updated.body).toBe('Original content\n\n## Note\nmore');
  });

  it('appendBody onto an empty body sets it without a leading separator', async () => {
    const t = await createTicket({ title: 'No body' });
    const updated = await updateTicket(t.id, { appendBody: 'First section' });
    expect(updated.body).toBe('First section');
  });

  it('appends accumulate across successive calls', async () => {
    const t = await createTicket({ title: 'Accumulate', body: 'A' });
    await updateTicket(t.id, { appendBody: 'B' });
    const twice = await updateTicket(t.id, { appendBody: 'C' });
    expect(twice.body).toBe('A\n\nB\n\nC');
  });

  it('an empty/whitespace appendBody is a no-op', async () => {
    const t = await createTicket({ title: 'Untouched', body: 'Keep' });
    const updated = await updateTicket(t.id, { appendBody: '   ' });
    expect(updated.body).toBe('Keep');
  });

  it('rejects body and appendBody together with 400, leaving the body untouched', async () => {
    const t = await createTicket({ title: 'Both', body: 'Original' });
    const err = await httpError(updateTicket(t.id, { body: 'Replace', appendBody: 'Add' }));
    expect(err.status).toBe(400);
    expect((await getTicket(t.id)).body).toBe('Original');
  });

  it('appendBody does not resurrect as a persisted ticket field', async () => {
    const t = await createTicket({ title: 'Clean', body: 'X' });
    const updated = await updateTicket(t.id, { appendBody: 'Y' });
    expect('appendBody' in updated).toBe(false);
  });

  // A raw HTTP patch reaches the service untyped, and clients routinely serialize
  // unset fields as null. null must mean ABSENT for body/appendBody — never a
  // crash, and never a phantom "explicit replace" (code review, 2026-07-23).
  it('treats appendBody: null as absent instead of crashing on .trim()', async () => {
    const t = await createTicket({ title: 'Null append', body: 'Keep' });
    // @ts-expect-error — raw HTTP bodies are untyped; null must not reach .trim()
    const updated = await updateTicket(t.id, { appendBody: null });
    expect(updated.body).toBe('Keep');
  });

  it('treats body: null as no-change, so an append alongside it still lands', async () => {
    const t = await createTicket({ title: 'Null body', body: 'Original' });
    // @ts-expect-error — a client spreading a draft object sends nulls for unset fields
    const updated = await updateTicket(t.id, { body: null, appendBody: 'Add' });
    expect(updated.body).toBe('Original\n\nAdd');
  });

  // trim() must only detect the whitespace-only no-op — it must not eat indentation
  // that makes the appended markdown a code block or a list continuation.
  it('preserves leading indentation in the appended text', async () => {
    const t = await createTicket({ title: 'Indent', body: 'Intro' });
    const updated = await updateTicket(t.id, { appendBody: '    const x = 1;' });
    expect(updated.body).toBe('Intro\n\n    const x = 1;');
  });

  it('strips only surrounding blank lines from the append, not indentation', async () => {
    const t = await createTicket({ title: 'Pad', body: 'Intro' });
    const updated = await updateTicket(t.id, { appendBody: '\n\n  padded  \n\n' });
    expect(updated.body).toBe('Intro\n\n  padded');
  });

  // The whitespace no-op is documented as a no-op — it must not restamp `updated`,
  // which would reorder the dashboard and reset the archive clock.
  it('a whitespace-only append leaves the updated timestamp untouched', async () => {
    const t = await createTicket({ title: 'No restamp', body: 'Keep' });
    await new Promise((r) => setTimeout(r, 2));
    const updated = await updateTicket(t.id, { appendBody: '   ' });
    expect(updated.body).toBe('Keep');
    expect(updated.updated).toBe(t.updated);
  });
});

describe('deleteTicket', () => {
  it('resolves for an existing ticket, then getTicket returns 404', async () => {
    const t = await createTicket({ title: 'To delete' });
    await expect(deleteTicket(t.id)).resolves.toBeUndefined();
    const err = await httpError(getTicket(t.id));
    expect(err.status).toBe(404);
  });

  it('returns 404 for a nonexistent id', async () => {
    const err = await httpError(deleteTicket('tkt-ghost'));
    expect(err.status).toBe(404);
  });

  it('prunes the deleted id from other tickets that were blocked by it', async () => {
    const blocker = await createTicket({ title: 'Blocker' });
    const dependent = await updateTicket(
      (await createTicket({ title: 'Dependent' })).id,
      { blockers: [blocker.id] },
    );
    expect(dependent.blockers).toEqual([blocker.id]);

    await deleteTicket(blocker.id);

    expect((await getTicket(dependent.id)).blockers).toEqual([]);
  });

  it('leaves other blocker ids intact when pruning', async () => {
    const b1 = await createTicket({ title: 'B1' });
    const b2 = await createTicket({ title: 'B2' });
    const dep = await createTicket({ title: 'Dep' });
    await updateTicket(dep.id, { blockers: [b1.id, b2.id] });

    await deleteTicket(b1.id);

    expect((await getTicket(dep.id)).blockers).toEqual([b2.id]);
  });

  it('does not bump `updated` on a ticket it prunes (housekeeping, not an edit)', async () => {
    const blocker = await createTicket({ title: 'Blocker' });
    const dep = await createTicket({ title: 'Dep' });
    const before = await updateTicket(dep.id, { blockers: [blocker.id] });

    await deleteTicket(blocker.id);

    expect((await getTicket(dep.id)).updated).toBe(before.updated);
  });

  it('no-ops for tickets that never referenced the deleted id', async () => {
    const unrelated = await createTicket({ title: 'Unrelated' });
    const before = await getTicket(unrelated.id);
    const victim = await createTicket({ title: 'Victim' });

    await deleteTicket(victim.id);

    expect(await getTicket(unrelated.id)).toEqual(before);
  });

  it('orphans children to top-level (parent → null) when their parent is deleted', async () => {
    const parent = await createTicket({ title: 'Parent' });
    const childA = await updateTicket((await createTicket({ title: 'Child A' })).id, { parent: parent.id });
    const childB = await updateTicket((await createTicket({ title: 'Child B' })).id, { parent: parent.id });
    expect(childA.parent).toBe(parent.id);

    await deleteTicket(parent.id);

    expect((await getTicket(childA.id)).parent).toBeNull();
    expect((await getTicket(childB.id)).parent).toBeNull();
  });

  it('does not bump a child\'s `updated` when orphaning it (housekeeping, not an edit)', async () => {
    const parent = await createTicket({ title: 'Parent' });
    const child = await updateTicket((await createTicket({ title: 'Child' })).id, { parent: parent.id });

    await deleteTicket(parent.id);

    expect((await getTicket(child.id)).updated).toBe(child.updated);
  });

  it('cleans blocker and parent edges in one pass, leaving unrelated edges intact', async () => {
    const victim = await createTicket({ title: 'Victim' });
    const otherParent = await createTicket({ title: 'Other parent' });
    // One ticket is BOTH a child of the victim AND blocked by it.
    const both = await updateTicket(
      (await createTicket({ title: 'Both' })).id,
      { parent: victim.id, blockers: [victim.id, otherParent.id] },
    );
    expect(both).toMatchObject({ parent: victim.id, blockers: [victim.id, otherParent.id] });

    await deleteTicket(victim.id);

    const after = await getTicket(both.id);
    expect(after.parent).toBeNull();          // orphaned
    expect(after.blockers).toEqual([otherParent.id]); // victim stripped, other kept
  });
});

describe('listProjects', () => {
  it('returns [] when no tickets have a project', async () => {
    await writeRaw('tkt-np1', makeRaw('No project 1', 1));
    await writeRaw('tkt-np2', makeRaw('No project 2', 2));
    expect(await listProjects()).toEqual([]);
  });

  it('returns unique sorted project names, excluding tickets with null project', async () => {
    await writeRaw('tkt-p1', makeRaw('A', 1, { project: 'zebra' }));
    await writeRaw('tkt-p2', makeRaw('B', 2, { project: 'alpha' }));
    await writeRaw('tkt-p3', makeRaw('C', 3, { project: 'zebra' }));
    await writeRaw('tkt-p4', makeRaw('D', 4));
    expect(await listProjects()).toEqual(['alpha', 'zebra']);
  });

  it('excludes empty-string project values', async () => {
    await writeRaw('tkt-ep', makeRaw('Empty project', 1, { project: "''" }));
    expect(await listProjects()).toEqual([]);
  });
});

describe('listTickets', () => {
  it('returns tickets sorted by order ascending regardless of filename order', async () => {
    await writeRaw('tkt-zzz', makeRaw('C', 30));
    await writeRaw('tkt-aaa', makeRaw('A', 10));
    await writeRaw('tkt-mmm', makeRaw('B', 20));
    const tickets = await listTickets();
    expect(tickets.map((t) => t.order)).toEqual([10, 20, 30]);
  });

  it('ignores non-.md files in the tickets directory', async () => {
    await writeRaw('tkt-real', makeRaw('Real', 1));
    await fs.writeFile(path.join(dirs.tickets, 'README.txt'), 'not a ticket', 'utf8');
    await fs.writeFile(path.join(dirs.tickets, '.DS_Store'), 'junk', 'utf8');
    const tickets = await listTickets();
    expect(tickets.map((t) => t.id)).toEqual(['tkt-real']);
  });
});

describe('normalize raw-file coercion (invalid enums + blockers)', () => {
  it('falls back to "medium" for an invalid priority in a raw file', async () => {
    await writeRaw('tkt-badprio', makeRaw('Bad prio', 1, { priority: 'screaming' }));
    expect((await getTicket('tkt-badprio')).priority).toBe('medium');
  });

  it('falls back to "backlog" for an invalid status in a raw file', async () => {
    await writeRaw('tkt-badstat', makeRaw('Bad status', 1, { status: 'limbo' }));
    expect((await getTicket('tkt-badstat')).status).toBe('backlog');
  });

  it('filters out non-string entries from a blockers array', async () => {
    // YAML array with mixed types; normalize keeps only the string members.
    await writeRaw('tkt-blockers', makeRaw('Mixed blockers', 1, {
      blockers: '["tkt-aaa", 42, true, "tkt-bbb"]',
    }));
    expect((await getTicket('tkt-blockers')).blockers).toEqual(['tkt-aaa', 'tkt-bbb']);
  });
});

// "stale" = updated >3 days ago; "fresh" = updated just now.
const STALE_DATE = "'2026-01-01T00:00:00.000Z'";
const freshDate = () => `'${new Date().toISOString()}'`;

describe('archiveStaleTickets', () => {
  it('returns 0 and changes nothing on an empty board', async () => {
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    expect(await listTickets()).toHaveLength(0);
  });

  it('archives a done ticket whose updated timestamp is older than 3 days', async () => {
    await writeRaw('tkt-stale', makeRaw('Stale done', 1, { status: 'done', updated: STALE_DATE }));
    const count = await archiveStaleTickets();
    expect(count).toBe(1);
    const t = await getTicket('tkt-stale');
    expect(t.status).toBe('archived');
  });

  it('does not archive a done ticket updated within the last 3 days', async () => {
    await writeRaw('tkt-fresh', makeRaw('Fresh done', 1, { status: 'done', updated: freshDate() }));
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    const t = await getTicket('tkt-fresh');
    expect(t.status).toBe('done');
  });

  it('does not archive non-done tickets regardless of age', async () => {
    for (const [id, status] of [
      ['tkt-bl', 'backlog'],
      ['tkt-td', 'todo'],
      ['tkt-ip', 'in-progress'],
      ['tkt-qa', 'qa'],
    ]) {
      await writeRaw(id, makeRaw(status, 1, { status, updated: STALE_DATE }));
    }
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    const tickets = await listTickets();
    expect(tickets.every((t) => t.status !== 'archived')).toBe(true);
  });

  it('does not archive a done ticket with a missing updated field (NaN guard)', async () => {
    // No `updated` key → new Date('').getTime() is NaN; the guard skips rather than archiving.
    const raw = [
      '---',
      'title: No updated field',
      'type: task',
      'priority: medium',
      'status: done',
      'order: 1',
      "created: '2026-01-01T00:00:00.000Z'",
      '---',
      '',
    ].join('\n');
    await writeRaw('tkt-noupdated', raw);
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    expect((await getTicket('tkt-noupdated')).status).toBe('done');
  });

  it('only archives the stale done tickets in a mixed board', async () => {
    await writeRaw('tkt-stale1', makeRaw('Stale 1', 1, { status: 'done', updated: STALE_DATE }));
    await writeRaw('tkt-stale2', makeRaw('Stale 2', 2, { status: 'done', updated: STALE_DATE }));
    await writeRaw('tkt-recent', makeRaw('Recent done', 3, { status: 'done', updated: freshDate() }));
    await writeRaw('tkt-active', makeRaw('In progress', 4, { status: 'in-progress', updated: STALE_DATE }));

    const count = await archiveStaleTickets();
    expect(count).toBe(2);

    expect((await getTicket('tkt-stale1')).status).toBe('archived');
    expect((await getTicket('tkt-stale2')).status).toBe('archived');
    expect((await getTicket('tkt-recent')).status).toBe('done');
    expect((await getTicket('tkt-active')).status).toBe('in-progress');
  });
});


describe('searchTickets', () => {
  it('returns tickets whose title matches (case-insensitive)', async () => {
    await writeRaw('tkt-s1', makeRaw('Fix Login Bug', 1));
    await writeRaw('tkt-s2', makeRaw('Add Dashboard', 2));
    const results = await searchTickets('login');
    expect(results.map((t) => t.id)).toContain('tkt-s1');
    expect(results.map((t) => t.id)).not.toContain('tkt-s2');
  });

  it('returns tickets whose body matches (case-insensitive)', async () => {
    await writeRaw('tkt-s3', makeRaw('Refactor auth', 1) + 'The password reset flow is broken\n');
    await writeRaw('tkt-s4', makeRaw('Update docs', 2) + 'Nothing relevant here\n');
    const results = await searchTickets('PASSWORD');
    expect(results.map((t) => t.id)).toContain('tkt-s3');
    expect(results.map((t) => t.id)).not.toContain('tkt-s4');
  });

  it('matches across both title and body in the same result set', async () => {
    await writeRaw('tkt-s5', makeRaw('Search title match', 1));
    await writeRaw('tkt-s6', makeRaw('Unrelated', 2) + 'search body match\n');
    const results = await searchTickets('search');
    const ids = results.map((t) => t.id);
    expect(ids).toContain('tkt-s5');
    expect(ids).toContain('tkt-s6');
  });

  it('returns empty array when no tickets match', async () => {
    await writeRaw('tkt-s7', makeRaw('Unrelated ticket', 1));
    const results = await searchTickets('xyzzy-no-match');
    expect(results).toHaveLength(0);
  });

  it('returns every ticket for an empty query term (matches all)', async () => {
    await writeRaw('tkt-s10', makeRaw('Anything', 1));
    await writeRaw('tkt-s11', makeRaw('Whatever', 2));
    const results = await searchTickets('');
    expect(results).toHaveLength(2);
  });
});

describe('dueDate field', () => {
  it('persists dueDate when set on createTicket', async () => {
    const t = await createTicket({ title: 'With due date', dueDate: '2026-12-31' });
    expect(t.dueDate).toBe('2026-12-31');
    const loaded = await getTicket(t.id);
    expect(loaded.dueDate).toBe('2026-12-31');
  });

  it('defaults dueDate to null when omitted on createTicket', async () => {
    const t = await createTicket({ title: 'No due date' });
    expect(t.dueDate).toBeNull();
  });

  it('updates dueDate via updateTicket', async () => {
    const t = await createTicket({ title: 'Update due date' });
    const updated = await updateTicket(t.id, { dueDate: '2026-06-30' });
    expect(updated.dueDate).toBe('2026-06-30');
    expect((await getTicket(t.id)).dueDate).toBe('2026-06-30');
  });

  it('clears dueDate by setting null via updateTicket', async () => {
    const t = await createTicket({ title: 'Clear due date', dueDate: '2026-06-30' });
    const updated = await updateTicket(t.id, { dueDate: null });
    expect(updated.dueDate).toBeNull();
  });

  it('leaves dueDate unchanged when not in the patch', async () => {
    const t = await createTicket({ title: 'Preserve due date', dueDate: '2026-09-01' });
    const updated = await updateTicket(t.id, { title: 'Renamed' });
    expect(updated.dueDate).toBe('2026-09-01');
  });
});

describe('assignee field', () => {
  it('persists assignee when set on createTicket', async () => {
    const t = await createTicket({ title: 'Assigned ticket', assignee: 'Alice' });
    expect(t.assignee).toBe('Alice');
    expect((await getTicket(t.id)).assignee).toBe('Alice');
  });

  it('defaults assignee to null when omitted on createTicket', async () => {
    const t = await createTicket({ title: 'Unassigned ticket' });
    expect(t.assignee).toBeNull();
  });

  it('updates assignee via updateTicket', async () => {
    const t = await createTicket({ title: 'Reassign me' });
    const updated = await updateTicket(t.id, { assignee: 'Bob' });
    expect(updated.assignee).toBe('Bob');
    expect((await getTicket(t.id)).assignee).toBe('Bob');
  });

  it('clears assignee by setting null via updateTicket', async () => {
    const t = await createTicket({ title: 'Clear assignee', assignee: 'Alice' });
    const updated = await updateTicket(t.id, { assignee: null });
    expect(updated.assignee).toBeNull();
  });

  it('leaves assignee unchanged when not in the patch', async () => {
    const t = await createTicket({ title: 'Preserve assignee', assignee: 'Alice' });
    const updated = await updateTicket(t.id, { title: 'Renamed' });
    expect(updated.assignee).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------

describe('summarize (pure aggregation)', () => {
  const mk = (over: Partial<Ticket>): Ticket => ({
    id: over.id ?? 't', title: over.title ?? 'T', type: over.type ?? 'task',
    priority: over.priority ?? 'medium', status: over.status ?? 'backlog', order: over.order ?? 0,
    created: over.created ?? '2026-01-01T00:00:00.000Z', updated: over.updated ?? '2026-01-01T00:00:00.000Z',
    body: '', project: over.project ?? null, blockers: [], parent: null, dueDate: null, assignee: null,
  });

  const find = <T extends Record<string, unknown>>(rows: T[], key: keyof T, val: unknown) =>
    rows.find((r) => r[key] === val);

  it('returns all-zero buckets and empty recents for an empty board', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.project).toBeNull();
    expect(s.byStatus.every((b) => b.count === 0)).toBe(true);
    expect(s.byPriority.every((b) => b.count === 0)).toBe(true);
    expect(s.byType.every((b) => b.count === 0)).toBe(true);
    expect(s.recentlyUpdated).toEqual([]);
  });

  it('counts by status, priority, and type', () => {
    const s = summarize([
      mk({ id: 'a', status: 'todo', priority: 'high', type: 'bug' }),
      mk({ id: 'b', status: 'todo', priority: 'low', type: 'feature' }),
      mk({ id: 'c', status: 'done', priority: 'high', type: 'bug' }),
    ]);
    expect(s.total).toBe(3);
    expect(find(s.byStatus, 'status', 'todo')?.count).toBe(2);
    expect(find(s.byStatus, 'status', 'done')?.count).toBe(1);
    expect(find(s.byPriority, 'priority', 'high')?.count).toBe(2);
    expect(find(s.byType, 'type', 'bug')?.count).toBe(2);
  });

  it('excludes archived tickets from every count', () => {
    const s = summarize([
      mk({ id: 'a', status: 'done' }),
      mk({ id: 'b', status: 'archived' }),
    ]);
    expect(s.total).toBe(1);
    expect(s.byStatus.reduce((n, b) => n + b.count, 0)).toBe(1);
    expect(s.recentlyUpdated).toHaveLength(1);
  });

  it('scopes counts to a project when given', () => {
    const s = summarize([
      mk({ id: 'a', project: 'kanban' }),
      mk({ id: 'b', project: 'other' }),
      mk({ id: 'c', project: null }),
    ], 'kanban');
    expect(s.project).toBe('kanban');
    expect(s.total).toBe(1);
  });

  it('orders recentlyUpdated newest-first and caps at 8', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      mk({ id: `t${i}`, updated: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }));
    const s = summarize(many);
    expect(s.recentlyUpdated).toHaveLength(8);
    expect(s.recentlyUpdated[0].id).toBe('t9'); // latest date
    expect(s.recentlyUpdated[0].updated > s.recentlyUpdated[1].updated).toBe(true);
  });

  it('recentlyUpdated rows omit the body', () => {
    const s = summarize([mk({ id: 'a' })]);
    expect(s.recentlyUpdated[0]).not.toHaveProperty('body');
  });
});

describe('summarizeBoard (reads the live board)', () => {
  it('aggregates tickets from disk', async () => {
    await writeRaw('aaaaaaaaaaaa', makeRaw('One', 1, { status: 'todo', priority: 'high' }));
    await writeRaw('bbbbbbbbbbbb', makeRaw('Two', 2, { status: 'done', priority: 'high' }));
    const s = await summarizeBoard();
    expect(s.total).toBe(2);
    expect(s.byPriority.find((b) => b.priority === 'high')?.count).toBe(2);
  });

  it('filters to a single project', async () => {
    await writeRaw('cccccccccccc', makeRaw('K', 1, { project: 'kanban' }));
    await writeRaw('dddddddddddd', makeRaw('O', 2, { project: 'other' }));
    const s = await summarizeBoard('kanban');
    expect(s.total).toBe(1);
    expect(s.project).toBe('kanban');
  });
});

describe('updateTicket — status-milestone telemetry', () => {
  it('records a `started` event on the transition into in-progress', async () => {
    const t = await createTicket({ title: 'A', status: 'todo' });
    await updateTicket(t.id, { status: 'in-progress' });
    const { events } = await readEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ step: 'started', state: 'reached' });
  });

  it('maps qa and done transitions to their steps', async () => {
    const t = await createTicket({ title: 'A', status: 'in-progress' });
    await updateTicket(t.id, { status: 'qa' });
    await updateTicket(t.id, { status: 'done' });
    expect((await readEvents(t.id)).events.map((e) => e.step)).toEqual(['qa', 'done']);
  });

  it('emits nothing for a body/priority-only patch (no status change)', async () => {
    const t = await createTicket({ title: 'A', status: 'in-progress' });
    await updateTicket(t.id, { body: 'new body', priority: 'high' });
    expect((await readEvents(t.id)).events).toEqual([]);
  });

  it('emits nothing when the status patch is a no-op', async () => {
    const t = await createTicket({ title: 'A', status: 'in-progress' });
    await updateTicket(t.id, { status: 'in-progress' });
    expect((await readEvents(t.id)).events).toEqual([]);
  });

  it('emits nothing for a transition into an untracked status (todo)', async () => {
    const t = await createTicket({ title: 'A', status: 'backlog' });
    await updateTicket(t.id, { status: 'todo' });
    expect((await readEvents(t.id)).events).toEqual([]);
  });
});

describe('concurrent same-id writes (temp-file uniqueness)', () => {
  it('resolves two overlapping updates on one id without a 500 and leaves a consistent file', async () => {
    const t = await createTicket({ title: 'Race', body: 'start' });
    // Interleaved writes: the per-call random temp suffix keeps their renames independent.
    const [a, b] = await Promise.all([
      updateTicket(t.id, { body: 'first' }),
      updateTicket(t.id, { body: 'second' }),
    ]);
    expect(a.id).toBe(t.id);
    expect(b.id).toBe(t.id);
    // Whichever rename landed last — one of the two bodies, never half-written or missing.
    const persisted = await getTicket(t.id);
    expect(['first', 'second']).toContain(persisted.body);
    // No stray .tmp left beside the ticket file.
    const leftovers = (await fs.readdir(dirs.tickets)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('write-path type + create-status validation', () => {
  // Stages a wrong-typed field via Object.assign (no `as` cast), as express.json() would deliver.
  function withRuntime(base: Partial<Ticket>, extra: Record<string, unknown>): Partial<Ticket> {
    Object.assign(base, extra);
    return base;
  }

  it('createTicket rejects a non-string title with 400 (no .trim() 500)', async () => {
    const err = await httpError(createTicket(withRuntime({}, { title: 42 })));
    expect(err.status).toBe(400);
    expect(err.message).toContain('title');
  });

  it('createTicket rejects qa and archived as a create status', async () => {
    for (const status of ['qa', 'archived'] as const) {
      const err = await httpError(createTicket({ title: 'A', status }));
      expect(err.status).toBe(400);
      expect(err.message).toContain('status');
    }
  });

  it('createTicket still accepts the pre-work board statuses', async () => {
    for (const status of ['backlog', 'todo', 'in-progress', 'done'] as const) {
      const t = await createTicket({ title: 'A', status });
      expect(t.status).toBe(status);
    }
  });

  it('updateTicket rejects a non-string project rather than writing then losing it', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, withRuntime({}, { project: { x: 1 } })));
    expect(err.status).toBe(400);
    expect(err.message).toContain('project');
    // The bad write never landed: the ticket is unchanged on disk.
    expect((await getTicket(t.id)).project).toBeNull();
  });

  it('updateTicket rejects a non-array blockers value', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, withRuntime({}, { blockers: 'tkt-x' })));
    expect(err.status).toBe(400);
    expect(err.message).toContain('blockers');
  });

  it('updateTicket still allows a transition to archived (service lifecycle path)', async () => {
    const t = await createTicket({ title: 'A', status: 'done' });
    const archived = await updateTicket(t.id, { status: 'archived' });
    expect(archived.status).toBe('archived');
  });
});

describe('corrupt ticket file resilience', () => {
  const CORRUPT = "---\ntitle: 'unclosed\n---\n"; // unclosed quote → gray-matter throws
  // The real-world trigger (tkt-6cd916608a2f): a hand-edited unquoted title whose
  // colon makes YAML read "Fix the seam" as a nested mapping key.
  const UNQUOTED_COLON = '---\ntitle: Fix the seam: stale tabs\ntype: task\n---\n';

  it('listTickets skips an unparseable file, keeps the rest of the board, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const good = await createTicket({ title: 'Good one' });
    await writeRaw('tkt-bad', CORRUPT);
    const all = await listTickets();                    // must not throw
    expect(all.map((t) => t.id)).toContain(good.id);
    expect(all.map((t) => t.id)).not.toContain('tkt-bad');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('getTicket surfaces a 500 naming the ticket for unparseable frontmatter', async () => {
    await writeRaw('tkt-bad', CORRUPT);
    const err = await httpError(getTicket('tkt-bad'));
    expect(err.status).toBe(500);
    expect(err.message).toContain('tkt-bad');
  });

  it('stays consistent across repeated reads (gray-matter content cache is bypassed)', async () => {
    // NO_CACHE guard: gray-matter's un-parsed cache would let a corrupt file throw once
    // then return a cached empty success (500 decaying to a silent ghost). Both reads must match.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    await writeRaw('tkt-bad', CORRUPT);
    expect((await listTickets()).map((t) => t.id)).not.toContain('tkt-bad');
    expect((await listTickets()).map((t) => t.id)).not.toContain('tkt-bad'); // 2nd read too
    expect((await httpError(getTicket('tkt-bad'))).status).toBe(500);
    expect((await httpError(getTicket('tkt-bad'))).status).toBe(500);        // still 500, not a ghost
    warn.mockRestore();
  });

  // tkt-6cd916608a2f — skipping is correct; skipping *silently* is the bug. A caller
  // holding no independent expected count reads the short list as the whole board.
  it('listBoard reports an unparseable file to the caller, naming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const good = await createTicket({ title: 'Good one' });
    await writeRaw('tkt-colon', UNQUOTED_COLON);

    const board = await listBoard();

    expect(board.tickets.map((t) => t.id)).toEqual([good.id]);
    expect(board.unreadable).toHaveLength(1);
    expect(board.unreadable[0]?.file).toBe('tkt-colon.md');
    expect(board.unreadable[0]?.reason).toBeTruthy();
    warn.mockRestore();
  });

  it('listBoard reports an empty unreadable list when every file parses', async () => {
    await createTicket({ title: 'A' });
    const board = await listBoard();
    expect(board.tickets).toHaveLength(1);
    expect(board.unreadable).toEqual([]); // always present, so "no field" can't read as "nothing wrong"
  });

  it('listBoard reports a file that vanishes between readdir and readFile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    await createTicket({ title: 'Survivor' });
    await fs.symlink(path.join(dirs.tickets, 'gone.md'), path.join(dirs.tickets, 'tkt-ghost.md'));

    const board = await listBoard();

    expect(board.tickets).toHaveLength(1);
    expect(board.unreadable.map((u) => u.file)).toEqual(['tkt-ghost.md']);
    warn.mockRestore();
    vi.restoreAllMocks();
  });
});

// tkt-0612c572b49e — a concurrent delete/archive (or an atomic-write rename) can remove a file
// between readdir and readFile. The board read must degrade to skipping it, as the unparseable
// case already does, rather than failing whole.
describe('concurrent file deletion during listTickets', () => {
  // Restore here, not after the assertions: a failing expect would skip an inline mockRestore and
  // leak the spy into the next test (it already did once while writing these).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips a file that is named by readdir but gone by readFile, keeps the rest, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const survivor = await createTicket({ title: 'Survivor' });
    // A dangling symlink stands in for the race without mocking fs: readdir still names it,
    // readFile follows it and gets the same real ENOENT a mid-flight delete produces.
    await fs.symlink(path.join(dirs.tickets, 'gone.md'), path.join(dirs.tickets, 'tkt-ghost.md'));

    const all = await listTickets(); // must not throw

    expect(all.map((t) => t.id)).toContain(survivor.id);
    expect(all.map((t) => t.id)).not.toContain('tkt-ghost');
    expect(warn).toHaveBeenCalled();
  });

  it('still surfaces a non-ENOENT read failure instead of silently swallowing it', async () => {
    await createTicket({ title: 'A' });
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFile').mockRejectedValue(denied);

    await expect(listTickets()).rejects.toThrow(/EACCES/);
  });
});

describe('provenance (source + runId)', () => {
  it('stamps source + runId when createTicket is given provenance', async () => {
    const t = await createTicket({ title: 'Agent made this' }, { source: 'agent', runId: 'run-abc' });
    expect(t.source).toBe('agent');
    expect(t.runId).toBe('run-abc');
    // Round-trips through the file, not just the return value.
    const reread = await getTicket(t.id);
    expect(reread.source).toBe('agent');
    expect(reread.runId).toBe('run-abc');
  });

  it('leaves source/runId null (and omits the frontmatter keys) for a human write', async () => {
    const t = await createTicket({ title: 'Human made this' });
    expect(t.source).toBeNull();
    expect(t.runId).toBeNull();
    const raw = await fs.readFile(path.join(dirs.tickets, `${t.id}.md`), 'utf8');
    expect(raw).not.toContain('source:');
    expect(raw).not.toContain('runId:');
  });

  it('updateTicket links the run (runId) but does NOT reassign authorship', async () => {
    const t = await createTicket({ title: 'Start human' }); // source null (human)
    const updated = await updateTicket(t.id, { title: 'Edited by agent' }, { source: 'agent', runId: 'run-9' });
    expect(updated.source).toBeNull(); // authorship stays human — not flipped to agent
    expect(updated.runId).toBe('run-9'); // but the modifying run is linked
  });

  it('updateTicket refreshes runId on an agent-authored ticket, keeping source', async () => {
    const t = await createTicket({ title: 'By agent' }, { source: 'agent', runId: 'run-1' });
    const updated = await updateTicket(t.id, { title: 'Agent again' }, { source: 'agent', runId: 'run-2' });
    expect(updated.source).toBe('agent');
    expect(updated.runId).toBe('run-2'); // latest run that touched it
  });

  it('updateTicket preserves existing provenance on a human (unstamped) edit', async () => {
    const t = await createTicket({ title: 'By agent' }, { source: 'agent', runId: 'run-1' });
    const edited = await updateTicket(t.id, { title: 'Human tweak' }); // no provenance
    expect(edited.source).toBe('agent'); // preserved, not cleared
    expect(edited.runId).toBe('run-1');
  });

  it('reads valid source/runId from a hand-authored file', async () => {
    await writeRaw('tkt-prov', makeRaw('Prov', 1, { source: 'agent', runId: 'run-file' }));
    const t = await getTicket('tkt-prov');
    expect(t.source).toBe('agent');
    expect(t.runId).toBe('run-file');
  });

  it('rejects an invalid source value in a file (falls back to null)', async () => {
    await writeRaw('tkt-badsrc', makeRaw('Bad', 1, { source: 'hacker', runId: 'run-x' }));
    const t = await getTicket('tkt-badsrc');
    expect(t.source).toBeNull(); // 'hacker' isn't a valid TicketSource
    expect(t.runId).toBe('run-x');
  });
});

// tkt-b3a53c992933 — updateTicket is a read-modify-write with awaits between the read
// and the atomic rename; without the per-id mutex two concurrent updates interleaved
// and the second clobbered the first (a silently lost append). Before the fix the
// first test persisted only "BASE\n\nTWO" and both callers returned success.
describe('updateTicket concurrency (per-id mutex)', () => {
  it('serializes two concurrent appends without losing one', async () => {
    const t = await createTicket({ title: 'Race', body: 'BASE' });
    await Promise.all([
      updateTicket(t.id, { appendBody: 'ONE' }),
      updateTicket(t.id, { appendBody: 'TWO' }),
    ]);
    const final = await getTicket(t.id);
    expect(final.body.startsWith('BASE')).toBe(true);
    expect(final.body).toContain('ONE'); // neither append is lost…
    expect(final.body).toContain('TWO'); // …regardless of which lands first
  });

  it('serializes a concurrent append and a field edit (both persist)', async () => {
    const t = await createTicket({ title: 'Race2', body: 'BASE' });
    await Promise.all([
      updateTicket(t.id, { appendBody: 'ADDED' }),
      updateTicket(t.id, { priority: 'urgent' }),
    ]);
    const final = await getTicket(t.id);
    expect(final.body).toContain('ADDED');
    expect(final.priority).toBe('urgent');
  });

  it('does not block concurrent updates to different ids', async () => {
    const [a, b] = await Promise.all([
      createTicket({ title: 'A', body: 'A0' }),
      createTicket({ title: 'B', body: 'B0' }),
    ]);
    await Promise.all([
      updateTicket(a.id, { appendBody: 'A1' }),
      updateTicket(b.id, { appendBody: 'B1' }),
    ]);
    expect((await getTicket(a.id)).body).toContain('A1');
    expect((await getTicket(b.id)).body).toContain('B1');
  });

  it('a failed update does not wedge the lock for later updates on the same id', async () => {
    const t = await createTicket({ title: 'Wedge', body: 'BASE' });
    // First update rejects (bad dueDate) inside the lock; the append queued behind it
    // on the SAME id must still run — a rejected op must never wedge the chain.
    const results = await Promise.allSettled([
      updateTicket(t.id, { dueDate: 'nonsense' }),
      updateTicket(t.id, { appendBody: 'KEEP' }),
    ]);
    expect(results[0].status).toBe('rejected');
    expect((await getTicket(t.id)).body).toContain('KEEP');
  });
});

// tkt-dea70aad5c1a — archiveStaleTickets and deleteTicket cleanup also do a read-
// modify-write and used to write their stale listTickets() snapshot outside the lock,
// clobbering a concurrent updateTicket. Both now go through withTicketLock + re-read.
// These are timing races, so each runs many iterations: without the fix at least one
// interleaving loses the append (verified red by bypassing the lock).
describe('archive/delete writes serialize with updateTicket (tkt-dea70aad5c1a)', () => {
  const ROUNDS = 30;

  it('archiveStaleTickets never clobbers a concurrent append on the same stale ticket', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = `tkt-arch-race-${i}`;
      await writeRaw(id, makeRaw('Stale', i + 1, { status: 'done', updated: STALE_DATE }));
      await Promise.all([
        updateTicket(id, { appendBody: 'KEEP' }),
        archiveStaleTickets(),
      ]);
      expect((await getTicket(id)).body, `round ${i}`).toContain('KEEP');
    }
  });

  it('deleteTicket cleanup never clobbers a concurrent append on an affected ticket', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const victimId = `tkt-victim-${i}`;
      const affectedId = `tkt-affected-${i}`;
      await writeRaw(victimId, makeRaw('Victim', i * 2 + 1));
      await writeRaw(affectedId, makeRaw('Affected', i * 2 + 2, { blockers: `["${victimId}"]` }));
      await Promise.all([
        updateTicket(affectedId, { appendBody: 'KEEP' }),
        deleteTicket(victimId),
      ]);
      const final = await getTicket(affectedId);
      expect(final.body, `round ${i}`).toContain('KEEP');       // append survived cleanup
      expect(final.blockers, `round ${i}`).not.toContain(victimId); // edge still stripped
    }
  });
});

// tkt-18d53c0c7cd8 — backup-on-write: an overwrite of a gitignored, history-less body
// is unrecoverable, so updateTicket snapshots the prior file before a body change.
describe('backup-on-write history snapshots (tkt-18d53c0c7cd8)', () => {
  async function historyFiles(id: string): Promise<string[]> {
    return fs.readdir(path.join(dirs.tickets, '.history', id)).catch(() => []);
  }
  async function readSnapshot(id: string, file: string): Promise<string> {
    return fs.readFile(path.join(dirs.tickets, '.history', id, file), 'utf8');
  }

  it('snapshots the prior full file before a body-replacing update', async () => {
    const t = await createTicket({ title: 'Doc', body: 'ORIGINAL' });
    await updateTicket(t.id, { body: 'REPLACED' });
    const files = await historyFiles(t.id);
    expect(files).toHaveLength(1);
    const snap = await readSnapshot(t.id, files[0]);
    expect(snap).toContain('ORIGINAL');       // prior body preserved for recovery
    expect(snap).not.toContain('REPLACED');    // snapshot is the PRIOR state
    expect(snap).toContain('title: Doc');      // full file: frontmatter too
    expect((await getTicket(t.id)).body).toBe('REPLACED'); // current file overwritten
  });

  it('snapshots on an appendBody update too (body changes)', async () => {
    const t = await createTicket({ title: 'Doc', body: 'BASE' });
    await updateTicket(t.id, { appendBody: 'MORE' });
    const files = await historyFiles(t.id);
    expect(files).toHaveLength(1);
    expect(await readSnapshot(t.id, files[0])).not.toContain('MORE'); // prior state only
  });

  it('does NOT snapshot a structured-only update (body unchanged)', async () => {
    const t = await createTicket({ title: 'Doc', body: 'BODY' });
    await updateTicket(t.id, { priority: 'high', status: 'todo' });
    expect(await historyFiles(t.id)).toHaveLength(0);
  });

  it('does NOT snapshot a no-op update', async () => {
    const t = await createTicket({ title: 'Doc', body: 'BODY' });
    await updateTicket(t.id, { body: 'BODY' }); // same body → no write, no snapshot
    expect(await historyFiles(t.id)).toHaveLength(0);
  });

  it('accumulates one snapshot per prior version across successive body edits', async () => {
    const t = await createTicket({ title: 'Doc', body: 'V1' });
    await updateTicket(t.id, { body: 'V2' });
    await updateTicket(t.id, { body: 'V3' });
    expect(await historyFiles(t.id)).toHaveLength(2); // V1 and V2 snapshotted
  });

  it('does not let .history leak into listTickets', async () => {
    const t = await createTicket({ title: 'Doc', body: 'V1' });
    await updateTicket(t.id, { body: 'V2' });
    const all = await listTickets();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(t.id);
  });
});

// ---------------------------------------------------------------------------

// tkt-5b2a1fbd011b. A NUL makes the .md file classify as binary, so every binary-skipping tool
// silently drops the ticket while the board still reads it and reports nothing wrong — the write
// succeeds, `unreadable` stays empty, and a count is quietly short. Both real occurrences arrived
// through appendBody, in prose that meant the two-character escape and emitted the byte.
// Written as one case per DIMENSION of the state the guard lives in: entry path, field type,
// position/count, effect on disk, pre-existing state, and the escape that must NOT trip it.
const NUL = '\0'; // spelled as an escape on purpose — a raw byte here would be invisible

describe('NUL bytes are rejected at the write boundary (tkt-5b2a1fbd011b)', () => {
  it('rejects a NUL in the body on create', async () => {
    const err = await httpError(createTicket({ title: 'A', body: `as a \`${NUL}\` escape` }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/body/);
    expect(err.message).toMatch(/NUL/);
  });

  it('rejects a NUL in the title on create', async () => {
    const err = await httpError(createTicket({ title: `A${NUL}B` }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/title/);
  });

  it('rejects a NUL in the body on update', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, { body: `x${NUL}y` }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/body/);
  });

  // The path BOTH real incidents used — a guard on create alone would have caught neither.
  it('rejects a NUL in appendBody on update', async () => {
    const t = await createTicket({ title: 'A', body: 'original' });
    const err = await httpError(updateTicket(t.id, { appendBody: `see \`${NUL}\`` }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/appendBody/);
  });

  it('rejects a NUL in a structured string field', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, { project: `proj${NUL}` }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/project/);
  });

  it('rejects a NUL inside blockers and names which element', async () => {
    const t = await createTicket({ title: 'A' });
    const err = await httpError(updateTicket(t.id, { blockers: ['tkt-ok', `tkt-${NUL}bad`] }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/blockers\[1\]/);
  });

  it('rejects a NUL at the start and at the end, not only mid-string', async () => {
    const lead = await httpError(createTicket({ title: 'A', body: `${NUL}leading` }));
    const trail = await httpError(createTicket({ title: 'A', body: `trailing${NUL}` }));
    expect(lead.status).toBe(400);
    expect(trail.status).toBe(400);
  });

  // Effect, not just the throw: a rejected write must leave the board untouched.
  it('writes no file when a create is rejected', async () => {
    const before = (await listTickets()).length;
    await httpError(createTicket({ title: 'A', body: NUL }));
    expect((await listTickets()).length).toBe(before);
  });

  it('leaves the existing file byte-identical when an update is rejected', async () => {
    const t = await createTicket({ title: 'A', body: 'original' });
    const file = path.join(dirs.tickets, `${t.id}.md`);
    const before = await fs.readFile(file);
    await httpError(updateTicket(t.id, { body: `new${NUL}` }));
    expect(await fs.readFile(file)).toEqual(before);
  });

  // Negative controls: the guard must not fire on the thing the author actually meant.
  it('accepts the two-character \\0 escape, which is what the prose intends', async () => {
    const t = await createTicket({ title: 'A', body: 'the header is `SQLite format 3\\0`' });
    expect((await getTicket(t.id)).body).toContain('\\0');
  });

  it('accepts ordinary text, unicode and newlines', async () => {
    const t = await createTicket({ title: 'Café ✅', body: 'line one\nline two — dash\ttab' });
    expect((await getTicket(t.id)).title).toBe('Café ✅');
  });

  // Pre-existing state: a ticket whose file ALREADY holds a NUL (the state the live board was in)
  // must stay editable on unrelated fields. Guarding the merged result instead of the input would
  // wedge every such ticket, including the edit that repairs it.
  it('still allows an unrelated update to a ticket whose stored body already holds a NUL', async () => {
    await writeRaw('tkt-legacynul', `${makeRaw('Legacy', 900)}before${NUL}after\n`);
    const updated = await updateTicket('tkt-legacynul', { status: 'todo' });
    expect(updated.status).toBe('todo');
    expect(updated.body).toContain(NUL);
  });
});

// Review findings, 2026-08-17. Both were measured before being pinned here.
describe('NUL guard scope and wording (tkt-5b2a1fbd011b review)', () => {
  // An unknown key is dropped by the merge, so rejecting the whole patch over one discarded the
  // legitimate part — while the SAME key without a NUL was silently ignored. Reachable only from
  // the raw Express path, which is exactly what validateWritableTypes exists for.
  it('ignores a NUL in a key the write never persists, and still applies the rest', async () => {
    const t = await createTicket({ title: 'A' });
    // Attached via Object.assign, not a cast: the raw Express path carries keys TicketPatch does
    // not declare, and this repo bans type assertions.
    const patch = { title: 'ok' };
    Object.assign(patch, { note: `x${NUL}` });
    const updated = await updateTicket(t.id, patch);
    expect(updated.title).toBe('ok');
    expect(await fs.readFile(path.join(dirs.tickets, `${t.id}.md`), 'utf8')).not.toContain(NUL);
  });

  // js-yaml escapes control characters in dumped scalars, so a frontmatter NUL round-trips as
  // "a\0b" and never lands as a raw byte — only body/appendBody can actually corrupt the file.
  // The message must not tell a title-field caller their file would go binary.
  it('gives the file-corruption reason for body but not for a frontmatter field', async () => {
    const bodyErr = await httpError(createTicket({ title: 'A', body: NUL }));
    const titleErr = await httpError(createTicket({ title: `A${NUL}` }));
    expect(bodyErr.message).toMatch(/binary/);
    expect(titleErr.message).not.toMatch(/binary/);
    expect(titleErr.message).toMatch(/must not contain a raw NUL byte/);
  });
});
