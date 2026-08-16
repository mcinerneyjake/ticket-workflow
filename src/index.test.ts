import { describe, expect, it } from 'vitest';
import * as api from './index.js';

// The barrel IS the public API: a re-export dropped here vanishes for every consumer while all
// module-level tests stay green, because they import the modules directly.
describe('public API surface', () => {
  it('exports the board service, MCP handlers, templates, audit, and init entry points', () => {
    for (const name of [
      'listTickets',
      'getTicket',
      'createTicket',
      'updateTicket',
      'boardRoot',
      'ticketsDir',
      'eventsDir',
      'guardrailTemplates',
      'tierIncludes',
      'runAudit',
      'auditExitCode',
      'formatAudit',
      'AUDIT_CHECKS',
      'runInit',
    ]) {
      expect(api, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});
