import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as z from 'zod/v4';
import {
  extractPageText, MAX_PAGE_TEXT, OneNoteError, parseAllowedNotebookIds,
  type OneNoteClient, type PageText,
} from './onenote.ts';

const execute = promisify(execFile);
const bridge = fileURLToPath(new URL('../scripts/onenote-com.ps1', import.meta.url));
const notebookSchema = z.object({ id: z.string().min(1), displayName: z.string() });
const sectionSchema = notebookSchema.extend({ lastModifiedDateTime: z.string().optional() });
const pageSchema = z.object({
  id: z.string().min(1), title: z.string(), lastModifiedDateTime: z.string().optional(),
});
const cursorSchema = z.object({ scope: z.string(), offset: z.number().int().nonnegative() });

export interface OneNoteComRequest {
  action: 'notebooks' | 'sections' | 'pages' | 'page';
  allowedNotebookIds: string[];
  notebookId?: string;
  sectionId?: string;
  pageId?: string;
}

export type OneNoteComRunner = (request: OneNoteComRequest) => Promise<unknown>;

async function runCom(request: OneNoteComRequest): Promise<unknown> {
  if (process.platform !== 'win32' || !process.env.SystemRoot) {
    throw new OneNoteError('OneNote COM requires Windows and the installed OneNote desktop application.');
  }
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'RemoteSigned',
    '-File', bridge, '-Action', request.action,
  ];
  for (const [parameter, value] of [
    ['NotebookId', request.notebookId], ['SectionId', request.sectionId], ['PageId', request.pageId],
  ]) {
    if (value !== undefined) args.push(`-${parameter}`, value);
  }
  let stdout: string;
  try {
    ({ stdout } = await execute(join(
      process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    ), args, {
      env: { ...process.env, ONENOTE_ALLOWED_NOTEBOOK_IDS: JSON.stringify(request.allowedNotebookIds) },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new OneNoteError(stderr.startsWith('OneNote COM:')
      ? stderr.slice(0, 512)
      : 'OneNote COM bridge failed or exceeded its 30-second/2-MiB limit. Open OneNote desktop and retry.');
  }
  try {
    return JSON.parse(stdout.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    throw new OneNoteError('OneNote COM bridge returned invalid JSON.');
  }
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OneNoteError('OneNote COM bridge returned an invalid response.');
  return parsed.data;
}

function pageOffset(limit: number, cursor: string | undefined, scope: string): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new OneNoteError('Limit must be an integer from 1 to 100.');
  }
  if (cursor === undefined) return 0;
  try {
    if (cursor.length > 8192 || !/^[\w-]+$/u.test(cursor)) throw new Error();
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.scope !== scope || !Number.isSafeInteger(parsed.offset)) throw new Error();
    return parsed.offset;
  } catch {
    throw new OneNoteError('Invalid pagination cursor for this OneNote notebook or section.');
  }
}

function paginate<T extends { id: string }>(items: T[], offset: number, limit: number, scope: string) {
  items.sort((left, right) => left.id.localeCompare(right.id));
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length
      ? Buffer.from(JSON.stringify({ scope, offset: next })).toString('base64url')
      : null,
  };
}

export class OneNoteComClient implements OneNoteClient {
  private readonly allowedNotebookIds: string[];
  private readonly run: OneNoteComRunner;

  constructor(allowedNotebookIds: string[], run: OneNoteComRunner = runCom) {
    this.allowedNotebookIds = parseAllowedNotebookIds({
      ONENOTE_ALLOWED_NOTEBOOK_IDS: JSON.stringify(allowedNotebookIds),
    });
    this.run = run;
  }

  async listNotebooks() {
    const response = parseResponse(z.object({
      notebooks: z.array(notebookSchema).max(25),
    }), await this.run({ action: 'notebooks', allowedNotebookIds: this.allowedNotebookIds }));
    if (response.notebooks.length !== this.allowedNotebookIds.length
      || new Set(response.notebooks.map((notebook) => notebook.id)).size !== this.allowedNotebookIds.length
      || response.notebooks.some((notebook) => !this.allowedNotebookIds.includes(notebook.id))) {
      throw new OneNoteError('OneNote COM returned notebooks outside the configured allowlist or omitted an approved notebook.');
    }
    return response.notebooks;
  }

  async listSections(notebookId: string, limit: number, cursor?: string) {
    this.authorize(notebookId);
    const scope = JSON.stringify(['sections', notebookId]);
    const offset = pageOffset(limit, cursor, scope);
    const response = parseResponse(z.object({ sections: z.array(sectionSchema).max(2000) }),
      await this.run({ action: 'sections', allowedNotebookIds: this.allowedNotebookIds, notebookId }));
    const page = paginate(response.sections, offset, limit, scope);
    return { sections: page.items, nextCursor: page.nextCursor };
  }

  async listPages(notebookId: string, sectionId: string, limit: number, cursor?: string) {
    this.authorize(notebookId);
    const scope = JSON.stringify(['pages', notebookId, sectionId]);
    const offset = pageOffset(limit, cursor, scope);
    const response = parseResponse(z.object({ pages: z.array(pageSchema).max(2000) }),
      await this.run({ action: 'pages', allowedNotebookIds: this.allowedNotebookIds, notebookId, sectionId }));
    const page = paginate(response.pages, offset, limit, scope);
    return { pages: page.items, nextCursor: page.nextCursor };
  }

  async readPage(notebookId: string, pageId: string): Promise<PageText> {
    this.authorize(notebookId);
    const response = parseResponse(pageSchema.extend({ html: z.string().max(1024 * 1024) }),
      await this.run({ action: 'page', allowedNotebookIds: this.allowedNotebookIds, notebookId, pageId }));
    if (response.id !== pageId) throw new OneNoteError('OneNote COM returned a different page.');
    const { html, ...metadata } = response;
    const extracted = extractPageText(html);
    return {
      ...metadata,
      text: extracted.text.slice(0, MAX_PAGE_TEXT),
      truncated: extracted.truncated || extracted.text.length > MAX_PAGE_TEXT,
    };
  }

  private authorize(notebookId: string) {
    if (!this.allowedNotebookIds.includes(notebookId)) {
      throw new OneNoteError('Notebook is not in the configured allowlist.');
    }
  }
}
