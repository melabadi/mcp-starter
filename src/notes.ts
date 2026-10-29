import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 12;

export class NotesError extends Error {}

function relativePath(value: string) {
  if (!value) return '';
  const parts = value.split(/[\\/]/);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || parts.some((part) => !part || part === '.' || part === '..'
      || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new NotesError('Use a relative path inside the notes folder, without traversal or special device names.');
  }
  return parts.join(path.sep);
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function openNotes(root: string) {
  if (!path.isAbsolute(root)) throw new NotesError('NOTES_ROOT must be an absolute folder path.');
  const base = await realpath(root);
  if (!(await stat(base)).isDirectory()) throw new NotesError('NOTES_ROOT must point to a folder.');
  await (await opendir(base)).close();

  async function resolveSafe(value: string) {
    const relative = relativePath(value);
    let target = base;
    for (const part of relative ? relative.split(path.sep) : []) {
      target = path.join(target, part);
      if ((await lstat(target)).isSymbolicLink()) {
        throw new NotesError('Symbolic links and junctions are not readable notes paths.');
      }
      if (!inside(base, await realpath(target))) {
        throw new NotesError('The requested path is outside the notes folder.');
      }
    }
    return target;
  }

  async function list(directory: string) {
    const start = await resolveSafe(directory);
    if (!(await stat(start)).isDirectory()) throw new NotesError('The directory must be a folder.');
    const notes: { path: string; bytes: number; modifiedAt: string }[] = [];
    let entriesSeen = 0;
    async function walk(folder: string, depth: number): Promise<void> {
      for await (const entry of await opendir(folder)) {
        entriesSeen++;
        if (entriesSeen > MAX_ENTRIES) {
          throw new NotesError(`Folder scan exceeds ${MAX_ENTRIES} entries. Choose a narrower directory.`);
        }
        if (entry.isSymbolicLink()) continue;
        const relative = path.relative(base, path.join(folder, entry.name));
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH) {
            throw new NotesError(`Folder scan exceeds ${MAX_DEPTH} levels. Choose a narrower directory.`);
          }
          await walk(await resolveSafe(relative), depth + 1);
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.txt') {
          const info = await stat(await resolveSafe(relative));
          notes.push({ path: relative, bytes: info.size, modifiedAt: info.mtime.toISOString() });
        }
      }
    }
    await walk(start, 0);
    return notes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  async function read(value: string) {
    if (path.extname(value).toLowerCase() !== '.txt') throw new NotesError('Only .txt notes can be read.');
    const target = await resolveSafe(value);
    if (!(await lstat(target)).isFile()) throw new NotesError('The note must be a regular file.');
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new NotesError('The note must be a regular file.');
      if (info.size > MAX_FILE_BYTES) throw new NotesError('Notes must be no larger than 64 KiB.');
      // Read one extra byte so a file that grows after stat cannot bypass the limit.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) throw new NotesError('Notes must be no larger than 64 KiB.');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new NotesError('The note is not valid UTF-8. Save it as UTF-8 text before reading.');
      }
      return text === '' ? [] : text.split(/\r\n|\n|\r/);
    } finally {
      await handle.close();
    }
  }

  return { list, read };
}

export function notesErrorMessage(error: unknown) {
  if (error instanceof NotesError) return error.message;
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
  return `Notes operation failed (${code}). Check that the folder or note exists and is readable.`;
}
