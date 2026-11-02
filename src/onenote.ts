import { parse, type DefaultTreeAdapterTypes } from 'parse5';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_VERSION = 'v1.0';
const MAX_NOTEBOOKS = 25;
const MAX_HTML_BYTES = 1024 * 1024;
export const MAX_PAGE_TEXT = 20_000;
const MAX_RETRIES = 2;
const MAX_AUTOMATIC_RETRY_DELAY_MS = 5_000;

export class OneNoteError extends Error {}

export interface OneNoteConfig {
  clientId: string;
  tenantId: string;
  allowedNotebookIds: string[];
}

export interface OneNoteNotebook {
  id: string;
  displayName: string;
}

export interface OneNoteSection {
  id: string;
  displayName: string;
  lastModifiedDateTime?: string;
}

export interface OneNotePage {
  id: string;
  title: string;
  lastModifiedDateTime?: string;
}

export interface PageText {
  id: string;
  title: string;
  lastModifiedDateTime?: string;
  text: string;
  truncated: boolean;
}

export interface OneNoteClient {
  listNotebooks(): Promise<OneNoteNotebook[]>;
  listSections(notebookId: string, limit: number, cursor?: string): Promise<{
    sections: OneNoteSection[];
    nextCursor: string | null;
  }>;
  listPages(notebookId: string, sectionId: string, limit: number, cursor?: string): Promise<{
    pages: OneNotePage[];
    nextCursor: string | null;
  }>;
  readPage(notebookId: string, pageId: string): Promise<PageText>;
}

interface GraphCollection<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

interface GraphOptions {
  allowedNotebookIds: string[];
  getAccessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}

const graphNotebookSchema = {
  parse(value: unknown): OneNoteNotebook {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.displayName !== 'string') {
      throw new OneNoteError('Microsoft Graph returned an invalid notebook.');
    }
    return { id: value.id, displayName: value.displayName };
  },
};

const graphSectionSchema = {
  parse(value: unknown): OneNoteSection {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.displayName !== 'string') {
      throw new OneNoteError('Microsoft Graph returned an invalid section.');
    }
    return {
      id: value.id,
      displayName: value.displayName,
      ...(typeof value.lastModifiedDateTime === 'string'
        ? { lastModifiedDateTime: value.lastModifiedDateTime }
        : {}),
    };
  },
};

const graphPageSchema = {
  parse(value: unknown): OneNotePage {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') {
      throw new OneNoteError('Microsoft Graph returned an invalid page.');
    }
    return {
      id: value.id,
      title: value.title,
      ...(typeof value.lastModifiedDateTime === 'string'
        ? { lastModifiedDateTime: value.lastModifiedDateTime }
        : {}),
    };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OneNoteError(`Invalid ${label}.`);
  }
  return encodeURIComponent(value);
}

function graphPath(...parts: string[]): string {
  return `/${GRAPH_VERSION}/me/onenote/${parts.join('/')}`;
}

function decodeCursor(cursor: string, expectedPath: string): URL {
  try {
    const url = new URL(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (url.origin !== GRAPH_ORIGIN || url.username || url.password
      || url.hash || url.pathname !== expectedPath || !url.pathname.startsWith(`/${GRAPH_VERSION}/`)
      || url.searchParams.getAll('$top').length > 1
      || Number(url.searchParams.get('$top') ?? '100') > 100
      || [...url.searchParams.keys()].some((key) => !['$top', '$skiptoken', '$select'].includes(key))) {
      throw new Error();
    }
    return url;
  } catch {
    throw new OneNoteError('Invalid pagination cursor.');
  }
}

function encodeCursor(nextLink: string, expectedPath: string): string {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    throw new OneNoteError('Microsoft Graph returned an unsafe pagination URL.');
  }
  if (url.origin !== GRAPH_ORIGIN || url.username || url.password || url.hash
    || url.pathname !== expectedPath || !url.pathname.startsWith(`/${GRAPH_VERSION}/`)
    || url.searchParams.getAll('$top').length > 1
    || Number(url.searchParams.get('$top') ?? '100') > 100
    || [...url.searchParams.keys()].some((key) => !['$top', '$skiptoken', '$select'].includes(key))) {
    throw new OneNoteError('Microsoft Graph returned an unsafe pagination URL.');
  }
  const cursor = Buffer.from(url.toString()).toString('base64url');
  if (cursor.length > 8192) {
    throw new OneNoteError('Microsoft Graph returned an oversized pagination URL.');
  }
  return cursor;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const header = response.headers.get('content-length');
  if (header !== null && (!/^\d+$/u.test(header) || Number(header) > maxBytes)) {
    await response.body?.cancel();
    throw new OneNoteError('Microsoft Graph response exceeded the size limit.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new OneNoteError('Microsoft Graph response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new OneNoteError('Microsoft Graph returned invalid UTF-8 data.');
  }
}

function retryDelay(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

export class OneNoteGraphClient {
  private readonly allowedNotebookIds: Set<string>;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GraphOptions) {
    this.allowedNotebookIds = new Set(options.allowedNotebookIds);
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async listNotebooks(): Promise<OneNoteNotebook[]> {
    const notebooks: OneNoteNotebook[] = [];
    for (const notebookId of this.allowedNotebookIds) {
      const path = graphPath('notebooks', safeId(notebookId, 'notebook ID'));
      const response = await this.requestJson(
        path,
        (value) => graphNotebookSchema.parse(value),
        new URLSearchParams({ '$select': 'id,displayName' }),
      );
      if (response.id !== notebookId) {
        throw new OneNoteError('Microsoft Graph returned a notebook outside the configured allowlist.');
      }
      notebooks.push(response);
    }
    return notebooks;
  }

  async listSections(notebookId: string, limit: number, cursor?: string) {
    const notebook = this.authorizeNotebook(notebookId);
    const path = graphPath('notebooks', safeId(notebook, 'notebook ID'), 'sections');
    const page = await this.collection(
      path, limit, 'id,displayName,lastModifiedDateTime', cursor, graphSectionSchema.parse,
    );
    return {
      sections: page.items,
      nextCursor: page.nextCursor,
    };
  }

  async listPages(notebookId: string, sectionId: string, limit: number, cursor?: string) {
    const notebook = this.authorizeNotebook(notebookId);
    const sectionPath = graphPath(
      'notebooks', safeId(notebook, 'notebook ID'), 'sections',
    );
    let sectionCursor: string | undefined;
    let sectionFound = false;
    let couldHaveMoreSections = false;
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      const sections = await this.collection(
        sectionPath, 100, 'id,displayName,lastModifiedDateTime', sectionCursor, graphSectionSchema.parse,
      );
      if (sections.items.some((section) => section.id === sectionId)) {
        sectionFound = true;
        break;
      }
      sectionCursor = sections.nextCursor ?? undefined;
      couldHaveMoreSections = sectionCursor !== undefined;
      if (!couldHaveMoreSections) break;
    }
    if (!sectionFound) {
      throw new OneNoteError(
        couldHaveMoreSections
          ? 'Could not verify the section within the 500-section verification limit.'
          : 'The section is not in the approved notebook.',
      );
    }
    const path = graphPath('sections', safeId(sectionId, 'section ID'), 'pages');
    const page = await this.collection(
      path, limit, 'id,title,lastModifiedDateTime', cursor, graphPageSchema.parse,
    );
    return {
      pages: page.items,
      nextCursor: page.nextCursor,
    };
  }

  async readPage(notebookId: string, pageId: string): Promise<PageText> {
    const notebook = this.authorizeNotebook(notebookId);
    const pagePath = graphPath('pages', safeId(pageId, 'page ID'));
    const metadata = await this.requestJson(pagePath, (value) => {
      if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string'
        || !isRecord(value.parentNotebook)
        || value.parentNotebook.id !== notebook) {
        throw new OneNoteError('The page is not in the approved notebook.');
      }
      return {
        id: value.id,
        title: value.title,
        ...(typeof value.lastModifiedDateTime === 'string'
          ? { lastModifiedDateTime: value.lastModifiedDateTime }
          : {}),
      };
    }, new URLSearchParams({
      '$select': 'id,title,lastModifiedDateTime',
      '$expand': 'parentNotebook,parentSection',
    }));

    const html = await this.requestText(`${pagePath}/content`, MAX_HTML_BYTES);
    const extracted = extractPageText(html);
    return {
      ...metadata,
      text: extracted.text.slice(0, MAX_PAGE_TEXT),
      truncated: extracted.truncated || extracted.text.length > MAX_PAGE_TEXT,
    };
  }

  private authorizeNotebook(notebookId: string): string {
    if (!this.allowedNotebookIds.has(notebookId)) {
      throw new OneNoteError('Notebook is not in the configured allowlist.');
    }
    return notebookId;
  }

  private async collection<T>(
    path: string,
    limit: number,
    select: string,
    cursor: string | undefined,
    parseItem: (value: unknown) => T,
  ) {
    const expectedPath = path;
    const url = cursor
      ? decodeCursor(cursor, expectedPath)
      : new URL(path, GRAPH_ORIGIN);
    if (!cursor) {
      url.searchParams.set('$select', select);
      url.searchParams.set('$top', String(limit));
    }
    const response = await this.requestJsonUrl(url, (value) => {
      if (!isRecord(value) || !Array.isArray(value.value)) {
        throw new OneNoteError('Microsoft Graph returned an invalid collection.');
      }
      const nextLink = value['@odata.nextLink'];
      if (nextLink !== undefined && typeof nextLink !== 'string') {
        throw new OneNoteError('Microsoft Graph returned an invalid pagination link.');
      }
      return {
        items: value.value.map(parseItem),
        nextCursor: typeof nextLink === 'string' ? encodeCursor(nextLink, expectedPath) : null,
      };
    });
    return response;
  }

  private async requestJson<T>(
    path: string,
    parseValue: (value: unknown) => T,
    query = new URLSearchParams(),
  ): Promise<T> {
    const url = new URL(path, GRAPH_ORIGIN);
    url.search = query.toString();
    return this.requestJsonUrl(url, parseValue);
  }

  private async requestJsonUrl<T>(url: URL, parseValue: (value: unknown) => T): Promise<T> {
    const text = await this.requestText(url.toString(), 1024 * 1024);
    try {
      return parseValue(JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof OneNoteError) throw error;
      throw new OneNoteError('Microsoft Graph returned invalid JSON.');
    }
  }

  private async requestText(url: string, maxBytes: number): Promise<string> {
    const target = new URL(url, GRAPH_ORIGIN);
    if (target.origin !== GRAPH_ORIGIN || !target.pathname.startsWith(`/${GRAPH_VERSION}/me/onenote/`)) {
      throw new OneNoteError('Refusing to request a URL outside Microsoft Graph OneNote.');
    }
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      let accessToken: string;
      try {
        accessToken = await this.getAccessToken();
      } catch (error) {
        if (error instanceof OneNoteError) throw error;
        throw new OneNoteError('Unable to acquire a Microsoft Graph access token.');
      }
      try {
        response = await this.fetchImpl(target, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: target.pathname.endsWith('/content') ? 'text/html' : 'application/json',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new OneNoteError('Unable to reach Microsoft Graph.');
      }

      if (!response.ok) await response.body?.cancel();
      if (response.status === 429 || response.status === 503) {
        const delay = retryDelay(response);
        if (attempt < MAX_RETRIES && delay !== undefined && delay <= MAX_AUTOMATIC_RETRY_DELAY_MS) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new OneNoteError(
          delay === undefined
            ? `Microsoft Graph throttled the request (HTTP ${response.status}).`
            : `Microsoft Graph throttled the request (HTTP ${response.status}); retry after ${Math.ceil(delay / 1000)} seconds.`,
        );
      }
      if (!response.ok) {
        const detail = response.status === 401
          ? 'Authentication failed (HTTP 401). Sign in again and confirm delegated Notes.Read consent.'
          : response.status === 403
            ? 'Access denied (HTTP 403). Confirm delegated Notes.Read consent and notebook access.'
            : `Request failed (HTTP ${response.status}).`;
        throw new OneNoteError(`Microsoft Graph: ${detail}`);
      }
      return readBoundedBody(response, maxBytes);
    }
    throw new OneNoteError('Microsoft Graph request retry limit reached.');
  }
}

type HtmlNode = DefaultTreeAdapterTypes.Node;

export function extractPageText(html: string): { text: string; truncated: boolean } {
  const document = parse(html);
  const output: string[] = [];
  let characterCount = 0;
  let truncated = false;
  const blockTags = new Set(['address', 'article', 'blockquote', 'br', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
  const ignoredTags = new Set(['head', 'script', 'style', 'svg', 'template']);

  function walk(node: HtmlNode): void {
    if ('value' in node) {
      const value = node.value.replace(/\s+/gu, ' ');
      if (!value) return;
      const excerpt = value.slice(0, MAX_PAGE_TEXT + 1 - characterCount);
      output.push(excerpt);
      characterCount += excerpt.length;
      if (excerpt.length < value.length) truncated = true;
      return;
    }
    if ('tagName' in node && ignoredTags.has(node.tagName)) return;
    if (!('childNodes' in node)) return;
    const isBlock = 'tagName' in node && blockTags.has(node.tagName);
    if (isBlock) output.push('\n');
    for (const child of node.childNodes) {
      walk(child);
      if (truncated) break;
    }
    if (isBlock) output.push('\n');
  }

  walk(document);
  return {
    text: output.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim(),
    truncated,
  };
}

export function parseAllowedNotebookIds(env: NodeJS.ProcessEnv = process.env): string[] {
  let allowedNotebookIds: unknown;
  try {
    allowedNotebookIds = JSON.parse(env.ONENOTE_ALLOWED_NOTEBOOK_IDS ?? '');
  } catch {
    throw new OneNoteError('ONENOTE_ALLOWED_NOTEBOOK_IDS must be a JSON array of notebook IDs.');
  }
  if (!Array.isArray(allowedNotebookIds) || allowedNotebookIds.length < 1
    || allowedNotebookIds.length > MAX_NOTEBOOKS
    || !allowedNotebookIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512)
    || new Set(allowedNotebookIds).size !== allowedNotebookIds.length) {
    throw new OneNoteError(
      `ONENOTE_ALLOWED_NOTEBOOK_IDS must be a JSON array of 1-${MAX_NOTEBOOKS} unique notebook IDs.`,
    );
  }
  return allowedNotebookIds;
}

export function parseOneNoteConfig(env: NodeJS.ProcessEnv = process.env): OneNoteConfig {
  const allowedNotebookIds = parseAllowedNotebookIds(env);
  const clientId = env.ONENOTE_CLIENT_ID?.trim() ?? '';
  const tenantId = env.ONENOTE_TENANT_ID?.trim() || 'organizations';
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(clientId)) {
    throw new OneNoteError('ONENOTE_CLIENT_ID must be an application client ID in GUID format.');
  }
  if (!/^[a-z0-9.-]{1,253}$/iu.test(tenantId) || tenantId.includes('..')) {
    throw new OneNoteError('ONENOTE_TENANT_ID must be a tenant ID, domain, or organizations.');
  }
  return { clientId, tenantId, allowedNotebookIds };
}
