import { createMcpHttpServer } from './mcp-server.ts';
import { createRegistryServer } from './registry.ts';

const service = process.argv[2] ?? process.env.SERVICE ?? 'server';
if (service !== 'registry' && service !== 'server') {
  throw new Error('SERVICE must be registry or server.');
}
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? (service === 'registry' ? 3000 : 3001));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535.');
}
if (service === 'registry' && host === '0.0.0.0' && !process.env.MCP_SERVER_URL) {
  throw new Error('MCP_SERVER_URL is required when hosting the registry publicly.');
}
const allowedHosts = [
  'localhost', '127.0.0.1', '[::1]',
  process.env.CONTAINER_APP_HOSTNAME ?? '',
  ...(process.env.ALLOWED_HOSTS ?? '').split(','),
].map((value) => value.trim()).filter(Boolean);

const server = service === 'registry'
  ? createRegistryServer(process.env.MCP_SERVER_URL)
  : createMcpHttpServer({
    allowedHosts,
    allowedOriginHosts: process.env.ALLOWED_ORIGIN_HOSTS?.split(',').map((value) => value.trim()),
  });

server.listen(port, host, () => console.error(`${service} listening on http://${host}:${port}`));
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}