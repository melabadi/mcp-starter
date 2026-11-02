import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod/v4';

const fixture = z.object({
  fixtureVersion: z.literal(1),
  notebookId: z.string().min(1),
  sectionId: z.string().min(1),
  pageId: z.string().min(1),
}).parse(JSON.parse(readFileSync(new URL('../.local/onenote-demo.json', import.meta.url), 'utf8')));
const client = new Client({ name: 'onenote-com-live-demo', version: '1.0.0' });
const checks: string[] = [];

function passed(name: string) {
  checks.push(name);
  console.log(`PASS ${name}`);
}

function structured(result: { isError?: boolean; structuredContent?: unknown; content?: unknown }) {
  if (result.isError) {
    const errors = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
    throw new Error(errors.map((error) => error.text).join('\n'));
  }
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/onenote-stdio.ts', import.meta.url))],
    env: { ONENOTE_BACKEND: 'com', ONENOTE_ALLOWED_NOTEBOOK_IDS: JSON.stringify([fixture.notebookId]) },
    stderr: 'inherit',
  }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'list_notebooks', 'list_pages', 'list_sections', 'read_page',
  ]);
  assert.ok(tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations?.readOnlyHint));
  passed('SDK stdio discovery: exactly four read-only OneNote tools');
  const notebooks = structured(await client.callTool({ name: 'list_notebooks', arguments: {} }));
  assert.deepEqual(notebooks.notebooks, [{ id: fixture.notebookId, displayName: 'MCP Workshop Demo' }]);
  passed('COM list_notebooks: only the synthetic approved notebook');
  const sections = structured(await client.callTool({
    name: 'list_sections', arguments: { notebookId: fixture.notebookId, limit: 100 },
  }));
  assert.ok(z.array(z.object({ id: z.string() })).parse(sections.sections)
    .some((section) => section.id === fixture.sectionId));
  passed('COM list_sections: real demo section found');
  const pages = structured(await client.callTool({
    name: 'list_pages',
    arguments: { notebookId: fixture.notebookId, sectionId: fixture.sectionId, limit: 100 },
  }));
  assert.ok(z.array(z.object({ id: z.string() })).parse(pages.pages).some((page) => page.id === fixture.pageId));
  passed('COM list_pages: real demo page found');
  const page = structured(await client.callTool({
    name: 'read_page', arguments: { notebookId: fixture.notebookId, pageId: fixture.pageId },
  }));
  assert.equal(page.id, fixture.pageId);
  assert.equal(page.title, 'MCP Workshop Demo');
  assert.equal(page.truncated, false);
  assert.match(z.string().parse(page.text), /MCP_WORKSHOP_PUBLIC_FIXTURE_V1/u);
  assert.match(z.string().parse(page.text), /No private data is included in this notebook\./u);
  passed('COM read_page: exact synthetic marker and expected text, not an empty success');
  for (const call of [
    { name: 'read_page', arguments: { notebookId: 'not-approved', pageId: fixture.pageId } },
    { name: 'read_page', arguments: { notebookId: fixture.notebookId, pageId: 'not-in-notebook' } },
    { name: 'list_sections', arguments: { notebookId: fixture.notebookId, limit: 101 } },
  ]) {
    assert.equal((await client.callTool(call)).isError, true);
  }
  passed('Notebook/page access boundaries and invalid inputs rejected');
  console.log(`${checks.length}/${checks.length} live OneNote COM checks passed; no note contents logged.`);
} finally {
  await client.close();
}
