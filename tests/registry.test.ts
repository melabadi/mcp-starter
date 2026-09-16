import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRegistryServer } from '../src/registry.ts';

test('registry implements the GitHub v0.1 discovery contract', async (context) => {
  const server = createRegistryServer('https://demo.example.com/mcp');
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
  assert.equal(catalog.metadata.count, 1);
  assert.equal(catalog.metadata.nextCursor, undefined);
  assert.equal(catalog.servers[0].server.remotes[0].url, 'https://demo.example.com/mcp');

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
  assert.equal(firstPage.metadata.nextCursor, undefined);
});

test('registry refuses insecure non-local MCP URLs', () => {
  assert.throws(() => createRegistryServer('http://demo.example.com/mcp'), /HTTPS/);
  assert.throws(() => createRegistryServer('https://demo.example.com/mcp?token=example'), /credentials/);
  assert.throws(() => createRegistryServer('https://user:example@demo.example.com/mcp'), /credentials/);
});