import { describe, it, expect } from 'vitest';
import {
  extractTicketFields, validatedStatus, CREATE_STATUS_ENUM, UPDATE_STATUS_ENUM,
} from './validation.js';
import { HttpError, type TicketPatch } from './tickets.js';

// Protocol-neutral validators, extracted from mcp/handlers so a consumer's HTTP
// controller and the MCP layer share one implementation (tkt-156c5c00149b).

describe('CREATE_STATUS_ENUM / UPDATE_STATUS_ENUM', () => {
  it('qa is transition-only: creatable set excludes it, updatable set includes it', () => {
    expect(CREATE_STATUS_ENUM).not.toContain('qa');
    expect(UPDATE_STATUS_ENUM).toContain('qa');
  });
});

describe('validatedStatus', () => {
  it('returns the value when it is in the allowed set', () => {
    expect(validatedStatus('todo', CREATE_STATUS_ENUM)).toBe('todo');
  });

  it('rejects a real status that is not in the per-call allowed set', () => {
    // qa is a valid StatusId but not creatable.
    expect(() => validatedStatus('qa', CREATE_STATUS_ENUM)).toThrow(HttpError);
  });

  it('rejects an unknown status value', () => {
    expect(() => validatedStatus('nonsense', UPDATE_STATUS_ENUM)).toThrow(HttpError);
  });
});

describe('extractTicketFields', () => {
  it('returns an empty patch for undefined args', () => {
    expect(extractTicketFields(undefined, UPDATE_STATUS_ENUM)).toEqual({});
  });

  it('extracts the full set of valid fields', () => {
    const out = extractTicketFields(
      {
        title: 'Fix export', type: 'bug', priority: 'high', status: 'todo',
        body: 'details', project: 'kanban', parent: 'tkt-1', dueDate: '2026-08-01',
        assignee: 'jake', blockers: ['tkt-2', 'tkt-3'],
      },
      CREATE_STATUS_ENUM,
    );
    expect(out).toEqual({
      title: 'Fix export', type: 'bug', priority: 'high', status: 'todo',
      body: 'details', project: 'kanban', parent: 'tkt-1', dueDate: '2026-08-01',
      assignee: 'jake', blockers: ['tkt-2', 'tkt-3'],
    });
  });

  it('skips absent fields but rejects present-but-wrong-typed ones (no silent drop)', () => {
    expect(() => extractTicketFields({ title: 42 }, UPDATE_STATUS_ENUM)).toThrow(HttpError);
  });

  it('rejects an invalid enum value', () => {
    expect(() => extractTicketFields({ type: 'epic' }, UPDATE_STATUS_ENUM)).toThrow(HttpError);
  });

  it('accepts null for nullable fields but rejects a non-string/non-null', () => {
    expect(extractTicketFields({ project: null }, UPDATE_STATUS_ENUM)).toEqual({ project: null });
    expect(() => extractTicketFields({ project: 5 }, UPDATE_STATUS_ENUM)).toThrow(HttpError);
  });

  it('rejects a status outside the per-call allowed set', () => {
    expect(() => extractTicketFields({ status: 'qa' }, CREATE_STATUS_ENUM)).toThrow(HttpError);
    expect(extractTicketFields({ status: 'qa' }, UPDATE_STATUS_ENUM)).toEqual({ status: 'qa' });
  });

  it('rejects a blockers value that is not an array of strings', () => {
    expect(() => extractTicketFields({ blockers: ['tkt-1', 2] }, UPDATE_STATUS_ENUM)).toThrow(HttpError);
  });

  // tkt-81b4d35e95e5 — appendBody crosses this extractor on its way to updateTicket,
  // so a drop here would silently turn an append into a no-op.
  it('carries appendBody through and rejects a non-string one', () => {
    expect(extractTicketFields({ appendBody: '## Note' }, UPDATE_STATUS_ENUM)).toEqual({ appendBody: '## Note' });
    expect(() => extractTicketFields({ appendBody: 42 }, UPDATE_STATUS_ENUM)).toThrow(HttpError);
  });

  // tkt-cb982de01540 — the extractor's output type (TicketFields) is derived from
  // TicketPatch, so it must stay assignable to it. The annotation fails `tsc` if the
  // two ever diverge (a field the extractor emits that the service would drop).
  it('emits a TicketPatch-assignable object (cross-layer field set stays in sync)', () => {
    const patch: TicketPatch = extractTicketFields({ title: 'x' }, UPDATE_STATUS_ENUM);
    expect(patch.title).toBe('x');
  });
});
