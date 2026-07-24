import { beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Redirects the service's file I/O (tickets + telemetry) to isolated temp dirs
// for the lifetime of a suite, cleaning both between tests. Call it once at the
// top of a test file and read the returned paths where fixtures are written.
//
// tickets and events get SEPARATE dirs on purpose: sharing one dir leaks .jsonl
// telemetry past a .md-only cleanup, accumulating events across tests and
// creating latent order-dependence. Centralizing that invariant here is the
// point — a new suite can't re-introduce the drift by hand.
//
// Returns a stable object whose `tickets`/`events` fields are populated in the
// beforeAll hook, so reads inside tests (which run after beforeAll) see the real
// paths. Do not destructure the fields at call time — they are empty until then.
export function setupTempTicketDirs(prefix: string): { tickets: string; events: string } {
  const dirs = { tickets: '', events: '' };

  beforeAll(async () => {
    dirs.tickets = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    dirs.events = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-events-`));
    process.env.TICKETS_DIR_OVERRIDE = dirs.tickets;
    process.env.EVENTS_DIR_OVERRIDE = dirs.events;
  });

  afterAll(async () => {
    delete process.env.TICKETS_DIR_OVERRIDE;
    delete process.env.EVENTS_DIR_OVERRIDE;
    await fs.rm(dirs.tickets, { recursive: true, force: true });
    await fs.rm(dirs.events, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const dir of [dirs.tickets, dirs.events]) {
      const entries = await fs.readdir(dir);
      // recursive rm, not unlink: the tickets dir now holds a `.history/` subdir
      // (backup-on-write snapshots, tkt-18d53c0c7cd8) — unlink throws on a directory
      // and would leave prior-test state behind. rm handles files and subdirs alike.
      await Promise.all(entries.map((e) => fs.rm(path.join(dir, e), { recursive: true, force: true })));
    }
  });

  return dirs;
}
