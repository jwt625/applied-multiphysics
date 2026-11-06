// SPDX-License-Identifier: GPL-3.0-or-later
// Exact-field evaluator bridge to validation/a/fields.py (lane L7a): points in, values out.
//   cd validation && uv run python a/fields.py <CASE> --points pts.json --out vals.json
// pts.json: {"points": [[x, y(, z)], ...], "params": {...}}; output {"fields": {name: [..] | {re, im}}, "units": {...}}.
// Used for field targets (extract.kind = field, extract.evaluator): the engine samples its field at the same points
// and metrics.fieldError compares them (L2 and max).

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '../node-io.ts';

export interface ExactField { values: number[] | { re: number[]; im: number[] }; unit: string | undefined; generator: string; versions?: unknown }

export async function evaluateExactField(
  evaluator: string, caseId: string, field: string, points: number[][],
  opts: { params?: Record<string, unknown>; root?: string; timeoutMs?: number } = {},
): Promise<ExactField> {
  const root = opts.root ?? REPO_ROOT;
  const vdir = join(root, 'validation');
  const script = relative(vdir, join(root, evaluator));
  const tmp = mkdtempSync(join(tmpdir(), 'amp-eval-fields-'));
  try {
    const pin = join(tmp, 'pts.json'), pout = join(tmp, 'vals.json');
    writeFileSync(pin, JSON.stringify({ points, ...(opts.params ? { params: opts.params } : {}) }));
    const env = { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2' };
    const res = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const ch = spawn('nice', ['-n', '10', 'uv', 'run', 'python', script, caseId, '--points', pin, '--out', pout], { cwd: vdir, env, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
      let err = '';
      ch.stderr.on('data', (d) => (err += d));
      ch.on('error', (e) => resolve({ code: -1, err: err + String(e) }));
      ch.on('close', (code) => resolve({ code, err }));
    });
    if (res.code !== 0) throw new Error(`${evaluator} ${caseId} exit ${res.code}: ${res.err.trim().split('\n').slice(-2).join(' | ')}`);
    const out = JSON.parse(readFileSync(pout, 'utf8')) as { fields?: Record<string, ExactField['values']>; units?: Record<string, string>; generator?: string; versions?: unknown };
    const v = out.fields?.[field];
    if (v === undefined) throw new Error(`${evaluator} ${caseId}: no field '${field}' (has ${Object.keys(out.fields ?? {}).join(', ')})`);
    return { values: v, unit: out.units?.[field], generator: out.generator ?? evaluator, versions: out.versions };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
