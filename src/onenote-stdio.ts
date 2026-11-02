import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createOneNoteTokenProvider } from './onenote-auth.ts';
import { OneNoteComClient } from './onenote-com.ts';
import {
  OneNoteError, OneNoteGraphClient, parseAllowedNotebookIds, parseOneNoteConfig,
  type OneNoteClient,
} from './onenote.ts';
import { buildOneNoteServer } from './onenote-server.ts';

try {
  const backend = process.env.ONENOTE_BACKEND ?? 'com';
  let client: OneNoteClient;
  if (backend === 'com') {
    client = new OneNoteComClient(parseAllowedNotebookIds());
  } else if (backend === 'graph') {
    const config = parseOneNoteConfig();
    client = new OneNoteGraphClient({
      allowedNotebookIds: config.allowedNotebookIds,
      getAccessToken: createOneNoteTokenProvider(config),
    });
  } else {
    throw new OneNoteError('ONENOTE_BACKEND must be com or graph.');
  }
  await serveStdio(() => buildOneNoteServer(client));
} catch (error) {
  const message = error instanceof OneNoteError
    ? error.message
    : 'Unexpected startup error.';
  console.error(`Cannot start OneNote MCP server: ${message}`);
  process.exitCode = 1;
}
