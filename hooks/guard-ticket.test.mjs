import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, REASON, createReason } from './guard-ticket.mjs';

const isBlocked = (toolName, toolInput = {}) =>
  decide(toolName === undefined ? {} : { tool_name: toolName, tool_input: toolInput }).blocked;

describe('decide — blocks only create_ticket', () => {
  it('blocks the real create tool id', () => {
    expect(isBlocked('mcp__kanban__create_ticket', { title: 'x' })).toBe(true);
  });

  it('blocks a bare create_ticket (server-rename defensive)', () => {
    expect(isBlocked('create_ticket')).toBe(true);
  });

  // Creation-only scope: body/summary/structured updates and delete stay Claude's.
  it('allows update_ticket even with a body (implementation summaries are Claude-authored)', () => {
    expect(isBlocked('mcp__kanban__update_ticket', { id: 'tkt-1', body: '## Implementation summary\n…' })).toBe(false);
  });

  it('allows a structured-field-only update', () => {
    expect(isBlocked('mcp__kanban__update_ticket', { id: 'tkt-1', status: 'done' })).toBe(false);
  });

  it('allows delete_ticket', () => {
    expect(isBlocked('mcp__kanban__delete_ticket', { id: 'tkt-1' })).toBe(false);
  });

  it('allows the read tools', () => {
    expect(isBlocked('mcp__kanban__list_tickets')).toBe(false);
    expect(isBlocked('mcp__kanban__get_ticket', { id: 'tkt-1' })).toBe(false);
    expect(isBlocked('mcp__kanban__start_ticket', { id: 'tkt-1' })).toBe(false);
  });

  it('does not match a tool whose name merely contains create_ticket mid-string', () => {
    expect(isBlocked('mcp__kanban__create_ticket_draft')).toBe(false);
  });

  // Fail CLOSED: the settings matcher routes only create_ticket here, so no readable
  // tool name is treated as the create call (opposite of guard-bash's fail-open).
  it('fails closed on an absent or non-string tool name', () => {
    expect(isBlocked(undefined)).toBe(true);
    expect(decide({ tool_name: 42 }).blocked).toBe(true);
  });

  it('always supplies a reason, and the shipped default names no consumer-specific command', () => {
    const { reason } = decide({ tool_name: 'mcp__kanban__create_ticket' }, {});
    expect(reason).toBe(REASON);
    // The defect (tkt-0361525dbf9f): this guard is wired at USER scope, so it fires in every repo on
    // the machine, and it used to hand every one of them `npm run agent` — a script that exists in one.
    expect(reason).not.toMatch(/npm run |\/api\//);
    // Still actionable rather than merely vague: it says where to look instead of naming a command.
    expect(reason).toContain('TICKET_WORKFLOW_CREATE_REASON');
  });
});

// The consumer seam. Same shape as guard-bash's TICKET_WORKFLOW_PROTECTED_BRANCH: the policy ships, the
// concrete command comes from the environment that actually has one.
describe('createReason — the consumer override', () => {
  it('replaces the default when set', () => {
    const mine = 'Run `just file-ticket "<report>"` — one issue per run.';
    expect(createReason({ TICKET_WORKFLOW_CREATE_REASON: mine })).toBe(mine);
    expect(decide({ tool_name: 'create_ticket' }, { TICKET_WORKFLOW_CREATE_REASON: mine }).reason).toBe(mine);
  });

  it('falls back to the default when unset, blank, or whitespace', () => {
    // Blocking with an empty explanation is barely better than failing open, and unset-vs-empty is a
    // distinction no caller means to draw.
    for (const env of [{}, { TICKET_WORKFLOW_CREATE_REASON: '' }, { TICKET_WORKFLOW_CREATE_REASON: '   \n' }]) {
      expect(createReason(env), JSON.stringify(env)).toBe(REASON);
    }
  });

  it('trims, so a trailing newline from a shell heredoc is not part of the message', () => {
    expect(createReason({ TICKET_WORKFLOW_CREATE_REASON: '  do the thing\n' })).toBe('do the thing');
  });
});

describe('hook entrypoint (stdin → exit code)', () => {
  const hook = fileURLToPath(new URL('./guard-ticket.mjs', import.meta.url));
  const runHook = (payload) => spawnSync('node', [hook], { input: payload, encoding: 'utf8' });

  it('exits 2 and surfaces the reason on a create_ticket call', () => {
    const r = runHook(JSON.stringify({ tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'x' } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('create_ticket is blocked');
  });

  // What the consumer actually depends on: the override has to survive the spawn and reach the stderr a
  // blocked session reads. Asserting createReason() alone would leave main() free to ignore it — the
  // "consulted but not wired" shape. Driven through the real process, with the default as the control.
  it('carries a consumer override all the way to stderr', () => {
    const mine = 'FILE-IT-THIS-WAY: run `just ticket --create-only "<report>"`, one issue per run';
    const payload = JSON.stringify({ tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'x' } });
    const withOverride = spawnSync('node', [hook], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, TICKET_WORKFLOW_CREATE_REASON: mine },
    });
    expect(withOverride.status).toBe(2);
    expect(withOverride.stderr).toContain(mine);
    // The control: without it the same call prints the shipped default instead, so the assertion above
    // is attributable to the env var and not to the message merely being long.
    expect(runHook(payload).stderr).not.toContain('FILE-IT-THIS-WAY');
  });

  it('exits 0 on an update_ticket call', () => {
    const r = runHook(JSON.stringify({ tool_name: 'mcp__kanban__update_ticket', tool_input: { id: 'tkt-1', body: 'x' } }));
    expect(r.status).toBe(0);
  });

  it('exits 2 on unparseable stdin (fails closed)', () => {
    expect(runHook('not json').status).toBe(2);
  });
});
