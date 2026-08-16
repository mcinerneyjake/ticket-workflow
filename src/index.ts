// Public JS API — the entry consumers (e.g. a host board app) import from.
export * from './shared/constants.js';
export * from './server/tickets.js';
export * from './server/events.js';
export * from './server/validation.js';
export * from './mcp/handlers.js';
export { boardRoot, ticketsDir, eventsDir } from './paths.js';
export { guardrailTemplates } from './templates.js';
export type { GuardrailTemplate, GuardrailTier } from './templates.js';
export { runAudit, auditExitCode, formatAudit, AUDIT_CHECKS } from './audit/run.js';
export { runInit } from './init/run.js';
export type { InitResult } from './init/run.js';
export type { AuditReport } from './audit/run.js';
export type { AuditResult, AuditStatus, AuditCheck, AuditContext, Exec, ExecResult, ReadResult } from './audit/types.js';
