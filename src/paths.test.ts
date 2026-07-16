import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { boardRoot, ticketsDir, eventsDir } from './paths.js';

const KEYS = ['BOARD_DIR_OVERRIDE', 'CLAUDE_PROJECT_DIR', 'TICKETS_DIR_OVERRIDE', 'EVENTS_DIR_OVERRIDE'];
function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

describe('board-root resolution', () => {
  afterEach(clearEnv);

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
});
