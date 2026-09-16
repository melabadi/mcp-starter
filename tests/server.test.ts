import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHttpServer } from '../src/mcp-server.ts';

test('MCP tools work with current and legacy HTTP handshakes', async (context) => {
  const server = createMcpHttpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  for (const mode of ['legacy', 'auto'] as const) {
    const client = new Client({ name: 'mcp-setup-test', version: '1.0.0' }, {
      versionNegotiation: { mode },
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['deployment_checklist', 'greet']);
      const greeting = await client.callTool({ name: 'greet', arguments: { name: 'GitHub' } });
      assert.equal(greeting.isError, undefined);
      assert.deepEqual(greeting.structuredContent, { message: 'Hello, GitHub! Your MCP server is connected.' });
      const checklist = await client.callTool({ name: 'deployment_checklist', arguments: { component: 'registry' } });
      assert.equal(checklist.isError, undefined);
      assert.ok(checklist.structuredContent && typeof checklist.structuredContent === 'object');
      assert.ok('steps' in checklist.structuredContent);
      assert.ok(Array.isArray(checklist.structuredContent.steps));
      assert.equal(checklist.structuredContent.steps.length, 4);
      const invalid = await client.callTool({ name: 'greet', arguments: { name: '' } });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
    }
  }

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/mcp`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(`${base}/mcp`, { headers: { Host: 'untrusted.example' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(badHostStatus, 403);
});

test('local stdio entrypoint exposes the same read-only tools', async () => {
  const client = new Client({ name: 'mcp-setup-stdio-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/stdio.ts', import.meta.url))],
    }));
    const tools = await client.listTools();
    assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    const greeting = await client.callTool({ name: 'greet', arguments: { name: 'Local' } });
    assert.deepEqual(greeting.structuredContent, { message: 'Hello, Local! Your MCP server is connected.' });
  } finally {
    await client.close();
  }
});