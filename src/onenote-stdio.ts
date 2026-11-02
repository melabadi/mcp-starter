import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createOneNoteTokenProvider } from './onenote-auth.ts';
import { OneNoteError, OneNoteGraphClient, parseOneNoteConfig } from './onenote.ts';
import { buildOneNoteServer } from './onenote-server.ts';

try {
  const config = parseOneNoteConfig();
  const graph = new OneNoteGraphClient({
    allowedNotebookIds: config.allowedNotebookIds,
    getAccessToken: createOneNoteTokenProvider(config),
  });
  await serveStdio(() => buildOneNoteServer(graph));
} catch (error) {
  const message = error instanceof OneNoteError
    ? error.message
    : 'Unexpected startup error.';
  console.error(`Cannot start OneNote MCP server: ${message}`);
  process.exitCode = 1;
}
