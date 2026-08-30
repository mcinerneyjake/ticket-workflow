import { describe, it, expect } from 'vitest';
import {
  checkWriterUniqueness,
  checkHookWiring,
  checkPin,
  checkMcp,
  checkBoard,
  checkProtectedBranch,
  checkReporterLiveness,
  checkToolchain,
  runChecks,
  exitCodeFor,
  formatResults,
  HOOK_ONLY_STEPS,
  SERVICE_WRITTEN_STEPS,
  AMBIGUOUS_STEPS,
  type DoctorFacts,
} from './checks.js';
import { STEP_IDS } from '../shared/constants.js';

// Facts are total, so every case states the whole world and a missing field cannot silently default
// to the healthy answer.
const HEALTHY: DoctorFacts = {
  postToolUse: [{ command: 'track-steps-central.sh', kind: 'writer' }],
  guardCopies: [
    { source: 'user scope', hook: 'guard-bash', path: '/h/run-hook.mjs', sha: 'launcher', isLauncher: true },
  ],
  canonicalShas: { 'guard-bash': 'aaa', 'guard-ticket': 'bbb' },
  installs: [{ root: '/tools', version: '0.13.0' }],
  selfVersion: '0.13.0',
  mcp: { probed: true, configured: true, resolved: true, timedOut: false, version: '0.13.0' },
  board: {
    root: '/board',
    via: 'BOARD_DIR_OVERRIDE',
    ticketsDir: '/board/tickets',
    ticketsDirExists: true,
    targets: [
      { source: 'writer (user scope)', root: '/board' },
      { source: 'mcp server', root: '/board' },
    ],
  },
  protectedBranch: { current: 'feat/x', protects: ['main'], existing: ['main'], hasRemote: true },
  lastHookEventAt: '2026-08-16T00:00:00.000Z',
  now: '2026-08-16T04:00:00.000Z',
  gateScripts: { kanban: ['typecheck', 'lint', 'test'] },
};
const facts = (over: Partial<DoctorFacts> = {}): DoctorFacts => ({ ...HEALTHY, ...over });

describe('step attribution', () => {
  it('excludes review from the hook-only set — record_review writes it too', () => {
    // The Done-when line said review is service-written. It is BOTH: track-steps derives it from a
    // passing commit AND handlers.ts record_review appends it. Ambiguous, so it cannot witness the
    // hook being alive — which is the same conclusion for a better reason.
    expect(AMBIGUOUS_STEPS).toContain('review');
    expect(HOOK_ONLY_STEPS).not.toContain('review');
  });

  it('derives the service-written steps from the status mapping rather than a literal', () => {
    expect([...SERVICE_WRITTEN_STEPS].sort()).toEqual(['done', 'qa', 'started']);
  });

  it('partitions every step exactly once, so a new step id cannot fall through unclassified', () => {
    const all = [...HOOK_ONLY_STEPS, ...SERVICE_WRITTEN_STEPS, ...AMBIGUOUS_STEPS];
    expect([...all].sort()).toEqual([...STEP_IDS].sort());
  });
});

describe('writer-uniqueness', () => {
  it('is OK with exactly one writer', () => {
    expect(checkWriterUniqueness(HEALTHY).status).toBe('ok');
  });

  it('MISMATCHes on two writers — the 1,889-duplicate-row defect', () => {
    const r = checkWriterUniqueness(
      facts({
        postToolUse: [
          { command: 'a', kind: 'writer' },
          { command: 'b', kind: 'writer' },
        ],
      }),
    );
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('2 PostToolUse writers');
  });

  it('MISMATCHes on zero writers — milestones recorded nowhere', () => {
    expect(checkWriterUniqueness(facts({ postToolUse: [] })).status).toBe('mismatch');
  });

  it('is UNKNOWN, not OK, when a PostToolUse hook cannot be classified', () => {
    // The renamed-writer trap: a matcher that stops recognising the writer would otherwise keep
    // reporting a confident count of 1.
    const r = checkWriterUniqueness(
      facts({
        postToolUse: [
          { command: 'track-steps-central.sh', kind: 'writer' },
          { command: 'node /some/other-hook.mjs', kind: 'unknown' },
        ],
      }),
    );
    expect(r.status).toBe('unknown');
    expect(r.detail).toContain('other-hook.mjs');
  });

  it('is UNKNOWN when no settings file could be read', () => {
    // The CI case. Reporting OK here is the whole failure mode this type exists to prevent.
    expect(checkWriterUniqueness(facts({ postToolUse: null })).status).toBe('unknown');
  });
});

describe('hook-wiring', () => {
  it('MISMATCHes on a vendored copy that differs from the shipped hook', () => {
    const r = checkHookWiring(
      facts({
        guardCopies: [
          { source: 'project scope', hook: 'guard-bash', path: '/jt/guard-bash.mjs', sha: 'old', isLauncher: false },
        ],
      }),
    );
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('/jt/guard-bash.mjs');
  });

  it('does NOT flag a launcher whose bytes differ — it delegates, so difference is expected', () => {
    expect(checkHookWiring(HEALTHY).status).toBe('ok');
  });

  it('is OK for a vendored copy that still matches byte-for-byte', () => {
    expect(
      checkHookWiring(
        facts({
          guardCopies: [{ source: 'project scope', hook: 'guard-bash', path: '/p/g.mjs', sha: 'aaa', isLauncher: false }],
        }),
      ).status,
    ).toBe('ok');
  });

  it('ignores a wired hook that is not one of ours', () => {
    // A PreCompact hook belonging to something else must not be reported as a drifted guard.
    expect(
      checkHookWiring(
        facts({ guardCopies: [{ source: 'user scope', hook: null, path: '/x/other.mjs', sha: null, isLauncher: false }] }),
      ).status,
    ).toBe('ok');
  });

  it('is UNKNOWN when a wired hook of ours cannot be read', () => {
    expect(
      checkHookWiring(
        facts({ guardCopies: [{ source: 'user scope', hook: 'guard-bash', path: '/x/g.mjs', sha: null, isLauncher: false }] }),
      ).status,
    ).toBe('unknown');
  });

  it('is UNKNOWN when the shipped hooks cannot be read', () => {
    const r = checkHookWiring(facts({ canonicalShas: null }));
    expect(r.status).toBe('unknown');
    expect(r.detail).toContain("package's own hooks");
  });

  it('names the settings file, not the shipped hooks, when there is no wiring to read', () => {
    // Two different causes with two different fixes; one shared sentence sends the reader to the
    // wrong one. A diagnostic that cannot say which of two things it failed at is half a diagnostic.
    const r = checkHookWiring(facts({ guardCopies: null }));
    expect(r.status).toBe('unknown');
    expect(r.detail).toContain('settings file');
  });

  it('is UNKNOWN, not OK, when a vendored copy names a hook this package does not ship', () => {
    // Version skew downward: an older consumer vendoring a hook we since removed is unjudgeable.
    const r = checkHookWiring(
      facts({
        guardCopies: [{ source: 'project scope', hook: 'track-steps', path: '/p/t.mjs', sha: 'x', isLauncher: false }],
        canonicalShas: { 'guard-bash': 'aaa' },
      }),
    );
    expect(r.status).toBe('unknown');
    expect(r.detail).toContain('track-steps');
  });

  it('treats zero wired copies as a real OK answer, not unknown', () => {
    expect(checkHookWiring(facts({ guardCopies: [] })).status).toBe('ok');
  });
});

describe('pin', () => {
  it('does not compare doctor\'s own version against the wired install', () => {
    // `npx` fetches latest and a source checkout runs ahead of the install, so counting self would
    // MISMATCH on every development run and on the README's headline invocation.
    const r = checkPin(facts({ installs: [{ root: '/tools', version: '0.12.0' }], selfVersion: '0.13.0' }));
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('0.13.0'); // still reported, just not judged
  });

  it('is UNKNOWN when no install can be located', () => {
    expect(checkPin(facts({ installs: [] })).status).toBe('unknown');
    expect(checkPin(facts({ installs: null })).status).toBe('unknown');
  });

  it('is UNKNOWN when an install is present but its version is unreadable', () => {
    expect(checkPin(facts({ installs: [{ root: '/tools', version: null }] })).status).toBe('unknown');
  });

  it('MISMATCHes when two versions are live at once', () => {
    const r = checkPin(
      facts({
        installs: [
          { root: '/tools', version: '0.13.0' },
          { root: '/repo', version: '0.11.0' },
        ],
      }),
    );
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('0.11.0');
  });
});

describe('mcp / board', () => {
  it('MISMATCHes when the configured MCP binary does not answer', () => {
    expect(checkMcp(facts({ mcp: { probed: true, configured: true, resolved: false, timedOut: false, version: null } })).status).toBe('mismatch');
  });

  it('is UNKNOWN when no MCP server is configured, and when the config is unreadable', () => {
    expect(checkMcp(facts({ mcp: { probed: true, configured: false, resolved: false, timedOut: false, version: null } })).status).toBe('unknown');
    expect(checkMcp(facts({ mcp: null })).status).toBe('unknown');
  });

  it('keeps a timed-out probe at MISMATCH, so it cannot exit 0 outside --strict', () => {
    // The tempting reading is UNKNOWN ("I could not tell"). It is wrong where it costs most: an MCP
    // server is long-lived, so one that boots and never answers times out rather than dying — the
    // ORDINARY broken shape. UNKNOWN is exit 0 without --strict, so that reading would let the
    // commonest breakage exit clean. The exit-code assertion is the point of this test, not the
    // status (tkt-38391beace3e).
    const f = facts({ mcp: { probed: true, configured: true, resolved: false, timedOut: true, version: null } });
    const r = checkMcp(f);
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('did not answer initialize within');
    expect(exitCodeFor([r], false)).toBe(2);
  });

  it('says "not probed" rather than "could not be read" under --no-mcp', () => {
    const r = checkMcp(facts({ mcp: { probed: false, configured: false, resolved: false, timedOut: false, version: null } }));
    expect(r.status).toBe('unknown');
    expect(r.detail).toContain('not probed');
  });

  it('names the directory it actually stat\'d, which an override can move off the board root', () => {
    const r = checkBoard(
      facts({ board: { root: '/board', via: 'cwd', ticketsDir: '/elsewhere/t', ticketsDirExists: false, targets: [{ source: 'w', root: '/board' }] } }),
    );
    expect(r.detail).toContain('/elsewhere/t');
  });

  it('names which env var resolved the board', () => {
    expect(checkBoard(HEALTHY).detail).toContain('BOARD_DIR_OVERRIDE');
    expect(checkBoard(facts({ board: null })).status).toBe('unknown');
  });

  it('MISMATCHes when the WIRING names a root that holds no tickets dir — the mis-launch shape', () => {
    const r = checkBoard(
      facts({
        board: {
          root: '/wrong',
          via: 'writer wiring',
          ticketsDir: '/wrong/tickets',
          ticketsDirExists: false,
          targets: [{ source: 'writer', root: '/wrong' }],
        },
      }),
    );
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('empty board');
  });

  it('is UNKNOWN, not MISMATCH, when nothing configured a board and cwd is not one', () => {
    // A bare machine (CI, a fresh clone) has no board; reporting that as a defect fails the gate for
    // an absence. The mirror of reporting UNKNOWN as OK, and just as wrong.
    const r = checkBoard(
      facts({ board: { root: '/tmp/x', via: 'cwd', ticketsDir: '/tmp/x/tickets', ticketsDirExists: false, targets: [] } }),
    );
    expect(r.status).toBe('unknown');
    expect(r.detail).toContain('no board is configured');
  });

  it('still MISMATCHes when an explicit env var points at a non-board', () => {
    const r = checkBoard(
      facts({
        board: { root: '/typo', via: 'BOARD_DIR_OVERRIDE', ticketsDir: '/typo/tickets', ticketsDirExists: false, targets: [] },
      }),
    );
    expect(r.status).toBe('mismatch');
  });

  it('MISMATCHes when the writer and the MCP server point at different boards', () => {
    // Both halves work; each ticket's pipeline is silently split in two. A single-root reading of
    // the board — the shape this check replaced — reports OK on exactly this machine.
    const r = checkBoard(
      facts({
        board: {
          root: '/a',
          via: 'writer wiring',
          ticketsDir: '/a/tickets',
          ticketsDirExists: true,
          targets: [
            { source: 'writer (user scope)', root: '/a' },
            { source: 'mcp server', root: '/b' },
          ],
        },
      }),
    );
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('/b');
  });
});

describe('protected-branch', () => {
  it('is OK when the protected branch exists here', () => {
    expect(checkProtectedBranch(HEALTHY).status).toBe('ok');
  });

  it('MISMATCHes with NO remote, because guard-bash returns before its branch rules', () => {
    // The worst possible answer here is "OK, protects main" in a repo where `git commit` on main is
    // allowed: a report of a guard that does not fire, produced by the tool built to catch exactly
    // that. guard-bash gates the commit rule on hasRemote (tkt-f32915b3e858), so this must too.
    const r = checkProtectedBranch(
      facts({ protectedBranch: { current: 'main', protects: ['main'], existing: ['main'], hasRemote: false } }),
    );
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('ALLOWED');
  });

  it('reports the no-remote case ahead of the ambiguity case, matching the guard\'s own order', () => {
    // Both hold at once in a remote-less repo with two candidate defaults. The guard returns on the
    // remote check first, so "every commit is blocked" would be exactly backwards.
    const r = checkProtectedBranch(
      facts({ protectedBranch: { current: 'x', protects: null, existing: [], hasRemote: false } }),
    );
    expect(r.detail).toContain('ALLOWED');
    expect(r.detail).not.toContain('blocked until origin/HEAD');
  });

  it('MISMATCHes when the guard protects branches this repo does not have', () => {
    // `git init -b trunk`: the resolver falls back to {main, master}, so the guard reads as armed
    // and protects nothing. That silence is the whole reason this check exists.
    const r = checkProtectedBranch(facts({ protectedBranch: { current: 'trunk', protects: ['main', 'master'], existing: [], hasRemote: true } }));
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('unguarded');
  });

  it('MISMATCHes when the resolver refuses, because every commit here is blocked', () => {
    const r = checkProtectedBranch(facts({ protectedBranch: { current: 'x', protects: null, existing: [], hasRemote: true } }));
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('refuses');
  });

  it('is UNKNOWN outside a git repository', () => {
    expect(checkProtectedBranch(facts({ protectedBranch: null })).status).toBe('unknown');
  });
});

describe('reporter-liveness', () => {
  it('is OK inside the window', () => {
    expect(checkReporterLiveness(HEALTHY).status).toBe('ok');
  });

  it('MISMATCHes once the writer has been silent past the window', () => {
    const r = checkReporterLiveness(facts({ lastHookEventAt: '2026-08-01T00:00:00.000Z' }));
    expect(r.status).toBe('mismatch');
    expect(r.detail).toContain('stopped recording');
  });

  it('is UNKNOWN with no events — a new board looks identical to a dead writer', () => {
    expect(checkReporterLiveness(facts({ lastHookEventAt: null })).status).toBe('unknown');
  });

  it('is UNKNOWN rather than OK on an unparseable timestamp', () => {
    expect(checkReporterLiveness(facts({ lastHookEventAt: 'not-a-date' })).status).toBe('unknown');
  });

  it('does not fire on a local-evening gap — timestamps are UTC', () => {
    // A ~10h gap spanning local midnight is normal; treating it as a dead writer is the false alarm.
    expect(checkReporterLiveness(facts({ lastHookEventAt: '2026-08-15T18:00:00.000Z' })).status).toBe('ok');
  });
});

describe('toolchain', () => {
  it('reports an absent gate step as UNKNOWN, not as a defect', () => {
    // Measured live: ticket-workflow has no lint script. Plenty of healthy repos do not — calling
    // that MISMATCH made the README's own headline invocation exit 2 on a healthy machine, which
    // teaches the reader to ignore the exit code. UNKNOWN still surfaces it under --strict.
    const r = checkToolchain(facts({ gateScripts: { 'ticket-workflow': ['typecheck', 'test'] } }));
    expect(r.status).toBe('unknown');
    expect(r.detail).toContain('ticket-workflow:lint');
    expect(exitCodeFor([r], false)).toBe(0);
    expect(exitCodeFor([r], true)).toBe(2);
  });

  it('is UNKNOWN when no scripts could be read', () => {
    expect(checkToolchain(facts({ gateScripts: null })).status).toBe('unknown');
  });
});

describe('exit codes', () => {
  it('is 0 on an all-OK machine', () => {
    expect(exitCodeFor(runChecks(HEALTHY), false)).toBe(0);
  });

  it('is 2 on any mismatch', () => {
    expect(
      exitCodeFor(
        runChecks(
          facts({
            postToolUse: [
              { command: 'a', kind: 'writer' },
              { command: 'b', kind: 'writer' },
            ],
          }),
        ),
        false,
      ),
    ).toBe(2);
  });

  it('passes UNKNOWN by default but FAILS it under --strict', () => {
    // The CI shape: unanswerable user-scope checks must not read as success when a gate depends on it.
    const unknowns = runChecks(facts({ postToolUse: null }));
    expect(exitCodeFor(unknowns, false)).toBe(0);
    expect(exitCodeFor(unknowns, true)).toBe(2);
  });

  it('runs every check, so a silently dropped one is visible', () => {
    expect(runChecks(HEALTHY)).toHaveLength(8);
    expect(new Set(runChecks(HEALTHY).map((r) => r.id)).size).toBe(8);
  });

  it('formats each result with its status and id', () => {
    const out = formatResults(runChecks(HEALTHY));
    expect(out).toContain('writer-uniqueness');
    expect(out.split('\n')).toHaveLength(8);
  });
});
