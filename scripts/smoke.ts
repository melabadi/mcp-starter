import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHttpServer } from '../src/mcp-server.ts';
import { createRegistryServer } from '../src/registry.ts';

const { values } = parseArgs({ options: {
  local: { type: 'boolean', default: false },
  registry: { type: 'string' },
  server: { type: 'string' },
  output: { type: 'string' },
} });
const localServers: Server[] = [];

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  localServers.push(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

const checks: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
async function check(name: string, action: () => Promise<unknown>) {
  try {
    const detail = await action();
    checks.push({ name, status: 'passed', detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exitCode = 1;
  }
}

async function get(url: string, options: RequestInit = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
}

try {
  let registryUrl: string;
  let mcpServerUrl: string;
  if (values.local) {
    mcpServerUrl = `${await listen(createMcpHttpServer())}/mcp`;
    registryUrl = await listen(createRegistryServer(mcpServerUrl));
  } else if (values.registry && values.server) {
    registryUrl = values.registry;
    mcpServerUrl = values.server;
  } else {
    const deployment = JSON.parse(readFileSync(new URL('../.azure/deployment.json', import.meta.url), 'utf8'));
    registryUrl = deployment.registryUrl;
    mcpServerUrl = deployment.mcpServerUrl;
  }
  registryUrl = registryUrl.replace(/\/$/, '');
  for (const endpoint of [registryUrl, mcpServerUrl]) {
    const url = new URL(endpoint);
    assert.ok(url.protocol === 'https:' || (values.local && url.hostname === '127.0.0.1'));
    assert.ok(!url.username && !url.password && !url.search && !url.hash, 'Endpoints must not include secrets.');
  }

  await check('Registry discovery, version routes, and configured catalog', async () => {
    const response = await get(`${registryUrl}/v0.1/servers?version=latest`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const catalog = await response.json();
    const expected = JSON.parse(readFileSync(new URL('../registry/catalog.json', import.meta.url), 'utf8'));
    assert.equal(catalog.metadata.count, expected.length);
    for (const entry of expected) {
      const name = encodeURIComponent(entry.server.name);
      for (const version of ['latest', entry.server.version]) {
        const versionResponse = await get(`${registryUrl}/v0.1/servers/${name}/versions/${encodeURIComponent(version)}`);
        assert.equal(versionResponse.status, 200);
        const actual = (await versionResponse.json()).server;
        if (entry.server.name === 'com.example/mcp-setup-demo') {
          assert.equal(actual.remotes[0].url, mcpServerUrl);
        } else {
          assert.deepEqual(actual, entry.server);
        }
      }
    }
    return { entries: catalog.servers.map((entry: { server: { name: string } }) => entry.server.name) };
  });

  await check('Registry CORS preflight and write rejection', async () => {
    const response = await get(`${registryUrl}/v0.1/servers`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://github.com', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal((await get(`${registryUrl}/v0.1/publish`, { method: 'POST' })).status, 405);
  });

  await check('Server health and Origin rejection', async () => {
    const health = await get(new URL('/healthz', mcpServerUrl).href);
    assert.equal(health.status, 200);
    assert.equal((await get(mcpServerUrl, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    return await health.json();
  });

  for (const mode of ['legacy', 'auto'] as const) {
    await check(`SDK tool discovery and calls (${mode})`, async () => {
      const client = new Client({ name: 'mcp-setup-smoke', version: '1.0.0' }, { versionNegotiation: { mode } });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(mcpServerUrl)));
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['deployment_checklist', 'greet']);
        const greeting = await client.callTool({ name: 'greet', arguments: { name: 'GitHub' } });
        assert.deepEqual(greeting.structuredContent, { message: 'Hello, GitHub! Your MCP server is connected.' });
        const checklist = await client.callTool({ name: 'deployment_checklist', arguments: { component: 'server' } });
        assert.ok(!checklist.isError);
        const invalid = await client.callTool({ name: 'greet', arguments: { name: '' } });
        assert.equal(invalid.isError, true);
        return { tools: tools.tools.map((tool) => tool.name), greeting: greeting.structuredContent };
      } finally {
        await client.close();
      }
    });
  }

  const report = { verifiedAt: new Date().toISOString(), registryUrl, mcpServerUrl, checks };
  if (values.output) {
    const path = resolve(values.output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`${checks.filter((item) => item.status === 'passed').length}/${checks.length} checks passed`);
} finally {
  for (const server of localServers) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}