// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tetRule, triRule, gaussLegendre01 } from '../src/common/quad.ts';
import { rectTriMesh, boxMesh, facetsOn, nNodes } from '../src/common/mesh.ts';
import { assembleCells, assembleFacets, eliminate, SpdSolver } from '../src/common/scalar.ts';

test('quadrature moments', () => {
  const g = gaussLegendre01(5); let s = 0; for (let i = 0; i < 5; i++) s += g.w[i]! * g.x[i]! ** 8; assert.ok(Math.abs(s - 1 / 9) < 1e-14);
  const t = triRule(4); let a = 0; for (let q = 0; q < t.n; q++) a += t.wts[q]! * t.pts[2 * q]! ** 3 * t.pts[2 * q + 1]! ** 2;
  assert.ok(Math.abs(a - (6 * 2) / 5040) < 1e-14); // int x^3 y^2 = 3! 2! / 7!
  const T = tetRule(4); let b = 0; for (let q = 0; q < T.n; q++) b += T.wts[q]! * T.pts[3 * q]! ** 2 * T.pts[3 * q + 1]! * T.pts[3 * q + 2]!;
  assert.ok(Math.abs(b - 2 / 5040) < 1e-15); // 2! 1! 1! / 7!
});

for (const cell of ['tet4', 'tet10', 'hex8'] as const) test(`Poisson 3D ${cell}: quadratic exact / volume`, () => {
  const m = boxMesh({ x: [0, 1], y: [0, 2], z: [0, 1], nx: 3, ny: 4, nz: 2, cell });
  const nc = m.cells.conn.length / ({ tet4: 4, tet10: 10, hex8: 8 } as const)[cell];
  const A = assembleCells(m, { k: new Float64Array(nc).fill(1), m: new Float64Array(nc).fill(1), f: new Float64Array(nc).fill(2) });
  let vol = 0; for (const v of A.M!) vol += v; assert.ok(Math.abs(vol - 2) < 1e-12);
  // -u'' = 2 in x, u = 0 at x = 0, 1: u = x (1 - x)
  const n = nNodes(m), fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const x = m.nodes[3 * i]!; if (x < 1e-12 || x > 1 - 1e-12) fixed[i] = 1; }
  const E = eliminate(A.pat, A.K!, A.F!, fixed, new Float64Array(n));
  const S = new SpdSolver(E.R.pat); S.factor(E.R.val); const u = E.lift(S.solve(E.b));
  let err = 0; for (let i = 0; i < n; i++) { const x = m.nodes[3 * i]!; err = Math.max(err, Math.abs(u[i]! - x * (1 - x))); }
  if (cell === 'tet10') assert.ok(err < 1e-12, `err ${err}`); else assert.ok(err < 0.05, `err ${err}`);
  const S2 = new SpdSolver(E.R.pat, 'amg-pcg'); S2.factor(E.R.val); const u2 = E.lift(S2.solve(E.b));
  let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(u2[i]! - u[i]!)); assert.ok(d < 1e-9, `amg ${d}`);
});

test('Robin facet + tri6 1D exactness', () => {
  // -k u'' = 0, u(0) = 1, -k u'(1) = h u(1): u = 1 - h x / (k + h)
  const m = rectTriMesh({ x: [0, 1], y: [0, 0.2], nx: 4, ny: 1, order: 2 });
  const nc = m.cells.conn.length / 6, k = 3, h = 2;
  const A = assembleCells(m, { k: new Float64Array(nc).fill(k), f: new Float64Array(nc) });
  assembleFacets(m, A.pat, facetsOn(m, ['bnd:rect.right']), { h, Kval: A.K! });
  const n = nNodes(m), fixed = new Uint8Array(n), uc = new Float64Array(n);
  for (let i = 0; i < n; i++) if (m.nodes[2 * i]! < 1e-12) { fixed[i] = 1; uc[i] = 1; }
  const E = eliminate(A.pat, A.K!, A.F!, fixed, uc);
  const S = new SpdSolver(E.R.pat); S.factor(E.R.val); const u = E.lift(S.solve(E.b));
  let err = 0; for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(u[i]! - (1 - (h * m.nodes[2 * i]!) / (k + h))));
  assert.ok(err < 1e-13, `err ${err}`);
});
