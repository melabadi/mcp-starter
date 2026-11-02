import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod/v4';
import {
  OneNoteError,
  OneNoteGraphClient,
  parseOneNoteConfig,
} from '../src/onenote.ts';

const fixture = fileURLToPath(new URL('./fixtures/onenote-stdio.ts', import.meta.url));

function data(response: { structuredContent?: unknown }) {
  return z.record(z.string(), z.unknown()).parse(response.structuredContent);
}

async function connectFixture(context: TestContext) {
  const client = new Client({ name: 'onenote-test', version: '1.0.0' });
  context.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fixture],
    env: {},
  }));
  return client;
}

test('OneNote configuration requires a public client ID and explicit bounded notebook allowlist', () => {
  const base = {
    ONENOTE_CLIENT_ID: 'a1234567-1234-1234-1234-123456789012',
    ONENOTE_TENANT_ID: 'organizations',
    ONENOTE_ALLOWED_NOTEBOOK_IDS: '["notebook-1"]',
  };
  assert.deepEqual(parseOneNoteConfig(base), {
    clientId: base.ONENOTE_CLIENT_ID,
    tenantId: 'organizations',
    allowedNotebookIds: ['notebook-1'],
  });
  for (const invalid of [
    { ...base, ONENOTE_CLIENT_ID: 'not-a-guid' },
    { ...base, ONENOTE_TENANT_ID: 'tenant.example/path' },
    { ...base, ONENOTE_ALLOWED_NOTEBOOK_IDS: '' },
    { ...base, ONENOTE_ALLOWED_NOTEBOOK_IDS: '["same","same"]' },
    { ...base, ONENOTE_ALLOWED_NOTEBOOK_IDS: JSON.stringify(Array.from({ length: 26 }, (_, i) => `${i}`)) },
  ]) {
    assert.throws(() => parseOneNoteConfig(invalid), OneNoteError);
  }
});

test('OneNote MCP discovers and calls read-only tools through the official SDK stdio transport', async (context) => {
  const client = await connectFixture(context);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'list_notebooks', 'list_pages', 'list_sections', 'read_page',
  ]);
  assert.ok(tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations?.readOnlyHint));

  const notebooks = await client.callTool({ name: 'list_notebooks', arguments: {} });
  assert.deepEqual(data(notebooks), {
    notebooks: [{ id: 'approved-1', displayName: 'Demo notebook' }],
  });

  const sections = await client.callTool({
    name: 'list_sections', arguments: { notebookId: 'approved-1' },
  });
  assert.deepEqual(data(sections), {
    sections: [{ id: 'section-1', displayName: 'General' }],
    nextCursor: null,
  });

  const pages = await client.callTool({
    name: 'list_pages', arguments: { notebookId: 'approved-1', sectionId: 'section-1' },
  });
  assert.deepEqual(data(pages), {
    pages: [{
      id: 'page-1', title: 'Welcome', lastModifiedDateTime: '2025-01-02T03:04:05Z',
    }],
    nextCursor: null,
  });

  const page = await client.callTool({
    name: 'read_page', arguments: { notebookId: 'approved-1', pageId: 'page-1' },
  });
  assert.equal(page.isError, undefined, JSON.stringify(page));
  assert.deepEqual(data(page), {
    id: 'page-1',
    title: 'Welcome',
    lastModifiedDateTime: '2025-01-02T03:04:05Z',
    text: 'Welcome\n\nHello OneNote.',
    truncated: false,
  });
  assert.ok(!JSON.stringify(page).includes('do not include'));
  assert.ok(!JSON.stringify(page).includes('invalid.example'));

  for (const call of [
    { name: 'list_sections', arguments: { notebookId: 'not-approved' } },
    { name: 'list_pages', arguments: { notebookId: 'approved-1', sectionId: 'not-in-notebook' } },
    { name: 'read_page', arguments: { notebookId: 'approved-1', pageId: 'page-outside' } },
    { name: 'list_sections', arguments: { notebookId: 'approved-1', limit: 101 } },
  ]) {
    const response = await client.callTool(call);
    assert.equal(response.isError, true, JSON.stringify(call));
  }
});

test('OneNote Graph refuses malformed pagination cursors before making a request', async () => {
  let calls = 0;
  const graph = new OneNoteGraphClient({
    allowedNotebookIds: ['approved-1'],
    getAccessToken: async () => 'test-token',
    fetch: async () => {
      calls++;
      return Response.json({ value: [] });
    },
  });
  await assert.rejects(graph.listSections('approved-1', 10, 'https://attacker.example/path'), OneNoteError);
  assert.equal(calls, 0);
});

test('OneNote Graph verifies notebook membership before requesting page content', async () => {
  const calls: string[] = [];
  const graph = new OneNoteGraphClient({
    allowedNotebookIds: ['approved-1'],
    getAccessToken: async () => 'test-token',
    fetch: async (input) => {
      const url = new URL(input.toString());
      calls.push(url.pathname);
      return Response.json({
        id: 'page-outside',
        title: 'Outside',
        parentNotebook: { id: 'not-approved' },
        parentSection: { id: 'section-outside' },
      });
    },
  });
  await assert.rejects(graph.readPage('approved-1', 'page-outside'), /not in the approved notebook/u);
  assert.deepEqual(calls, ['/v1.0/me/onenote/pages/page-outside']);
});

test('OneNote entrypoint fails without protocol output when configuration is missing', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/onenote-stdio.ts', import.meta.url))], {
    env: {},
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /Cannot start OneNote MCP server.*ONENOTE_ALLOWED_NOTEBOOK_IDS/u);
});
