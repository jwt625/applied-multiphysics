// SPDX-License-Identifier: GPL-3.0-or-later
// Lane G3 (DevLog-060): elasticity AMG-PCG (smoothed aggregation with rigid-body modes; P2 -> P1 p-multigrid), the
// run.solver record (withStudySolver, driver merge), the shift-invert eigen completeness check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { prepareRun, runStudy } from '../src/index.ts';
import { boxMesh, rectTriMesh } from '../src/common/mesh.ts';
import { solveElastic, type ElasticProblem } from '../src/elastic/index.ts';
import { mergeSolverRecords, solverRecordOf } from '../src/common/scalar.ts';
import { shiftInvertEigen, setEigenCheckDefault } from '../src/common/eigen.ts';
import type { Csr } from '../src/common/scalar.ts';

const relDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let d = 0, m = 0;
  for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i]! - b[i]!)); m = Math.max(m, Math.abs(a[i]!)); }
  return d / m;
};

function cantilever(cell: 'tet4' | 'tet10', solver?: 'cholesky' | 'amg-pcg'): ElasticProblem {
  // 10 x 1 x 1 mm beam, fixed at x = 0, tip traction; a roller on y = 0 leaves single free components on some nodes
  const mesh = boxMesh({ x: [0, 10e-3], y: [0, 1e-3], z: [0, 1e-3], nx: 20, ny: 3, nz: 3, cell });
  const nc = mesh.cells.conn.length / (cell === 'tet10' ? 10 : 4);
  return {
    mesh, model: '3d', E: new Float64Array(nc).fill(170e9), nu: new Float64Array(nc).fill(0.28),
    bcs: [{ type: 'fixed', select: ['bnd:box.xmin'] }, { type: 'roller', select: ['bnd:box.ymin'] }, { type: 'traction', select: ['bnd:box.xmax'], t: [0, 0, -1e6] }],
    ...(solver ? { solver } : {}),
  };
}

test('elastic AMG-PCG (tet4: smoothed aggregation; tet10: p-multigrid) equals the direct solve to the tolerance', async () => {
  for (const cell of ['tet4', 'tet10'] as const) {
    const d = await solveElastic(cantilever(cell));
    const a = await solveElastic(cantilever(cell, 'amg-pcg'));
    assert.equal(a.stats.solver, 'amg-pcg');
    assert.ok(a.stats.residual! <= 1e-11, `${cell} residual ${a.stats.residual}`);
    assert.ok(a.stats.iterations! > 0 && a.stats.iterations! < 200, `${cell} iterations ${a.stats.iterations}`);
    const r = relDiff(d.u, a.u);
    assert.ok(r < 1e-8, `${cell}: max |u_amg - u_direct| / max |u| = ${r}`);
  }
});

test('elastic AMG-PCG in 2D (tri3: smoothed aggregation; tri6: p-multigrid) equals the direct solve', async () => {
  for (const order of [1, 2] as const) {
    const mk = (solver?: 'amg-pcg'): ElasticProblem => {
      const mesh = rectTriMesh({ x: [0, 0.2], y: [0, 0.02], nx: 80, ny: 8, order, id: 'r' });
      const nc = mesh.cells.conn.length / (order === 2 ? 6 : 3);
      return { mesh, model: 'plane-stress', E: new Float64Array(nc).fill(70e9), nu: new Float64Array(nc).fill(0.33),
        bcs: [{ type: 'fixed', select: ['bnd:r.left'] }, { type: 'traction', select: ['bnd:r.right'], t: [1e5, -1e6] }], ...(solver ? { solver } : {}) };
    };
    const d = await solveElastic(mk()), a = await solveElastic(mk('amg-pcg'));
    const r = relDiff(d.u, a.u);
    assert.ok(r < 1e-8 && a.stats.iterations! < 200, `order ${order}: ${r}, ${a.stats.iterations} iterations`);
  }
});

const warp = parseYaml(readFileSync(new URL('../../../sims/die-warpage-3d.yaml', import.meta.url), 'utf8')).data as { studies: Array<Record<string, unknown>> };
async function warpRun(settings?: Record<string, unknown>) {
  const s = structuredClone(warp);
  if (settings) s.studies[0]!.settings = settings;
  return runStudy(await prepareRun({ spec: s as unknown as Record<string, unknown>, hFactor: 1 }));
}

test('study solver setting on heat -> elastic: amg-pcg matches direct; run.solver per physics and merged', async () => {
  const d = await warpRun();
  const a = await warpRun({ solver: 'amg-pcg', rtol: 1e-10 });
  const ud = d.fields.find((f) => f.name === 'u')!.data, ua = a.fields.find((f) => f.name === 'u')!.data;
  const r = relDiff(ud, ua);
  assert.ok(r < 1e-8, `max |u_amg - u_direct| / max |u| = ${r}`);
  assert.deepEqual(d.run.solver, {
    kind: 'direct', rtol: null, iterations: null, residual: null,
    byPhysics: { ht: { kind: 'direct', rtol: null, iterations: null, residual: null }, solid: { kind: 'direct', rtol: null, iterations: null, residual: null } },
  });
  const s = a.run.solver!;
  assert.equal(s.kind, 'amg-pcg');
  assert.equal(s.rtol, 1e-10);
  assert.ok(s.iterations! > 0 && s.residual! <= 1e-10, JSON.stringify(s));
  assert.equal(s.byPhysics!.solid!.kind, 'amg-pcg');
  assert.equal(s.iterations, Math.max(s.byPhysics!.ht!.iterations!, s.byPhysics!.solid!.iterations!));
  assert.ok((a as { notes?: string[] }).notes?.some((n) => /amg-pcg, rtol 1e-10, 1 solve\(s\)/.test(n)));
});

test('solver record helpers', () => {
  assert.deepEqual(solverRecordOf([{ kind: 'cholesky' }]), { kind: 'direct', rtol: null, iterations: null, residual: null });
  assert.deepEqual(solverRecordOf([{ kind: 'cholesky' }, { kind: 'amg-pcg', rtol: 1e-10, iterations: 12, residual: 5e-11 }, { kind: 'amg-pcg', rtol: 1e-9, iterations: 7, residual: 8e-10 }]),
    { kind: 'amg-pcg', rtol: 1e-9, iterations: 12, residual: 8e-10 });
  assert.equal(mergeSolverRecords([['a', undefined]]), undefined);
  const m = mergeSolverRecords([['a', { kind: 'direct', rtol: null, iterations: null, residual: null }], ['b', { kind: 'ams-pcg', rtol: 1e-10, iterations: 30, residual: 9e-11 }]])!;
  assert.equal(m.kind, 'ams-pcg');
  assert.deepEqual(Object.keys(m.byPhysics), ['a', 'b']);
});

/** 1D Laplacian pencil (K tridiagonal, M = I), eigenvalues 2 - 2 cos(k pi / (n + 1)). */
function laplace1d(n: number): { pat: Csr; K: Float64Array; M: Float64Array } {
  const rowptr = new Int32Array(n + 1), cols: number[] = [], kv: number[] = [], mv: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < n) { cols.push(j); kv.push(j === i ? 2 : -1); mv.push(j === i ? 1 : 0); }
    rowptr[i + 1] = cols.length;
  }
  return { pat: { n, rowptr, colidx: Int32Array.from(cols), nnz: cols.length }, K: Float64Array.from(kv), M: Float64Array.from(mv) };
}

test('eigen completeness: pass leaves the result bitwise unchanged; a hidden eigenvalue is detected (lowest and interior shifts)', () => {
  const n = 120, P = laplace1d(n);
  const exact = Array.from({ length: n }, (_, k) => 2 - 2 * Math.cos(((k + 1) * Math.PI) / (n + 1)));
  for (const sigma of [-0.01, exact[10]! + 0.3 * (exact[11]! - exact[10]!)]) {
    const base = { ...P, sigma, nWant: 6, kPsd: true, tol: 1e-12 };
    const off = shiftInvertEigen({ ...base, check: 'off' });
    const on = shiftInvertEigen({ ...base, check: 'inertia' });
    assert.equal(on.stats.check!.status, 'pass', JSON.stringify(on.stats.check));
    assert.ok(on.stats.check!.intervals.length >= 1);
    assert.ok(off.lambda.every((x, i) => Object.is(x, on.lambda[i])), 'eigenvalues bitwise');
    assert.ok(off.vecs.every((v, i) => v.every((x, q) => Object.is(x, on.vecs[i]![q]))), 'eigenvectors bitwise');
    // auto on this small factor runs the check too
    assert.equal(shiftInvertEigen(base).stats.check!.status, 'pass');
    // hide an eigenvector inside the wanted range by a projector (claimed null space 0): the Krylov space never sees
    // it, the inertia count does
    // (DevLog-066: also the 5th / 6th nearest, i.e. between the outermost computed eigenvalue and the last gap)
    const order = exact.map((l, k) => k).sort((i, j) => Math.abs(exact[i]! - sigma) - Math.abs(exact[j]! - sigma));
    let project = (_x: Float64Array) => {};
    for (const pos of [2, 4, 5]) {
      const kh = order[pos]!;
      const q = Float64Array.from({ length: n }, (_, i) => Math.sin(((kh + 1) * (i + 1) * Math.PI) / (n + 1)));
      const qq = q.reduce((s, x) => s + x * x, 0);
      project = (x: Float64Array) => { let c = 0; for (let i = 0; i < n; i++) c += q[i]! * x[i]!; c /= qq; for (let i = 0; i < n; i++) x[i]! -= c * q[i]!; };
      const hid = shiftInvertEigen({ ...base, project, nullDim: 0, check: 'inertia' });
      assert.ok(!Array.from(hid.lambda).some((l) => Math.abs(l - exact[kh]!) < 1e-9), 'hidden eigenvalue not computed');
      assert.equal(hid.stats.check!.status, 'missed', `sigma ${sigma} hidden nearest #${pos + 1}: ${JSON.stringify(hid.stats.check)}`);
      assert.equal(hid.lambda.length, 6);
      assert.equal(hid.stats.check!.attempts, 4);
    }
    // projector without a null-space dimension: skipped
    assert.equal(shiftInvertEigen({ ...base, project }).stats.check!.status, 'skipped');
  }
  const prev = setEigenCheckDefault('off');
  try { assert.equal(shiftInvertEigen({ ...P, sigma: -0.01, nWant: 4, kPsd: true }).stats.check!.status, 'skipped'); }
  finally { setEigenCheckDefault(prev); }
});

import { symTetRule } from '../src/common/quad.ts';
import { setTetQuadrature, tetQuadrature, defaultRule } from '../src/common/lagrange.ts';

test('symmetric tet rules: exact moments up to their degree; option off by default', () => {
  const fact = (n: number): number => (n <= 1 ? 1 : n * fact(n - 1));
  for (const [d, np] of [[1, 1], [2, 4], [5, 14]] as const) {
    const r = symTetRule(d)!;
    assert.equal(r.n, np);
    for (let a = 0; a <= d; a++) for (let b = 0; a + b <= d; b++) for (let c = 0; a + b + c <= d; c++) {
      let s = 0;
      for (let q = 0; q < r.n; q++) s += r.wts[q]! * r.pts[3 * q]! ** a * r.pts[3 * q + 1]! ** b * r.pts[3 * q + 2]! ** c;
      const ex = (fact(a) * fact(b) * fact(c)) / fact(a + b + c + 3);
      assert.ok(Math.abs(s - ex) <= 1e-15 * ex, `degree ${d}: x^${a} y^${b} z^${c}: ${s} vs ${ex}`);
    }
    assert.ok(r.wts.every((w) => w > 0));
  }
  assert.equal(symTetRule(6), null);
  assert.equal(tetQuadrature(), 'collapsed');
  assert.equal(defaultRule('tet10', 4).n, 64);
});

test("tet quadrature 'matched': elastic on an affine tet10 mesh equals the collapsed rule to round-off", async () => {
  // a compact block (well conditioned; a slender cantilever amplifies the round-off of K by its condition number)
  const block = (): ElasticProblem => {
    const mesh = boxMesh({ x: [0, 1e-3], y: [0, 1e-3], z: [0, 1e-3], nx: 3, ny: 3, nz: 3, cell: 'tet10' });
    const nc = mesh.cells.conn.length / 10;
    return { mesh, model: '3d', E: new Float64Array(nc).fill(170e9), nu: new Float64Array(nc).fill(0.28),
      thermal: { alpha: new Float64Array(nc).fill(2.6e-6), T: Float64Array.from({ length: mesh.nodes.length / 3 }, (_, v) => 300 + 1e5 * mesh.nodes[3 * v]!), Tref: 300 },
      bcs: [{ type: 'fixed', select: ['bnd:box.xmin'] }, { type: 'traction', select: ['bnd:box.xmax'], t: [0, 1e6, -1e6] }] };
  };
  const ref = await solveElastic(block());
  const prev = setTetQuadrature('matched');
  try {
    assert.equal(defaultRule('tet10', 4).n, 14);
    const m = await solveElastic(block());
    const r = relDiff(ref.u, m.u);
    assert.ok(r < 1e-13, `max |u_matched - u_collapsed| / max |u| = ${r}`);
  } finally { setTetQuadrature(prev); }
  assert.throws(() => setTetQuadrature('gauss' as 'matched'));
});
