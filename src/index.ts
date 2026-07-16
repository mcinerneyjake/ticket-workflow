// Public JS API — the entry consumers (e.g. a host board app) import from.
export * from './shared/constants.js';
export * from './server/tickets.js';
export * from './server/events.js';
export * from './mcp/handlers.js';
export { boardRoot, ticketsDir, eventsDir } from './paths.js';
