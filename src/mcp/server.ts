#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, handleToolCall } from './handlers.js';

// Thin entrypoint: advertise tools + delegate to the testable handlers in ./handlers.ts.
// The tool namespace comes from the consumer's .mcp.json server key, not this name.

const server = new Server(
  { name: 'ticket-workflow', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
