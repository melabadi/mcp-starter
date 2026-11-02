import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { OneNoteGraphClient } from '../../src/onenote.ts';
import { buildOneNoteServer } from '../../src/onenote-server.ts';

const requests: string[] = [];

const mockFetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (new Headers(init?.headers).get('authorization') !== 'Bearer test-token') {
    return new Response('Unauthorized', { status: 401 });
  }
  if (url.pathname === '/v1.0/me/onenote/notebooks/approved-1') {
    return Response.json({ id: 'approved-1', displayName: 'Demo notebook' });
  }
  if (url.pathname === '/v1.0/me/onenote/notebooks/approved-1/sections') {
    return Response.json({ value: [{ id: 'section-1', displayName: 'General' }] });
  }
  if (url.pathname === '/v1.0/me/onenote/sections/section-1/pages') {
    return Response.json({
      value: [{ id: 'page-1', title: 'Welcome', lastModifiedDateTime: '2025-01-02T03:04:05Z' }],
    });
  }
  if (url.pathname === '/v1.0/me/onenote/pages/page-1') {
    return Response.json({
      id: 'page-1',
      title: 'Welcome',
      lastModifiedDateTime: '2025-01-02T03:04:05Z',
      parentNotebook: { id: 'approved-1' },
      parentSection: { id: 'section-1' },
    });
  }
  if (url.pathname === '/v1.0/me/onenote/pages/page-1/content') {
    return new Response(
      '<html><head><title>Hidden</title><script>do not include</script></head><body><h1>Welcome</h1><p>Hello <b>OneNote</b>.</p><img src="https://invalid.example/private"><style>hidden</style></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
  if (url.pathname === '/v1.0/me/onenote/pages/page-outside') {
    return Response.json({
      id: 'page-outside',
      title: 'Outside',
      parentNotebook: { id: 'not-approved' },
      parentSection: { id: 'section-outside' },
    });
  }
  return new Response('Not found', { status: 404 });
};

const graph = new OneNoteGraphClient({
  allowedNotebookIds: ['approved-1'],
  getAccessToken: async () => 'test-token',
  fetch: mockFetch,
});

await serveStdio(() => buildOneNoteServer(graph));
