import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Machine-wide test-run slots (tkt-14788b3fc356). A `node:`-only leaf: the race test's children
// import it directly, and vitest.config.ts loads it before anything else in the package exists.

export const EXIT = {
  /** All K slots are held by live holders and the wait budget ran out. Retry later. */
  SLOTS_FULL: 75,
  /** The state directory or a slot file cannot be read or trusted, or an env override is invalid. */
  STATE_UNREADABLE: 78,
  /** The per-run TMPDIR cannot be created. */
  TMPDIR_UNAVAILABLE: 74,
} as const;

export type RefusalCode = (typeof EXIT)[keyof typeof EXIT];

/** A holder whose heartbeat is older than this is reclaimed even if its pid looks alive. */
export const DEFAULT_TTL_MS = 15 * 60_000;

/** A reclaim lock older than this belongs to a process that died mid-reclaim; it is broken. */
export const RECLAIM_LOCK_STALE_MS = 30_000;

export class TestRunRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = 'TestRunRefusal';
    this.code = code;
  }
}

export type Liveness = 'alive' | 'dead' | 'unknown';
export type Probe = (pid: number) => Liveness;

export interface SlotRecord {
  readonly version: 1;
  readonly pid: number;
  readonly repo: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly tmpDir: string;
  /**
   * Per-hold nonce, so ownership can be decided WITHIN one pid (tkt-a99209bedbb9). Optional on
   * purpose: several pinned versions of this package share one state dir on a machine, so a record
   * written by one without tokens must still parse and still release here.
   */
  readonly token?: string;
}

export interface SlotView {
  readonly slot: number;
  readonly file: string;
  readonly record: SlotRecord;
  readonly liveness: Liveness;
  readonly ageMs: number;
  readonly expired: boolean;
}

const SLOT_NAME = /^slot-(\d+)$/;

export function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

export function testSlotsStateDir(env: NodeJS.ProcessEnv): string {
  return env.TEST_SLOTS_DIR ?? path.join(homedir(), '.claude', 'state', 'test-slots');
}

/**
 * Only `ESRCH` is dead. `EPERM` is another user's live process (pid reuse on a shared box), and pids
 * that are ≤0 or non-integers never reach `process.kill` — they would signal a group or throw.
 */
export function pidLiveness(pid: number): Liveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/** `undefined` takes the default; anything present must be a finite integer at or above `min`. */
export function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new TestRunRefusal(
      EXIT.STATE_UNREADABLE,
      `${name}=${JSON.stringify(raw)} is not an integer >= ${min}; refusing to guess a test-slot setting.`,
    );
  }
  return n;
}

export function parseSlotRecord(text: string): SlotRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o: Record<string, unknown> = { ...parsed };
  if (o.version !== 1) return null;
  if (!Number.isSafeInteger(o.pid) || typeof o.pid !== 'number' || o.pid <= 0) return null;
  if (typeof o.repo !== 'string' || typeof o.cwd !== 'string' || typeof o.tmpDir !== 'string') return null;
  if (typeof o.startedAt !== 'string' || Number.isNaN(Date.parse(o.startedAt))) return null;
  // An empty token would compare equal to an absent one, silently restoring pid-only ownership.
  if (o.token !== undefined && (typeof o.token !== 'string' || o.token === '')) return null;
  const token = typeof o.token === 'string' ? o.token : undefined;
  return { version: 1, pid: o.pid, repo: o.repo, cwd: o.cwd, startedAt: o.startedAt, tmpDir: o.tmpDir, token };
}

function unreadable(what: string, err: unknown): TestRunRefusal {
  const code = errnoCode(err) ?? (err instanceof Error ? err.message : String(err));
  return new TestRunRefusal(
    EXIT.STATE_UNREADABLE,
    `Cannot read the test-slot state (${what}: ${code}); refusing to run unguarded. Fix the state dir or point TEST_SLOTS_DIR elsewhere.`,
  );
}

export function ensureStateDir(stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    throw unreadable(`mkdir ${stateDir}`, err);
  }
  let st;
  try {
    st = statSync(stateDir);
  } catch (err) {
    throw unreadable(`stat ${stateDir}`, err);
  }
  if (!st.isDirectory()) throw unreadable(`${stateDir}`, 'ENOTDIR');
}

function slotPath(stateDir: string, slot: number): string {
  return path.join(stateDir, `slot-${slot}`);
}

export interface UnparseableSlot {
  readonly slot: number;
  readonly file: string;
  readonly record: null;
  readonly ageMs: number;
  readonly expired: boolean;
}

export type SlotRead = SlotView | UnparseableSlot;

function unparseableRefusal(file: string): TestRunRefusal {
  return new TestRunRefusal(
    EXIT.STATE_UNREADABLE,
    `${file} is not a valid slot record; refusing to run unguarded. It may be a live hold written by another version of this package, so \`ticket-workflow test-slots clear-stale\` removes it only once nothing has refreshed it within the TTL. Before then, remove it by hand only once you know whose it is.`,
  );
}

/** `null` when no slot file exists. */
function openSlot(file: string): number | null {
  try {
    return openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); // a FIFO must not block the read
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw unreadable(file, err);
  }
}

function inspectSlot(stateDir: string, slot: number, probe: Probe, now: number, ttlMs: number): SlotRead | null {
  const file = slotPath(stateDir, slot);
  const fd = openSlot(file);
  if (fd === null) return null;
  try {
    return judgeSlot(fd, file, slot, probe, now, ttlMs);
  } finally {
    closeSync(fd);
  }
}

// One fd: a path stat then a path read can pair an old file's expired mtime with a new file's content.
function judgeSlot(fd: number, file: string, slot: number, probe: Probe, now: number, ttlMs: number): SlotRead {
  let text: string;
  let mtimeMs: number;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw unreadable(file, 'not a regular file');
    mtimeMs = st.mtimeMs;
    text = readFileSync(fd, 'utf8');
  } catch (err) {
    if (err instanceof TestRunRefusal) throw err;
    throw unreadable(file, err);
  }
  const ageMs = Math.max(0, now - mtimeMs);
  const expired = ageMs > ttlMs;
  const record = parseSlotRecord(text);
  if (record === null) return { slot, file, record: null, ageMs, expired };
  return { slot, file, record, liveness: probe(record.pid), ageMs, expired };
}

function readSlot(stateDir: string, slot: number, probe: Probe, now: number, ttlMs: number): SlotView | null {
  const read = inspectSlot(stateDir, slot, probe, now, ttlMs);
  if (read !== null && read.record === null) throw unparseableRefusal(read.file);
  return read;
}

export interface ReadOptions {
  readonly probe: Probe;
  readonly now: number;
  readonly ttlMs: number;
}

function inspectSlots(stateDir: string, opts: ReadOptions): SlotRead[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw unreadable(`readdir ${stateDir}`, err);
  }
  const slots = names
    .map((n) => SLOT_NAME.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const out: SlotRead[] = [];
  for (const slot of slots) {
    const read = inspectSlot(stateDir, slot, opts.probe, opts.now, opts.ttlMs);
    if (read !== null) out.push(read);
  }
  return out;
}

/** Every held slot, in slot order. A missing state dir is an empty board; an unreadable one refuses. */
export function listSlots(stateDir: string, opts: ReadOptions): SlotView[] {
  return inspectSlots(stateDir, opts).map((read) => {
    if (read.record === null) throw unparseableRefusal(read.file);
    return read;
  });
}

/** A stale lock is broken by RENAMING it, so only one of several breakers can win before the mkdir. */
function acquireReclaimLock(lock: string, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock);
      return true;
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw unreadable(`mkdir ${lock}`, err);
    }
    let ageMs: number;
    try {
      ageMs = now - statSync(lock).mtimeMs;
    } catch {
      return false; // released between our mkdir and stat; the caller retries the link
    }
    if (ageMs <= RECLAIM_LOCK_STALE_MS) return false;
    const broken = `${lock}.broken-${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(lock, broken);
    } catch {
      return false; // another breaker won the rename
    }
    rmSync(broken, { recursive: true, force: true });
  }
  return false;
}

/**
 * A hold token is `<ownership domain>.<per-hold nonce>`. `.` is absent from `randomUUID()`, so the
 * split is unambiguous without escaping, and these two functions are the only production sites that
 * know the shape (tkt-f5dae96f0298).
 */
const NONCE_SEP = '.';

export function mintToken(nonce: string, hold: string): string {
  // Refused rather than escaped, on both halves: a token `nonceOf` cannot invert parses back as a
  // DIFFERENT domain or as none, silently restoring pid-only ownership for this whole process. A
  // separator inside `hold` is harmless — only the FIRST one is read — so it is not refused.
  if (nonce === '' || hold === '' || nonce.includes(NONCE_SEP)) {
    throw new TestRunRefusal(
      EXIT.STATE_UNREADABLE,
      `a slot token needs a non-empty ownership domain and hold, and no ${JSON.stringify(NONCE_SEP)} in the domain; refusing to mint an ambiguous token.`,
    );
  }
  return `${nonce}${NONCE_SEP}${hold}`;
}

/**
 * The domain a token was minted in, or `undefined` when it carries none we can read: a pre-nonce
 * copy's bare token, or a malformed one. Unreadable stays distinct from every real nonce rather than
 * being coerced into one — a domain we cannot name is one we may not assume is ours.
 */
function nonceOf(token: string): string | undefined {
  const i = token.indexOf(NONCE_SEP);
  if (i <= 0 || i === token.length - 1) return undefined;
  return token.slice(0, i);
}

// Process-wide, even read from a worker thread; floored to `startedAt`'s ms precision.
const PROCESS_STARTED_AT = Math.floor(performance.timeOrigin);

/** Who is claiming: the pid, our own token's nonce domain, and the tokens of the slots we still hold. */
interface SelfClaim {
  readonly pid: number;
  readonly nonce: string | undefined;
  readonly heldTokens: ReadonlySet<string>;
}

/**
 * Whether a slot recording our own pid is a LEAK from a failed release rather than a live sibling
 * hold. A token we still hold belongs to a run that is about to use it: reclaiming that would delete
 * a live record and over-grant `slots` (tkt-a99209bedbb9). Both the out-of-lock decision and
 * reclaim's in-lock re-check go through here, so the two cannot disagree and half-apply the reclaim.
 *
 * Token-less and started during this process: an older package copy's live hold (tkt-a51a84902cc9).
 *
 * Two residuals the nonce cannot reach, each needing a colliding pid. A token-less record predating
 * this process is judged a recycled pid's leak, so a FOREIGN pre-token holder is still reclaimed; and
 * two pre-nonce copies carry no domain to compare, so they match on pid exactly as before. And the
 * domain being per-isolate, a leak from an isolate that has since exited waits out the TTL.
 */
function isSelfOrphan(record: SlotRecord, self: SelfClaim | null): boolean {
  if (self === null || record.pid !== self.pid) return false;
  if (record.token === undefined) return Date.parse(record.startedAt) < PROCESS_STARTED_AT;
  // Another domain is a stranger wearing our pid across a shared state dir, so its absence from
  // heldTokens says nothing about us; dead and expired still reclaim, so refusing costs one TTL.
  if (nonceOf(record.token) !== self.nonce) return false;
  return !self.heldTokens.has(record.token);
}

type StaleTest = (current: SlotRead) => boolean;

function staleHold(self: SelfClaim | null): StaleTest {
  return (current) => {
    if (current.record === null) throw unparseableRefusal(current.file);
    return current.liveness === 'dead' || current.expired || isSelfOrphan(current.record, self);
  };
}

// An unparseable record may be another version's live hold: no heartbeat within the TTL is its only staleness (tkt-c3df050395d8).
const staleForSweep: StaleTest = (current) => (current.record === null ? current.expired : current.liveness === 'dead' || current.expired);

/** `null` when the identity cannot be told apart: a filesystem reporting ino 0 must not match everything. */
function identity(st: BigIntStats): string | null {
  return st.ino === 0n ? null : `${st.dev}:${st.ino}`;
}

/**
 * Puts back a record a reclaim renamed away by mistake. `link` never replaces, so a slot re-granted in
 * the rename-to-restore window refuses here, and the displaced record stays on disk as the evidence.
 */
function restore(stale: string, file: string): void {
  try {
    linkSync(stale, file);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') {
      throw new TestRunRefusal(
        EXIT.STATE_UNREADABLE,
        `${file} changed hands twice during a reclaim; the live hold it displaced could not be put back and is kept at ${stale}. Two runs may share that slot until one finishes.`,
      );
    }
    throw unreadable(`link ${stale} -> ${file}`, err);
  }
  rmSync(stale, { force: true });
}

/**
 * Removes a slot `isStale` judges stale, deciding INSIDE a per-slot lock: judging from an earlier
 * read then renaming let a reclaimer rename a live winner's fresh record (3 of 8 granted,
 * tkt-14788b3fc356). `isStale` must match the caller's out-of-lock decision, or this re-check vetoes
 * it and the reclaim silently never happens.
 */
function reclaim(view: SlotRead, opts: ReadOptions, isStale: StaleTest): boolean {
  const lock = `${view.file}.reclaim`;
  if (!acquireReclaimLock(lock, opts.now)) return false;
  let fd: number | null = null;
  try {
    fd = openSlot(view.file);
    if (fd === null) return false;
    let judged: BigIntStats;
    try {
      judged = fstatSync(fd, { bigint: true });
    } catch (err) {
      throw unreadable(view.file, err);
    }
    const current = judgeSlot(fd, view.file, view.slot, opts.probe, opts.now, opts.ttlMs);
    if (!isStale(current)) return false;
    const owner = current.record === null ? 'unparseable' : current.record.pid;
    const stale = `${view.file}.stale-${owner}-${opts.now}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(view.file, stale);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw unreadable(`rename ${view.file}`, err);
    }
    // Claimers, releasers and heartbeats skip this lock, so the rename can take a newer record or a
    // re-touched one (tkt-12ebbc36021a). The open fd pins the judged inode against number reuse.
    let unchanged = false;
    try {
      const moved = statSync(stale, { bigint: true });
      unchanged = identity(judged) !== null && identity(moved) === identity(judged) && moved.mtimeNs === judged.mtimeNs;
    } catch {
      // Cannot tell what was moved: put it back rather than delete it.
    }
    if (!unchanged) {
      restore(stale, view.file);
      return false;
    }
    rmSync(stale, { force: true });
    return true;
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      rmdirSync(lock);
    } catch {
      // Already broken by a peer that judged us dead; nothing to release.
    }
  }
}

/** Required token: isSelfOrphan treats a token-less own-pid record as another copy's (tkt-a51a84902cc9). */
export type ClaimRecord = SlotRecord & { readonly token: string };

export interface ClaimOptions extends ReadOptions {
  readonly stateDir: string;
  readonly slots: number;
  readonly record: ClaimRecord;
  readonly log: (line: string) => void;
  /** Tokens of slots this process still holds: live siblings, never leaks to reclaim. */
  readonly heldTokens?: ReadonlySet<string>;
}

export interface Claim {
  readonly slot: number;
  readonly file: string;
}

export function formatSlot(v: SlotRead): string {
  const age = Math.round(v.ageMs / 1000);
  if (v.record === null) return `slot ${v.slot}: unparseable record (last written ${age}s ago)`;
  return `slot ${v.slot}: pid ${v.record.pid} ${v.record.repo} ${v.record.cwd} (${v.liveness}, last heartbeat ${age}s ago)`;
}

/**
 * Clears any OTHER slot this process has orphaned once we hold one. The in-loop branch below only sees
 * slots we actually contend for, so a leak in a slot we never reached would survive — two slots on
 * one live pid, which `clear-stale` will not touch and which reads as full to every other repo for
 * the whole TTL (tkt-0ce4d4313ce7). Read errors are swallowed deliberately: before this sweep a
 * corrupt slot elsewhere never refused a valid claim, and it must not start.
 */
function clearOwnOrphans(opts: ClaimOptions, self: SelfClaim, keepSlot: number): void {
  for (let slot = 0; slot < opts.slots; slot += 1) {
    if (slot === keepSlot) continue;
    let view: SlotView | null;
    try {
      view = readSlot(opts.stateDir, slot, opts.probe, opts.now, opts.ttlMs);
    } catch {
      continue;
    }
    if (view === null || !isSelfOrphan(view.record, self)) continue;
    try {
      if (reclaim(view, opts, staleHold(self))) {
        opts.log(`[test-run] WARNING: reclaimed ${formatSlot(view)} — our own orphaned slot from a failed release`);
      }
    } catch (err) {
      // We already hold a slot: refusing now would strand it until the TTL (tkt-12ebbc36021a).
      opts.log(`[test-run] WARNING: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * One attempt over all K slots. `null` when every slot is held by a live (or unknowable) holder
 * inside its TTL. Dead holders are reclaimed on sight; live ones past the TTL with a warning.
 */
export function claimSlot(opts: ClaimOptions): Claim | null {
  ensureStateDir(opts.stateDir);
  const self: SelfClaim = { pid: opts.record.pid, nonce: nonceOf(opts.record.token), heldTokens: opts.heldTokens ?? new Set() };
  const draft = path.join(opts.stateDir, `slot.draft-${opts.record.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(draft, JSON.stringify(opts.record), { mode: 0o644 });
  } catch (err) {
    throw unreadable(`write ${draft}`, err);
  }
  try {
    for (let slot = 0; slot < opts.slots; slot += 1) {
      const target = slotPath(opts.stateDir, slot);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let granted = false;
        try {
          linkSync(draft, target); // AUTHORIZING: the only line that grants a slot
          granted = true;
        } catch (err) {
          if (errnoCode(err) !== 'EEXIST') throw unreadable(`link ${target}`, err);
        }
        if (granted) {
          clearOwnOrphans(opts, self, slot);
          return { slot, file: target };
        }
        const view = readSlot(opts.stateDir, slot, opts.probe, opts.now, opts.ttlMs);
        if (view === null) continue; // freed between the link and the read; retry the link
        if (view.liveness === 'dead') {
          if (reclaim(view, opts, staleHold(null))) opts.log(`[test-run] reclaimed ${formatSlot(view)} — process is gone`);
          continue;
        }
        if (view.expired) {
          if (reclaim(view, opts, staleHold(null))) opts.log(`[test-run] WARNING: reclaimed ${formatSlot(view)} — no heartbeat within the TTL`);
          continue;
        }
        if (isSelfOrphan(view.record, self)) {
          // Our own pid in a slot we are trying to claim, with a token we no longer hold, is a leak
          // from a failed release — not a peer. Without this the run blocks on itself until the TTL
          // (tkt-0ce4d4313ce7). A token we DO still hold falls through to the break below and is
          // treated as the live holder it is (tkt-a99209bedbb9).
          if (reclaim(view, opts, staleHold(self))) {
            opts.log(`[test-run] WARNING: reclaimed ${formatSlot(view)} — our own orphaned slot from a failed release`);
          }
          continue;
        }
        break; // held by a live holder; try the next slot
      }
    }
    return null;
  } finally {
    rmSync(draft, { force: true });
  }
}

export function heartbeat(file: string, now: number): void {
  const t = new Date(now);
  utimesSync(file, t, t);
}

export type ReleaseOutcome = 'released' | 'missing' | 'foreign';

/**
 * Unlinks the slot only while it still records THIS hold; a reissued or vanished slot is reported,
 * not deleted. The token is what makes that true within one pid: on pid alone a released hold deleted
 * the record of a second hold that had since taken the same slot, reporting `released` and leaving
 * that run unguarded (tkt-a99209bedbb9).
 *
 * `undefined` on both sides matches on pid alone. `releaseHeld` always passes a token, so that is not
 * a path this package takes — it is tolerance for a record written by an older pinned copy, kept so
 * such a record cannot wedge a slot. The reverse direction is NOT guarded and cannot be from here: an
 * older copy's two-argument `releaseSlot` still deletes one of our records on a pid match.
 */
export function releaseSlot(file: string, pid: number, token?: string): ReleaseOutcome {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 'missing';
    throw err;
  }
  const record = parseSlotRecord(text);
  // AUTHORIZING: the only line that permits the unlink.
  if (record === null || record.pid !== pid || record.token !== token) return 'foreign';
  unlinkSync(file);
  return 'released';
}

/** Removes dead and expired slots; leaves live ones. Returns what it removed. */
export function clearStaleSlots(stateDir: string, opts: ReadOptions): SlotRead[] {
  const reads = inspectSlots(stateDir, opts);
  const fresh = reads.find((read) => read.record === null && !read.expired);
  if (fresh !== undefined) throw unparseableRefusal(fresh.file);
  const removed: SlotRead[] = [];
  for (const read of reads) {
    if (staleForSweep(read) && reclaim(read, opts, staleForSweep)) removed.push(read);
  }
  return removed;
}
