// SPDX-License-Identifier: GPL-3.0-or-later
// Gate RF-01 / RF-21 (hero H5): PEC circular cylinder cavity, a = 2.74 cm, d = 2a, eps_r 2.08, tan_delta 4e-4
// (eval/cases/a/RF-21.yaml, materials from that case file). 3D Nedelec order 2 on curved tet10 meshes (structured ring
// disk extruded, h = a / N), shift-invert Arnoldi at the case shift. References: eval/expected/RF-21.json (exact Bessel
// zeros); Palace analytic table (R3 RF-01, 4-decimal zeros) reported as a delta only. Richardson extrapolation over the
// three finest levels (eval metrics); gate rel 1e-5 after Richardson (case tolerance).
// Run: cd packages/physics && nice -n 10 node --max-old-space-size=1536 gates/rf-01.ts [--levels 2,3,4] [--order 2]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '@amp/spec';
const parse = (t: string) => parseYaml(t).data as any;
import { cylinderTetMesh } from '../src/common/fixtures3d.ts';
import { solveCavity } from '../src/em3d/index.ts';
import { richardson } from '../../eval/src/metrics.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const levels = arg('levels', '2,3,4').split(',').map(Number);
const order = Number(arg('order', '2')) as 1 | 2;
const nModes = Number(arg('modes', '16'));

const kase = parse(readFileSync(join(ROOT, 'eval/cases/a/RF-21.yaml'), 'utf8'));
const exp = JSON.parse(readFileSync(join(ROOT, 'eval/expected/RF-21.json'), 'utf8'));
const a = kase.geometry.spec.radius_m as number, d = kase.geometry.spec.height_m as number;
const mat = kase.materials.fill as { eps_r: number; tan_delta: number; mu_r: number };
const shiftHz = kase.study.shift as number;
const refs = (exp.targets as Array<{ metric_id: string; value: number }>).filter((t) => t.metric_id.startsWith('f_'));
const qRef = (exp.targets as Array<{ metric_id: string; value: number }>).find((t) => t.metric_id === 'Q_dielectric')!.value;
const tolRel = 1e-5;
// Palace cylinder.md analytic table as quoted in R3 RF-01 (GHz)
const PALACE: Record<string, number> = { f_TM010: 2.903605, f_TE111: 2.922212, f_TM011: 3.468149, f_TM110: 4.626474, f_TE211: 4.146842, f_TE011: 5.000140 };

const pad = (x: number) => String(x).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const logPath = join(ROOT, `logs/l4-rf01-${stamp}.jsonl`);
const lines: string[] = [];
const rows: Array<{ N: number; dof: number; tets: number; wall: number; timing: Record<string, number>; f: number[]; ez: number[]; m: number[]; q: number; div: number; res: number }> = [];
for (const N of levels) {
  const t0 = performance.now();
  const mesh = cylinderTetMesh({ radius: a, height: d, h: a / N, nz: 2 * N, cell: 'tet10', disk: 'rings' });
  const tMesh = performance.now() - t0;
  const nc = mesh.cells.conn.length / 10;
  const sol = await solveCavity({
    mesh, order, epsR: new Float64Array(nc).fill(mat.eps_r), muR: new Float64Array(nc).fill(mat.mu_r), tanDelta: new Float64Array(nc).fill(mat.tan_delta),
    pec: ['bnd:cav.side', 'bnd:cav.top', 'bnd:cav.bottom'], nModes, shiftHz, blockSize: 1,
  });
  const wall = performance.now() - t0;
  const f = Array.from(sol.steps!.values);
  const iTM010 = f.reduce((b, x, i) => (Math.abs(x - refs[0]!.value) < Math.abs(f[b]! - refs[0]!.value) ? i : b), 0);
  const row = { N, dof: sol.stats.dof, tets: nc, wall, timing: { mesh: tMesh, ...sol.timing }, f, ez: Array.from(sol.detail.ezFraction), m: Array.from(sol.detail.azimuthalOrder), q: sol.scalars[`Q_${iTM010}`]!.value, div: Math.max(...sol.detail.divResidual), res: sol.stats.residual ?? NaN };
  rows.push(row);
  lines.push(JSON.stringify({ kind: 'level', case: 'RF-21', order, N, h_m: a / N, dof: row.dof, tets: nc, wall_ms: wall, timing_ms: row.timing, f_Hz: f, ez_fraction: row.ez, azimuthal_order: row.m, Q_TM010: row.q, div_residual_max: row.div, eig_residual_max: row.res, run: sol.run, stats: sol.stats }));
  console.log(`N=${N} h=a/${N} tets=${nc} dof=${row.dof} wall=${wall.toFixed(0)} ms ${JSON.stringify(Object.fromEntries(Object.entries(row.timing).map(([k, v]) => [k, Math.round(v)])))} div=${row.div.toExponential(1)}`);
}
// mode family from the metric id f_<TE|TM><m><n><p>: TE = E_z energy fraction < 0.05, m = azimuthal order about z;
// the computed mode of that family nearest to the reference is taken (the TE011 / TM111 degeneracy needs the family)
const family = (id: string) => { const g = /^f_(TE|TM)(\d)/.exec(id)!; return { te: g[1] === 'TE', m: Number(g[2]) }; };
// m >= 1 modes are degenerate pairs (cos / sin): the pair mean is taken (the mesh splits the pair slightly)
const nearFam = (r: (typeof rows)[number], id: string, v: number) => {
  const fam = family(id);
  const c = r.f.filter((x, i) => (r.ez[i]! < 0.05) === fam.te && r.m[i] === fam.m).sort((x, y) => Math.abs(x - v) - Math.abs(y - v));
  if (!c.length) return NaN;
  return fam.m >= 1 && c.length >= 2 ? 0.5 * (c[0]! + c[1]!) : c[0]!;
};
let allPass = true;
console.log('\ntarget      ref (GHz)      ' + rows.map((r) => `N=${r.N} err`.padEnd(11)).join(' ') + ' f_ext (GHz)    err_ext    p_obs  pass  err_ext(p=4, 2 finest; info)  Palace delta');
for (const t of refs) {
  const vals = rows.map((r) => nearFam(r, t.metric_id, t.value));
  const h = rows.map((r) => a / r.N);
  const rich = richardson(vals, h);
  const fx = rich.f_ext ?? vals[vals.length - 1]!;
  const err = (fx - t.value) / t.value;
  const pass = Math.abs(err) <= tolRel;
  allPass &&= pass;
  const pal = PALACE[t.metric_id];
  // theoretical order of ND2 eigenvalues (2p = 4) from the two finest levels: informative, not gated
  const r4 = richardson(vals.slice(-2), h.slice(-2), { assumedOrder: 4 });
  const err4 = r4.f_ext !== null ? (r4.f_ext - t.value) / t.value : NaN;
  console.log(`${t.metric_id.padEnd(10)} ${(t.value / 1e9).toFixed(9)} ${vals.map((v) => ((v - t.value) / t.value).toExponential(2).padEnd(11)).join(' ')} ${(fx / 1e9).toFixed(9)} ${err.toExponential(2).padEnd(10)} ${rich.p_obs?.toFixed(2) ?? 'n/a'}  ${pass ? 'PASS' : 'FAIL'}  ${err4.toExponential(2).padEnd(29)} ${pal ? ((pal * 1e9 - fx) / fx).toExponential(2) : ''}`);
  lines.push(JSON.stringify({ kind: 'target', case: 'RF-21', target: t.metric_id, ref: t.value, values: vals, h_m: h, richardson: rich, richardson_p4_info: r4, err_rel_p4_info: err4, value: fx, err_rel: err, tol_rel: tolRel, pass, palace_GHz: pal ?? null, palace_rel_vs_ext: pal ? (pal * 1e9 - fx) / fx : null }));
}
const q = rows[rows.length - 1]!.q;
const qPass = Math.abs(q - qRef) / qRef <= 1e-3;
allPass &&= qPass;
console.log(`Q_dielectric (TM010, finest) ${q.toFixed(6)} ref ${qRef} ${qPass ? 'PASS' : 'FAIL'}`);
const total = rows.reduce((s, r) => s + r.wall, 0);
const finest = rows[rows.length - 1]!.wall;
console.log(`total wall over levels ${total.toFixed(0)} ms (finest ${finest.toFixed(0)} ms); <5 s at the gate accuracy: ${total < 5000 ? 'yes' : 'no'}; gate ${allPass ? 'PASS' : 'FAIL'}`);
lines.push(JSON.stringify({ kind: 'summary', case: 'RF-21', levels, order, total_wall_ms: total, finest_wall_ms: finest, under_5s: total < 5000, Q: q, Q_ref: qRef, pass: allPass, ts: new Date().toISOString() }));
writeFileSync(logPath, lines.join('\n') + '\n');
console.log(`log ${logPath}`);
