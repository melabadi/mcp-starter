import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from './mcp-server.ts';

await serveStdio(buildMcpServer);