import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DELETE_RECORD_FILE, HttpError, fullPatchOf, getTicket, getTicketsDir, historyDir, isENOENT,
  parseTicketFile, restoreRawTicketFile, snapshotTicketState, ticketExists, updateTicket,
  type DeleteRecord, type StrippedEdge,
} from './tickets.js';
import { log } from '../logger.js';
import type { Ticket } from '../shared/constants.js';

// Read side of the backup-on-write history tickets.ts writes (tkt-2147a878f3ba). The writer is
// upstream of every consumer and has existed since tkt-18d53c0c7cd8; until this module there was
// no reader at all, so the snapshots were an undo nobody could perform.

export interface SnapshotEntry {
  file: string
  bytes: number
  modified: string
}

export interface HistoryListing {
  id: string
  live: boolean
  snapshots: SnapshotEntry[]
  deletion: DeleteRecord | null
}

// A snapshot filename starts with the ISO timestamp snapshotName() stamped, with `:` and `.`
// rewritten as `-`. That substitution is order-preserving within a fixed-width prefix, so a
// descending lexical sort IS newest-first and needs no stat call or filename parsing.
function newestFirst(files: string[]): string[] {
  return [...files].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

async function readDeleteRecord(dir: string): Promise<DeleteRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, DELETE_RECORD_FILE), 'utf8');
  } catch (err) {
    if (isENOENT(err)) return null; // never deleted, or deleted before this feature shipped
    // EISDIR and friends: a tombstone we cannot read is the same to a caller as one that is
    // unparseable below, and must not turn a listing into an unmapped 500.
    log.warn(`[history] could not read ${DELETE_RECORD_FILE} in ${dir}:`, err instanceof Error ? err.message : err);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    const record: Record<string, unknown> = { ...parsed };
    const edges: StrippedEdge[] = Array.isArray(record.edges)
      ? record.edges.flatMap((e: unknown) => {
        if (e === null || typeof e !== 'object') return [];
        const edge: Record<string, unknown> = { ...e };
        return typeof edge.id === 'string'
          ? [{ id: edge.id, blocker: edge.blocker === true, parent: edge.parent === true }]
          : [];
      })
      : [];
    return {
      id: typeof record.id === 'string' ? record.id : '',
      deletedAt: typeof record.deletedAt === 'string' ? record.deletedAt : '',
      snapshot: typeof record.snapshot === 'string' ? record.snapshot : '',
      edges,
    };
  } catch (err) {
    // Report-only: a damaged tombstone must not hide the snapshots beside it, which are the part
    // that actually restores work. The listing still says the id was deleted via `live: false`.
    log.warn(`[history] ignoring unreadable ${DELETE_RECORD_FILE} in ${dir}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function listHistory(id: string): Promise<HistoryListing> {
  const dir = historyDir(id); // validates the id → a malformed one is 400, not an empty listing
  const live = await ticketExists(id);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isENOENT(err)) throw new HttpError(404, `No history for ${id}${live ? ' — its body has never been overwritten.' : '.'}`);
    throw err;
  }
  const files = newestFirst(names.filter((n) => n.endsWith('.md')));
  // A snapshot can vanish between readdir and stat (a concurrent prune), which listBoard already
  // treats as a skip rather than a fault (tkt-0612c572b49e). Dropping it keeps one disappearing file
  // from turning a listing into an unmapped 500.
  const entries = await Promise.all(files.map(async (file): Promise<SnapshotEntry | null> => {
    try {
      const stat = await fs.stat(path.join(dir, file));
      return { file, bytes: stat.size, modified: stat.mtime.toISOString() };
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }));
  const snapshots = entries.filter((e): e is SnapshotEntry => e !== null);
  return { id, live, snapshots, deletion: await readDeleteRecord(dir) };
}

// Containment is what stands in for an id check: a snapshot's frontmatter carries no id (identity is
// the directory), so "belongs to this ticket" can only mean "sits directly in .history/<id>/".
// Three separate things are checked, because each admits what the others do not:
//   - the `.md` suffix, or `--at deleted.json` would restore the tombstone JSON as the ticket body,
//     as would an `atomicWrite` `*.tmp` orphaned by a crash between its write and its rename;
//   - lexical containment, which stops `../`;
//   - containment again after realpath, which stops a symlink planted INSIDE the directory, and a
//     check that the directory itself resolves under tickets/, since realpath(dir) would otherwise
//     happily follow `.history/<id>` being a symlink to anywhere and call its contents contained.
async function resolveSnapshotPath(id: string, file: string): Promise<string> {
  const dir = historyDir(id);
  if (!file.endsWith('.md'))
    throw new HttpError(400, `Snapshot ${file} is not a ticket snapshot (expected a .md file) — nothing was written.`);
  const target = path.resolve(dir, file);
  if (path.dirname(target) !== path.resolve(dir))
    throw new HttpError(400, `Snapshot ${file} is not in this ticket's history directory — nothing was written.`);
  let realTarget: string;
  let realDir: string;
  let realRoot: string;
  try {
    realTarget = await fs.realpath(target);
    realDir = await fs.realpath(dir);
    realRoot = await fs.realpath(getTicketsDir());
  } catch (err) {
    if (isENOENT(err)) throw new HttpError(404, `No such snapshot for ${id}: ${file}`);
    throw err;
  }
  if (path.dirname(realTarget) !== realDir)
    throw new HttpError(400, `Snapshot ${file} resolves outside this ticket's history directory — nothing was written.`);
  if (realDir !== path.join(realRoot, '.history', id))
    throw new HttpError(400, `This ticket's history directory resolves outside the board — nothing was written.`);
  return realTarget;
}

export interface RestoreResult {
  ticket: Ticket
  scope: 'body' | 'full'
  from: string
}

export async function restoreFromSnapshot(id: string, file: string, options: { full?: boolean } = {}): Promise<RestoreResult> {
  const full = options.full === true;
  const snapshotPath = await resolveSnapshotPath(id, file);
  const snapshot = parseTicketFile(id, await fs.readFile(snapshotPath, 'utf8'), file);
  let current: Ticket;
  try {
    current = await getTicket(id);
  } catch (err) {
    // The one refusal that must point somewhere: restoring onto a deleted id is a different verb.
    if (err instanceof HttpError && err.status === 404)
      throw new HttpError(404, `Ticket ${id} does not exist — use \`restore ${id} --undelete\` to recreate it from its last snapshot.`);
    throw err;
  }
  const patch = full ? fullPatchOf(snapshot) : { body: snapshot.body };
  const unchanged = full
    ? JSON.stringify(fullPatchOf(current)) === JSON.stringify(patch)
    : current.body === snapshot.body;
  // Refused BEFORE the write rather than relying on updateTicket's own no-op guard: the caller asked
  // for a restore, and reporting success for a write that never happened is the fail-open shape.
  if (unchanged)
    throw new HttpError(400, `Ticket ${id} already matches ${file}${full ? '' : ' (body)'} — nothing was written.`);
  // updateTicket snapshots only a BODY change, so a --full restore of structured fields alone would
  // leave nothing to undo — while the CLI prints that the pre-restore state was saved. Taking it
  // here unconditionally for --full keeps that true; when the body also changes this leaves two
  // snapshots of the same prior state, which costs a file and duplicates nothing that matters.
  if (full) await snapshotTicketState(id);
  return { ticket: await updateTicket(id, patch), scope: full ? 'full' : 'body', from: file };
}

export interface UndeleteResult {
  ticket: Ticket
  from: string
  edges: StrippedEdge[]
  tombstone: boolean
}

export async function undeleteFromHistory(id: string): Promise<UndeleteResult> {
  const listing = await listHistory(id);
  if (listing.live)
    throw new HttpError(409, `Ticket ${id} already exists — undelete refuses to overwrite a live ticket. Use \`restore ${id} --at <snapshot>\` to roll its body back instead.`);
  // Prefer the tombstone's own pointer: it names the FINAL state deleteTicket recorded, which the
  // newest-first sort would also pick — but only while no later file lands in the directory.
  const named = listing.deletion?.snapshot;
  const file = named !== undefined && named !== '' && listing.snapshots.some((s) => s.file === named)
    ? named
    : listing.snapshots[0]?.file;
  if (file === undefined)
    throw new HttpError(404, `No snapshot to restore for ${id} — its history directory holds no ticket file.`);
  // Through the same containment check as `--at`, not a bare join: the name is a basename from
  // readdir so it cannot traverse, but it can still BE a symlink pointing anywhere, and reviving
  // whatever it points at as the ticket is the same hole `--at` already refuses.
  const snapshotPath = await resolveSnapshotPath(id, file);
  const raw = await fs.readFile(snapshotPath);
  // Validate before writing: a corrupt snapshot must not be revived. Parsed from the bytes, while
  // what gets written is the bytes themselves.
  parseTicketFile(id, raw.toString('utf8'), file);
  await restoreRawTicketFile(id, raw);
  return {
    ticket: await getTicket(id),
    from: file,
    edges: listing.deletion?.edges ?? [],
    tombstone: listing.deletion !== null,
  };
}
