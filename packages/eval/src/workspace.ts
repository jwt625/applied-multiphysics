// SPDX-License-Identifier: GPL-3.0-or-later
// Resolve sibling workspace packages (@amp/physics, @amp/core, ...) by file path, so the harness works before and
// after `pnpm install` links them. Returns null with a reason when the package is not there yet.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './node-io.ts';

/** absent: the package directory does not exist (a legitimate pre-landing state); otherwise a null mod is a broken package. */
export interface Resolved<T = Record<string, unknown>> { mod: T | null; reason: string; path?: string; version?: string; absent?: boolean }

function entryOf(pkg: Record<string, unknown>, sub: string): string | undefined {
  const ex = pkg.exports as unknown;
  const key = sub === '' ? '.' : `./${sub}`;
  const pick = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return pick(o.import ?? o.node ?? o.default ?? o.types);
    }
    return undefined;
  };
  if (typeof ex === 'string' && sub === '') return ex;
  if (ex && typeof ex === 'object') {
    const o = ex as Record<string, unknown>;
    if (key in o) return pick(o[key]);
    for (const [k, v] of Object.entries(o)) {
      // subpath pattern, e.g. "./la/*": { "default": "./src/la/*.mjs" }
      const star = k.indexOf('*');
      if (star < 0) continue;
      const pre = k.slice(0, star), post = k.slice(star + 1);
      if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
        const mid = key.slice(pre.length, key.length - post.length);
        const target = pick(v);
        if (target) return target.replace('*', mid);
      }
    }
    if (sub === '' && !Object.keys(o).some((k) => k.startsWith('.'))) return pick(o);
  }
  if (sub === '') return (pkg.module as string | undefined) ?? (pkg.main as string | undefined);
  return undefined;
}

/** name: '@amp/<dir>' with optional subpath, e.g. '@amp/core' or '@amp/core/la'. */
export async function importWorkspace<T = Record<string, unknown>>(spec: string, root = REPO_ROOT): Promise<Resolved<T>> {
  const m = /^@amp\/([a-z0-9-]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return { mod: null, reason: `not a workspace package: ${spec}` };
  const dir = join(root, 'packages', m[1]!);
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) return { mod: null, reason: `${spec}: packages/${m[1]}/package.json not found`, absent: true };
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(readFileSync(pj, 'utf8')); } catch (e) { return { mod: null, reason: `${spec}: bad package.json (${(e as Error).message})` }; }
  const candidates = [entryOf(pkg, m[2] ?? ''), ...(m[2] ? [] : ['src/index.ts', 'src/index.mjs', 'index.mjs', 'index.ts'])].filter(Boolean) as string[];
  for (const c of candidates) {
    const p = join(dir, c);
    if (!existsSync(p)) continue;
    try {
      const mod = (await import(pathToFileURL(p).href)) as T;
      return { mod, reason: 'ok', path: p, version: String(pkg.version ?? '0.0.0') };
    } catch (e) {
      return { mod: null, reason: `${spec}: import of ${c} failed: ${(e as Error).message.split('\n')[0]}`, path: p };
    }
  }
  return { mod: null, reason: `${spec}: no entry file found (${candidates.join(', ') || 'no exports'})` };
}
