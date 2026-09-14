import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { boardRoot, resolveBoardRoot, ticketsDir, eventsDir, _resetBoardRootWarnings } from './paths.js';
import { setLogger } from './logger.js';

const KEYS = ['BOARD_DIR_OVERRIDE', 'CLAUDE_PROJECT_DIR', 'TICKETS_DIR_OVERRIDE', 'EVENTS_DIR_OVERRIDE'];
function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

describe('board-root resolution', () => {
  // Captured through the logger seam, not a console spy: the service writes to process.stderr
  // directly now, so a console spy would observe nothing at all (tkt-c2ed32531824). Scoped to this
  // describe so a later one triggering log.warn cannot accumulate into it and make these counts
  // order-dependent.
  const warnings: string[][] = [];

  // Reset the warn-once memory + silence the warning so each test observes it
  // independently and the fallback warning doesn't pollute test output.
  beforeEach(() => {
    _resetBoardRootWarnings();
    warnings.length = 0;
    setLogger({ info: () => undefined, warn: (...args) => { warnings.push(args.map(String)); }, error: () => undefined });
  });
  afterEach(() => {
    clearEnv();
    setLogger(null);
    vi.restoreAllMocks();
  });

  it('defaults to process.cwd() when nothing is set', () => {
    clearEnv();
    expect(boardRoot()).toBe(process.cwd());
    expect(ticketsDir()).toBe(path.join(process.cwd(), 'tickets'));
    expect(eventsDir()).toBe(path.join(process.cwd(), 'events'));
  });

  it('prefers CLAUDE_PROJECT_DIR over cwd (the MCP server has no reliable cwd)', () => {
    clearEnv();
    process.env.CLAUDE_PROJECT_DIR = '/repo';
    expect(boardRoot()).toBe('/repo');
    expect(ticketsDir()).toBe(path.join('/repo', 'tickets'));
    expect(eventsDir()).toBe(path.join('/repo', 'events'));
  });

  it('prefers BOARD_DIR_OVERRIDE over CLAUDE_PROJECT_DIR', () => {
    clearEnv();
    process.env.CLAUDE_PROJECT_DIR = '/repo';
    process.env.BOARD_DIR_OVERRIDE = '/board';
    expect(boardRoot()).toBe('/board');
  });

  it('resolves tickets/ and events/ under the same single root', () => {
    clearEnv();
    process.env.BOARD_DIR_OVERRIDE = '/board';
    expect(path.dirname(ticketsDir())).toBe(path.dirname(eventsDir()));
    expect(path.dirname(ticketsDir())).toBe('/board');
  });

  it('TICKETS/EVENTS overrides win independently, above the board root', () => {
    clearEnv();
    process.env.BOARD_DIR_OVERRIDE = '/board';
    process.env.TICKETS_DIR_OVERRIDE = '/custom-tickets';
    expect(ticketsDir()).toBe('/custom-tickets');
    expect(eventsDir()).toBe(path.join('/board', 'events')); // events unaffected
  });

  it('treats an empty-string override as unset (falls through, not a relative path)', () => {
    clearEnv();
    process.env.CLAUDE_PROJECT_DIR = '/repo';
    process.env.BOARD_DIR_OVERRIDE = ''; // must NOT win — else board root becomes ""
    expect(boardRoot()).toBe('/repo');
    process.env.TICKETS_DIR_OVERRIDE = '';
    expect(ticketsDir()).toBe(path.join('/repo', 'tickets')); // not the relative "tickets"
  });

  describe('resolveBoardRoot reports its source', () => {
    it('reports cwd when neither env var is set', () => {
      clearEnv();
      expect(resolveBoardRoot()).toEqual({ root: process.cwd(), source: 'cwd' });
    });

    it('reports CLAUDE_PROJECT_DIR', () => {
      clearEnv();
      process.env.CLAUDE_PROJECT_DIR = '/repo';
      expect(resolveBoardRoot()).toEqual({ root: '/repo', source: 'CLAUDE_PROJECT_DIR' });
    });

    it('reports BOARD_DIR_OVERRIDE (highest precedence)', () => {
      clearEnv();
      process.env.CLAUDE_PROJECT_DIR = '/repo';
      process.env.BOARD_DIR_OVERRIDE = '/board';
      expect(resolveBoardRoot()).toEqual({ root: '/board', source: 'BOARD_DIR_OVERRIDE' });
    });
  });

  describe('fail-loud warning on the implicit cwd fallback (tkt-4befa760dc29)', () => {
    it('warns naming the resolved path when falling back to cwd', () => {
      clearEnv();
      boardRoot();
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain(process.cwd());
    });

    it('warns only once per distinct root (no per-operation spam)', () => {
      clearEnv();
      boardRoot();
      boardRoot();
      boardRoot();
      expect(warnings).toHaveLength(1);
    });

    it('does not warn when BOARD_DIR_OVERRIDE is supplied', () => {
      clearEnv();
      process.env.BOARD_DIR_OVERRIDE = '/board';
      boardRoot();
      expect(warnings).toHaveLength(0);
    });

    it('does not warn when CLAUDE_PROJECT_DIR is supplied', () => {
      clearEnv();
      process.env.CLAUDE_PROJECT_DIR = '/repo';
      boardRoot();
      expect(warnings).toHaveLength(0);
    });
  });
});
