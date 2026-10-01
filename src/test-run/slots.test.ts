import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimSlot,
  clearStaleSlots,
  envInt,
  EXIT,
  listSlots,
  mintToken,
  parseSlotRecord,
  pidLiveness,
  RECLAIM_LOCK_STALE_MS,
  releaseSlot,
  TestRunRefusal,
  type Liveness,
  type SlotRecord,
} from './slots.js';

// Every case injects its own state dir and probe; nothing here reads process.env or touches the
// real ~/.claude/state, so a worker's own VITEST_WORKER_ID cannot make a case pass vacuously.

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-slots-'));
  tempDirs.push(dir);
  return dir;
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** The pid of a node process that has already exited: ESRCH from `process.kill(pid, 0)`. */
function exitedPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid === undefined || r.pid === 0) throw new Error('could not spawn a probe child');
  return r.pid;
}

/**
 * A live pid that is never ours. `claimSlot` reclaims a slot recording the CLAIMANT's own pid
 * (tkt-0ce4d4313ce7), so a case meaning "somebody else holds this" must not spell it `process.pid`.
 * pid 1 answers EPERM — which `pidLiveness` maps to 'alive' — or succeeds outright as root.
 */
const FOREIGN_PID = 1;
if (FOREIGN_PID === process.pid) throw new Error('FOREIGN_PID must not be this process: the cases below would invert silently');

function record(pid: number, repo = 'repo-a'): SlotRecord {
  return { version: 1, pid, repo, cwd: `/work/${repo}`, startedAt: '2026-09-22T00:00:00.000Z', tmpDir: `/tmp/${repo}` };
}

function plant(dir: string, slot: number, rec: SlotRecord | string, ageMs = 0): string {
  const file = path.join(dir, `slot-${slot}`);
  writeFileSync(file, typeof rec === 'string' ? rec : JSON.stringify(rec));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(file, t, t);
  }
  return file;
}

const alive: Liveness = 'alive';
const fixedProbe = (answer: Liveness) => () => answer;
const NOW = Date.now();
const TTL = 15 * 60_000;

function claim(dir: string, rec: SlotRecord, extra: Partial<Parameters<typeof claimSlot>[0]> = {}) {
  const log: string[] = [];
  const result = claimSlot({ stateDir: dir, slots: 1, record: { token: 'tok-claimant', ...rec }, probe: pidLiveness, now: NOW, ttlMs: TTL, log: (l) => log.push(l), ...extra });
  return { result, log };
}

function refusalOf(fn: () => unknown): TestRunRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof TestRunRefusal) return err;
    throw err;
  }
  throw new Error('expected a TestRunRefusal');
}

describe('envInt', () => {
  it('takes the default when the variable is unset, and the value when it is an integer', () => {
    expect(envInt({}, 'TEST_SLOTS', 2, 1)).toBe(2);
    expect(envInt({ TEST_SLOTS: '3' }, 'TEST_SLOTS', 2, 1)).toBe(3);
  });

  it.each(['abc', '0', '1.5', '', 'Infinity', '-1'])('refuses %j with STATE_UNREADABLE naming the variable', (raw) => {
    const err = refusalOf(() => envInt({ TEST_SLOTS: raw }, 'TEST_SLOTS', 2, 1));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(err.message).toContain('TEST_SLOTS=');
  });
});

describe('pidLiveness', () => {
  it('reports this process alive and an exited child dead', () => {
    expect(pidLiveness(process.pid)).toBe('alive');
    expect(pidLiveness(exitedPid())).toBe('dead');
  });

  it.skipIf(isRoot)('reads EPERM (another user’s live process, e.g. pid 1) as alive, never as dead', () => {
    expect(pidLiveness(1)).toBe('alive');
  });

  it.each([0, -1, 2 ** 40, 1.5, Number.NaN])('never calls a pid it cannot signal safely: %s is unknown', (pid) => {
    expect(pidLiveness(pid)).toBe('unknown');
  });
});

describe('parseSlotRecord', () => {
  it('round-trips a valid record', () => {
    const rec = record(process.pid);
    expect(parseSlotRecord(JSON.stringify(rec))).toEqual(rec);
  });

  it.each(['garbage', '[]', '', '{"version":2,"pid":1,"repo":"a","cwd":"b","startedAt":"2026-01-01T00:00:00Z","tmpDir":"c"}', '{"version":1,"pid":"x","repo":"a","cwd":"b","startedAt":"2026-01-01T00:00:00Z","tmpDir":"c"}', '{"version":1,"pid":1,"repo":"a","cwd":"b","startedAt":"not a date","tmpDir":"c"}', 'null'])(
    'rejects %j',
    (text) => {
      expect(parseSlotRecord(text)).toBeNull();
    },
  );

  it('round-trips a token', () => {
    const rec = { ...record(process.pid), token: 'tok-1' };
    expect(parseSlotRecord(JSON.stringify(rec))).toEqual(rec);
  });

  it('reads a record written before tokens as having none, rather than rejecting it', () => {
    // Several pinned versions share one state dir, so a token-less record must stay readable here.
    expect(parseSlotRecord(JSON.stringify(record(process.pid)))?.token).toBeUndefined();
  });

  // An empty or non-string token compares equal to an absent one somewhere in the ownership tests,
  // which would silently restore pid-only ownership for that record.
  it.each(['""', '123', 'null', '{}'])('rejects a record whose token is %s', (tok) => {
    const text = `{"version":1,"pid":1,"repo":"a","cwd":"b","startedAt":"2026-01-01T00:00:00Z","tmpDir":"c","token":${tok}}`;
    expect(parseSlotRecord(text)).toBeNull();
  });
});

describe('claimSlot — the slot dimension', () => {
  it('grants slot 0 when none is held, and the file is a complete record from its first instant', () => {
    const dir = stateDir();
    const { result } = claim(dir, record(process.pid));
    expect(result).toEqual({ slot: 0, file: path.join(dir, 'slot-0') });
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))).toEqual({ ...record(process.pid), token: 'tok-claimant' });
    expect(readdirSync(dir)).toEqual(['slot-0']); // the draft is gone
  });

  it('refuses (null) when the only slot is held by a live holder, and leaves that slot untouched', () => {
    const dir = stateDir();
    const held = plant(dir, 0, record(FOREIGN_PID, 'other'));
    const before = readFileSync(held, 'utf8');
    const { result } = claim(dir, record(process.pid));
    expect(result).toBeNull();
    expect(readFileSync(held, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });

  it('creates the state dir on first use', () => {
    const dir = path.join(stateDir(), 'nested', 'test-slots');
    const { result } = claim(dir, record(process.pid));
    expect(result?.slot).toBe(0);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('ignores stray entries in a reused dir: .DS_Store, a leftover draft, a stale-rename leftover', () => {
    const dir = stateDir();
    writeFileSync(path.join(dir, '.DS_Store'), 'x');
    writeFileSync(path.join(dir, 'slot.draft-999-abc'), 'x');
    writeFileSync(path.join(dir, 'slot-0.stale-999-1'), 'x');
    const { result } = claim(dir, record(process.pid));
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['.DS_Store', 'slot-0', 'slot-0.stale-999-1', 'slot.draft-999-abc']);
  });

  it('takes the next slot when slot 0 is held by another repo, and lists both holders', () => {
    const dir = stateDir();
    plant(dir, 0, record(FOREIGN_PID, 'repo-a'));
    const { result } = claim(dir, record(process.pid, 'repo-b'), { slots: 2 });
    expect(result?.slot).toBe(1);
    const views = listSlots(dir, { probe: pidLiveness, now: NOW, ttlMs: TTL });
    expect(views.map((v) => [v.slot, v.record.repo])).toEqual([
      [0, 'repo-a'],
      [1, 'repo-b'],
    ]);
  });
});

describe('claimSlot — the state-dir dimension (every one refuses with STATE_UNREADABLE)', () => {
  it.skipIf(isRoot)('read-only dir: refuses on the claim and leaves no draft behind', () => {
    const dir = stateDir();
    chmodSync(dir, 0o500);
    const err = refusalOf(() => claim(dir, record(process.pid)));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    chmodSync(dir, 0o700);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(isRoot)('unreadable dir (mode 000)', () => {
    const dir = stateDir();
    chmodSync(dir, 0o000);
    const err = refusalOf(() => claim(dir, record(process.pid)));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
  });

  it('state path is a regular file', () => {
    const file = path.join(stateDir(), 'not-a-dir');
    writeFileSync(file, 'x');
    const err = refusalOf(() => claim(file, record(process.pid)));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('a slot that is a directory', () => {
    const dir = stateDir();
    mkdirSync(path.join(dir, 'slot-0'));
    const err = refusalOf(() => claim(dir, record(process.pid)));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
  });

  it.each(['garbage', '[]', '', '{"version":2}', '{"version":1,"pid":"x"}'])('a corrupt slot file %j is refused and left in place', (text) => {
    const dir = stateDir();
    const file = plant(dir, 0, text);
    const err = refusalOf(() => claim(dir, record(process.pid)));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(err.message).toContain('slot-0');
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
});

describe('claimSlot — the holder dimension', () => {
  it('reclaims a slot whose holder has exited (ESRCH), grants it, and says so', () => {
    const dir = stateDir();
    plant(dir, 0, record(exitedPid(), 'gone'));
    const { result, log } = claim(dir, record(process.pid));
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('reclaimed') && l.includes('gone'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['slot-0']); // no .stale-* residue
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.pid).toBe(process.pid);
  });

  it.skipIf(isRoot)('does NOT reclaim a slot whose pid belongs to another user (EPERM)', () => {
    const dir = stateDir();
    const held = plant(dir, 0, record(1, 'launchd'));
    const { result, log } = claim(dir, record(process.pid));
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(parseSlotRecord(readFileSync(held, 'utf8'))?.pid).toBe(1);
  });

  it('does NOT reclaim an unknown-liveness holder inside its TTL', () => {
    const dir = stateDir();
    plant(dir, 0, record(FOREIGN_PID, 'mystery'));
    const { result } = claim(dir, record(process.pid), { probe: fixedProbe('unknown') });
    expect(result).toBeNull();
  });

  it('reclaims a live holder whose heartbeat is older than the TTL, with a WARNING', () => {
    const dir = stateDir();
    plant(dir, 0, record(FOREIGN_PID, 'wedged'), TTL + 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    // The suffix, not the repo name: the self-reclaim line also carries WARNING and the repo.
    expect(log.some((l) => l.includes('no heartbeat within the TTL'))).toBe(true);
  });

  it('keeps a live holder whose heartbeat is fresh', () => {
    const dir = stateDir();
    plant(dir, 0, record(FOREIGN_PID, 'busy'), TTL - 60_000);
    const { result } = claim(dir, record(process.pid), { probe: fixedProbe(alive) });
    expect(result).toBeNull();
  });

  it('reclaims a fresh, live slot recording OUR OWN pid — a leak from a failed release, not a peer', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'ourself'), token: 'tok-leaked' }, TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(true);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('repo-a');
  });

  it('reuses our own orphan rather than leaking a second slot beside it', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'ourself'), token: 'tok-leaked' }, TTL - 60_000);
    const { result } = claim(dir, record(process.pid), { slots: 2, probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir)).toEqual(['slot-0']); // not slot-0 AND slot-1
  });

  it('clears our own orphan from a LATER slot when it grants an earlier free one', () => {
    // The leak need not sit in the slot we contend for first: a run that held slot 1 behind a peer,
    // failed its release, then found slot 0 free would otherwise hold two slots and wedge the machine
    // for the full TTL — the very symptom this ticket removes (tkt-0ce4d4313ce7).
    const dir = stateDir();
    plant(dir, 1, { ...record(process.pid, 'orphan'), token: 'tok-leaked' }, TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid, 'me'), { slots: 2, probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir)).toEqual(['slot-0']);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(true);
  });

  it('does not sweep somebody else’s DEAD slot as ours, which would also mislabel the log line', () => {
    // The sweep's own ownership test, isolated: for a LIVE foreign holder reclaim's in-lock veto
    // refuses anyway, so only a dead one can tell the two checks apart. Left for its owner or for
    // `clear-stale`, which is where a foreign dead slot belongs.
    const dir = stateDir();
    plant(dir, 1, record(exitedPid(), 'gone'));
    const { result, log } = claim(dir, record(process.pid, 'me'), { slots: 2 });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(false);
  });

  it('leaves a LATER slot held by somebody else alone when it grants an earlier free one', () => {
    const dir = stateDir();
    plant(dir, 1, record(FOREIGN_PID, 'peer'), TTL - 60_000);
    const { result } = claim(dir, record(process.pid, 'me'), { slots: 2, probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-1'), 'utf8'))?.repo).toBe('peer');
  });

  it('defers a self-reclaim to a reclaim already in progress, exactly as for a dead holder', () => {
    const dir = stateDir();
    const held = plant(dir, 0, record(process.pid, 'ourself'), TTL - 60_000);
    mkdirSync(`${held}.reclaim`);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive) });
    expect(result).toBeNull();
    expect(log).toEqual([]);
  });

  it('defers to a reclaim already in progress: a fresh reclaim lock leaves the dead holder for its owner', () => {
    const dir = stateDir();
    const held = plant(dir, 0, record(exitedPid(), 'gone'));
    mkdirSync(`${held}.reclaim`);
    const { result, log } = claim(dir, record(process.pid));
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-0.reclaim']);
  });

  it('breaks a reclaim lock left by a process that died mid-reclaim, then reclaims, leaving no residue', () => {
    const dir = stateDir();
    const held = plant(dir, 0, record(exitedPid(), 'gone'));
    mkdirSync(`${held}.reclaim`);
    const t = new Date(NOW - RECLAIM_LOCK_STALE_MS - 1000);
    utimesSync(`${held}.reclaim`, t, t);
    const { result } = claim(dir, record(process.pid));
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir)).toEqual(['slot-0']); // no .reclaim, no .broken-*, no .stale-*
  });

  it('lists a never-created state dir as empty without creating it', () => {
    const dir = path.join(stateDir(), 'never');
    expect(listSlots(dir, { probe: pidLiveness, now: NOW, ttlMs: TTL })).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('re-judges under the lock: a holder that came alive since the first read is NOT reclaimed', () => {
    // The probe answers "dead" for the read that justifies the reclaim and "alive" for the re-read
    // inside the lock — the shape of the race the lock exists for.
    const dir = stateDir();
    plant(dir, 0, record(FOREIGN_PID, 'revived'));
    const answers: Liveness[] = ['dead', 'alive', 'alive', 'alive'];
    const { result, log } = claim(dir, record(process.pid), { probe: () => answers.shift() ?? 'alive' });
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('revived');
  });

  // The self-reclaim's veto (tkt-a99209bedbb9). Each case below pairs with the one after it: the only
  // difference is whether the planted token is one we still hold, so a broken veto cannot read green.
  it('does NOT reclaim our own pid when the token is one we still hold — a live sibling, not a leak', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'sibling'), token: 'tok-live' }, TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive), heldTokens: new Set(['tok-live']) });
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('sibling');
  });

  it('DOES reclaim our own pid when the token is one we no longer hold', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'orphan'), token: 'tok-gone' }, TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive), heldTokens: new Set(['tok-live']) });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(true);
  });

  it('takes the next free slot rather than a live sibling’s, so the pool is never over-granted', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'sibling'), token: 'tok-live' }, TTL - 60_000);
    const { result } = claim(dir, record(process.pid, 'me'), { slots: 2, probe: fixedProbe(alive), heldTokens: new Set(['tok-live']) });
    expect(result?.slot).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('sibling');
  });

  it('does not sweep a live sibling’s LATER slot when it grants an earlier free one', () => {
    // clearOwnOrphans runs after the grant, so the veto has to hold on that path too.
    const dir = stateDir();
    plant(dir, 1, { ...record(process.pid, 'sibling'), token: 'tok-live' }, TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid, 'me'), { slots: 2, probe: fixedProbe(alive), heldTokens: new Set(['tok-live']) });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(false);
  });

  it('still reclaims a live sibling’s slot once its heartbeat is past the TTL', () => {
    // The TTL is the backstop for a hold whose process is wedged; the veto must not outrank it.
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'wedged-sibling'), token: 'tok-live' }, TTL + 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive), heldTokens: new Set(['tok-live']) });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('no heartbeat within the TTL'))).toBe(true);
  });

  // Token-less own-pid records (tkt-a51a84902cc9): each "during this process" case pairs with a "before" one.
  const processStart = Math.floor(performance.timeOrigin);
  const tokenless = (repo: string, startedAtMs: number): SlotRecord => ({ ...record(process.pid, repo), startedAt: new Date(startedAtMs).toISOString() });

  it('does NOT reclaim a token-less record our pid wrote during this process — another copy’s live hold', () => {
    const dir = stateDir();
    plant(dir, 0, tokenless('older-copy', Date.now()), TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('older-copy');
  });

  it('DOES reclaim a token-less record our pid wrote before this process started — a recycled pid’s leak', () => {
    const dir = stateDir();
    plant(dir, 0, tokenless('previous-incarnation', processStart - 60_000), TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(true);
  });

  it('takes the next free slot rather than deleting another copy’s token-less hold', () => {
    const dir = stateDir();
    plant(dir, 0, tokenless('older-copy', Date.now()), TTL - 60_000);
    const { result } = claim(dir, record(process.pid, 'me'), { slots: 2, probe: fixedProbe(alive) });
    expect(result?.slot).toBe(1);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('older-copy');
  });

  it('does not sweep another copy’s token-less hold from a LATER slot when it grants an earlier free one', () => {
    const dir = stateDir();
    plant(dir, 1, tokenless('older-copy', Date.now()), TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid, 'me'), { slots: 2, probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(false);
  });

  it('does sweep a recycled pid’s token-less leak from a LATER slot', () => {
    const dir = stateDir();
    plant(dir, 1, tokenless('previous-incarnation', processStart - 60_000), TTL - 60_000);
    const { result } = claim(dir, record(process.pid, 'me'), { slots: 2, probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });

  it('treats startedAt exactly at process start as this process’s — the boundary fails closed', () => {
    const dir = stateDir();
    plant(dir, 0, tokenless('boundary', processStart), TTL - 60_000);
    expect(claim(dir, record(process.pid), { probe: fixedProbe(alive) }).result).toBeNull();
  });

  it('treats startedAt one millisecond before process start as a previous incarnation', () => {
    const dir = stateDir();
    plant(dir, 0, tokenless('boundary', processStart - 1), TTL - 60_000);
    expect(claim(dir, record(process.pid), { probe: fixedProbe(alive) }).result?.slot).toBe(0);
  });

  it('still reclaims another copy’s token-less hold once its heartbeat is past the TTL', () => {
    const dir = stateDir();
    plant(dir, 0, tokenless('wedged-older-copy', Date.now()), TTL + 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('no heartbeat within the TTL'))).toBe(true);
  });

  // The foreign-nonce veto (tkt-f5dae96f0298). A token carries the ownership domain it was minted
  // in, so a stranger wearing our pid — one pid namespace's 42 meeting another's across a shared
  // TEST_SLOTS_DIR — mints its own: "absent from heldTokens" then says nothing about us. Each case
  // pairs with the one after it, the only difference being the planted token's nonce domain.
  const OUR_NONCE = '11111111-1111-4111-8111-111111111111';
  const THEIR_NONCE = '22222222-2222-4222-8222-222222222222';
  const ourToken = (hold: string): string => `${OUR_NONCE}.${hold}`;
  const theirToken = (hold: string): string => `${THEIR_NONCE}.${hold}`;
  const mine = (repo = 'me'): SlotRecord => ({ ...record(process.pid, repo), token: ourToken('claimant') });

  it('does NOT reclaim our own pid when the token was minted in another process’s nonce domain', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'stranger'), token: theirToken('hold') }, TTL - 60_000);
    const { result, log } = claim(dir, mine(), { probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('stranger');
  });

  it('DOES reclaim our own pid for a token from OUR nonce domain that we no longer hold', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'our-leak'), token: ourToken('gone') }, TTL - 60_000);
    const { result, log } = claim(dir, mine(), { probe: fixedProbe(alive), heldTokens: new Set([ourToken('live')]) });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(true);
  });

  it('does NOT reclaim a token from OUR domain that we still hold — a live sibling, not a leak', () => {
    // The heldTokens arm with a nonce-CARRYING claimant. Without this every veto case in this file
    // runs the legacy self.nonce === undefined branch, and breaking the arm for real holds stays
    // green here — measured: 97/97 green, caught only by hold.test.ts.
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'sibling'), token: ourToken('live') }, TTL - 60_000);
    const { result, log } = claim(dir, mine(), { probe: fixedProbe(alive), heldTokens: new Set([ourToken('live')]) });
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('sibling');
  });

  it('parses a MINTED token into the same domain as the literal shape — the writer/reader round trip', () => {
    // Planted from mintToken, claimed with the literal `${OUR_NONCE}.claimant`: that pairing is what
    // binds the two halves. Minting both sides instead left this green under a changed NONCE_SEP,
    // because both then parsed to undefined and undefined === undefined passes the domain check.
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'our-leak'), token: mintToken(OUR_NONCE, 'h1') }, TTL - 60_000);
    const { result } = claim(dir, mine(), { probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result?.slot).toBe(0);
  });

  it('takes the next free slot rather than a stranger’s, so the pool is never over-granted', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'stranger'), token: theirToken('hold') }, TTL - 60_000);
    const { result } = claim(dir, mine(), { slots: 2, probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result?.slot).toBe(1);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('stranger');
  });

  it('does not sweep a stranger’s LATER slot when it grants an earlier free one', () => {
    // clearOwnOrphans runs after the grant, so the veto has to hold on that path too.
    const dir = stateDir();
    plant(dir, 1, { ...record(process.pid, 'stranger'), token: theirToken('hold') }, TTL - 60_000);
    const { result, log } = claim(dir, mine(), { slots: 2, probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(false);
  });

  // The veto removes only the SELF-ORPHAN reason to reclaim. Both backstops below must survive it,
  // or a stranger's abandoned slot wedges the pool instead of costing at most one TTL.
  it('still reclaims a stranger’s slot when its holder is gone, whatever the nonce says', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'stranger'), token: theirToken('hold') }, TTL - 60_000);
    const { result, log } = claim(dir, mine(), { probe: fixedProbe('dead'), heldTokens: new Set() });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('gone'))).toBe(true);
  });

  it('still reclaims a stranger’s slot once its heartbeat is past the TTL', () => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'stranger'), token: theirToken('hold') }, TTL + 60_000);
    const { result, log } = claim(dir, mine(), { probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('no heartbeat within the TTL'))).toBe(true);
  });

  // A nonce we cannot read is not a nonce we may assume is ours. v0.29.2–v0.30.0 wrote a bare UUID,
  // and a hand-edited file can carry any shape; each resolves to "not ours" and waits out the TTL,
  // the same fail-closed trade tkt-a51a84902cc9 took for token-less records.
  it.each(['tok-no-separator', '.empty-nonce', `${OUR_NONCE}.`])('does NOT reclaim our pid for the unreadable-nonce token %j', (token) => {
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'other-copy'), token }, TTL - 60_000);
    const { result, log } = claim(dir, mine(), { probe: fixedProbe(alive), heldTokens: new Set() });
    expect(result).toBeNull();
    expect(log).toEqual([]);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('other-copy');
  });

  it('reclaims on heldTokens alone when NEITHER token carries a nonce — the residual for pre-nonce claimants', () => {
    // Deliberately fail-OPEN, and pinned so it cannot be tightened into an availability regression:
    // a claimant with no nonce of its own has nothing to compare, and refusing would strand its real
    // leak for a full TTL. Two pre-nonce copies sharing a pid number remain undistinguished.
    const dir = stateDir();
    plant(dir, 0, { ...record(process.pid, 'legacy-leak'), token: 'tok-gone' }, TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive), heldTokens: new Set(['tok-live']) });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(true);
  });

  it('refuses a corrupt record rather than treating it as our own orphan', () => {
    const dir = stateDir();
    plant(dir, 0, '{not json');
    expect(refusalOf(() => claim(dir, record(process.pid))).code).toBe(EXIT.STATE_UNREADABLE);
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });
});

describe('releaseSlot', () => {
  it('unlinks a slot that still records our pid', () => {
    const dir = stateDir();
    const file = plant(dir, 0, record(process.pid));
    expect(releaseSlot(file, process.pid)).toBe('released');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a slot that was already removed', () => {
    expect(releaseSlot(path.join(stateDir(), 'slot-0'), process.pid)).toBe('missing');
  });

  it('reports, and does not delete, a slot reissued to another pid', () => {
    const dir = stateDir();
    const file = plant(dir, 0, record(1));
    expect(releaseSlot(file, process.pid)).toBe('foreign');
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });

  // tkt-a99209bedbb9: the pair pid alone could not tell apart. Both records carry OUR pid.
  it('reports, and does not delete, a slot reissued to another hold in the same process', () => {
    const dir = stateDir();
    const file = plant(dir, 0, { ...record(process.pid, 'the-new-holder'), token: 'tok-2' });
    expect(releaseSlot(file, process.pid, 'tok-1')).toBe('foreign');
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });

  it('unlinks the slot when the token matches', () => {
    const dir = stateDir();
    const file = plant(dir, 0, { ...record(process.pid), token: 'tok-1' });
    expect(releaseSlot(file, process.pid, 'tok-1')).toBe('released');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('releases a pre-token record on a pid match, so an older pinned version’s slot is not stranded', () => {
    const dir = stateDir();
    const file = plant(dir, 0, record(process.pid));
    expect(releaseSlot(file, process.pid, undefined)).toBe('released');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a pre-token record when WE hold a token: ours was replaced by an older writer', () => {
    const dir = stateDir();
    const file = plant(dir, 0, record(process.pid));
    expect(releaseSlot(file, process.pid, 'tok-1')).toBe('foreign');
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });
});

describe('listSlots and clearStaleSlots', () => {
  it('lists held slots in order with liveness, age and expiry, ignoring strays', () => {
    const dir = stateDir();
    writeFileSync(path.join(dir, 'README'), 'x');
    plant(dir, 1, record(process.pid, 'b'));
    plant(dir, 0, record(process.pid, 'a'), TTL + 1000);
    const views = listSlots(dir, { probe: pidLiveness, now: Date.now(), ttlMs: TTL });
    expect(views.map((v) => [v.slot, v.record.repo, v.liveness, v.expired])).toEqual([
      [0, 'a', 'alive', true],
      [1, 'b', 'alive', false],
    ]);
  });

  it('clears dead and expired slots and keeps live ones', () => {
    const dir = stateDir();
    plant(dir, 0, record(exitedPid(), 'dead'));
    plant(dir, 1, record(process.pid, 'live'));
    plant(dir, 2, record(process.pid, 'expired'), TTL + 1000);
    const removed = clearStaleSlots(dir, { probe: pidLiveness, now: Date.now(), ttlMs: TTL });
    expect(removed.map((v) => v.record?.repo).sort()).toEqual(['dead', 'expired']);
    expect(readdirSync(dir)).toEqual(['slot-1']);
  });

  // tkt-c3df050395d8: the refusal named clear-stale as the recovery, and clear-stale refused too.
  it('clears an unparseable record once its mtime is past the TTL, reporting it with no record', () => {
    const dir = stateDir();
    plant(dir, 0, 'garbage', TTL + 1000);
    plant(dir, 1, record(process.pid, 'live'));
    const removed = clearStaleSlots(dir, { probe: pidLiveness, now: Date.now(), ttlMs: TTL });
    expect(removed.map((v) => [v.slot, v.record])).toEqual([[0, null]]);
    expect(readdirSync(dir)).toEqual(['slot-1']);
  });

  it('a fresh unparseable record still refuses the sweep, before anything is removed', () => {
    const dir = stateDir();
    plant(dir, 0, record(exitedPid(), 'dead'));
    plant(dir, 1, '{"version":2,"pid":1}');
    const err = refusalOf(() => clearStaleSlots(dir, { probe: pidLiveness, now: Date.now(), ttlMs: TTL }));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(err.message).toMatch(/not a valid slot record/);
    expect(err.message).not.toMatch(/run `ticket-workflow test-slots clear-stale` once/);
    expect(readdirSync(dir).sort()).toEqual(['slot-0', 'slot-1']);
  });

  it('keeps an unparseable record whose mtime was refreshed between the scan and the lock', () => {
    const dir = stateDir();
    plant(dir, 0, record(exitedPid(), 'dead'));
    const corrupt = plant(dir, 1, 'garbage', TTL + 1000);
    let probes = 0;
    // Probe call 1 is slot 0's scan; call 2 is its in-lock re-read, which runs before slot 1's reclaim.
    const probe = (pid: number): Liveness => {
      probes += 1;
      if (probes === 2) utimesSync(corrupt, new Date(), new Date());
      return pidLiveness(pid);
    };
    const removed = clearStaleSlots(dir, { probe, now: Date.now(), ttlMs: TTL });
    expect(removed.map((v) => v.record?.repo)).toEqual(['dead']);
    expect(readdirSync(dir)).toEqual(['slot-1']);
  });

  it('judges a record that turned unparseable under the lock by its mtime, never aborting the sweep', () => {
    const dir = stateDir();
    plant(dir, 0, record(exitedPid(), 'dead-a'));
    const flipped = plant(dir, 1, record(exitedPid(), 'dead-b'));
    let probes = 0;
    // Calls 1-2 are the scan of slots 0 and 1; call 3 is slot 0's in-lock re-read, before slot 1's reclaim.
    const probe = (pid: number): Liveness => {
      probes += 1;
      if (probes === 3) writeFileSync(flipped, 'garbage');
      return pidLiveness(pid);
    };
    const removed = clearStaleSlots(dir, { probe, now: Date.now(), ttlMs: TTL });
    expect(removed.map((v) => v.record?.repo)).toEqual(['dead-a']);
    expect(readFileSync(flipped, 'utf8')).toBe('garbage');
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO slot without blocking on it', () => {
    const dir = stateDir();
    const r = spawnSync('mkfifo', [path.join(dir, 'slot-0')]);
    if (r.status !== 0) throw new Error('mkfifo failed');
    const err = refusalOf(() => clearStaleSlots(dir, { probe: pidLiveness, now: Date.now(), ttlMs: TTL }));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(err.message).toMatch(/not a regular file/);
  });

  it('status (listSlots) still refuses an unparseable record, expired or not', () => {
    const dir = stateDir();
    plant(dir, 0, 'garbage', TTL + 1000);
    const err = refusalOf(() => listSlots(dir, { probe: pidLiveness, now: Date.now(), ttlMs: TTL }));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
    expect(readdirSync(dir)).toEqual(['slot-0']);
  });

  it('refuses an unreadable state path rather than reporting it empty', () => {
    const file = path.join(stateDir(), 'file');
    writeFileSync(file, 'x');
    const err = refusalOf(() => listSlots(file, { probe: pidLiveness, now: NOW, ttlMs: TTL }));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
  });
});

describe('mintToken', () => {
  // '' is the empty branch; 'has.separator' parses back as a SHORTER domain and '.' as an empty one —
  // two different consequences of the same clause. A third dotted case would add no branch.
  it.each(['', 'has.separator', '.'])('refuses the ambiguous ownership domain %j', (nonce) => {
    expect(refusalOf(() => mintToken(nonce, 'hold')).code).toBe(EXIT.STATE_UNREADABLE);
  });

  it('refuses an empty hold, which would parse back as no domain at all', () => {
    expect(refusalOf(() => mintToken('domain', '')).code).toBe(EXIT.STATE_UNREADABLE);
  });

  it('mints the literal shape, and allows a separator inside the hold half', () => {
    expect(mintToken('domain', 'hold')).toBe('domain.hold');
    expect(mintToken('domain', 'a.b')).toBe('domain.a.b');
  });
});
