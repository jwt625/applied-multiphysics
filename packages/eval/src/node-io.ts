// SPDX-License-Identifier: GPL-3.0-or-later
// Node-only file access: repo root discovery, case discovery, expected JSON lookup, log paths.

import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSES, parseCase, type LoadedCase } from './loader.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface CaseFilter {
  class?: string;
  caseId?: string;
  tag?: string;
}

export function listCaseFiles(root = REPO_ROOT, cls?: string): string[] {
  const out: string[] = [];
  for (const c of CLASSES) {
    if (cls && c !== cls) continue;
    const dir = join(root, 'eval', 'cases', c);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if ((f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('_')) out.push(join(dir, f));
    }
  }
  return out;
}

export function expectedPathFor(root: string, id: string, explicit?: string | null): string {
  return explicit ? join(root, explicit) : join(root, 'eval', 'expected', `${id}.json`);
}

export function loadCaseFile(path: string, root = REPO_ROOT): LoadedCase {
  const text = readFileSync(path, 'utf8');
  const rel = relative(root, path);
  const stem = basename(path).replace(/\.ya?ml$/, '');
  const dirClass = basename(dirname(path));
  // First pass to learn id / explicit expected path; then re-parse with the expected JSON attached.
  const first = parseCase(text, rel, { stem, dirClass });
  const id = typeof first.data?.id === 'string' ? first.data.id : stem;
  const explicit = typeof first.data?.expected === 'string' ? first.data.expected : null;
  const ep = expectedPathFor(root, id, explicit);
  const expectedText = existsSync(ep) ? readFileSync(ep, 'utf8') : null;
  return parseCase(text, rel, { stem, dirClass, expectedText, expectedFile: relative(root, ep) });
}

export function loadCases(filter: CaseFilter = {}, root = REPO_ROOT): LoadedCase[] {
  const files = listCaseFiles(root, filter.class);
  const loaded = files.map((f) => loadCaseFile(f, root));
  return loaded.filter((lc) => {
    const stem = basename(lc.file).replace(/\.ya?ml$/, '');
    if (filter.caseId && lc.data?.id !== filter.caseId && stem !== filter.caseId) return false;
    if (filter.tag) {
      const tags = Array.isArray(lc.data?.physics) ? lc.data.physics : [];
      if (!tags.some((t) => t === filter.tag || t.startsWith(`${filter.tag}-`) || t.split('-').includes(filter.tag!))) return false;
    }
    return true;
  });
}

export function timestampStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** ISO 8601 with local offset, e.g. 2026-11-06T15:20:01-08:00 (C5 startedAt format). */
export function isoWithOffset(d = new Date()): string {
  const p = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(off / 60)}:${p(off % 60)}`;
}

export function logsDir(root = REPO_ROOT): string {
  const d = join(root, 'logs');
  mkdirSync(d, { recursive: true });
  return d;
}

/** Repo commit without running git: read .git/HEAD and the ref file. */
export function repoCommit(root = REPO_ROOT): string {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    const rf = join(root, '.git', ref);
    if (existsSync(rf)) return readFileSync(rf, 'utf8').trim().slice(0, 7);
    const packed = join(root, '.git', 'packed-refs');
    if (existsSync(packed)) {
      const line = readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
      if (line) return line.slice(0, 7);
    }
    return 'nocommit';
  } catch { return 'unknown'; }
}
