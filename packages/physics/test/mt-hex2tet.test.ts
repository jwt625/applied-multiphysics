// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MT (DevLog-033 E2): hex8 box meshes -> conforming tet10 for elasticity. Coefficients are test numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshBoxes } from '@amp/mesh';
import type { Mesh } from '@amp/spec/types';
import { hexToTet10 } from '../src/elastic/hex2tet.ts';
import { solveElastic } from '../src/elastic/index.ts';
import { nCells } from '../src/common/mesh.ts';

test('hexToTet10: two-box union -> conforming tet10 (each interior face in exactly 2 tets, boundary faces = facets), volume kept', () => {
  const h = meshBoxes([{ id: 'a', x: [0, 1e-3], y: [0, 2e-4], z: [0, 1e-4] }, { id: 'b', x: [1e-3, 1.5e-3], y: [0, 6e-4], z: [0, 1e-4] }], { h: 5e-5 }) as unknown as Mesh;
  const m = hexToTet10(h);
  assert.equal(m.cells.type, 'tet10'); assert.equal(m.facets.type, 'tri6');
  const k = 10, nc = nCells(m), faces = new Map<string, number>();
  let V = 0;
  for (let e = 0; e < nc; e++) {
    const v = Array.from(m.cells.conn.subarray(k * e, k * e + 4));
    for (const f of [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]]) { const key = f.map((i) => v[i]!).sort((a, b) => a - b).join(','); faces.set(key, (faces.get(key) ?? 0) + 1); }
    const P = v.map((n) => [0, 1, 2].map((c) => m.nodes[3 * n + c]!));
    const u = [0, 1, 2].map((c) => P[1]![c]! - P[0]![c]!), w = [0, 1, 2].map((c) => P[2]![c]! - P[0]![c]!), z = [0, 1, 2].map((c) => P[3]![c]! - P[0]![c]!);
    const det = u[0]! * (w[1]! * z[2]! - w[2]! * z[1]!) - u[1]! * (w[0]! * z[2]! - w[2]! * z[0]!) + u[2]! * (w[0]! * z[1]! - w[1]! * z[0]!);
    assert.ok(det > 0, `tet ${e} orientation`);
    V += det / 6;
  }
  assert.ok(Math.abs(V - (1e-3 * 2e-4 * 1e-4 + 5e-4 * 6e-4 * 1e-4)) < 1e-20, `volume ${V}`);
  const once = [...faces.entries()].filter(([, c]) => c === 1).map(([f]) => f), more = [...faces.values()].filter((c) => c > 2).length;
  assert.equal(more, 0);
  // every face seen once lies on the exterior: it must be one of the (exterior) facets
  const fk = new Set<string>();
  for (let f = 0; f < m.facets.boundary.length; f++) fk.add(Array.from(m.facets.conn.subarray(6 * f, 6 * f + 3)).sort((a, b) => a - b).join(','));
  assert.ok(once.every((f) => fk.has(f)), `${once.filter((f) => !fk.has(f)).length} exterior faces without a facet`);
});

test('hexToTet10: cantilever tip deflection of a converted hex8 box beam (L/a = 20) within 2 % of Euler-Bernoulli', async () => {
  const L = 1e-3, a = 5e-5, E = 1.6e11, nu = 0.25, P = 1e3;   // test numbers; end traction P (Pa) in -y
  const h = meshBoxes([{ id: 'bm', x: [0, L], y: [0, a], z: [0, a] }], { h: a / 2 }) as unknown as Mesh;
  const m = hexToTet10(h), nc = nCells(m);
  const s = await solveElastic({ mesh: m, model: '3d', E: new Float64Array(nc).fill(E), nu: new Float64Array(nc).fill(nu), bcs: [{ type: 'fixed', select: ['bnd:bm.xmin'] }, { type: 'traction', select: ['bnd:bm.xmax'], t: [0, -P, 0] }] });
  let tip = 0, cnt = 0; for (let v = 0; v < m.nodes.length / 3; v++) if (Math.abs(m.nodes[3 * v]! - L) < 1e-12) { tip += s.u[3 * v + 1]!; cnt++; }
  tip /= cnt;
  const ref = -(P * a * a) * L ** 3 / (3 * E * a ** 4 / 12);   // Euler-Bernoulli: F L^3 / (3 E I), F = P a^2
  assert.ok(Math.abs(tip / ref - 1) < 0.02, `tip ${tip} vs EB ${ref} (rel ${tip / ref - 1})`);
});
