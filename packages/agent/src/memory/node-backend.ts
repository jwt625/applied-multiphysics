// SPDX-License-Identifier: GPL-3.0-or-later
// Node directory backend for memory files (export `@amp/agent/node`). Writes go to a temp file and are renamed into
// place, so a crash never leaves a half-written memory file.

import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkFileName, FILE_NAME, type MemoryBackend } from './backends.ts';

export async function nodeDirBackend(dir: string): Promise<MemoryBackend> {
  await mkdir(dir, { recursive: true });
  return {
    label: `dir:${dir}`,
    async list() { return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && FILE_NAME.test(d.name)).map((d) => d.name).sort(); },
    async read(f) {
      checkFileName(f);
      try { return await readFile(join(dir, f), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    async write(f, t) {
      checkFileName(f);
      const tmp = join(dir, `.${f}.tmp-${process.pid}`);
      await writeFile(tmp, t, 'utf8');
      await rename(tmp, join(dir, f));
    },
    async remove(f) { checkFileName(f); await rm(join(dir, f), { force: true }); },
  };
}
