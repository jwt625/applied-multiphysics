// SPDX-License-Identifier: GPL-3.0-or-later
// Node loader for the repository's materials/ directory (DevLog-013). Browser builds load the YAML texts themselves
// (e.g. Vite import.meta.glob('materials/*.yaml', {query: '?raw'})) and call parseMaterialText + createLibrary.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parseMaterialText, type Issue } from './validate.ts';
import { createLibrary, type Library, type EvalOptions, type PropertyValue } from './library.ts';
import type { MaterialDoc } from './schema.ts';

export const DEFAULT_MATERIALS_DIR = resolve(import.meta.dirname, '../../../materials');

export interface LoadReport { files: string[]; docs: MaterialDoc[]; issues: Array<Issue & { file: string }> }

export function loadMaterialsDir(dir: string = DEFAULT_MATERIALS_DIR): LoadReport {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  const docs: MaterialDoc[] = [];
  const issues: LoadReport['issues'] = [];
  for (const f of files) {
    const r = parseMaterialText(readFileSync(join(dir, f), 'utf8'), basename(f, '.yaml'));
    for (const i of r.issues) issues.push({ ...i, file: f });
    if (r.ok && r.doc) docs.push(r.doc);
  }
  return { files, docs, issues };
}

/** Load and validate; throws listing every issue when any file is invalid. */
export function loadLibrary(dir: string = DEFAULT_MATERIALS_DIR): Library {
  const r = loadMaterialsDir(dir);
  if (r.issues.length) throw new Error(`materials invalid:\n${r.issues.map((i) => `  ${i.file}: ${i.path}: ${i.message}`).join('\n')}`);
  return createLibrary(r.docs);
}

let cached: Library | undefined;
/** Default library from the repository's materials/ (loaded once). */
export function defaultLibrary(): Library {
  cached ??= loadLibrary();
  return cached;
}

/** getProperty on the default library: `getProperty('copper', 'k', {T: 300})` -> {value, unit, source, ...} (SI). */
export function getProperty(materialId: string, prop: string, opts: EvalOptions = {}): PropertyValue {
  return defaultLibrary().getProperty(materialId, prop, opts);
}
