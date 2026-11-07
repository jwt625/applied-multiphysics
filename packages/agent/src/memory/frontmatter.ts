// SPDX-License-Identifier: GPL-3.0-or-later
// Memory file format: markdown with YAML front matter, one entry per file, editable by the user (R5 s.3.4, s.4.4).
//
//   ---
//   name: units
//   description: Display units the user prefers (um for lengths, degC for temperatures)
//   type: units
//   applies_when: [heat, elastic]        # optional: physics types; empty = always applicable
//   updated: 2026-11-06
//   ---
//   free markdown body; a named config carries a fenced ```yaml block

import { parse as parseYamlText, stringify as stringifyYaml } from 'yaml';
import { ISO_DATE } from '@amp/spec';

export const MEMORY_TYPES = ['sim-type', 'material', 'mesh-defaults', 'solver-defaults', 'units', 'config', 'feedback', 'note'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  appliesWhen: string[];
  /** ISO date of the last write. */
  updated: string;
  body: string;
}

export class MemoryFormatError extends Error {}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseMemoryFile(text: string, fileName?: string): MemoryEntry {
  const m = FM.exec(text);
  if (!m) throw new MemoryFormatError('missing front matter (--- ... ---)');
  let fm: unknown;
  try { fm = parseYamlText(m[1] as string, { schema: 'core', maxAliasCount: 0, uniqueKeys: true }); }
  catch (e) { throw new MemoryFormatError(`front matter: ${(e as Error).message.split('\n')[0]}`); }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw new MemoryFormatError('front matter must be a mapping');
  const o = fm as Record<string, unknown>;
  const allowed = new Set(['name', 'description', 'type', 'applies_when', 'updated']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new MemoryFormatError(`front matter: unknown key '${k.slice(0, 40)}'`);
  const name = o.name;
  if (typeof name !== 'string' || !MEMORY_NAME.test(name)) throw new MemoryFormatError('name: lowercase letters, digits and -, at most 64');
  if (fileName !== undefined && fileName !== `${name}.md`) throw new MemoryFormatError(`name '${name}' does not match the file name`);
  if (typeof o.description !== 'string' || !o.description.trim() || o.description.length > 300) throw new MemoryFormatError('description: non-empty string of at most 300 characters');
  if (typeof o.type !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(o.type)) throw new MemoryFormatError(`type: one of ${MEMORY_TYPES.join(', ')}`);
  const aw = o.applies_when ?? [];
  if (!Array.isArray(aw) || !aw.every((x) => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x))) throw new MemoryFormatError('applies_when: list of physics type names');
  const updated = o.updated instanceof Date ? o.updated.toISOString().slice(0, 10) : o.updated;
  if (typeof updated !== 'string' || !ISO_DATE.test(updated)) throw new MemoryFormatError('updated: ISO date YYYY-MM-DD');
  return { name, description: o.description.trim(), type: o.type as MemoryType, appliesWhen: aw as string[], updated, body: (m[2] as string).replace(/\s+$/, '') };
}

export function formatMemoryFile(e: MemoryEntry): string {
  const fm: Record<string, unknown> = { name: e.name, description: e.description, type: e.type };
  if (e.appliesWhen.length) fm.applies_when = e.appliesWhen;
  fm.updated = e.updated;
  const head = stringifyYaml(fm, { lineWidth: 0, flowCollectionPadding: false, collectionStyle: 'flow' } as never).replace(/\s+$/, '');
  return `---\n${head}\n---\n${e.body.replace(/\s+$/, '')}\n`;
}
