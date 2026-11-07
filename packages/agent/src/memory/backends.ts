// SPDX-License-Identifier: GPL-3.0-or-later
// Storage backends for memory files: in memory (tests), a browser directory handle (OPFS root, or a folder the user
// picked with the File System Access API, used for export/import), and a Node directory (./node-backend.ts, kept
// separate so browser bundles never import node:fs). All backends hold flat files with safe names.

export interface MemoryBackend {
  readonly label: string;
  list(): Promise<string[]>;
  read(file: string): Promise<string | null>;
  write(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
}

export const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export function checkFileName(file: string): void {
  if (!FILE_NAME.test(file) || file.includes('..')) throw new Error(`invalid memory file name ${JSON.stringify(file.slice(0, 80))}`);
}

export function memoryBackend(seed: Record<string, string> = {}): MemoryBackend & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    label: 'memory',
    files,
    list: async () => [...files.keys()].sort(),
    read: async (f) => { checkFileName(f); return files.get(f) ?? null; },
    write: async (f, t) => { checkFileName(f); files.set(f, t); },
    remove: async (f) => { checkFileName(f); files.delete(f); },
  };
}

/** Backend over a FileSystemDirectoryHandle: the OPFS root (opfsBackend) or a user-picked folder. */
export function directoryHandleBackend(dir: FileSystemDirectoryHandle, label = `dir:${dir.name}`): MemoryBackend {
  return {
    label,
    async list() {
      const out: string[] = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'file' && FILE_NAME.test(name)) out.push(name);
      return out.sort();
    },
    async read(f) {
      checkFileName(f);
      try { return await (await (await dir.getFileHandle(f)).getFile()).text(); }
      catch (e) { if ((e as DOMException).name === 'NotFoundError') return null; throw e; }
    },
    async write(f, t) {
      checkFileName(f);
      const w = await (await dir.getFileHandle(f, { create: true })).createWritable();
      await w.write(t);
      await w.close();
    },
    async remove(f) {
      checkFileName(f);
      try { await dir.removeEntry(f); } catch (e) { if ((e as DOMException).name !== 'NotFoundError') throw e; }
    },
  };
}

/** Origin Private File System directory `amp-memory` (browser). */
export async function opfsBackend(subdir = 'amp-memory'): Promise<MemoryBackend> {
  const root = await navigator.storage.getDirectory();
  return directoryHandleBackend(await root.getDirectoryHandle(subdir, { create: true }), `opfs:${subdir}`);
}
