import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod/v4';
import { openNotes } from '../src/notes.ts';

const entrypoint = fileURLToPath(new URL('../src/notes-stdio.ts', import.meta.url));

function data(response: { structuredContent?: unknown }) {
  return z.record(z.string(), z.unknown()).parse(response.structuredContent);
}

async function fixture(context: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mcp-txt-notes-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'notes');
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'alpha.txt'), '\uFEFFDeployment plan\r\nUse MCP.\r\nDEPLOYMENT review');
  await writeFile(path.join(root, 'nested', 'beta.TXT'), 'Other notes\nDeployment complete');
  await writeFile(path.join(root, 'ignore.md'), 'Deployment must not be returned');
  await writeFile(path.join(temporary, 'outside.txt'), 'Outside must not be returned');
  return { temporary, root };
}

test('notes filesystem lists only text files and reads UTF-8 BOM, CRLF and empty notes', async (context) => {
  const { root } = await fixture(context);
  const notes = await openNotes(root);
  const files = await notes.list('');
  assert.deepEqual(files.map((file) => file.path), ['alpha.txt', path.join('nested', 'beta.TXT')]);
  assert.ok(files.every((file) => file.bytes > 0 && !Number.isNaN(Date.parse(file.modifiedAt))));
  assert.deepEqual(await notes.read('alpha.txt'), ['Deployment plan', 'Use MCP.', 'DEPLOYMENT review']);
  assert.deepEqual(await notes.read('nested\\beta.TXT'), ['Other notes', 'Deployment complete']);
  assert.equal((await notes.list('nested')).length, 1);
  await writeFile(path.join(root, 'empty.txt'), '');
  assert.deepEqual(await notes.read('empty.txt'), []);
});

test('notes reject traversal, absolute paths, alternate streams, devices and non-text files', async (context) => {
  const { root } = await fixture(context);
  const notes = await openNotes(root);
  for (const value of [
    '../outside.txt', '..\\outside.txt', 'nested/../../outside.txt',
    '/outside.txt', 'C:\\outside.txt', 'C:outside.txt', '\\\\server\\share\\outside.txt',
    'alpha.txt:secret.txt', 'NUL.txt', 'nested/../alpha.txt', 'nested//beta.TXT',
    'nested./beta.txt', 'nested /beta.txt',
  ]) {
    await assert.rejects(notes.read(value), /relative path/);
  }
  await assert.rejects(notes.list('../'), /relative path/);
  await assert.rejects(notes.read('ignore.md'), /Only .txt/);
  await assert.rejects(openNotes('relative-folder'), /absolute folder/);
  await assert.rejects(openNotes(path.join(root, 'alpha.txt')), /point to a folder/);
  await mkdir(path.join(root, 'directory.txt'));
  await assert.rejects(notes.read('directory.txt'), /regular file|EISDIR|EPERM/);
});

test('notes exclude directory links and refuse to follow junctions outside or inside the root', async (context) => {
  const { root, temporary } = await fixture(context);
  const outside = path.join(temporary, 'external');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'Outside must not be read');
  await symlink(outside, path.join(root, 'external-link'), 'junction');
  await symlink(path.join(root, 'nested'), path.join(root, 'internal-link'), 'junction');
  const notes = await openNotes(root);
  assert.equal((await notes.list('')).length, 2);
  await assert.rejects(notes.read('external-link\\secret.txt'), /links and junctions/);
  await assert.rejects(notes.list('internal-link'), /links and junctions/);
});

test('notes reject oversized and invalid UTF-8 files, and bound directory scan depth', async (context) => {
  const { root } = await fixture(context);
  const notes = await openNotes(root);
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(64 * 1024 + 1, 65));
  await assert.rejects(notes.read('large.txt'), /64 KiB/);
  await writeFile(path.join(root, 'limit.txt'), Buffer.alloc(64 * 1024, 65));
  assert.equal((await notes.read('limit.txt'))[0].length, 64 * 1024);
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  await assert.rejects(notes.read('invalid.txt'), /not valid UTF-8/);
  await mkdir(path.join(root, ...Array<string>(13).fill('deep')), { recursive: true });
  await assert.rejects(notes.list(''), /12 levels/);
});

test('notes bound the total directory entries rather than silently returning partial listings', async (context) => {
  const { root } = await fixture(context);
  for (let index = 0; index < 2000; index++) {
    await writeFile(path.join(root, `entry-${index}.md`), '');
  }
  const notes = await openNotes(root);
  await assert.rejects(notes.list(''), /2000 entries/);
});

test('notes MCP discovers schemas and executes list, read, search and error calls through stdio', async (context) => {
  const { root, temporary } = await fixture(context);
  const client = new Client({ name: 'notes-test', version: '1.0.0' });
  context.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entrypoint], env: { NOTES_ROOT: root },
  }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['list_notes', 'read_note', 'search_notes']);
  assert.ok(tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations?.readOnlyHint));

  const listing = await client.callTool({ name: 'list_notes', arguments: { limit: 1 } });
  assert.equal(listing.isError, undefined);
  assert.equal(data(listing).total, 2);
  assert.equal(data(listing).nextOffset, 1);
  const page = await client.callTool({ name: 'list_notes', arguments: { offset: 1, limit: 1 } });
  assert.equal(data(page).nextOffset, null);
  assert.equal(data(await client.callTool({
    name: 'list_notes', arguments: { directory: 'nested' },
  })).total, 1);

  const read = await client.callTool({
    name: 'read_note', arguments: { path: 'alpha.txt', startLine: 2, maxLines: 1 },
  });
  assert.deepEqual(read.structuredContent, {
    path: 'alpha.txt', lines: [{ line: 2, text: 'Use MCP.' }], totalLines: 3, nextStartLine: 3,
  });
  const last = await client.callTool({
    name: 'read_note', arguments: { path: 'alpha.txt', startLine: 3, maxLines: 10 },
  });
  assert.equal(data(last).nextStartLine, null);
  await writeFile(path.join(root, 'empty.txt'), '');
  const empty = await client.callTool({ name: 'read_note', arguments: { path: 'empty.txt' } });
  assert.deepEqual(data(empty).lines, []);
  assert.equal(data(empty).totalLines, 0);

  const search = await client.callTool({ name: 'search_notes', arguments: { query: 'deployment' } });
  assert.equal(search.isError, undefined);
  const searchData = data(search);
  assert.ok(Array.isArray(searchData.matches));
  assert.equal(searchData.matches.length, 3);
  assert.equal(searchData.truncated, false);
  const bounded = await client.callTool({
    name: 'search_notes', arguments: { query: 'Deployment', maxMatches: 1 },
  });
  assert.equal(data(bounded).truncated, true);
  assert.equal(data(bounded).scannedFiles, 1);
  const sensitive = await client.callTool({
    name: 'search_notes', arguments: { query: 'DEPLOYMENT', caseSensitive: true },
  });
  const sensitiveData = data(sensitive);
  assert.ok(Array.isArray(sensitiveData.matches));
  assert.equal(sensitiveData.matches.length, 1);
  const literal = await client.callTool({ name: 'search_notes', arguments: { query: '.*' } });
  assert.deepEqual(data(literal).matches, []);
  await writeFile(path.join(root, 'long.txt'), `${'a'.repeat(800)}needle${'b'.repeat(800)}`);
  const excerpt = await client.callTool({ name: 'search_notes', arguments: { query: 'needle' } });
  assert.deepEqual(data(excerpt).matches, [{
    path: 'long.txt', line: 1, text: `${'a'.repeat(100)}needle${'b'.repeat(394)}`,
    excerptStartColumn: 701, excerptTruncated: true,
  }]);
  await writeFile(path.join(root, 'unicode.txt'), `${'\u0130'.repeat(800)}needle`);
  const unicode = await client.callTool({ name: 'search_notes', arguments: { query: 'NEEDLE' } });
  const unicodeMatches = z.array(z.object({
    path: z.string(), text: z.string(), excerptStartColumn: z.number(),
  })).parse(data(unicode).matches);
  assert.deepEqual(unicodeMatches.find((match) => match.path === 'unicode.txt'), {
    path: 'unicode.txt', text: `${'\u0130'.repeat(100)}needle`, excerptStartColumn: 701,
  });

  for (const call of [
    { name: 'read_note', arguments: { path: '../outside.txt' } },
    { name: 'read_note', arguments: { path: 'missing.txt' } },
    { name: 'read_note', arguments: { path: 'alpha.txt', startLine: 99 } },
    { name: 'read_note', arguments: { path: 'alpha.txt', maxLines: 201 } },
    { name: 'list_notes', arguments: { limit: 0 } },
    { name: 'search_notes', arguments: { query: '' } },
    { name: 'search_notes', arguments: { query: 'line\nbreak' } },
    { name: 'search_notes', arguments: { query: 'x', maxMatches: 51 } },
  ]) {
    const response = await client.callTool(call);
    assert.equal(response.isError, true, JSON.stringify(call));
    assert.ok(!JSON.stringify(response).includes(temporary), 'errors must not expose absolute filesystem paths');
  }
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(64 * 1024 + 1));
  assert.equal((await client.callTool({
    name: 'search_notes', arguments: { query: 'absent' },
  })).isError, true);
});

test('notes entrypoint defaults to public samples independently of working directory', { timeout: 15_000 }, async (context) => {
  const client = new Client({ name: 'notes-samples-test', version: '1.0.0' });
  context.after(() => client.close());
  const { temporary } = await fixture(context);
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entrypoint], cwd: temporary, env: {},
  }));
  const response = await client.callTool({ name: 'read_note', arguments: { path: 'deployment.txt' } });
  assert.equal(response.isError, undefined);
  assert.match(JSON.stringify(response.structuredContent), /synthetic public demo notes/);
});

test('notes entrypoint fails clearly without protocol output for an invalid configured root', () => {
  const child = spawnSync(process.execPath, [entrypoint], {
    env: { ...process.env, NOTES_ROOT: 'relative-folder' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /Cannot start notes MCP server.*absolute folder/);
});
