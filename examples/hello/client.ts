import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'hello-test', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.ts', import.meta.url))],
  }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['hello']);
  const result = await client.callTool({ name: 'hello', arguments: { name: 'World' } });
  assert.ok(!result.isError);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Hello, World!' }]);
  assert.equal((await client.callTool({ name: 'hello', arguments: { name: '' } })).isError, true);
  console.log('PASS: discovered hello, received Hello, World!, and rejected invalid input.');
} finally {
  await client.close();
}
