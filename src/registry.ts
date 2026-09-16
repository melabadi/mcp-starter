import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

type CatalogEntry = {
  server: {
    name: string;
    version: string;
    remotes?: { type: string; url: string }[];
  };
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      status: string;
      updatedAt: string;
      isLatest: boolean;
    };
  };
};

export function createRegistryServer(mcpServerUrl?: string) {
  const catalog: CatalogEntry[] = JSON.parse(
    readFileSync(new URL('../registry/catalog.json', import.meta.url), 'utf8'),
  );

  if (mcpServerUrl) {
    const endpoint = new URL(mcpServerUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) {
      throw new Error('MCP_SERVER_URL must use HTTPS, except for local development.');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('MCP_SERVER_URL must not contain credentials, query parameters, or a fragment.');
    }
    const demo = catalog.find((entry) => entry.server.name === 'com.example/mcp-setup-demo');
    if (!demo?.server.remotes?.[0]) throw new Error('Demo catalog entry is missing.');
    demo.server.remotes[0].url = endpoint.href;
  }

  return createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET, OPTIONS');
      send(405, { error: 'This registry is read-only. Update the catalog in source control.' });
      return;
    }

    try {
      const url = new URL(request.url ?? '/', 'http://registry.local');
      if (url.pathname === '/healthz') {
        send(200, { status: 'ok', service: 'mcp-registry' });
        return;
      }
      if (url.pathname === '/') {
        send(200, { service: 'MCP Setup Registry', specification: 'v0.1', servers: '/v0.1/servers' });
        return;
      }
      if (url.pathname === '/v0.1/servers') {
        const limitText = url.searchParams.get('limit') ?? '30';
        const cursor = url.searchParams.get('cursor');
        const offsetText = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '0';
        if (!/^\d+$/.test(limitText) || !/^\d+$/.test(offsetText)) {
          send(400, { error: 'Invalid limit or cursor.' });
          return;
        }
        const limit = Number(limitText);
        const offset = Number(offsetText);
        if (limit < 1 || limit > 100 || !Number.isSafeInteger(offset)) {
          send(400, { error: 'Limit must be 1-100 and cursor must be valid.' });
          return;
        }
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const version = url.searchParams.get('version');
        const updatedSince = url.searchParams.get('updated_since');
        if (updatedSince && !Number.isFinite(Date.parse(updatedSince))) {
          send(400, { error: 'Invalid updated_since timestamp.' });
          return;
        }
        const matches = catalog.filter((entry) => {
          const metadata = entry._meta['io.modelcontextprotocol.registry/official'];
          return entry.server.name.toLowerCase().includes(search)
            && (!version || (version === 'latest' ? metadata.isLatest : entry.server.version === version))
            && (!updatedSince || Date.parse(metadata.updatedAt) > Date.parse(updatedSince));
        });
        const servers = matches.slice(offset, offset + limit);
        const nextCursor = offset + limit < matches.length
          ? Buffer.from(String(offset + limit)).toString('base64url')
          : undefined;
        send(200, { servers, metadata: { count: servers.length, nextCursor } });
        return;
      }

      const route = url.pathname.match(/^\/v0\.1\/servers\/(.+)\/versions(?:\/([^/]+))?$/);
      if (route) {
        const name = decodeURIComponent(route[1]);
        const version = route[2] ? decodeURIComponent(route[2]) : undefined;
        const versions = catalog.filter((entry) => entry.server.name === name);
        if (!version && versions.length) {
          send(200, { servers: versions, metadata: { count: versions.length } });
          return;
        }
        const entry = versions.find((candidate) => version === 'latest'
          ? candidate._meta['io.modelcontextprotocol.registry/official'].isLatest
          : candidate.server.version === version);
        if (entry) {
          send(200, entry);
          return;
        }
      }
      send(404, { error: 'Server, version, or route not found.' });
    } catch {
      send(400, { error: 'Malformed registry request.' });
    }
  });
}