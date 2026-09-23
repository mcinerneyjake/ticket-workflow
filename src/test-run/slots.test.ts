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
  const result = claimSlot({ stateDir: dir, slots: 1, record: rec, probe: pidLiveness, now: NOW, ttlMs: TTL, log: (l) => log.push(l), ...extra });
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
});

describe('claimSlot — the slot dimension', () => {
  it('grants slot 0 when none is held, and the file is a complete record from its first instant', () => {
    const dir = stateDir();
    const { result } = claim(dir, record(process.pid));
    expect(result).toEqual({ slot: 0, file: path.join(dir, 'slot-0') });
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))).toEqual(record(process.pid));
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
    plant(dir, 0, record(process.pid, 'ourself'), TTL - 60_000);
    const { result, log } = claim(dir, record(process.pid), { probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(log.some((l) => l.includes('own orphaned slot'))).toBe(true);
    expect(parseSlotRecord(readFileSync(path.join(dir, 'slot-0'), 'utf8'))?.repo).toBe('repo-a');
  });

  it('reuses our own orphan rather than leaking a second slot beside it', () => {
    const dir = stateDir();
    plant(dir, 0, record(process.pid, 'ourself'), TTL - 60_000);
    const { result } = claim(dir, record(process.pid), { slots: 2, probe: fixedProbe(alive) });
    expect(result?.slot).toBe(0);
    expect(readdirSync(dir)).toEqual(['slot-0']); // not slot-0 AND slot-1
  });

  it('clears our own orphan from a LATER slot when it grants an earlier free one', () => {
    // The leak need not sit in the slot we contend for first: a run that held slot 1 behind a peer,
    // failed its release, then found slot 0 free would otherwise hold two slots and wedge the machine
    // for the full TTL — the very symptom this ticket removes (tkt-0ce4d4313ce7).
    const dir = stateDir();
    plant(dir, 1, record(process.pid, 'orphan'), TTL - 60_000);
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
    expect(removed.map((v) => v.record.repo).sort()).toEqual(['dead', 'expired']);
    expect(readdirSync(dir)).toEqual(['slot-1']);
  });

  it('refuses an unreadable state path rather than reporting it empty', () => {
    const file = path.join(stateDir(), 'file');
    writeFileSync(file, 'x');
    const err = refusalOf(() => listSlots(file, { probe: pidLiveness, now: NOW, ttlMs: TTL }));
    expect(err.code).toBe(EXIT.STATE_UNREADABLE);
  });
});
