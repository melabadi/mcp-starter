import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRegistryServer, loadRegistryCatalog } from '../src/registry.ts';

test('catalog is organization-neutral by default and endpoint overrides never mutate the source', () => {
  const url = (override?: string) => loadRegistryCatalog(override)[0].server.remotes?.[0]?.url;
  assert.equal(url(), 'https://mcp.dev.azure.com/');
  assert.equal(url('https://mcp.dev.azure.com/reader-org'), 'https://mcp.dev.azure.com/reader-org');
  assert.equal(url(), 'https://mcp.dev.azure.com/');
});

test('registry implements the GitHub v0.1 discovery contract', async (context) => {
  const server = createRegistryServer('https://mcp.dev.azure.com/test-org');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const list = await fetch(`${base}/v0.1/servers?version=latest`);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('access-control-allow-origin'), '*');
  const catalog = await list.json();
  assert.equal(catalog.metadata.count, 2);
  assert.equal(catalog.metadata.nextCursor, undefined);
  assert.deepEqual(catalog.servers.map((entry: { server: { name: string } }) => entry.server.name), [
    'io.github.melabadi/azure-devops', 'io.github.melabadi/onenote-local',
  ]);
  assert.equal(catalog.servers[0].server.remotes[0].url, 'https://mcp.dev.azure.com/test-org');
  assert.deepEqual(catalog.servers[0].server.remotes[0].headers, [
    { name: 'X-MCP-Readonly', value: 'true', isRequired: true },
    { name: 'X-MCP-Tools', value: 'core_list_projects,wit_work_item,repo_pull_request', isRequired: true },
  ]);

  const name = encodeURIComponent(catalog.servers[0].server.name);
  for (const version of ['latest', '1.0.0']) {
    const response = await fetch(`${base}/v0.1/servers/${name}/versions/${version}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), catalog.servers[0]);
    const decoded = await fetch(`${base}/v0.1/servers/${catalog.servers[0].server.name}/versions/${version}`);
    assert.equal(decoded.status, 200);
    assert.deepEqual(await decoded.json(), catalog.servers[0]);
  }
  const versions = await fetch(`${base}/v0.1/servers/${name}/versions`);
  assert.equal((await versions.json()).metadata.count, 1);
  assert.equal((await fetch(`${base}/v0.1/servers/${name}/versions/9.0.0`)).status, 404);
  assert.equal((await fetch(`${base}/v0.1/servers/missing/versions/latest`)).status, 404);

  const preflight = await fetch(`${base}/v0.1/servers`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  assert.equal((await fetch(`${base}/v0.1/servers`, { method: 'POST' })).status, 405);

  for (const query of ['limit=0', 'limit=101', 'limit=no', 'cursor=invalid', 'updated_since=no']) {
    assert.equal((await fetch(`${base}/v0.1/servers?${query}`)).status, 400, query);
  }
  const empty = await fetch(`${base}/v0.1/servers?search=missing`);
  assert.deepEqual((await empty.json()).servers, []);

  const firstPage = await (await fetch(`${base}/v0.1/servers?limit=1`)).json();
  assert.equal(firstPage.metadata.count, 1);
  assert.ok(firstPage.metadata.nextCursor);
  const secondPage = await (await fetch(`${base}/v0.1/servers?limit=1&cursor=${firstPage.metadata.nextCursor}`)).json();
  assert.equal(secondPage.metadata.count, 1);
  assert.equal(secondPage.metadata.nextCursor, undefined);
  assert.equal(secondPage.servers[0].server.name, 'io.github.melabadi/onenote-local');
  assert.equal(secondPage.servers[0].server.packages, undefined);
  assert.equal(secondPage.servers[0].server.remotes, undefined);
  for (const removed of ['com.executeautomation/playwright-mcp-server', 'com.example/mcp-setup-demo']) {
    assert.equal((await fetch(`${base}/v0.1/servers/${encodeURIComponent(removed)}/versions/latest`)).status, 404);
  }
});

test('registry refuses insecure non-local MCP URLs', () => {
  assert.throws(() => createRegistryServer('https://unapproved.example/mcp'), /Azure DevOps/);
  assert.throws(() => createRegistryServer('https://mcp.dev.azure.com:8443/org'), /Azure DevOps/);
  assert.throws(() => createRegistryServer('https://mcp.dev.azure.com/org/extra'), /Azure DevOps/);
  assert.throws(() => createRegistryServer('http://demo.example.com/mcp'), /HTTPS/);
  assert.throws(() => createRegistryServer('https://demo.example.com/mcp?token=example'), /credentials/);
  assert.throws(() => createRegistryServer('https://user:example@demo.example.com/mcp'), /credentials/);
});

test('smoke verification accepts the reader organization override rather than a hardcoded endpoint', () => {
  const smoke = fileURLToPath(new URL('../scripts/smoke.ts', import.meta.url));
  const result = spawnSync(process.execPath, [
    smoke, '--local', '--ado-url', 'https://mcp.dev.azure.com/reader-org',
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5\/5 checks passed/u);
  const invalid = spawnSync(process.execPath, [smoke, '--registry', 'https://registry.example.com'], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Provide both --registry and --server/u);
});