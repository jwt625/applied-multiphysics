// SPDX-License-Identifier: GPL-3.0-or-later
// Gate RF-01 / RF-21 (hero H5): PEC circular cylinder cavity, a = 2.74 cm, d = 2a, eps_r 2.08, tan_delta 4e-4
// (eval/cases/a/RF-21.yaml, materials from that case file). 3D Nedelec order 2 on curved tet10 meshes (structured ring
// disk extruded, h = a / N), shift-invert Arnoldi at the case shift. References: eval/expected/RF-21.json (exact Bessel
// zeros); Palace analytic table (R3 RF-01, 4-decimal zeros) reported as a delta only (informative).
// Meshes: --mesh nested (default): @amp/mesh meshCylinder (order 2, side mid-nodes on the cylinder) at hmax = a / D,
// then refineUniform with the cylinder projector (nested, ratio 2); --mesh rings: the ring-disk fixture at h = a / N.
// Verdict: the shared harness rule (gates/common.ts) with the theoretical ND2 eigenvalue order 4 (band 0.25).
// Q_d is informative (homogeneous fill: Q_d = 1 / tan_delta for any field, audit M3).
// Run: cd packages/physics && nice -n 10 node --max-old-space-size=1536 gates/rf-01.ts [--mesh nested --base 1.5 --nlev 2] [--mesh rings --levels 4,5,6]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '@amp/spec';
const parse = (t: string) => parseYaml(t).data as any;
import { cylinderTetMesh } from '../src/common/fixtures3d.ts';
import { solveCavity } from '../src/em3d/index.ts';
import { evaluate, caseTarget, type Level } from './common.ts';
import { stamp as utcStamp } from './modes-common.ts';
import { meshCylinder, refineUniform, cylinderSideProjector } from '@amp/mesh';
import type { Mesh } from '@amp/spec/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const meshKind = arg('mesh', 'nested');
const levels = meshKind === 'rings' ? arg('levels', '4,5,6').split(',').map(Number) : Array.from({ length: Number(arg('nlev', '2')) }, (_, i) => i);
const baseDiv = Number(arg('base', '1.5'));
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

const stamp = utcStamp();
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const logPath = join(ROOT, `logs/l4-rf01-${stamp}.jsonl`);
const lines: string[] = [];
const rows: Array<{ N: number; dof: number; tets: number; wall: number; timing: Record<string, number>; f: number[]; ez: number[]; m: number[]; q: number; div: number; res: number }> = [];
const cyl = { id: 'cav', radius: a, height: d, base: [0, 0, 0] as [number, number, number], axis: 'z' as const };
let prev: Mesh | null = null;
for (const N of levels) {
  const t0 = performance.now();
  const mesh: Mesh = meshKind === 'rings' ? cylinderTetMesh({ radius: a, height: d, h: a / N, nz: 2 * N, cell: 'tet10', disk: 'rings' })
    : prev === null ? meshCylinder(cyl, { mesh2d: { hmax: a / baseDiv }, dz: a / baseDiv, cell: 'tet4', order: 2 }) : refineUniform(prev, { project: cylinderSideProjector(prev, cyl) });
  prev = mesh;
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
  console.log(`${meshKind === 'rings' ? `N=${N} h=a/${N}` : `nested level ${N} (base a/${baseDiv})`} tets=${nc} dof=${row.dof} wall=${wall.toFixed(0)} ms ${JSON.stringify(Object.fromEntries(Object.entries(row.timing).map(([k, v]) => [k, Math.round(v)])))} div=${row.div.toExponential(1)}`);
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
const hOf = (r: (typeof rows)[number]) => (meshKind === 'rings' ? a / r.N : 2 ** -r.N);
const lv: Level[] = rows.map((r, k) => ({ level: k, h: hOf(r), dof: r.dof, wall_ms: r.wall, stages: r.timing, values: Object.fromEntries(refs.map((t) => [t.metric_id, nearFam(r, t.metric_id, t.value)])) }));
// with 2 levels the harness rule extrapolates with the stated order 4 (a 2-level study); with >= 3 it gates p_obs
const res = evaluate(lv, refs.map((t) => caseTarget('a', 'RF-21', t.metric_id, { order: 4 })));
console.log('\ntarget      ref (GHz)      ' + rows.map((r) => `L${r.N} err`.padEnd(11)).join(' ') + ' value (GHz)    err        p_obs  status  basis | Palace delta (info)');
res.forEach((r, i) => {
  const t = refs[i]!, vals = lv.map((l) => l.values[t.metric_id]!);
  allPass &&= r.status === 'pass';
  const pal = PALACE[t.metric_id];
  const v = r.value ?? vals[vals.length - 1]!;
  console.log(`${t.metric_id.padEnd(10)} ${(t.value / 1e9).toFixed(9)} ${vals.map((x) => ((x - t.value) / t.value).toExponential(2).padEnd(11)).join(' ')} ${(v / 1e9).toFixed(9)} ${((v - t.value) / t.value).toExponential(2).padEnd(10)} ${r.p_obs?.toFixed(2) ?? 'n/a'}  ${r.status.toUpperCase().padEnd(7)} ${r.basis}${r.reason ? ` (${r.reason})` : ''} | ${pal ? ((pal * 1e9 - v) / v).toExponential(2) : ''}`);
  lines.push(JSON.stringify({ kind: 'target', case: 'RF-21', target: t.metric_id, ref: t.value, values: vals, result: r, tol_rel: tolRel, palace_GHz: pal ?? null }));
});
const q = rows[rows.length - 1]!.q;
console.log(`INFO Q_dielectric (TM010, finest) ${q.toFixed(6)} ref ${qRef} (homogeneous fill: tautological, audit M3)`);
const total = rows.reduce((s, r) => s + r.wall, 0);
const finest = rows[rows.length - 1]!.wall;
console.log(`total wall over levels ${total.toFixed(0)} ms (finest ${finest.toFixed(0)} ms); <5 s at the gate accuracy: ${allPass ? (total < 5000 ? 'yes' : 'no') : 'n/a (gate not passed)'}; gate ${allPass ? 'PASS' : 'FAIL'}`);
lines.push(JSON.stringify({ kind: 'summary', case: 'RF-21', mesh: meshKind, baseDiv, levels, order, total_wall_ms: total, finest_wall_ms: finest, under_5s: total < 5000, Q: q, Q_ref: qRef, pass: allPass, ts: new Date().toISOString() }));
writeFileSync(logPath, lines.join('\n') + '\n');
console.log(`log ${logPath}`);
process.exitCode = allPass ? 0 : 2;
