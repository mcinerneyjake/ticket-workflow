import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

/** Reads one slot. `null` means free (no file). Corrupt or unreadable content refuses. */
function readSlot(stateDir: string, slot: number, probe: Probe, now: number, ttlMs: number): SlotView | null {
  const file = slotPath(stateDir, slot);
  let text: string;
  let mtimeMs: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw unreadable(file, 'not a regular file');
    mtimeMs = st.mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof TestRunRefusal) throw err;
    if (errnoCode(err) === 'ENOENT') return null;
    throw unreadable(file, err);
  }
  const record = parseSlotRecord(text);
  if (record === null) {
    throw new TestRunRefusal(
      EXIT.STATE_UNREADABLE,
      `${file} is not a valid slot record; refusing to run unguarded. Inspect it, then remove it by hand or run \`ticket-workflow test-slots clear-stale\` once you know whose it is.`,
    );
  }
  const ageMs = Math.max(0, now - mtimeMs);
  return { slot, file, record, liveness: probe(record.pid), ageMs, expired: ageMs > ttlMs };
}

export interface ReadOptions {
  readonly probe: Probe;
  readonly now: number;
  readonly ttlMs: number;
}

/** Every held slot, in slot order. A missing state dir is an empty board; an unreadable one refuses. */
export function listSlots(stateDir: string, opts: ReadOptions): SlotView[] {
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
  const out: SlotView[] = [];
  for (const slot of slots) {
    const view = readSlot(stateDir, slot, opts.probe, opts.now, opts.ttlMs);
    if (view !== null) out.push(view);
  }
  return out;
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

/** Who is claiming: the pid, plus the tokens of the slots this process still holds. */
interface SelfClaim {
  readonly pid: number;
  readonly heldTokens: ReadonlySet<string>;
}

/**
 * Whether a slot recording our own pid is a LEAK from a failed release rather than a live sibling
 * hold. A token we still hold belongs to a run that is about to use it: reclaiming that would delete
 * a live record and over-grant `slots` (tkt-a99209bedbb9). Both the out-of-lock decision and
 * reclaim's in-lock re-check go through here, so the two cannot disagree and half-apply the reclaim.
 *
 * Two cases it does NOT distinguish, neither of them new and neither improved here:
 * a token-less record (the pre-token rule, pid alone — wrong if a second *version* of this package is
 * live in this process, tkt-a51a84902cc9), and a foreign process wearing our pid, whose token is
 * absent from our set for the same reason a leak's is (tkt-f5dae96f0298).
 */
function isSelfOrphan(record: SlotRecord, self: SelfClaim | null): boolean {
  if (self === null || record.pid !== self.pid) return false;
  return record.token === undefined || !self.heldTokens.has(record.token);
}

/**
 * Removes a dead, expired or self-orphaned slot, deciding INSIDE a per-slot lock: judging from an
 * earlier read then renaming let a reclaimer rename a live winner's fresh record (3 of 8 granted,
 * tkt-14788b3fc356). `self` must match the caller's out-of-lock decision, or this re-check vetoes
 * it and the reclaim silently never happens.
 */
function reclaim(view: SlotView, opts: ReadOptions, self: SelfClaim | null): boolean {
  const lock = `${view.file}.reclaim`;
  if (!acquireReclaimLock(lock, opts.now)) return false;
  try {
    const current = readSlot(path.dirname(view.file), view.slot, opts.probe, opts.now, opts.ttlMs);
    if (current === null) return false;
    if (current.liveness !== 'dead' && !current.expired && !isSelfOrphan(current.record, self)) return false;
    const stale = `${view.file}.stale-${current.record.pid}-${opts.now}`;
    try {
      renameSync(view.file, stale);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw unreadable(`rename ${view.file}`, err);
    }
    rmSync(stale, { force: true });
    return true;
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already broken by a peer that judged us dead; nothing to release.
    }
  }
}

export interface ClaimOptions extends ReadOptions {
  readonly stateDir: string;
  readonly slots: number;
  readonly record: SlotRecord;
  readonly log: (line: string) => void;
  /** Tokens of slots this process still holds: live siblings, never leaks to reclaim. */
  readonly heldTokens?: ReadonlySet<string>;
}

export interface Claim {
  readonly slot: number;
  readonly file: string;
}

export function formatSlot(v: SlotView): string {
  const age = Math.round(v.ageMs / 1000);
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
    if (reclaim(view, opts, self)) {
      opts.log(`[test-run] WARNING: reclaimed ${formatSlot(view)} — our own orphaned slot from a failed release`);
    }
  }
}

/**
 * One attempt over all K slots. `null` when every slot is held by a live (or unknowable) holder
 * inside its TTL. Dead holders are reclaimed on sight; live ones past the TTL with a warning.
 */
export function claimSlot(opts: ClaimOptions): Claim | null {
  ensureStateDir(opts.stateDir);
  const self: SelfClaim = { pid: opts.record.pid, heldTokens: opts.heldTokens ?? new Set() };
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
        try {
          linkSync(draft, target); // AUTHORIZING: the only line that grants a slot
          clearOwnOrphans(opts, self, slot);
          return { slot, file: target };
        } catch (err) {
          if (errnoCode(err) !== 'EEXIST') throw unreadable(`link ${target}`, err);
        }
        const view = readSlot(opts.stateDir, slot, opts.probe, opts.now, opts.ttlMs);
        if (view === null) continue; // freed between the link and the read; retry the link
        if (view.liveness === 'dead') {
          if (reclaim(view, opts, null)) opts.log(`[test-run] reclaimed ${formatSlot(view)} — process is gone`);
          continue;
        }
        if (view.expired) {
          if (reclaim(view, opts, null)) opts.log(`[test-run] WARNING: reclaimed ${formatSlot(view)} — no heartbeat within the TTL`);
          continue;
        }
        if (isSelfOrphan(view.record, self)) {
          // Our own pid in a slot we are trying to claim, with a token we no longer hold, is a leak
          // from a failed release — not a peer. Without this the run blocks on itself until the TTL
          // (tkt-0ce4d4313ce7). A token we DO still hold falls through to the break below and is
          // treated as the live holder it is (tkt-a99209bedbb9).
          if (reclaim(view, opts, self)) {
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
export function clearStaleSlots(stateDir: string, opts: ReadOptions): SlotView[] {
  const removed: SlotView[] = [];
  for (const view of listSlots(stateDir, opts)) {
    if (view.liveness === 'dead' || view.expired) {
      if (reclaim(view, opts, null)) removed.push(view);
    }
  }
  return removed;
}
