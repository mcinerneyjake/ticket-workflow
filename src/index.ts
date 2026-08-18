// Public JS API — the entry consumers (e.g. a host board app) import from.
export * from './shared/constants.js';
export * from './server/tickets.js';
export * from './server/events.js';
export * from './server/validation.js';
export * from './mcp/handlers.js';
export { boardRoot, ticketsDir, eventsDir } from './paths.js';
export { guardrailTemplates, tierIncludes } from './templates.js';
export type { GuardrailTemplate, GuardrailTier } from './templates.js';
export { runAudit, auditExitCode, formatAudit, AUDIT_CHECKS } from './audit/run.js';
export { runInit } from './init/run.js';
export type { InitResult } from './init/run.js';
export type { AuditReport } from './audit/run.js';
export type { AuditResult, AuditStatus, AuditCheck, AuditContext, Exec, ExecResult, ReadResult } from './audit/types.js';
export { sweep, testBlocks, screenBlock, assertInstruments, controlFailures, CONTROLS, HITS } from './vacuous/probe.js';
export type { SweepResult, Candidate, TestBlock } from './vacuous/probe.js';
export { checkRoot, compareToBaseline, vacuousExitCode, BASELINE_NAME, BREADTH_FLOOR, EXIT as VACUOUS_EXIT } from './vacuous/ratchet.js';
export type { CheckResult, BaselineRow } from './vacuous/ratchet.js';
