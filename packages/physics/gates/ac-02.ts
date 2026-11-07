// SPDX-License-Identifier: GPL-3.0-or-later
// Gate AC-02 (hero H6): rigid box 1.0 x 0.8 x 0.6 m, c from eval/cases/a/AC-02.yaml; the ten lowest non-zero modes of
// eval/expected/AC-02.json, rel 1e-4 after Richardson (case tolerance). Structured box meshes (5 s, 4 s, 3 s) cells,
// h = 0.2 m / s: tet10 (P2, gated) and hex8 (Q1, informative). The zero (constant-pressure) mode is dropped before
// matching (case definition "non-zero mode, ascending").
// Run: cd packages/physics && nice -n 10 node --max-old-space-size=1536 gates/ac-02.ts [--levels 1,2,3] [--cell tet10]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '@amp/spec';
import { boxMesh } from '../src/common/mesh.ts';
import { solveAcousticModes } from '../src/acoustics/index.ts';
import { richardson } from '../../eval/src/metrics.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const cells = arg('cell', 'tet10,hex8').split(',') as Array<'tet10' | 'hex8' | 'tet4'>;
const kase = parseYaml(readFileSync(join(ROOT, 'eval/cases/a/AC-02.yaml'), 'utf8')).data as { geometry: { spec: { box_m: number[] } }; materials: { air: { c: number } }; study: { shift: number } };
const exp = JSON.parse(readFileSync(join(ROOT, 'eval/expected/AC-02.json'), 'utf8')) as { targets: Array<{ metric_id: string; value: number }> };
const [Lx, Ly, Lz] = kase.geometry.spec.box_m as [number, number, number];
const c = kase.materials.air.c;
const refs = exp.targets.filter((t) => /^f_mode\d+$/.test(t.metric_id));
const tolRel = 1e-4;
const pad = (x: number) => String(x).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const logPath = join(ROOT, `logs/l4-ac02-${stamp}.jsonl`);
const lines: string[] = [];
let gatePass = true;
const summary: Record<string, unknown> = {};
for (const cell of cells) {
  const levels = arg('levels', cell === 'hex8' ? '2,4,6' : '1,2,3').split(',').map(Number);
  const rows: Array<{ s: number; dof: number; wall: number; timing: Record<string, number>; f: number[] }> = [];
  console.log(`\n${cell}`);
  for (const s of levels) {
    const t0 = performance.now();
    const mesh = boxMesh({ x: [0, Lx], y: [0, Ly], z: [0, Lz], nx: 5 * s, ny: 4 * s, nz: 3 * s, cell });
    const tMesh = performance.now() - t0;
    const nc = mesh.cells.conn.length / ({ tet10: 10, hex8: 8, tet4: 4 } as const)[cell];
    const sol = await solveAcousticModes({ mesh, c: new Float64Array(nc).fill(c), nModes: refs.length + 1, shiftHz: kase.study.shift });
    const wall = performance.now() - t0;
    const f = Array.from(sol.steps!.values).filter((x) => x > 0);
    rows.push({ s, dof: sol.stats.dof, wall, timing: { mesh: tMesh, ...sol.timing }, f });
    lines.push(JSON.stringify({ kind: 'level', case: 'AC-02', cell, s, h_m: 0.2 / s, dof: sol.stats.dof, wall_ms: wall, timing_ms: { mesh: tMesh, ...sol.timing }, f_Hz: Array.from(sol.steps!.values), run: sol.run, stats: sol.stats }));
    console.log(`s=${s} h=${(0.2 / s).toFixed(4)} m dof=${sol.stats.dof} wall=${wall.toFixed(0)} ms ${JSON.stringify(Object.fromEntries(Object.entries({ mesh: tMesh, ...sol.timing }).map(([k, v]) => [k, Math.round(v)])))}`);
  }
  console.log('target    ref (Hz)     ' + rows.map((r) => `s=${r.s} err`.padEnd(10)).join(' ') + ' f_ext (Hz)    err_ext    p_obs  pass');
  let pass = true;
  refs.forEach((t, i) => {
    const vals = rows.map((r) => r.f[i]!);
    const rich = richardson(vals, rows.map((r) => 0.2 / r.s));
    const fx = rich.f_ext ?? vals[vals.length - 1]!;
    const err = (fx - t.value) / t.value;
    const ok = Math.abs(err) <= tolRel;
    pass &&= ok;
    console.log(`${t.metric_id.padEnd(9)} ${t.value.toFixed(6).padEnd(12)} ${vals.map((v) => ((v - t.value) / t.value).toExponential(2).padEnd(10)).join(' ')} ${fx.toFixed(6).padEnd(13)} ${err.toExponential(2).padEnd(10)} ${rich.p_obs?.toFixed(2) ?? 'n/a'}  ${ok ? 'PASS' : 'FAIL'}`);
    lines.push(JSON.stringify({ kind: 'target', case: 'AC-02', cell, target: t.metric_id, ref: t.value, values: vals, richardson: rich, value: fx, err_rel: err, tol_rel: tolRel, pass: ok }));
  });
  const total = rows.reduce((s, r) => s + r.wall, 0);
  console.log(`${cell}: total wall over levels ${total.toFixed(0)} ms; <5 s: ${total < 5000 ? 'yes' : 'no'}; ${pass ? 'PASS' : 'FAIL'}${cell === 'tet10' ? ' (gated)' : ' (informative)'}`);
  if (cell === 'tet10') gatePass = pass;
  summary[cell] = { levels, total_wall_ms: total, under_5s: total < 5000, pass };
}
lines.push(JSON.stringify({ kind: 'summary', case: 'AC-02', ...summary, pass: gatePass, ts: new Date().toISOString() }));
writeFileSync(logPath, lines.join('\n') + '\n');
console.log(`gate ${gatePass ? 'PASS' : 'FAIL'}; log ${logPath}`);
