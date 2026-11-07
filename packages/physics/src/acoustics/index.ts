// SPDX-License-Identifier: GPL-3.0-or-later
// `acoustics` eigenfrequencies: pressure acoustics in a closed domain,
//   -div((1/rho) grad p) = omega^2 p / (rho c^2),  sound-hard walls: dp/dn = 0 (natural),  'pressure' boundaries: p = 0,
// as K p = omega^2 M p with K = int (1/rho) grad p . grad q, M = int p q / (rho c^2) per cell, so p and (1/rho) dp/dn
// are continuous across fluid interfaces (audit S6). A single fluid without a density uses rho = 1 (it cancels in the
// eigenvalues; it scales the normalisation only). (common/scalar.ts; Lagrange P1/P2 on
// triangles and tets, Q1 on hexes; axisymmetric meridional meshes use the weight r, i.e. azimuthal order 0 only).
// Shift-invert at sigma = (2 pi shift)^2, or below the spectrum when no positive shift is given (Cholesky); an
// all-rigid room has the constant-pressure mode at omega = 0, which is kept and reported as f = 0.

import type { Mesh, PhysicsModule, RunContext, Solution, FieldData } from '@amp/spec/types';
import { assembleCells, restrict } from '../common/scalar.ts';
import { facetsOn, facetNodes, nNodes } from '../common/mesh.ts';
import { shiftInvertEigen } from '../common/eigen.ts';
import { StageTimer, makeSolution, attachMesh } from '../common/solution.ts';
import { cellProps, bcSelections, bcTypes, eigenStudy, physicsNode, optionalCellProp, q } from '../common/ctx.ts';

export interface AcousticProblem {
  mesh: Mesh;
  /** speed of sound per cell (m/s); cells with mask 0 are not assembled */
  c: Float64Array;
  /** density per cell (kg/m^3); required when the fluid is not uniform */
  rho?: Float64Array;
  mask?: Uint8Array;
  /** p = 0 boundaries (entity ids) */
  pressureZero?: string[];
  nModes: number;
  shiftHz?: number | null;
  spec?: unknown;
  signal?: AbortSignal;
}

export async function solveAcousticModes(p: AcousticProblem): Promise<Solution & { detail: { eigResidual: Float64Array; stats: Record<string, unknown> } }> {
  const timer = new StageTimer();
  const { mesh } = p;
  timer.start('assemble');
  const nc = p.c.length;
  const m = new Float64Array(nc), k = new Float64Array(nc);
  for (let e = 0; e < nc; e++) {
    if (p.mask && !p.mask[e]) continue;
    const rho = p.rho ? p.rho[e]! : 1;
    if (!(rho > 0)) throw new Error(`acoustics: density missing or not positive on cell ${e}`);
    k[e] = 1 / rho; m[e] = 1 / (rho * p.c[e]! * p.c[e]!);
  }
  const A = assembleCells(mesh, { k, m, ...(p.mask ? { mask: p.mask } : {}), weight: mesh.axisym ? 'r' : 'none' });
  const free = Uint8Array.from(A.active);
  if (p.pressureZero?.length) for (const n of facetNodes(mesh, facetsOn(mesh, p.pressureZero))) free[n] = 0;
  const R = restrict(A.pat, A.K!, free);
  const Mr = restrict(A.pat, A.M!, free).val;
  timer.stop('assemble');
  // spectral scale (omega^2) from the bounding box and the largest speed of sound
  const dim = mesh.dim, nn = nNodes(mesh);
  let diag2 = 0, cMax = 0;
  for (let d = 0; d < dim; d++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < nn; i++) { const x = mesh.nodes[dim * i + d]!; lo = Math.min(lo, x); hi = Math.max(hi, x); }
    diag2 += (hi - lo) ** 2;
  }
  for (let e = 0; e < nc; e++) if (!p.mask || p.mask[e]) cMax = Math.max(cMax, p.c[e]!);
  const lamScale = (Math.PI * cMax) ** 2 / diag2;
  const positive = !!p.shiftHz && p.shiftHz > 0;
  const sigma = positive ? (2 * Math.PI * p.shiftHz!) ** 2 : -0.01 * lamScale;
  timer.start('solve');
  const eig = shiftInvertEigen({ pat: R.pat, K: R.val, M: Mr, sigma, nWant: p.nModes, kPsd: true, tol: 1e-10, ...(p.signal ? { signal: p.signal } : {}) });
  timer.stop('solve');
  timer.add('factor', eig.stats.factorMs);
  timer.timing.solve = (timer.timing.solve ?? 0) - eig.stats.factorMs;
  timer.start('post');
  const freqs = Float64Array.from(eig.lambda, (l) => (Math.abs(l) < 1e-9 * lamScale ? 0 : Math.sign(l) * Math.sqrt(Math.abs(l)) / (2 * Math.PI)));
  const ord = mesh.cells.type === 'tri6' || mesh.cells.type === 'tet10' ? 2 : 1;
  const fields: FieldData[] = [];
  const scalars: Solution['scalars'] = {};
  eig.vecs.forEach((x, i) => {
    const full = new Float64Array(nn);
    for (let r = 0; r < R.pat.n; r++) full[R.inv[r]!] = x[r]!;
    fields.push({ name: 'p', unit: 'Pa', space: ord === 2 ? 'H1P2' : 'H1P1', components: 1, data: full, step: i });
    scalars[`f_${i}`] = { value: freqs[i]!, unit: 'Hz' };
  });
  timer.stop('post');
  const sol = await makeSolution({
    mesh, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { module: 'acoustics', nModes: p.nModes, shiftHz: p.shiftHz ?? null, pressureZero: p.pressureZero ?? [], mesh: mesh.hash } }),
    fields, steps: { kind: 'eigen', values: freqs, unit: 'Hz' }, scalars,
    stats: { dof: R.pat.n, nnz: R.pat.nnz, iterations: eig.stats.opApplications, residual: Math.max(0, ...eig.residual), solver: `shift-invert block Arnoldi, ${eig.stats.factor} (supernodal)` },
    timer,
  });
  attachMesh(sol, mesh);
  return Object.assign(sol, { detail: { eigResidual: eig.residual, stats: { ...eig.stats, sigma } } });
}

export const acousticsModule: PhysicsModule = {
  type: 'acoustics',
  dims: ['2d', '2d-axisym', '3d'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const p = physicsNode(spec, physicsId);
      for (const b of p.bcs ?? []) {
        if (b.type === 'sound-hard') continue;
        if (b.type === 'pressure') {
          const v = (b.settings as { p?: unknown } | undefined)?.p;
          const zero = v === 0 || (typeof v === 'string' && /^0(\.0*)?\s*(Pa)?$/.test(v.trim())) || (typeof v === 'object' && v !== null && (v as { value?: unknown }).value === 0);
          if (!zero) reasons.push(`pressure BC '${b.id}': eigen analysis needs p = 0`);
          continue;
        }
        reasons.push(`unsupported BC type '${b.type}'`);
      }
      const st = (spec.studies ?? []).filter((s) => s.physics.includes(physicsId));
      if (!st.some((s) => s.type === 'eigen')) reasons.push('no eigen study for this physics (driven frequency response not implemented)');
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: reasons.length === 0, reasons };
  },
  async run(ctx: RunContext) {
    const { mask, values } = cellProps(ctx, ['c']);
    const rho = optionalCellProp(ctx, 'rho', mask);
    const matsUsed = new Set((ctx.spec.materials ?? []).filter((mt) => Object.keys(ctx.materials[mt.id] ?? {}).length).map((mt) => mt.id));
    const hasRho = Array.from(rho).some((v, c) => mask[c] && Number.isFinite(v));
    const allRho = Array.from(rho).every((v, c) => !mask[c] || Number.isFinite(v));
    if (hasRho && !allRho) throw new Error('acoustics: rho is given on some domains but not on all');
    let cMin = Infinity, cMax = -Infinity;
    for (let e = 0; e < mask.length; e++) if (mask[e]) { cMin = Math.min(cMin, values.c![e]!); cMax = Math.max(cMax, values.c![e]!); }
    if (!hasRho && (matsUsed.size > 1 || cMin !== cMax)) throw new Error('acoustics: several fluids need rho on every domain (interface condition (1/rho) dp/dn)');
    for (const b of ((physicsNode(ctx.spec, ctx.physicsId).bcs ?? []) as Array<{ id: string; type: string; settings?: { p?: unknown } }>))
      if (b.type === 'pressure' && b.settings?.p !== undefined && q(ctx.spec, b.settings.p, `${b.id}.p`) !== 0) throw new Error(`acoustics eigen: pressure boundary ${b.id} must be p = 0`);
    const { nModes, shiftHz } = eigenStudy(ctx);
    if (bcTypes(ctx.spec, ctx.physicsId).some((t) => t !== 'sound-hard' && t !== 'pressure')) throw new Error('acoustics eigen: only sound-hard / pressure (p = 0) boundaries');
    return solveAcousticModes({
      mesh: ctx.mesh, c: values.c!, ...(hasRho ? { rho } : {}), mask, pressureZero: bcSelections(ctx.spec, ctx.physicsId, 'pressure'),
      nModes, shiftHz, spec: ctx.spec, signal: ctx.signal,
    });
  },
};
