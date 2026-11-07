// SPDX-License-Identifier: GPL-3.0-or-later
// Gate: TS exact-field port (src/fields) vs the Python CLI validation/a/fields.py at the same sample points.
// Metric per field: max pointwise |ts - py| / |py| (complex modulus for complex fields) over points with
// |py| >= 1e-10 max|py| (points closer to a zero of the field are counted and reported normwise only), and the
// normwise max |ts - py| / max |py| over all points. Gate: pointwise <= 1e-12 for every field of every case.
//   node packages/eval/bench/fields-crosscheck.ts [--json]   (runs uv once per case; nice 10)

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateExactField } from '../src/adapters/fields.ts';
import { evaluateFields, FIELD_CASES, type FieldValues } from '../src/fields/index.ts';
import { REPO_ROOT, isoWithOffset, logsDir, timestampStamp, writeUnique } from '../src/node-io.ts';

const lin = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const grid2 = (xs: number[], ys: number[]) => xs.flatMap((x) => ys.map((y) => [x, y]));

export function samplePoints(id: string): number[][] {
  switch (id) {
    case 'SM-01': { // quarter plate, r in [a, 10 a], theta in [0, pi/2]
      const a = 5e-3;
      return lin(1, 10, 8).flatMap((s) => lin(0, Math.PI / 2, 9).map((t) => [s * a * Math.cos(t), s * a * Math.sin(t)]));
    }
    case 'FL-01': return grid2(lin(-0.5, 1.5, 9), lin(-0.5, 1.5, 9));
    case 'FL-01-pois': return grid2(lin(0, 1, 7), lin(0.05, 0.95, 7));
    case 'WO-03': { // inside and outside the sphere (radius 0.525 um), several directions
      const R = 0.525e-6;
      const dirs = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, 1, 0], [1, 1, 1], [-1, 0.5, 0.3], [0.2, -0.7, -0.4]];
      return [0.1, 0.4, 0.8, 0.99, 1.01, 1.5, 2.5, 4].flatMap((s) => dirs.map((d) => {
        const n = Math.hypot(d[0]!, d[1]!, d[2]!);
        return d.map((v) => (v / n) * s * R);
      }));
    }
    case 'EM-04': return grid2([0, 0.005, 0.02, 0.05, 0.08, 0.12, 0.2], lin(-0.12, 0.12, 9));
    case 'AC-03': {
      const dirs = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0.6, 0.3, 0.74], [-0.5, -0.5, 0.2]];
      return [1, 1.2, 2, 3.5].flatMap((s) => dirs.map((d) => { const n = Math.hypot(d[0]!, d[1]!, d[2]!); return d.map((v) => (v / n) * s); }));
    }
    case 'TR-01': return lin(0, 1, 21).map((x) => [x]);
    case 'CP-05': return lin(-100e-9, 100e-9, 21).map((y) => [y]);
    default: throw new Error(id);
  }
}

function modAt(v: FieldValues, i: number): [number, number] {
  return Array.isArray(v) ? [v[i]!, 0] : [v.re[i]!, v.im[i]!];
}
function len(v: FieldValues): number { return Array.isArray(v) ? v.length : v.re.length; }

export interface FieldCheck { case: string; field: string; n: number; n_near_zero: number; max_rel_pointwise: number; max_rel_normwise: number; pass: boolean }

export function compareField(id: string, name: string, ts: FieldValues, py: FieldValues, tol = 1e-12): FieldCheck {
  const n = len(py);
  if (len(ts) !== n) throw new Error(`${id} ${name}: ${len(ts)} vs ${n} values`);
  let mx = 0;
  for (let i = 0; i < n; i++) { const [a, b] = modAt(py, i); mx = Math.max(mx, Math.hypot(a, b)); }
  let pw = 0, nw = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = modAt(py, i), [x, y] = modAt(ts, i);
    const d = Math.hypot(x - a, y - b), m = Math.hypot(a, b);
    nw = Math.max(nw, mx > 0 ? d / mx : d);
    if (m >= 1e-10 * mx && m > 0) pw = Math.max(pw, d / m); else nz++;
  }
  return { case: id, field: name, n, n_near_zero: nz, max_rel_pointwise: pw, max_rel_normwise: nw, pass: pw <= tol && nw <= tol };
}

async function main(): Promise<number> {
  const json = process.argv.includes('--json');
  const started = new Date();
  const rows: FieldCheck[] = [];
  // default parameters for every case, plus variants that exercise other code paths
  const runs: Array<{ id: string; label: string; params?: Record<string, unknown> }> = [
    ...FIELD_CASES.map((id) => ({ id, label: id })),
    { id: 'WO-03', label: 'WO-03[m=1.5+1i]', params: { m_re: 1.5, m_im: 1.0 } },
    { id: 'FL-01', label: 'FL-01[Re=40]', params: { Re: 40.0 } },
    { id: 'TR-01', label: 'TR-01[Pe=100]', params: { Pe: 100.0 } },
  ];
  for (const run of runs) {
    const pts = samplePoints(run.id);
    const ts = evaluateFields(run.id, pts, run.params);
    for (const name of Object.keys(ts.fields)) {
      const py = await evaluateExactField('validation/a/fields.py', run.id, name, pts, { root: REPO_ROOT, ...(run.params ? { params: run.params } : {}) });
      rows.push(compareField(run.label, name, ts.fields[name]!, py.values));
    }
  }
  const pass = rows.every((r) => r.pass);
  const path = writeUnique(logsDir(), `fields-crosscheck-${timestampStamp(started)}`, [{ suffix: '.jsonl', text: [{ kind: 'meta', started_at: isoWithOffset(started), tol_rel: 1e-12, reference: 'validation/a/fields.py', port: 'packages/eval/src/fields' }, ...rows.map((r) => ({ kind: 'field', ...r })), { kind: 'summary', pass, n_fields: rows.length }].map((r) => JSON.stringify(r)).join('\n') + '\n' }])[0]!;
  if (json) process.stdout.write(JSON.stringify({ pass, rows, jsonl: path }) + '\n');
  else {
    for (const r of rows) process.stdout.write(`${r.pass ? 'pass' : 'FAIL'} ${r.case.padEnd(16)} ${r.field.padEnd(10)} n ${String(r.n).padStart(3)} near-zero ${String(r.n_near_zero).padStart(2)} pointwise ${r.max_rel_pointwise.toExponential(2)} normwise ${r.max_rel_normwise.toExponential(2)}\n`);
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${rows.filter((r) => r.pass).length}/${rows.length} fields; records ${path}\n`);
  }
  return pass ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`${(e as Error).stack}\n`); process.exitCode = 1; });
