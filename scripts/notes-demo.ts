import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'notes-protocol-demo', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/notes-stdio.ts', import.meta.url))],
    env: { NOTES_ROOT: fileURLToPath(new URL('../examples/notes/', import.meta.url)) },
  }));
  console.log('1. Connected through the SDK: MCP initialization and capability negotiation completed.');
  console.log('\n2. tools/list: discover descriptions and JSON input/output schemas.');
  console.log(JSON.stringify(await client.listTools(), null, 2));
  for (const call of [
    { name: 'list_notes', arguments: {} },
    { name: 'search_notes', arguments: { query: 'deployment' } },
    { name: 'read_note', arguments: { path: 'deployment.txt', startLine: 4, maxLines: 3 } },
  ]) {
    console.log(`\n3. tools/call request: ${JSON.stringify(call)}`);
    const response = await client.callTool(call);
    console.log(`Tool response:\n${JSON.stringify(response, null, 2)}`);
    if (response.isError) throw new Error(`Demo tool ${call.name} failed.`);
  }
  console.log('\n4. The host can now ground an answer in these passages. No LLM is used by this script.');
} finally {
  await client.close();
}
