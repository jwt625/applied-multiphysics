// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MOM gates (DevLog-034 s.1.3, results s.4): optomechanical coupling (moving boundary + photoelastic) on an
// axisymmetric microdisk. References: closed form -omega / R (2D limit; Ding et al. 2010 PRL 105 263903 p.3,
// Eichenfield et al. 2009 app. D.2), finite differences of the discrete optical problem, Baker et al. 2014 Opt.
// Express 22 14072 Table 3 (arXiv 1403.4269v1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Mesh, Spec } from '@amp/spec/types';
import { solveAxisymModes } from '../src/em-axisym/index.ts';
import { isoD } from '../src/coupled/assemble.ts';
import { cellMask, nCells, nNodes } from '../src/common/mesh.ts';
import { cubicT4, azimuthalAverage, axisymD, asym, rotateZ, t4 } from '../src/optomech/tensors.ts';
import { toTri3, interfaceEdges, movingBoundaryIntegral, opticalEnergy, traceStrainCellMean, HBAR } from '../src/optomech/axisym.ts';
import { loadSim, prepare, run, sv } from './mom-common.ts';

const rel = (a: number, b: number) => Math.abs(a / b - 1);

test('tensors: isotropic cubic is invariant under the azimuthal average; axisymD(iso) = isoD(axisym); Si average symmetric', () => {
  const E = 100e9, nu = 0.3, lam = (E * nu) / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  const iso = cubicT4(lam + 2 * mu, lam, mu);
  const avg = azimuthalAverage(iso);
  for (let i = 0; i < 81; i++) assert.ok(Math.abs(avg[i]! - iso[i]!) < 1e-6 * E);
  const D = axisymD(avg), Dref = isoD('axisym', E, nu);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(D[i]! - Dref[i]!) < 1e-6 * E, `D[${i}] ${D[i]} vs ${Dref[i]}`);
  // Si (Hall 1967, materials/silicon.yaml): averaged tensor is symmetric, transversely isotropic (phi-invariant)
  const si = azimuthalAverage(cubicT4(165.64e9, 63.94e9, 79.51e9));
  assert.ok(asym(axisymD(si), 4) < 1e-12);
  const rot = rotateZ(si, 0.37);
  for (let i = 0; i < 81; i++) assert.ok(Math.abs(rot[i]! - si[i]!) < 1e-6 * 165.64e9);
  // a cubic tensor rotated by 45 deg: C'_11 = (C11 + C12) / 2 + C44 (textbook [110] modulus)
  const c45 = rotateZ(cubicT4(165.64e9, 63.94e9, 79.51e9), Math.PI / 4);
  assert.ok(rel(t4(c45, 0, 0, 0, 0), (165.64e9 + 63.94e9) / 2 + 79.51e9) < 1e-12);
});

/** Dielectric cylinder spanning the window height (PMC top / bottom: z-invariant modes), PEC outer wall. */
function cylinderSpec(): Spec {
  const s = loadSim('gaas-microdisk-om') as Spec & Record<string, unknown>;
  const g = s.geometry as { features: Array<{ id: string; settings: Record<string, unknown> }> };
  g.features[0]!.settings = { size: ['R', '0.4 um'], center: ['R/2', '0 um'] };
  g.features[1]!.settings = { size: ['Rb', '0.4 um'], center: ['Rb/2', '0 um'] };
  (s.physics as Array<{ id: string; bcs?: unknown[] }>).find((p) => p.id === 'opt')!.bcs = [{ id: 'window', type: 'pec', select: ['bnd:box.right'] }];
  (s.mesh as { refine: Array<{ h: string }> }).refine[0]!.h = 'R/40';
  (s.mesh as { size: { hmax: string } }).size.hmax = 'Rb/40';
  return s;
}

test('G-MB1: z-invariant WGM of a dielectric cylinder, rigid sidewall shift: g_OM = -omega / R (2D scale invariance)', async () => {
  const p = await prepare(cylinderSpec());
  const m = p.mesh, m3 = toTri3(m), nc = nCells(m);
  const solid = cellMask(m, ['dom:disk']), all = new Uint8Array(nc).fill(1);
  const eps = Float64Array.from(solid, (s) => (s ? p.materials.GaAs!.eps_r! : 1));
  const r = await solveAxisymModes({ mesh: m3, m: 10, order: 2, epsR: eps, muR: new Float64Array(nc).fill(1), mask: all, pec: ['bnd:box.right'], nModes: 3, shiftHz: 227e12 });
  // the z-invariant TE (in-plane E) mode: E_z fraction 0
  const k = Array.from(r.detail.ezFraction).findIndex((v) => v < 1e-6);
  assert.ok(k >= 0, `no z-invariant TE mode among ${Array.from(r.steps!.values)}`);
  const o = { mesh: m3, space: r.space, order: 2 as const, x: r.x[k]!, omega: 2 * Math.PI * r.steps!.values[k]!, m: 10 };
  const { edges } = interfaceEdges(m3, all, solid, eps);
  const R = 1e-6;
  const side = (_t: number, rr: number): [number, number] => (Math.abs(rr - R) < 1e-12 ? [1, 0] : [0, 0]);
  const g = (-o.omega / 2) * movingBoundaryIntegral(o, edges, eps, side) / opticalEnergy(o, eps, all);
  const ref = -o.omega / R;
  console.log(`G-MB1: f ${(o.omega / 2 / Math.PI / 1e12).toFixed(4)} THz, g/2pi ${(g / 2 / Math.PI * 1e-18).toFixed(6)} GHz/nm, -omega/R/2pi ${(ref / 2 / Math.PI * 1e-18).toFixed(6)} GHz/nm, rel ${rel(g, ref).toExponential(2)}`);
  assert.ok(rel(g, ref) < 1e-3, `g ${g} vs ${ref}`);
});

test('GaAs microdisk (Baker 2014): frequencies, x_zpf, g_MB, g_PE vs Table 3; finite-difference gates', async () => {
  const spec = loadSim('gaas-microdisk-om');
  const { p, sol } = await run(spec);
  const No = 4;
  // optical mode 0: TE-like (in-plane E), the p = 1 WGM at m = 10
  const fo = sv(sol, 'opt.f_0'), lam = 299792458 / fo;
  assert.ok(sv(sol, 'opt.ezFraction_0') < 0.01);
  console.log(`optical TE p=1 m=10: f ${(fo / 1e12).toFixed(3)} THz, lambda ${(lam * 1e9).toFixed(1)} nm (Baker Table 1: 1320 nm, Table 3: ~1300 nm)`);
  // mechanical: mode 0 rigid (f 0), 1 bowl, 2 RBM1, ..., 5 RBM2 (identified by frequency vs Baker Table 3)
  const fm = (j: number) => sv(sol, `mech.f_${j}`);
  const j1 = [1, 2, 3, 4, 5].reduce((a, b) => (Math.abs(fm(b) - 1.375e9) < Math.abs(fm(a) - 1.375e9) ? b : a));
  const j2 = [1, 2, 3, 4, 5].reduce((a, b) => (Math.abs(fm(b) - 3.5e9) < Math.abs(fm(a) - 3.5e9) ? b : a));
  // Baker quotes g_om (GHz/nm) and g0 (MHz) as angular rates: omega0 / R ~ 1.4 THz/nm only holds without 1 / 2 pi
  const ang = (k: string) => 2 * Math.PI * sv(sol, k);
  const rows = [
    { name: 'RBM1', j: j1, f: 1.375e9, gGeo: 1080, gPe: 984, x: 1.23e-15, g0Geo: 1.33, g0Pe: 1.21 },
    { name: 'RBM2', j: j2, f: 3.5e9, gGeo: 412, gPe: 1720, x: 1.15e-15, g0Geo: 0.474, g0Pe: 1.98 },
  ];
  for (const r of rows) {
    const gMB = ang(`gOMMB_0_${r.j}`) * 1e-18, gPE = ang(`gOMPE_0_${r.j}`) * 1e-18;   // rad/s per nm, in 'GHz/nm' (Baker units)
    const x = sv(sol, `mech.xzpf_${r.j}`), g0MB = ang(`g0MB_0_${r.j}`) * 1e-6, g0PE = ang(`g0PE_0_${r.j}`) * 1e-6;
    console.log(`${r.name}: f ${(fm(r.j) / 1e9).toFixed(4)} GHz (Baker ${r.f / 1e9}), x_zpf ${x.toExponential(3)} m (${r.x}), -g_MB ${(-gMB).toFixed(1)} (${r.gGeo}), -g_PE ${(-gPE).toFixed(1)} (${r.gPe}) [Baker units], -g0 MB ${(-g0MB).toFixed(3)} (${r.g0Geo}), PE ${(-g0PE).toFixed(3)} (${r.g0Pe}) [rad/s x 1e6], g0/2pi total ${(sv(sol, `g0_0_${r.j}`) / 1e3).toFixed(1)} kHz`);
    assert.ok(rel(fm(r.j), r.f) < 0.03);
    assert.ok(rel(x, r.x) < 0.05);
    // the mode sign is a convention (dominant component at the max-|u| node positive); Baker's MB and PE parts add
    assert.ok(gMB * gPE > 0, 'moving-boundary and photoelastic parts have the same sign (Baker Table 3)');
    assert.ok(rel(Math.abs(gMB), r.gGeo) < 0.10, `g_MB ${gMB} vs ${r.gGeo}`);
  }
  // photoelastic frame: Baker eq. 13 applies the cubic p matrix in the local (r, theta, z) axes ('cylindrical')
  const sCyl = structuredClone(spec) as Spec & { couplings: Array<{ settings: { photoelastic: Array<{ frame: string }> } }> };
  sCyl.couplings[0]!.settings.photoelastic[0]!.frame = 'cylindrical';
  const { sol: solCyl } = await run(sCyl);
  for (const r of rows) {
    const avg = Math.abs(ang(`gOMPE_0_${r.j}`)) * 1e-18, cyl = Math.abs(2 * Math.PI * sv(solCyl, `gOMPE_0_${r.j}`)) * 1e-18;
    const g0cyl = Math.abs(2 * Math.PI * sv(solCyl, `g0PE_0_${r.j}`)) * 1e-6;
    console.log(`${r.name}: |g_PE| crystal-avg ${avg.toFixed(1)}, cylindrical ${cyl.toFixed(1)} (Baker ${r.gPe}); |g0_PE| cylindrical ${g0cyl.toFixed(3)} (${r.g0Pe}) [Baker units]`);
    assert.ok(rel(cyl, r.gPe) < 0.15, `g_PE (cylindrical) ${cyl} vs ${r.gPe}`);
  }
  // m_eff convention check: x_zpf = sqrt(hbar / (2 m_eff Omega))
  const meff = sv(sol, `mech.meff_${j1}`);
  assert.ok(rel(sv(sol, `mech.xzpf_${j1}`), Math.sqrt(HBAR / (2 * meff * 2 * Math.PI * fm(j1)))) < 1e-12);

  // ---- finite-difference gates on the same mesh (RBM1, optical mode 0)
  const m = p.mesh, m3 = toTri3(m), nc = nCells(m), nn = nNodes(m);
  const solid = cellMask(m, ['dom:disk']), all = new Uint8Array(nc).fill(1);
  const eps0 = p.materials.GaAs!.eps_r!;
  const eps = Float64Array.from(solid, (s) => (s ? eps0 : 1)), mu = new Float64Array(nc).fill(1);
  const u = sol.fields.find((f) => f.name === 'u' && f.step === No + j1)!.data;   // max |Q| = 1 m
  const solve = async (mesh: Mesh, e: Float64Array) => {
    const r = await solveAxisymModes({ mesh, m: 10, order: 2, epsR: e, muR: mu, mask: all, pec: ['bnd:box.right', 'bnd:box.top', 'bnd:box.bottom'], nModes: 1, shiftHz: fo });
    return 2 * Math.PI * r.steps!.values[0]!;
  };
  // G-MB2: move the solid nodes by +-d Q (corner mesh), re-solve: d omega / d alpha of the discrete problem
  const d = 2e-10;
  const moved = (s: number): Mesh => {
    const nodes = Float64Array.from(m3.nodes);
    const inSolid = new Uint8Array(nn);
    for (let c = 0; c < nc; c++) if (solid[c]) for (let a = 0; a < 3; a++) inSolid[m3.cells.conn[3 * c + a]!] = 1;
    for (let v = 0; v < nn; v++) if (inSolid[v]) { nodes[2 * v]! += s * d * u[2 * v]!; nodes[2 * v + 1]! += s * d * u[2 * v + 1]!; }
    return { ...m3, nodes };
  };
  const gFD = ((await solve(moved(1), eps)) - (await solve(moved(-1), eps))) / (2 * d);
  const gMB = 2 * Math.PI * sv(sol, `gOMMB_0_${j1}`);
  console.log(`G-MB2: g_MB perturbation ${(gMB * 1e-18).toFixed(3)} vs FD ${(gFD * 1e-18).toFixed(3)} rad/s/nm, rel ${rel(gMB, gFD).toExponential(2)}`);
  assert.ok(rel(gMB, gFD) < 0.02);
  // G-PE1: isotropic channel p11 = p12 = p, p44 = 0: d eps_r = -eps_r^2 p tr S per cell (cell mean), FD vs perturbation
  const pIso = -0.15;
  const s2 = structuredClone(spec) as Spec & { couplings: Array<{ settings: Record<string, unknown> }> };
  s2.couplings[0]!.settings.photoelastic = [{ material: 'GaAs', p11: pIso, p12: pIso, p44: 0, frame: 'cylindrical' }];
  const { sol: sIso } = await run(s2);
  const gPEiso = 2 * Math.PI * sv(sIso, `gOMPE_0_${j1}`);
  const trS = traceStrainCellMean(m, u, solid);
  const dE = 1e-9;
  const epsPert = (s: number) => Float64Array.from(eps, (e, c) => (solid[c] ? e + s * dE * (-e * e * pIso * trS[c]!) : e));
  const gPEfd = ((await solve(m3, epsPert(1))) - (await solve(m3, epsPert(-1)))) / (2 * dE);
  console.log(`G-PE1: g_PE (isotropic channel) perturbation ${(gPEiso * 1e-18).toFixed(3)} vs FD ${(gPEfd * 1e-18).toFixed(3)} rad/s/nm, rel ${rel(gPEiso, gPEfd).toExponential(2)}`);
  assert.ok(rel(gPEiso, gPEfd) < 0.02);
});

test('optomechanical readiness and output layout', async () => {
  const { optomechReadiness } = await import('../src/couplings/optomech.ts');
  const spec = loadSim('gaas-microdisk-om') as Spec & { couplings: Array<{ id: string; type: string; from: string; to: string; settings: Record<string, unknown> }> };
  assert.deepEqual(optomechReadiness(spec, spec.couplings[0]! as never), []);
  const bad = structuredClone(spec);
  (bad.physics as Array<{ id: string; settings?: Record<string, unknown> }>).find((p) => p.id === 'opt')!.settings = { azimuthal: [2], order: 2 };
  bad.couplings[0]!.settings.photoelastic = [{ material: 'GaAs', p11: -0.165, p12: -0.140, p44: -0.072 }];
  assert.ok(optomechReadiness(bad, bad.couplings[0]! as never).some((r) => r.includes('m != 2')));
  const { sol } = await run(spec);
  assert.equal(sol.steps!.values.length, 4 + 6);
  assert.ok(sol.fields.filter((f) => f.name === 'E_rphiz').every((f) => f.physics === 'opt' && f.step! < 4));
  assert.ok(sol.fields.filter((f) => f.name === 'u').every((f) => f.physics === 'mech' && f.step! >= 4));
  assert.ok(sol.normalization?.includes('max |u|'));
});
