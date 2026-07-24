import path from 'node:path';

export type BoardRootSource = 'BOARD_DIR_OVERRIDE' | 'CLAUDE_PROJECT_DIR' | 'cwd';

// Board-root resolution for a package installed under a consumer repo's
// node_modules. `__dirname` would point inside the package, so the board dir
// must come from the CONSUMER. Claude Code sets CLAUDE_PROJECT_DIR in both the
// MCP server's and the hooks' environment (the server's cwd is undocumented, so
// it comes BEFORE cwd here). The PostToolUse hook resolves events the same way,
// so status events (service) and command events (hook) land in one board.
// `||` not `??` on purpose: an empty-string env var (`BOARD_DIR_OVERRIDE=""`) must
// fall through, not be taken as an authoritative empty path (which would resolve
// the board to a relative `tickets`/`events` under cwd).
// Returns the source too, so callers can tell an explicit board dir from the
// implicit cwd fallback (tkt-4befa760dc29).
export function resolveBoardRoot(): { root: string; source: BoardRootSource } {
  if (process.env.BOARD_DIR_OVERRIDE) return { root: process.env.BOARD_DIR_OVERRIDE, source: 'BOARD_DIR_OVERRIDE' };
  if (process.env.CLAUDE_PROJECT_DIR) return { root: process.env.CLAUDE_PROJECT_DIR, source: 'CLAUDE_PROJECT_DIR' };
  return { root: process.cwd(), source: 'cwd' };
}

// Warn once per distinct implicit root. Falling back to cwd with no explicit board
// dir is the misconfiguration that silently served an empty board (tkt-4befa760dc29):
// the MCP server was launched from the wrong directory, so the board turned up empty
// with no signal. We WARN rather than refuse — a repo that IS its own board runs
// legitimately from cwd (the CLI, a default consumer), so a hard failure would break
// the common case; a named warning makes the mis-launch visible without wedging use.
const warnedImplicitRoots = new Set<string>();

// Test seam: reset the warn-once memory so each test observes the warning
// independently. Internal — not re-exported from the package index.
export function _resetBoardRootWarnings(): void {
  warnedImplicitRoots.clear();
}

export function boardRoot(): string {
  const { root, source } = resolveBoardRoot();
  if (source === 'cwd' && !warnedImplicitRoots.has(root)) {
    warnedImplicitRoots.add(root);
    console.warn(
      `[ticket-workflow] No BOARD_DIR_OVERRIDE or CLAUDE_PROJECT_DIR set; using the current directory as the board root: ${root}. ` +
        'If the board looks empty, the server is likely running from the wrong directory — set BOARD_DIR_OVERRIDE to the board location.',
    );
  }
  return root;
}

// TICKETS_DIR_OVERRIDE/EVENTS_DIR_OVERRIDE keep top priority so tests redirect
// I/O to a temp dir without touching a real board.
export function ticketsDir(): string {
  return process.env.TICKETS_DIR_OVERRIDE || path.join(boardRoot(), 'tickets');
}

export function eventsDir(): string {
  return process.env.EVENTS_DIR_OVERRIDE || path.join(boardRoot(), 'events');
}
