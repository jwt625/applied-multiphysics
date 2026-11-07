// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers of the em-modes gates (WO-01, WO-02): case loading (eval/cases YAML via @amp/spec parseYaml),
// Richardson via the harness metrics (@amp/eval, read-only import), JSONL log in logs/ with a timestamp, load check.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { parseYaml } from '@amp/spec';
import { richardson, hFromDof } from '../../eval/src/metrics.ts';
import type { Solution } from '@amp/spec/types';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function readCase(cls: string, id: string): Record<string, any> {
  const r = parseYaml(readFileSync(join(REPO, 'eval', 'cases', cls, `${id}.yaml`), 'utf8'));
  if (!r.data) throw new Error(`cannot parse case ${id}`);
  return r.data as Record<string, any>;
}
export function readExpected(id: string): Record<string, any> {
  return JSON.parse(readFileSync(join(REPO, 'eval', 'expected', `${id}.json`), 'utf8'));
}

export const stamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export class GateLog {
  path: string;
  constructor(name: string) {
    mkdirSync(join(REPO, 'logs'), { recursive: true });
    this.path = join(REPO, 'logs', `l4-${name}-${stamp()}.jsonl`);
    writeFileSync(this.path, '');
  }
  write(rec: Record<string, unknown>): void { appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`); }
}

/** Wait (poll every 5 s, at most 5 min) while the 1-minute load average is above maxLoad. */
export async function waitForLoad(maxLoad = 10): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const l = loadavg()[0]!;
    if (l <= maxLoad) return l;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return loadavg()[0]!;
}

export interface LevelRow { level: number; dof: number; h: number; value: number; err: number; stages: Record<string, number>; wall_ms: number }

/** Richardson over levels (coarse -> fine) with h from the DOF count (2D). */
export function extrapolate(rows: LevelRow[]) {
  const f = rows.map((r) => r.value), h = rows.map((r) => r.h);
  return richardson(f, h);
}
export { hFromDof };

export function stagesOf(sol: Solution): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(sol.timing)) o[k] = Math.round(v * 10) / 10;
  return o;
}

export const fmt = (v: number, d = 3) => (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5 ? v.toExponential(d) : v.toFixed(d + 2));
