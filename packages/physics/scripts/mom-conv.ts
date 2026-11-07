// SPDX-License-Identifier: GPL-3.0-or-later
// Mesh-convergence and thin-disk regime runner of lane MOM (not a test; output recorded in DevLog-034 s.4):
//   nice -n 10 node --max-old-space-size=1536 scripts/mom-conv.ts
import type { Spec } from '@amp/spec/types';
import { solveAxisymModes } from '../src/em-axisym/index.ts';
import { cellMask, nCells } from '../src/common/mesh.ts';
import { toTri3, interfaceEdges, movingBoundaryIntegral, opticalEnergy } from '../src/optomech/axisym.ts';
import { loadSim, run, prepare, sv } from '../test/mom-common.ts';
for (const [hd, hb] of [['h/6', 'Rb/10'], ['h/8', 'Rb/12'], ['h/12', 'Rb/16'], ['h/16', 'Rb/20']] as const) {
  const s = loadSim('gaas-microdisk-om') as Spec & { mesh: { size: { hmax: string }; refine: Array<{ h: string }> } };
  s.mesh.refine[0]!.h = hd; s.mesh.size.hmax = hb;
  const t0 = performance.now();
  const { p, sol } = await run(s);
  const ms = performance.now() - t0;
  const ang = (k: string) => 2 * Math.PI * sv(sol, k);
  // rigid sidewall regime check on optical mode 0
  const m = p.mesh, m3 = toTri3(m), nc = nCells(m), solid = cellMask(m, ['dom:disk']), all = new Uint8Array(nc).fill(1);
  const eps = Float64Array.from(solid, (x) => (x ? p.materials.GaAs!.eps_r! : 1));
  const r = await solveAxisymModes({ mesh: m3, m: 10, order: 2, epsR: eps, muR: new Float64Array(nc).fill(1), mask: all, pec: ['bnd:box.right', 'bnd:box.top', 'bnd:box.bottom'], nModes: 1, shiftHz: sv(sol, 'opt.f_0') });
  const o = { mesh: m3, space: r.space, order: 2 as const, x: r.x[0]!, omega: 2 * Math.PI * r.steps!.values[0]!, m: 10 };
  const { edges } = interfaceEdges(m3, all, solid, eps);
  const side = (_t: number, rr: number): [number, number] => (Math.abs(rr - 1e-6) < 1e-12 ? [1, 0] : [0, 0]);
  const gSide = (-o.omega / 2) * movingBoundaryIntegral(o, edges, eps, side) / opticalEnergy(o, eps, all);
  console.log(JSON.stringify({ disk_h: hd, air_h: hb, cells: nc, dof: sol.stats.dof, ms: Math.round(ms), timing: Object.fromEntries(Object.entries(sol.timing).filter(([k]) => !k.includes('+')).map(([k, v]) => [k, Math.round(v)])),
    fo_THz: sv(sol, 'opt.f_0') / 1e12, f_RBM1_GHz: sv(sol, 'mech.f_2') / 1e9, f_RBM2_GHz: sv(sol, 'mech.f_5') / 1e9,
    gMB1: ang('gOMMB_0_2') * 1e-18, gPE1: ang('gOMPE_0_2') * 1e-18, gMB2: ang('gOMMB_0_5') * 1e-18, gPE2: ang('gOMPE_0_5') * 1e-18,
    g0_RBM1_kHz_2pi: sv(sol, 'g0_0_2') / 1e3, g0_RBM2_kHz_2pi: sv(sol, 'g0_0_5') / 1e3, xzpf1: sv(sol, 'mech.xzpf_2'),
    sidewall_over_omegaR: gSide / (-o.omega / 1e-6), omegaR_baker_units: o.omega / 1e-6 * 1e-18 }));
}
