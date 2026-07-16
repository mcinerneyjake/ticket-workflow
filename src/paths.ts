import path from 'node:path';

// Board-root resolution for a package installed under a consumer repo's
// node_modules. `__dirname` would point inside the package, so the board dir
// must come from the CONSUMER. Claude Code sets CLAUDE_PROJECT_DIR in both the
// MCP server's and the hooks' environment (the server's cwd is undocumented, so
// it comes BEFORE cwd here). The PostToolUse hook resolves events the same way,
// so status events (service) and command events (hook) land in one board.
// `||` not `??` on purpose: an empty-string env var (`BOARD_DIR_OVERRIDE=""`) must
// fall through, not be taken as an authoritative empty path (which would resolve
// the board to a relative `tickets`/`events` under cwd).
export function boardRoot(): string {
  return process.env.BOARD_DIR_OVERRIDE || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// TICKETS_DIR_OVERRIDE/EVENTS_DIR_OVERRIDE keep top priority so tests redirect
// I/O to a temp dir without touching a real board.
export function ticketsDir(): string {
  return process.env.TICKETS_DIR_OVERRIDE || path.join(boardRoot(), 'tickets');
}

export function eventsDir(): string {
  return process.env.EVENTS_DIR_OVERRIDE || path.join(boardRoot(), 'events');
}
