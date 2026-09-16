import { createServer } from 'node:http';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const checklists = {
  registry: [
    'Serve the v0.1 list, latest-version, and specific-version HTTPS endpoints.',
    'Allow anonymous catalog reads with the documented CORS headers.',
    'Set the registry base URL in GitHub Copilot settings, without /v0.1/servers.',
    'Review catalog changes in source control before redeploying.',
  ],
  server: [
    'Implement tools using the official MCP SDK and validate their inputs.',
    'Expose a Streamable HTTP endpoint over HTTPS and validate Host and Origin.',
    'Use managed identity for Azure resources and OAuth before exposing private data.',
    'Test discovery, tool calls, invalid input, and authorization before release.',
  ],
};

export function buildMcpServer() {
  const server = new McpServer({ name: 'mcp-setup-demo', version: '1.0.0' });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool('greet', {
    title: 'Greet',
    description: 'Return a greeting to verify MCP connectivity. No external services are called.',
    inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
    outputSchema: z.object({ message: z.string() }),
    annotations,
  }, async ({ name }) => {
    const message = `Hello, ${name}! Your MCP server is connected.`;
    return { content: [{ type: 'text', text: message }], structuredContent: { message } };
  });

  server.registerTool('deployment_checklist', {
    title: 'Deployment Checklist',
    description: 'Read static setup guidance for an MCP registry or server. Does not deploy resources.',
    inputSchema: z.object({ component: z.enum(['registry', 'server']) }),
    outputSchema: z.object({ component: z.string(), steps: z.array(z.string()) }),
    annotations,
  }, async ({ component }) => {
    const steps = checklists[component];
    return {
      content: [{ type: 'text', text: steps.join('\n') }],
      structuredContent: { component, steps },
    };
  });

  return server;
}

export function createMcpHttpServer(options: {
  allowedHosts?: string[];
  allowedOriginHosts?: string[];
} = {}) {
  const hosts = options.allowedHosts ?? ['localhost', '127.0.0.1', '[::1]'];
  const validateHost = hostHeaderValidation(hosts);
  const validateOrigin = originValidation(options.allowedOriginHosts ?? hosts);
  const handleMcp = toNodeHandler(createMcpHandler(buildMcpServer));

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;

    if (request.headers.origin) {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id');
      response.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Mcp-Session-Id, WWW-Authenticate');
    }

    const path = new URL(request.url ?? '/', 'http://mcp.local').pathname;
    if (request.method === 'GET' && (path === '/healthz' || path === '/')) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        status: 'ok',
        service: 'mcp-setup-demo',
        transport: 'streamable-http',
        endpoint: '/mcp',
        tools: ['greet', 'deployment_checklist'],
        dataAccess: 'none; public demo only',
      }));
      return;
    }
    if (path !== '/mcp') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Route not found.' }));
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      await handleMcp(request, response);
    } catch (error) {
      console.error('MCP request failed:', error instanceof Error ? error.message : 'Unknown error');
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Internal server error.' }));
      } else {
        response.end();
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}