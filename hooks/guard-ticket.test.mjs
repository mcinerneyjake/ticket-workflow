import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, REASON } from './guard-ticket.mjs';

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

  it('always supplies a reason that points at the local agent', () => {
    const { reason } = decide({ tool_name: 'mcp__kanban__create_ticket' });
    expect(reason).toBe(REASON);
    expect(reason).toContain('npm run agent');
  });
});

describe('hook entrypoint (stdin → exit code)', () => {
  const hook = fileURLToPath(new URL('./guard-ticket.mjs', import.meta.url));
  const runHook = (payload) => spawnSync('node', [hook], { input: payload, encoding: 'utf8' });

  it('exits 2 and surfaces the reason on a create_ticket call', () => {
    const r = runHook(JSON.stringify({ tool_name: 'mcp__kanban__create_ticket', tool_input: { title: 'x' } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('npm run agent');
  });

  it('exits 0 on an update_ticket call', () => {
    const r = runHook(JSON.stringify({ tool_name: 'mcp__kanban__update_ticket', tool_input: { id: 'tkt-1', body: 'x' } }));
    expect(r.status).toBe(0);
  });

  it('exits 2 on unparseable stdin (fails closed)', () => {
    expect(runHook('not json').status).toBe(2);
  });
});
