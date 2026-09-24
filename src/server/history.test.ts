import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTicket, deleteTicket, getTicket, listBoard, updateTicket, restoreRawTicketFile, DELETE_RECORD_FILE, HttpError } from './tickets.js';
import { listHistory, restoreFromSnapshot, undeleteFromHistory } from './history.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';
import { setLogger } from '../logger.js';

// tkt-2147a878f3ba — the read side of backup-on-write. Until this shipped the snapshots were an
// undo nobody could perform, and delete bypassed them entirely.

const dirs = setupTempTicketDirs('history-test');

afterEach(() => { setLogger(null); });

function silenceLog(): void {
  setLogger({ info: () => undefined, warn: () => undefined, error: () => undefined });
}

function histDir(id: string): string {
  return path.join(dirs.tickets, '.history', id);
}

async function historyFiles(id: string): Promise<string[]> {
  return fs.readdir(histDir(id)).catch(() => []);
}

async function ticketFileExists(id: string): Promise<boolean> {
  return fs.stat(path.join(dirs.tickets, `${id}.md`)).then(() => true, () => false);
}

async function httpError<T>(p: Promise<T>): Promise<HttpError> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  if (!(err instanceof HttpError)) throw new Error('Expected HttpError');
  return err;
}

describe('delete records the final state before unlinking', () => {
  it('writes a final-state snapshot and a tombstone naming it', async () => {
    const t = await createTicket({ title: 'Doomed', body: 'FINAL BODY' });
    await deleteTicket(t.id);

    const files = await historyFiles(t.id);
    expect(files).toContain(DELETE_RECORD_FILE);
    const snapshots = files.filter((f) => f.endsWith('.md'));
    expect(snapshots).toHaveLength(1);
    expect(await fs.readFile(path.join(histDir(t.id), snapshots[0]), 'utf8')).toContain('FINAL BODY');

    const record: { id: string; snapshot: string; edges: unknown[]; deletedAt: string } =
      JSON.parse(await fs.readFile(path.join(histDir(t.id), DELETE_RECORD_FILE), 'utf8'));
    expect(record).toMatchObject({ id: t.id, snapshot: snapshots[0], edges: [] });
    // A real timestamp, not a placeholder the listing would render as an empty column.
    expect(record.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records the blocker and parent edges its cleanup strips from other tickets', async () => {
    const target = await createTicket({ title: 'Target' });
    const blocked = await createTicket({ title: 'Blocked', blockers: [target.id] });
    const child = await createTicket({ title: 'Child', parent: target.id });
    await deleteTicket(target.id);

    const record: { edges: { id: string; blocker: boolean; parent: boolean }[] } =
      JSON.parse(await fs.readFile(path.join(histDir(target.id), DELETE_RECORD_FILE), 'utf8'));
    expect(record.edges).toEqual(expect.arrayContaining([
      { id: blocked.id, blocker: true, parent: false },
      { id: child.id, blocker: false, parent: true },
    ]));
    expect(record.edges).toHaveLength(2);
    // The edges really were stripped — the tombstone describes something that happened.
    expect((await getTicket(blocked.id)).blockers).toEqual([]);
    expect((await getTicket(child.id)).parent).toBeNull();
  });

  it('REFUSES the delete when the final state cannot be recorded, leaving the ticket intact', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Undeletable', body: 'STILL HERE' });
    // A regular file where the history DIRECTORY must be: mkdir then fails for real, with no mock.
    await fs.mkdir(path.join(dirs.tickets, '.history'), { recursive: true });
    await fs.writeFile(histDir(t.id), 'not a directory', 'utf8');

    const err = await httpError(deleteTicket(t.id));
    expect(err.status).toBe(500);
    expect(err.message).toContain('Refusing to delete');
    // The point of fail-closed: the work is still there.
    expect(await ticketFileExists(t.id)).toBe(true);
    expect((await getTicket(t.id)).body).toBe('STILL HERE');
  });

  it('still deletes a ticket whose frontmatter does not parse', async () => {
    // Raw bytes are snapshotted rather than a parsed Ticket precisely so this stays possible.
    const id = 'tkt-corrupt00001';
    await fs.mkdir(dirs.tickets, { recursive: true });
    await fs.writeFile(path.join(dirs.tickets, `${id}.md`), '---\ntitle: [unclosed\n---\nBODY\n', 'utf8');
    await deleteTicket(id);
    expect(await ticketFileExists(id)).toBe(false);
    const snapshots = (await historyFiles(id)).filter((f) => f.endsWith('.md'));
    expect(snapshots).toHaveLength(1);
    expect(await fs.readFile(path.join(histDir(id), snapshots[0]), 'utf8')).toContain('[unclosed');
  });

  it('404s an unknown id without creating a history directory', async () => {
    const err = await httpError(deleteTicket('tkt-neverexisted'));
    expect(err.status).toBe(404);
    expect(await historyFiles('tkt-neverexisted')).toEqual([]);
  });
});

describe('listHistory', () => {
  it('lists snapshots newest-first for a live ticket', async () => {
    const t = await createTicket({ title: 'Doc', body: 'V1' });
    await updateTicket(t.id, { body: 'V2' });
    await updateTicket(t.id, { body: 'V3' });

    const listing = await listHistory(t.id);
    expect(listing.live).toBe(true);
    expect(listing.deletion).toBeNull();
    expect(listing.snapshots).toHaveLength(2);
    // Newest first: the V2 snapshot (written second) precedes the V1 one.
    const bodies = await Promise.all(listing.snapshots.map((s) =>
      fs.readFile(path.join(histDir(t.id), s.file), 'utf8')));
    expect(bodies[0]).toContain('V2');
    expect(bodies[1]).toContain('V1');
    expect(listing.snapshots[0].bytes).toBeGreaterThan(0);
  });

  it('reports a deleted id as not live, with its tombstone', async () => {
    const t = await createTicket({ title: 'Gone', body: 'BODY' });
    await deleteTicket(t.id);
    const listing = await listHistory(t.id);
    expect(listing.live).toBe(false);
    expect(listing.deletion?.snapshot).toBe(listing.snapshots[0].file);
  });

  it('excludes the tombstone from the snapshot list', async () => {
    const t = await createTicket({ title: 'Gone' });
    await deleteTicket(t.id);
    const listing = await listHistory(t.id);
    expect(listing.snapshots.map((s) => s.file)).not.toContain(DELETE_RECORD_FILE);
  });

  it('survives a corrupt tombstone rather than hiding the snapshots beside it', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Gone', body: 'RECOVERABLE' });
    await deleteTicket(t.id);
    await fs.writeFile(path.join(histDir(t.id), DELETE_RECORD_FILE), '{ not json', 'utf8');
    const listing = await listHistory(t.id);
    expect(listing.deletion).toBeNull();
    expect(listing.snapshots).toHaveLength(1); // the part that actually restores work
  });

  it('REFUSES a malformed id', async () => {
    const err = await httpError(listHistory('../escape'));
    expect(err.status).toBe(400);
  });

  it('404s an id with no history at all', async () => {
    const t = await createTicket({ title: 'Never edited' });
    const err = await httpError(listHistory(t.id));
    expect(err.status).toBe(404);
  });
});

describe('restore --at', () => {
  it('restores the body and snapshots the pre-restore state', async () => {
    const t = await createTicket({ title: 'Doc', body: 'ORIGINAL' });
    await updateTicket(t.id, { body: 'MISTAKE' });
    const [snap] = (await listHistory(t.id)).snapshots;

    const result = await restoreFromSnapshot(t.id, snap.file);
    expect(result.scope).toBe('body');
    expect((await getTicket(t.id)).body).toBe('ORIGINAL');
    // The restore went through updateTicket, so it is itself undoable.
    const after = await listHistory(t.id);
    expect(after.snapshots).toHaveLength(2);
    expect(await fs.readFile(path.join(histDir(t.id), after.snapshots[0].file), 'utf8')).toContain('MISTAKE');
  });

  it('restores only the body by default, leaving structured fields alone', async () => {
    const t = await createTicket({ title: 'Doc', body: 'ORIGINAL', priority: 'low' });
    await updateTicket(t.id, { body: 'NEXT' });
    await updateTicket(t.id, { priority: 'urgent', title: 'Renamed' });
    const oldest = (await listHistory(t.id)).snapshots.at(-1);
    if (!oldest) throw new Error('expected a snapshot');

    await restoreFromSnapshot(t.id, oldest.file);
    const ticket = await getTicket(t.id);
    expect(ticket.body).toBe('ORIGINAL');
    expect(ticket.priority).toBe('urgent'); // untouched
    expect(ticket.title).toBe('Renamed');
  });

  it('--full restores every writable field', async () => {
    const t = await createTicket({ title: 'Doc', body: 'ORIGINAL', priority: 'low', project: 'alpha' });
    await updateTicket(t.id, { body: 'NEXT' }); // snapshot carries the ORIGINAL field set
    const [snap] = (await listHistory(t.id)).snapshots;
    await updateTicket(t.id, { title: 'Renamed', priority: 'urgent', project: 'beta', status: 'todo' });

    const result = await restoreFromSnapshot(t.id, snap.file, { full: true });
    expect(result.scope).toBe('full');
    const ticket = await getTicket(t.id);
    expect(ticket.title).toBe('Doc');
    expect(ticket.priority).toBe('low');
    expect(ticket.project).toBe('alpha');
    expect(ticket.status).toBe('backlog');
    expect(ticket.body).toBe('ORIGINAL');
    // created/source are set-once and are NOT forged by a restore.
    expect(ticket.created).toBe(t.created);
  });

  it('REFUSES a no-op restore without writing', async () => {
    const t = await createTicket({ title: 'Doc', body: 'SAME' });
    await updateTicket(t.id, { body: 'CHANGED' });
    await updateTicket(t.id, { body: 'SAME' }); // back to the snapshotted body by hand
    const before = await listHistory(t.id);
    const updatedBefore = (await getTicket(t.id)).updated;
    const oldest = before.snapshots.at(-1);
    if (!oldest) throw new Error('expected a snapshot');

    const err = await httpError(restoreFromSnapshot(t.id, oldest.file));
    expect(err.status).toBe(400);
    expect(err.message).toContain('nothing was written');
    // Nothing written: no new snapshot, and the file's own `updated` stamp never moved.
    expect((await listHistory(t.id)).snapshots).toHaveLength(before.snapshots.length);
    expect((await getTicket(t.id)).updated).toBe(updatedBefore);
  });

  it('REFUSES a snapshot outside the ticket history directory', async () => {
    const mine = await createTicket({ title: 'Mine', body: 'MINE' });
    const other = await createTicket({ title: 'Other', body: 'OTHER' });
    await updateTicket(mine.id, { body: 'MINE2' });
    await updateTicket(other.id, { body: 'OTHER2' });
    const [otherSnap] = (await listHistory(other.id)).snapshots;

    const err = await httpError(restoreFromSnapshot(mine.id, path.join('..', other.id, otherSnap.file)));
    expect(err.status).toBe(400);
    expect(err.message).toContain('nothing was written');
    expect((await getTicket(mine.id)).body).toBe('MINE2'); // untouched
  });

  it('REFUSES a symlink inside the history directory that points outside it', async () => {
    const t = await createTicket({ title: 'Doc', body: 'ORIGINAL' });
    await updateTicket(t.id, { body: 'CURRENT' });
    const outside = path.join(dirs.tickets, 'outside.md');
    await fs.writeFile(outside, '---\ntitle: Elsewhere\n---\nINJECTED\n', 'utf8');
    // Passes the lexical containment check — only realpath catches it.
    await fs.symlink(outside, path.join(histDir(t.id), 'link.md'));

    const err = await httpError(restoreFromSnapshot(t.id, 'link.md'));
    expect(err.status).toBe(400);
    expect(err.message).toContain('outside');
    expect((await getTicket(t.id)).body).toBe('CURRENT');
  });

  it('404s a snapshot filename that does not exist', async () => {
    const t = await createTicket({ title: 'Doc', body: 'A' });
    await updateTicket(t.id, { body: 'B' });
    const err = await httpError(restoreFromSnapshot(t.id, 'no-such-snapshot.md'));
    expect(err.status).toBe(404);
    expect((await getTicket(t.id)).body).toBe('B');
  });

  it('REFUSES an unparseable snapshot without writing', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Doc', body: 'CURRENT' });
    await updateTicket(t.id, { body: 'NEXT' });
    const [snap] = (await listHistory(t.id)).snapshots;
    await fs.writeFile(path.join(histDir(t.id), snap.file), '---\ntitle: [unclosed\n---\nX\n', 'utf8');

    const err = await httpError(restoreFromSnapshot(t.id, snap.file));
    expect(err.status).toBe(400);
    expect(err.message).toContain('nothing was written');
    expect((await getTicket(t.id)).body).toBe('NEXT');
  });

  it('points a restore on a DELETED id at --undelete', async () => {
    const t = await createTicket({ title: 'Doc', body: 'A' });
    await updateTicket(t.id, { body: 'B' });
    const [snap] = (await listHistory(t.id)).snapshots;
    await deleteTicket(t.id);

    const err = await httpError(restoreFromSnapshot(t.id, snap.file));
    expect(err.status).toBe(404);
    expect(err.message).toContain('--undelete');
  });
});

describe('restore --undelete', () => {
  it('recreates a deleted ticket from its final-state snapshot', async () => {
    const t = await createTicket({ title: 'Gone', body: 'FINAL', priority: 'high' });
    await deleteTicket(t.id);

    const result = await undeleteFromHistory(t.id);
    expect(result.ticket.id).toBe(t.id);
    expect(result.ticket.title).toBe('Gone');
    expect(result.ticket.body).toBe('FINAL');
    expect(result.ticket.priority).toBe('high');
    expect(result.tombstone).toBe(true);
  });

  it('reports the stripped edges instead of re-linking them', async () => {
    const target = await createTicket({ title: 'Target' });
    const blocked = await createTicket({ title: 'Blocked', blockers: [target.id] });
    await deleteTicket(target.id);

    const result = await undeleteFromHistory(target.id);
    expect(result.edges).toEqual([{ id: blocked.id, blocker: true, parent: false }]);
    // Deliberately NOT re-linked — the other ticket may have moved on.
    expect((await getTicket(blocked.id)).blockers).toEqual([]);
  });

  it('REFUSES to overwrite a live ticket', async () => {
    const t = await createTicket({ title: 'Doc', body: 'LIVE' });
    await updateTicket(t.id, { body: 'LIVE2' });
    const err = await httpError(undeleteFromHistory(t.id));
    expect(err.status).toBe(409);
    expect((await getTicket(t.id)).body).toBe('LIVE2');
  });

  it('404s an id with no history', async () => {
    const err = await httpError(undeleteFromHistory('tkt-nohistory01'));
    expect(err.status).toBe(404);
  });

  it('the underlying write refuses an existing file, not just the listing check above it', async () => {
    // undeleteFromHistory's `live` check is the first line of defence and is inherently racy; the
    // exclusive-create in restoreRawTicketFile is what actually cannot clobber a live ticket.
    const t = await createTicket({ title: 'Live', body: 'KEEP ME' });
    const err = await httpError(restoreRawTicketFile(t.id, Buffer.from('---\ntitle: Overwritten\n---\nCLOBBERED\n')));
    expect(err.status).toBe(409);
    expect((await getTicket(t.id)).body).toBe('KEEP ME');
  });

  it('REFUSES to revive a corrupt snapshot', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Gone', body: 'FINAL' });
    await deleteTicket(t.id);
    const [snap] = (await listHistory(t.id)).snapshots;
    await fs.writeFile(path.join(histDir(t.id), snap.file), '---\ntitle: [unclosed\n---\nX\n', 'utf8');

    const err = await httpError(undeleteFromHistory(t.id));
    expect(err.status).toBe(400);
    expect(await ticketFileExists(t.id)).toBe(false);
  });

  // tkt-ee3f3315cdd8 — undelete returns the file as it was, so an invalid status comes back unreadable
  // (not refused, not coerced to backlog); an update that sets status then repairs it.
  it('revives a snapshot whose status is invalid, byte for byte, as unreadable', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Gone', body: 'FINAL' });
    await deleteTicket(t.id);
    const [snap] = (await listHistory(t.id)).snapshots;
    const snapPath = path.join(histDir(t.id), snap.file);
    const raw = await fs.readFile(snapPath, 'utf8');
    expect(raw).toMatch(/^status: backlog$/m); // control: the substitution below really applies
    const corrupt = raw.replace(/^status: backlog$/m, 'status: in progres');
    await fs.writeFile(snapPath, corrupt, 'utf8');

    const result = await undeleteFromHistory(t.id);

    expect(result.ticket.status).toBeNull();
    expect(result.ticket.title).toBe('Gone');
    expect(await fs.readFile(path.join(dirs.tickets, `${t.id}.md`), 'utf8')).toBe(corrupt);
    expect((await listBoard()).unreadable).toEqual([{ file: `${t.id}.md`, reason: 'invalid status' }]);
  });

  it('REFUSES to restore --full FROM a snapshot whose status is invalid', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Doc', body: 'A' });
    await updateTicket(t.id, { body: 'B' });
    const [snap] = (await listHistory(t.id)).snapshots;
    const snapPath = path.join(histDir(t.id), snap.file);
    await fs.writeFile(snapPath, (await fs.readFile(snapPath, 'utf8')).replace(/^status: backlog$/m, 'status: 42'), 'utf8');

    const err = await httpError(restoreFromSnapshot(t.id, snap.file, { full: true }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('invalid status');
    expect((await getTicket(t.id)).body).toBe('B');
  });

  it('round-trips create -> edit -> delete -> undelete with the final body intact', async () => {
    const created = await createTicket({ title: 'Round trip', body: 'V1' });
    await updateTicket(created.id, { body: 'V2' });
    const final = await updateTicket(created.id, { appendBody: 'V3 APPENDED' });
    await deleteTicket(created.id);
    expect(await ticketFileExists(created.id)).toBe(false);

    const result = await undeleteFromHistory(created.id);
    expect(result.ticket.body).toBe(final.body);
    expect(result.ticket.body).toContain('V3 APPENDED');
    expect(result.ticket.title).toBe(final.title);
    expect(result.ticket.created).toBe(created.created);
    // And the restored ticket is a first-class board member again.
    expect((await getTicket(created.id)).body).toBe(final.body);
  });
});

// Findings from the tkt-2147a878f3ba code review. Each of these was RED before its fix.
describe('code-review regressions', () => {
  it('F1: --full snapshots the pre-restore state even when the body is unchanged', async () => {
    const t = await createTicket({ title: 'Doc', body: 'SAME', priority: 'low', project: 'alpha' });
    await updateTicket(t.id, { body: 'ELSEWHERE' });
    await updateTicket(t.id, { body: 'SAME' }); // snapshot #2; body now matches snapshot #1's
    const oldest = (await listHistory(t.id)).snapshots.at(-1);
    if (!oldest) throw new Error('expected a snapshot');
    await updateTicket(t.id, { priority: 'urgent', project: 'beta', title: 'Renamed' });
    const before = (await listHistory(t.id)).snapshots.length;

    await restoreFromSnapshot(t.id, oldest.file, { full: true });
    const after = await listHistory(t.id);
    // Body never changed, so updateTicket takes no snapshot of its own — without an explicit one the
    // overwritten title/priority/project would be gone for good, contradicting the CLI's own line.
    expect(after.snapshots.length).toBe(before + 1);
    const newest = await fs.readFile(path.join(histDir(t.id), after.snapshots[0].file), 'utf8');
    expect(newest).toContain('Renamed');
    expect(newest).toContain('urgent');
  });

  it('F2: a concurrent update during a delete is never lost unrecorded', async () => {
    const t = await createTicket({ title: 'Racy', body: 'V1' });
    const [, updateOutcome] = await Promise.all([
      deleteTicket(t.id).catch((e: unknown) => e),
      updateTicket(t.id, { body: 'V2 IMPORTANT' }).catch((e: unknown) => e),
    ]);
    // Serialized by the per-id lock, so exactly one ordering happens and either is recoverable:
    // the update ran first and its body is in a snapshot, or it ran second and found nothing.
    if (updateOutcome instanceof HttpError) {
      expect(updateOutcome.status).toBe(404);
    } else {
      const files = (await historyFiles(t.id)).filter((f) => f.endsWith('.md'));
      const bodies = await Promise.all(files.map((f) => fs.readFile(path.join(histDir(t.id), f), 'utf8')));
      expect(bodies.some((b) => b.includes('V2 IMPORTANT'))).toBe(true);
    }
  });

  it('F3: REFUSES --at deleted.json, which would restore the tombstone as the body', async () => {
    const t = await createTicket({ title: 'Doc', body: 'REAL BODY' });
    await deleteTicket(t.id);
    await undeleteFromHistory(t.id);
    await updateTicket(t.id, { body: 'CURRENT' });
    // Re-delete so a tombstone exists beside the snapshots, then bring it back to have a live target.
    const err = await httpError(restoreFromSnapshot(t.id, DELETE_RECORD_FILE));
    expect(err.status).toBe(400);
    expect((await getTicket(t.id)).body).toBe('CURRENT');
  });

  it('F3: REFUSES a non-.md file such as an orphaned atomicWrite temp', async () => {
    const t = await createTicket({ title: 'Doc', body: 'A' });
    await updateTicket(t.id, { body: 'B' });
    await fs.writeFile(path.join(histDir(t.id), 'stray.md.tmp'), '---\ntitle: Stray\n---\nSTRAY\n', 'utf8');
    const err = await httpError(restoreFromSnapshot(t.id, 'stray.md.tmp'));
    expect(err.status).toBe(400);
    expect((await getTicket(t.id)).body).toBe('B');
  });

  it('F4: --undelete REFUSES a symlinked snapshot pointing outside the history directory', async () => {
    const t = await createTicket({ title: 'Doc', body: 'FINAL' });
    await deleteTicket(t.id);
    const outside = path.join(dirs.tickets, 'planted.md');
    await fs.writeFile(outside, '---\ntitle: Planted\n---\nPLANTED FROM OUTSIDE\n', 'utf8');
    // Sorts newest-first ahead of the real snapshot, so undelete would otherwise choose it.
    await fs.symlink(outside, path.join(histDir(t.id), '9999-01-01T00-00-00-000Z-aaaaaaaa.md'));
    await fs.rm(path.join(histDir(t.id), DELETE_RECORD_FILE), { force: true }); // drop the safe pointer

    const err = await httpError(undeleteFromHistory(t.id));
    expect(err.status).toBe(400);
    expect(await ticketFileExists(t.id)).toBe(false);
  });

  it('F5: REFUSES when the history directory itself is a symlink out of the board', async () => {
    const t = await createTicket({ title: 'Doc', body: 'CURRENT' });
    await updateTicket(t.id, { body: 'NEXT' });
    const elsewhere = path.join(dirs.tickets, '..', 'outside-history');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.writeFile(path.join(elsewhere, 'planted.md'), '---\ntitle: Planted\n---\nPLANTED\n', 'utf8');
    await fs.rm(histDir(t.id), { recursive: true, force: true });
    await fs.symlink(elsewhere, histDir(t.id));

    const err = await httpError(restoreFromSnapshot(t.id, 'planted.md'));
    expect(err.status).toBe(400);
    expect((await getTicket(t.id)).body).toBe('NEXT');
  });

  it('F6: clears the tombstone on undelete, so history stops calling a live ticket deleted', async () => {
    const t = await createTicket({ title: 'Doc', body: 'FINAL' });
    await deleteTicket(t.id);
    await undeleteFromHistory(t.id);

    const listing = await listHistory(t.id);
    expect(listing.live).toBe(true);
    expect(listing.deletion).toBeNull(); // otherwise cmdHistory prints "live" AND "deleted <date>"
    expect(await historyFiles(t.id)).not.toContain(DELETE_RECORD_FILE);
  });

  it('F6: a later delete records the CURRENT state, not the first delete stale pointer', async () => {
    const t = await createTicket({ title: 'Doc', body: 'FIRST' });
    await deleteTicket(t.id);
    await undeleteFromHistory(t.id);
    await updateTicket(t.id, { body: 'EDITED AFTER UNDELETE' });
    await deleteTicket(t.id);

    const result = await undeleteFromHistory(t.id);
    expect(result.ticket.body).toBe('EDITED AFTER UNDELETE');
  });

  it('F7: a ticket holding invalid UTF-8 round-trips through delete and undelete unchanged', async () => {
    const id = 'tkt-binary000001';
    // A lone 0xFF is not valid UTF-8; reading as a string would rewrite it as U+FFFD, silently.
    const raw = Buffer.concat([Buffer.from('---\ntitle: Binary\n---\n\nBEFORE'), Buffer.from([0xff]), Buffer.from('AFTER\n')]);
    await fs.mkdir(dirs.tickets, { recursive: true });
    await fs.writeFile(path.join(dirs.tickets, `${id}.md`), raw);
    await deleteTicket(id);
    await undeleteFromHistory(id);
    expect(await fs.readFile(path.join(dirs.tickets, `${id}.md`))).toEqual(raw);
  });
});

// tkt-ee3f3315cdd8 — a live file whose status is invalid, against the restore and delete paths.
describe('a live ticket whose status is invalid', () => {
  async function corruptStatus(id: string, value: string): Promise<string> {
    const file = path.join(dirs.tickets, `${id}.md`);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).toMatch(/^status: backlog$/m); // control: the substitution below really applies
    const corrupt = raw.replace(/^status: backlog$/m, `status: ${value}`);
    await fs.writeFile(file, corrupt, 'utf8');
    return corrupt;
  }

  it('restore --full refuses it and changes nothing; the repair is an update that sets status', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Doc', body: 'A' });
    await updateTicket(t.id, { body: 'B' });
    const [snap] = (await listHistory(t.id)).snapshots;
    const corrupt = await corruptStatus(t.id, 'in progres');
    const before = (await historyFiles(t.id)).length;

    const err = await httpError(restoreFromSnapshot(t.id, snap.file, { full: true }));

    expect(err.status).toBe(500);
    expect(err.message).toContain('update that sets `status`');
    expect(await fs.readFile(path.join(dirs.tickets, `${t.id}.md`), 'utf8')).toBe(corrupt);
    expect(await historyFiles(t.id)).toHaveLength(before);
  });

  it('a body-only restore FROM the snapshot a repair left works, though its status is invalid', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Doc', body: 'OLD' });
    await corruptStatus(t.id, 'in progres');
    await updateTicket(t.id, { status: 'todo', body: 'NEW' });
    const [snap] = (await listHistory(t.id)).snapshots;

    const result = await restoreFromSnapshot(t.id, snap.file);

    expect(result.ticket.body).toBe('OLD');
    expect(result.ticket.status).toBe('todo');
  });

  it('a body-only restore refuses, because it would leave the status invalid', async () => {
    silenceLog();
    const t = await createTicket({ title: 'Doc', body: 'A' });
    await updateTicket(t.id, { body: 'B' });
    const [snap] = (await listHistory(t.id)).snapshots;
    const corrupt = await corruptStatus(t.id, 'in progres');

    const err = await httpError(restoreFromSnapshot(t.id, snap.file));

    expect(err.status).toBe(500);
    expect(await fs.readFile(path.join(dirs.tickets, `${t.id}.md`), 'utf8')).toBe(corrupt);
  });

  it('deleting a ticket it links to still records the edge for an undelete to report', async () => {
    silenceLog();
    const target = await createTicket({ title: 'Target' });
    const linked = await createTicket({ title: 'Linked', parent: target.id });
    await corruptStatus(linked.id, 'in progres');

    await deleteTicket(target.id);

    expect((await listHistory(target.id)).deletion?.edges).toEqual([{ id: linked.id, blocker: false, parent: true }]);
  });
});
