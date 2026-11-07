// SPDX-License-Identifier: GPL-3.0-or-later
// hex8 -> tet10 conversion for elasticity on 3D box-union meshes (lane MT, DevLog-033 E2). The box mesher of @amp/mesh
// gives axis-aligned hex8 cells; trilinear hexes lock in bending (thin arms, warpage), so the elastic path uses P2
// tets instead: each hex is reordered to the canonical VTK corner order by coordinates (node 0 at the minimum corner)
// and split into 6 Kuhn tets around its main diagonal 0-6. Every hex face is then split along the diagonal from its
// minimum to its maximum corner, so the split is conforming across hexes; each quad facet is split the same way
// (min-max diagonal), facet boundary tags and domain tags are kept, and @amp/mesh toP2 adds the mid-edge nodes
// (straight edges: exact for boxes). Entity tables (domains, boundaries, points) are unchanged.

import type { Mesh } from '@amp/spec/types';
import { toP2 } from '@amp/mesh';
import { makeMesh } from '../common/mesh.ts';

const KUHN = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
/** VTK hex corner (i, j, k) -> local index */
const VTK: Record<string, number> = { '000': 0, '100': 1, '110': 2, '010': 3, '001': 4, '101': 5, '111': 6, '011': 7 };

export function hexToTet10(m: Mesh): Mesh {
  if (m.dim !== 3 || m.cells.type !== 'hex8' || m.facets.type !== 'quad4') throw new Error(`hexToTet10: needs a hex8 mesh with quad4 facets, got ${m.cells.type} / ${m.facets.type}`);
  const X = m.nodes, nc = m.cells.domain.length, conn: number[] = [], dom: number[] = [];
  let span = 0;
  for (let d = 0; d < 3; d++) { let lo = Infinity, hi = -Infinity; for (let i = d; i < X.length; i += 3) { lo = Math.min(lo, X[i]!); hi = Math.max(hi, X[i]!); } span = Math.max(span, hi - lo); }
  const tol = 1e-9 * span;
  const vol = (a: number, b: number, c: number, d: number) => {
    const u = [0, 1, 2].map((k) => X[3 * b + k]! - X[3 * a + k]!), v = [0, 1, 2].map((k) => X[3 * c + k]! - X[3 * a + k]!), w = [0, 1, 2].map((k) => X[3 * d + k]! - X[3 * a + k]!);
    return u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
  };
  for (let e = 0; e < nc; e++) {
    const v = Array.from(m.cells.conn.subarray(8 * e, 8 * e + 8));
    const lo = [0, 1, 2].map((k) => Math.min(...v.map((n) => X[3 * n + k]!))), hi = [0, 1, 2].map((k) => Math.max(...v.map((n) => X[3 * n + k]!)));
    const can = new Array<number>(8).fill(-1);
    for (const n of v) {
      const bits = [0, 1, 2].map((k) => {
        const x = X[3 * n + k]!;
        if (Math.abs(x - lo[k]!) <= tol) return '0';
        if (Math.abs(x - hi[k]!) <= tol) return '1';
        throw new Error(`hexToTet10: cell ${e} is not an axis-aligned box`);
      }).join('');
      can[VTK[bits]!] = n;
    }
    if (can.some((n) => n < 0)) throw new Error(`hexToTet10: cell ${e} is not an axis-aligned box`);
    for (const t of KUHN) {
      let [a, b, c, d] = t.map((i) => can[i]!) as [number, number, number, number];
      if (vol(a, b, c, d) < 0) [b, c] = [c, b];
      conn.push(a, b, c, d); dom.push(m.cells.domain[e]!);
    }
  }
  // quad facets: split along the diagonal from the minimum to the maximum corner (the Kuhn face diagonal)
  const fconn: number[] = [], fb: number[] = [];
  const nf = m.facets.boundary.length;
  for (let f = 0; f < nf; f++) {
    const q = Array.from(m.facets.conn.subarray(4 * f, 4 * f + 4));
    const key = (n: number) => X[3 * n]! + X[3 * n + 1]! + X[3 * n + 2]!;
    const order = [...q].sort((a, b) => key(a) - key(b));
    const mn = order[0]!, mx = order[3]!, others = q.filter((n) => n !== mn && n !== mx);
    if (others.length !== 2) throw new Error(`hexToTet10: degenerate facet ${f}`);
    fconn.push(mn, others[0]!, mx, mn, others[1]!, mx); fb.push(m.facets.boundary[f]!, m.facets.boundary[f]!);
  }
  const t4 = makeMesh({
    dim: 3, nodes: m.nodes,
    cells: { type: 'tet4', conn: Int32Array.from(conn), domain: Int32Array.from(dom) },
    facets: { type: 'tri3', conn: Int32Array.from(fconn), boundary: Int32Array.from(fb) },
    entities: m.entities,
  });
  const pn = (m as Mesh & { pointNode?: Int32Array }).pointNode;
  if (pn) (t4 as Mesh & { pointNode?: Int32Array }).pointNode = pn;
  return toP2(t4 as Parameters<typeof toP2>[0]) as Mesh;
}
