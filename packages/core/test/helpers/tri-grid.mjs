// SPDX-License-Identifier: GPL-3.0-or-later
// Test helper (not exported by @amp/core): structured triangle meshes in the shape the EO mesher returns to fem.mjs
// ({nNodes, nTris, x, y, tri, triRegion}), standing in for EO section.mjs / mesh.mjs (lane L3) in the ported EO
// tests. Each tensor cell is split along alternating diagonals (union-jack free, deterministic). Counter-clockwise
// triangles. Coordinates come from breakpoints: every breakpoint is a grid line, spacing <= h between them, with an
// optional geometric grading towards the low end of each interval.

/** Grid line coordinates through every breakpoint, spacing at most h (grading g >= 1 shrinks cells towards `lo`). */
export function lines(breaks, h, g = 1) {
  const b = [...new Set(breaks)].sort((p, q) => p - q);
  const out = [b[0]];
  for (let q = 0; q + 1 < b.length; q++) {
    const L = b[q + 1] - b[q];
    const n = Math.max(1, Math.ceil(L / h - 1e-9));
    if (g === 1) for (let k = 1; k <= n; k++) out.push(b[q] + (L * k) / n);
    else {
      const w = Array.from({ length: n }, (_, k) => g ** k), s = w.reduce((a, c) => a + c, 0);
      let x = b[q];
      for (let k = 0; k < n; k++) { x += (L * w[k]) / s; out.push(k === n - 1 ? b[q + 1] : x); }
    }
  }
  return Float64Array.from(out);
}

/**
 * @param {Float64Array} xs grid lines in x
 * @param {Float64Array} ys grid lines in y
 * @param {(cx:number, cy:number) => number} [region] region index of a triangle from its centroid
 */
export function triGrid(xs, ys, region = () => 0) {
  const nx = xs.length, ny = ys.length;
  const nNodes = nx * ny, nTris = 2 * (nx - 1) * (ny - 1);
  const x = new Float64Array(nNodes), y = new Float64Array(nNodes);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { x[i + nx * j] = xs[i]; y[i + nx * j] = ys[j]; }
  const tri = new Int32Array(3 * nTris), triRegion = new Int32Array(nTris);
  let t = 0;
  const put = (a, b, c) => {
    tri[3 * t] = a; tri[3 * t + 1] = b; tri[3 * t + 2] = c;
    triRegion[t] = region((x[a] + x[b] + x[c]) / 3, (y[a] + y[b] + y[c]) / 3);
    t++;
  };
  for (let j = 0; j + 1 < ny; j++)
    for (let i = 0; i + 1 < nx; i++) {
      const n00 = i + nx * j, n10 = n00 + 1, n01 = n00 + nx, n11 = n01 + 1;
      if ((i + j) % 2 === 0) { put(n00, n10, n11); put(n00, n11, n01); }
      else { put(n00, n10, n01); put(n10, n11, n01); }
    }
  return { nNodes, nTris, x, y, tri, triRegion };
}

export const inRect = (x0, x1, y0, y1, tol = 1e-12) => (x, y) => x >= x0 - tol && x <= x1 + tol && y >= y0 - tol && y <= y1 + tol;
