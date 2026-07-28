#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { TOOLS, handleToolCall } from './handlers.js';

// Thin entrypoint: advertise tools + delegate to the testable handlers in ./handlers.ts.
// The tool namespace comes from the consumer's .mcp.json server key, not this name.

// Read the version rather than hardcoding it: a stale literal here is invisible (it only shows in the
// initialize handshake) and misdirects "which build am I talking to?" debugging. createRequire, not an
// import: rootDir is src/, so package.json can't be imported without breaking the build. Both
// src/mcp/ and the emitted dist/mcp/ sit two levels under the package root, so this path holds either way.
function packageVersion(): string {
  const pkg: unknown = createRequire(import.meta.url)('../../package.json');
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg) {
    const { version } = pkg;
    if (typeof version === 'string') return version;
  }
  return '0.0.0-unknown';
}

const server = new Server(
  { name: 'ticket-workflow', version: packageVersion() },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
