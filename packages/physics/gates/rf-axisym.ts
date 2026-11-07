// SPDX-License-Identifier: GPL-3.0-or-later
// Gate RF-21 on the axisymmetric per-m Maxwell eigen solver (src/em-axisym, Follow-up 3 path B): meridional
// rectangle [0, a] x [0, d] (exact for the cylinder), tri3, nested levels by refineUniform, Nedelec order 2 + P2,
// m = 0, 1, 2. Inputs (a, d, eps_r, mu_r, shift) and references from eval/cases/a/RF-21.yaml and its expected file;
// verdict by the shared harness rule (gates/common.ts) with the theoretical eigenvalue order 4. Cross-check against
// the 3D ND2 solver: the latest logs/l4-rf01-*.jsonl of gates/rf-01.ts (rings N = 4, 5, 6), modes that pass there.
// Usage: nice -n 10 node --max-old-space-size=1536 gates/rf-axisym.ts [--levels 4]

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineUniform } from '@amp/mesh';
import type { Mesh } from '@amp/spec/types';
import { rectTriMesh, nCells } from '../src/common/mesh.ts';
import { solveAxisymModes } from '../src/em-axisym/index.ts';
import { readCase, caseTarget, GateLog, waitForLoad, evaluate, printTable, speedLine, ExitCode, REPO, type Level } from './common.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const nLev = Number(arg('levels', '5'));
const c = readCase('a', 'RF-21');
const a = c.geometry.spec.radius_m as number, d = c.geometry.spec.height_m as number;
const mat = c.materials.fill as { eps_r: number; mu_r: number };
const shiftHz = c.study.shift as number;
const ids = ['f_TM010', 'f_TE111', 'f_TM011', 'f_TM110', 'f_TE211', 'f_TE011'];
const targets = ids.map((id) => caseTarget('a', 'RF-21', id, { order: 4 }));
const fam = (id: string) => { const g = /^f_(TE|TM)(\d)/.exec(id)!; return { te: g[1] === 'TE', m: Number(g[2]) }; };
const log = new GateLog('rf-axisym');
const exit = new ExitCode();
await waitForLoad();

let mesh: Mesh = rectTriMesh({ x: [0, a], y: [0, d], nx: 2, ny: 4, axisym: true });
const levels: Level[] = [];
for (let L = 0; L < nLev; L++) {
  const t0 = performance.now();
  if (L > 0) mesh = refineUniform(mesh);
  const tMesh = performance.now() - t0;
  const values: Record<string, number> = {};
  const stages: Record<string, number> = { mesh: +tMesh.toFixed(1) };
  let dof = 0;
  for (const m of [0, 1, 2]) {
    const s = await solveAxisymModes({ mesh, m, order: 2, epsR: new Float64Array(nCells(mesh)).fill(mat.eps_r), muR: new Float64Array(nCells(mesh)).fill(mat.mu_r),
      pec: ['bnd:rect.right', 'bnd:rect.top', 'bnd:rect.bottom'], nModes: 6, shiftHz });
    dof += s.stats.dof;
    for (const [k, v] of Object.entries(s.timing)) stages[k] = +((stages[k] ?? 0) + v).toFixed(1);
    const f = Array.from(s.steps!.values), ez = Array.from(s.detail.ezFraction);
    for (const t of targets) {
      const F = fam(t.id);
      if (F.m !== m) continue;
      const cand = f.map((x, i) => ({ x, te: ez[i]! < 0.05 })).filter((y) => y.te === F.te).sort((p, q) => Math.abs(p.x - t.ref) - Math.abs(q.x - t.ref));
      values[t.id] = cand[0]?.x ?? NaN;
    }
  }
  levels.push({ level: L, h: 2 ** -L, dof, wall_ms: performance.now() - t0, stages, values });
}
const res = evaluate(levels, targets);
printTable('RF-21 axisymmetric per-m (m = 0, 1, 2), ND2 + P2, nested', levels, res, log);
speedLine('RF-21-axisym', levels, targets, res, log);
exit.add(res);

// cross-check against the 3D ND2 solver (gates/rf-01.ts log, rings N = 4..6; only modes that pass there)
const files = readdirSync(join(REPO, 'logs')).filter((f) => /^l4-rf01-.*Z\.jsonl$/.test(f)).sort();
for (const f of files.reverse()) {
  const lines = readFileSync(join(REPO, 'logs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const summ = lines.find((l) => l.kind === 'summary');
  if (summ?.mesh !== 'rings') continue;
  console.log(`\ncross-check vs 3D ND2 (${f}):`);
  for (const l of lines.filter((x) => x.kind === 'target')) {
    const r = res.find((x) => x.target === l.target);
    if (!r || l.result?.status !== 'pass') { if (r) console.log(`  ${l.target}: 3D ${l.result?.status} (not used)`); continue; }
    const v3 = l.result.value as number, va = r.value ?? r.fine;
    const rel = (va - v3) / v3, band = Math.abs(l.result.err ?? 0) / l.ref + Math.abs(r.err ?? 0) / r.ref;
    console.log(`  ${l.target}: axisym ${(va / 1e9).toFixed(9)} GHz, 3D ${(v3 / 1e9).toFixed(9)} GHz, rel diff ${rel.toExponential(2)} (sum of the two errors vs exact ${band.toExponential(2)})`);
    log.write({ kind: 'crosscheck', target: l.target, axisym: va, three_d: v3, rel_diff: rel, log3d: f });
  }
  break;
}
console.log(`log: ${log.path}`);
exit.set();
