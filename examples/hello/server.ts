import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

serveStdio(() => {
  const server = new McpServer({ name: 'hello-mcp', version: '1.0.0' });
  server.registerTool('hello', {
    description: 'Return a greeting for a supplied name.',
    inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
    annotations: {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
  }, async ({ name }) => ({
    content: [{ type: 'text', text: `Hello, ${name}!` }],
  }));
  return server;
});
