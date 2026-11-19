// SPDX-License-Identifier: GPL-3.0-or-later
// Fix lane FX3-engine (DevLog-066): axisymmetric elastic AMG with the rigid-body near-nullspace, singular (under-
// constrained) systems on the AMG path, the PCG tolerance note, material temperature on T-independent library leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { defaultLibrary } from '@amp/materials/node';
import { prepareRun, runStudy } from '../src/index.ts';
import { rectTriMesh, nCells } from '../src/common/mesh.ts';
import { solveElastic } from '../src/elastic/index.ts';
import { SpdSolver, withStudySolver, PCG_ACCEPT_FACTOR, type Csr } from '../src/common/scalar.ts';

const ROOT = new URL('../../../', import.meta.url);

test('axisymmetric elasticity: AMG-PCG with the (r, z) rigid-body near-nullspace, same stresses as direct', async () => {
  const lib = defaultLibrary();
  const run = async (solver?: string) => {
    const spec = parseYaml(readFileSync(new URL('sims/tsv-stress-axisym.yaml', ROOT), 'utf8')).data as { studies: Array<{ settings?: unknown }> };
    if (solver) spec.studies[0]!.settings = { solver };
    const sol = await runStudy(await prepareRun(spec as never, { library: lib, hFactor: 0.5 }));
    const f = sol.fields.find((x) => x.name === 'srr' || x.name.endsWith('srr'))!;
    return { f, rec: sol.run.solver?.byPhysics?.solid ?? sol.run.solver };
  };
  const d = await run(), a = await run('amg-pcg');
  assert.equal(a.rec?.kind, 'amg-pcg');
  // measured 2026-11-18: 20 iterations at hFactor 0.5 (the scalar AMG took 171); bound with margin
  assert.ok((a.rec?.iterations ?? Infinity) <= 40, `iterations ${a.rec?.iterations}`);
  let dm = 0, mx = 0;
  for (let i = 0; i < d.f.data.length; i++) { dm = Math.max(dm, Math.abs(d.f.data[i]! - a.f.data[i]!)); mx = Math.max(mx, Math.abs(d.f.data[i]!)); }
  assert.ok(dm <= 1e-7 * mx, `max |srr| difference ${dm} of ${mx}`);
});

test('AMG-PCG on an under-constrained (floating) elastic body throws like the direct solver', async () => {
  const mesh = rectTriMesh({ x: [0, 1], y: [0, 0.5], nx: 40, ny: 20, order: 1 });
  const nc = nCells(mesh);
  const p = {
    mesh, model: 'plane-stress' as const, E: new Float64Array(nc).fill(170e9), nu: new Float64Array(nc).fill(0.28),
    // balanced tractions: a consistent singular system (three rigid-body modes free)
    bcs: [{ type: 'traction' as const, select: ['bnd:rect.right'], t: [1e6, 0] }, { type: 'traction' as const, select: ['bnd:rect.left'], t: [-1e6, 0] }],
  };
  await assert.rejects(solveElastic(p), /not positive definite/);
  await assert.rejects(solveElastic({ ...p, solver: 'amg-pcg' }), /AMG-PCG: matrix not positive definite .*under-constrained/);
  // constrained: unchanged
  const ok = await solveElastic({ ...p, bcs: [{ type: 'fixed', select: ['bnd:rect.left'] }, { type: 'traction', select: ['bnd:rect.right'], t: [1e6, 0] }], solver: 'amg-pcg' });
  assert.ok(ok.stats.residual! <= 1e-10);
});

test('AMG-PCG stopped between rtol and the acceptance factor: a solution note, run.solver keeps the residual', async () => {
  // diagonal SPD system, eigenvalues 1 .. 1e5 (geometric), identity preconditioner: CG reaches about 1e-5 in 2000 steps
  const n = 3000, rowptr = new Int32Array(n + 1), colidx = new Int32Array(n), val = new Float64Array(n);
  for (let i = 0; i < n; i++) { rowptr[i + 1] = i + 1; colidx[i] = i; val[i] = 10 ** (5 * i / (n - 1)); }
  const pat: Csr = { n, rowptr, colidx, nnz: n };
  const b = Float64Array.from({ length: n }, (_, i) => 1 + (i % 7));
  const ident = { amg: () => ({ cycle: (r: Float64Array, z: Float64Array) => { z.set(r); }, levels: [] }) };
  // first run: the residual reached after 2000 iterations (error above the acceptance factor)
  let reached = NaN;
  try { const S = new SpdSolver(pat, 'amg-pcg', 1e-14, ident); S.factor(val); S.solve(b); } catch (e) { reached = Number(/relres ([0-9.e+-]+)/.exec((e as Error).message)?.[1]); }
  assert.ok(reached > 0, 'first run did not stop above the acceptance factor');
  const rtol = reached / 3;
  const sol = await withStudySolver({ settings: {} }, 'heat', async () => {
    const S = new SpdSolver(pat, 'amg-pcg', rtol, ident); S.factor(val); S.solve(b);
    return { stats: { solver: 'amg-pcg' }, notes: [] as string[], run: {} as { solver?: { residual: number | null } } };
  });
  assert.ok(sol.run.solver && sol.run.solver.residual! > rtol && sol.run.solver.residual! <= PCG_ACCEPT_FACTOR * rtol, `${JSON.stringify(sol.run.solver)} rtol ${rtol} reached ${reached}`);
  assert.equal(sol.notes.length, 1);
  assert.match(sol.notes[0]!, /AMG-PCG stopped above its tolerance in 1 solve\(s\).*2000 iterations.*accepted up to 10 x rtol/);
  // reached: no note
  const fine = await withStudySolver({ settings: {} }, 'heat', async () => {
    const S = new SpdSolver(pat, 'amg-pcg', 0.5, ident); S.factor(val); S.solve(b);
    return { stats: {}, notes: [] as string[], run: {} };
  });
  assert.equal(fine.notes.length, 0);
});

test('material T on a T-independent library leaf: Si n (293 K table in lambda) resolves at T 298.15 K, with a note', async () => {
  const lib = defaultLibrary();
  const base = parseYaml(readFileSync(new URL('sims/si-dc-supermodes.yaml', ROOT), 'utf8')).data as { materials: Array<Record<string, unknown>>; params?: unknown };
  const withSi = (extra: Record<string, unknown>) => {
    const s = structuredClone(base);
    s.materials[0] = { id: 'Si', ref: 'materials/silicon', ...extra, select: s.materials[0]!.select };
    return s;
  };
  const p0 = await prepareRun(withSi({}) as never, { library: lib });
  const nRef = p0.materials.Si!.n!;
  assert.ok(nRef > 3.4 && nRef < 3.5, `n ${nRef}`);
  const p1 = await prepareRun(withSi({ T: { value: 298.15, unit: 'K' } }) as never, { library: lib });
  assert.ok(Object.is(p1.materials.Si!.n, nRef), 'same value as without T');
  assert.ok(p1.notes.some((n) => /materials\.Si \(materials\/silicon\)\.n: the library value does not depend on temperature and is stated for T = 293 K; used as-is at the material temperature 298\.15 K/.test(n)), p1.notes.join('\n'));
  // at the stated temperature: no such note; a run temperature is treated the same way
  const p2 = await prepareRun(withSi({ T: { value: 293, unit: 'K' } }) as never, { library: lib });
  assert.ok(!p2.notes.some((n) => n.includes('does not depend on temperature')));
  const p3 = await prepareRun(withSi({}) as never, { library: lib, T: 350 });
  assert.ok(Object.is(p3.materials.Si!.n, nRef));
  assert.ok(p3.notes.some((n) => n.includes('used as-is at the run temperature 350 K')));
});
