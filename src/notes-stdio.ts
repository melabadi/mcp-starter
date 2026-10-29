import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildNotesServer } from './notes-server.ts';
import { notesErrorMessage } from './notes.ts';

const root = process.env.NOTES_ROOT ?? fileURLToPath(new URL('../examples/notes/', import.meta.url));

try {
  const server = await buildNotesServer(root);
  await serveStdio(() => server);
} catch (error) {
  console.error(`Cannot start notes MCP server: ${notesErrorMessage(error)}`);
  process.exitCode = 1;
}
