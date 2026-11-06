// Ported from advanced-packaging-atlas/engine/src/em3d/mesh.mjs at fe39985 (GPL-3.0-or-later). Changes: only the z-plane
// subdivision (zPlanes interval loop, as subdivideInterval) and the prism -> 3 tet split with the minimum-global-index
// diagonal rule (Dompierre, Labbe, Vallet, Camarero 1999) are kept, as standalone functions over plain arrays. The
// em2d-mesher call, painter-order solids, cuts / surfaces and subMesh are not ported: the 2D mesh comes from
// mesh2d.ts with entity tags, and layer / domain activity from @amp/geom extrudeLayered (no painter order).
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Interior + end planes of one interval [a, b] (APA zPlanes body): uniform cells of size <= dz, or, with 0 < dzMin < dz
 * and L > 2 dzMin, cells growing geometrically by `growth` from dzMin at both ends (capped at dz), scaled to fit L.
 * Returns the planes after a (a excluded, b included).
 */
export function subdivideInterval(a, b, dz, dzMin = 0, growth = 1.5) {
  const out = [];
  const L = b - a;
  if (dzMin > 0 && dzMin < dz && L > 2 * dzMin) {
    const half = [];
    let acc = 0,
      h = dzMin;
    while (acc < L / 2 - 1e-12 * L) {
      const hh = Math.min(h, dz);
      half.push(hh);
      acc += hh;
      h *= growth;
    }
    const sizes = [...half, ...half.slice().reverse()];
    const tot = sizes.reduce((x, y) => x + y, 0);
    let z = a;
    for (let k = 0; k < sizes.length - 1; k++) {
      z += (sizes[k] * L) / tot;
      out.push(z);
    }
    out.push(b);
    return out;
  }
  const n = Math.max(1, Math.ceil(L / dz - 1e-9));
  for (let k = 1; k <= n; k++) out.push(k === n ? b : a + (L * k) / n);
  return out;
}

// rotations of the prism (bottom 0 1 2, top 3 4 5 above 0 1 2) bringing local vertex r to position 0 (APA)
const ROT = [
  [0, 1, 2, 3, 4, 5],
  [1, 2, 0, 4, 5, 3],
  [2, 0, 1, 5, 3, 4],
  [3, 5, 4, 0, 2, 1],
  [4, 3, 5, 1, 0, 2],
  [5, 4, 3, 2, 1, 0],
];

/**
 * Split one prism with global vertex ids G = [b0, b1, b2, t0, t1, t2] into 3 tets (APA rule): rotate so the minimum id is
 * at local 0; the quad face (1, 2, 5, 4) not touching it is cut through its smallest vertex. Every quad face is then
 * cut through its own minimum vertex, so neighbouring prisms conform. Calls put(a, b, c, d) three times (unsorted ids).
 */
export function splitPrism(G, put) {
  let r = 0;
  for (let i = 1; i < 6; i++) if (G[i] < G[r]) r = i;
  const R = ROT[r];
  const P = [G[R[0]], G[R[1]], G[R[2]], G[R[3]], G[R[4]], G[R[5]]];
  if (Math.min(P[1], P[5]) < Math.min(P[2], P[4])) {
    put(P[0], P[1], P[2], P[5]);
    put(P[0], P[1], P[5], P[4]);
    put(P[0], P[4], P[5], P[3]);
  } else {
    put(P[0], P[1], P[2], P[4]);
    put(P[0], P[4], P[2], P[5]);
    put(P[0], P[4], P[5], P[3]);
  }
}

/** The two triangles of quad (q0, q1, q2, q3) (cyclic) cut through its minimum vertex, as splitPrism does. */
export function splitQuad(q, out) {
  let m = 0;
  for (let i = 1; i < 4; i++) if (q[i] < q[m]) m = i;
  const a = q[m], b = q[(m + 1) % 4], c = q[(m + 2) % 4], d = q[(m + 3) % 4];
  out.push(a, b, c, a, c, d);
  return out;
}
