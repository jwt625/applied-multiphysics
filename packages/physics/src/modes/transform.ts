// SPDX-License-Identifier: GPL-3.0-or-later
// Coordinate transforms of the em-modes cross-section (lane S2, DevLog-043 s.2.1): per-triangle complex factors for
// PML stretching (sx, sy) and the bend metric h, consumed by the kernel option `transform` (vector-mode.mjs
// transformTensors). Coordinates in SI (m); factors are dimensionless and evaluated at triangle centroids.
//
// PML: s(xi) = 1 - j a xi^p, xi = depth into the layer / layer thickness in [0, 1] (time convention exp(+j omega t):
//   outgoing exp(-j k x) decays). a = strength, p = power: numerical modelling choices.
// Bend: bend in the x-z plane about an axis parallel to y; centre of curvature at x = x0 - R (R > 0: outer side at +x;
//   R < 0: centre at x0 + |R|, outer side at -x); h = 1 + (x~ - x0) / R = r / |R|, with x~ the complex stretched
//   coordinate inside an x-PML (analytic continuation). n_eff is referenced to the radius |R| (arc length at x = x0).

import type { Mesh } from '@amp/spec/types';
import { NPC, nCells } from '../common/mesh.ts';

export interface PmlRegion {
  /** domain indices (mesh.entities.domains) stretched by this entry */
  domains: number[];
  /** a in s = 1 - j a xi^p */
  strength: number;
  /** p in s = 1 - j a xi^p */
  power: number;
  /** explicit [inner, outer] x of the stretch (m); default: from the domain bounding box */
  x?: [number, number];
  /** explicit [inner, outer] y of the stretch (m) */
  y?: [number, number];
}

export interface BendOptions { radius: number; x0?: number; model?: 'metric' | 'conformal' }

export interface TransformOut {
  sx: Float64Array | null; sy: Float64Array | null; h: Float64Array | null; model: 'metric' | 'conformal';
  /** resolved stretch per PML domain (for notes) */
  layers: Array<{ domain: number; x?: [number, number]; y?: [number, number] }>;
}

function centroids(mesh: Mesh) {
  const k = NPC[mesh.cells.type], nc = nCells(mesh);
  const cx = new Float64Array(nc), cy = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    let x = 0, y = 0;
    for (let a = 0; a < 3; a++) { const n = mesh.cells.conn[k * c + a]!; x += mesh.nodes[2 * n]!; y += mesh.nodes[2 * n + 1]!; }
    cx[c] = x / 3; cy[c] = y / 3;
  }
  return { cx, cy };
}

/** Bounding box of the vertices of the cells for which pick(c) holds. */
function bbox(mesh: Mesh, pick: (c: number) => boolean) {
  const k = NPC[mesh.cells.type], nc = nCells(mesh);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let c = 0; c < nc; c++) {
    if (!pick(c)) continue;
    for (let a = 0; a < 3; a++) {
      const n = mesh.cells.conn[k * c + a]!, x = mesh.nodes[2 * n]!, y = mesh.nodes[2 * n + 1]!;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { x0, x1, y0, y1 };
}

/**
 * Per-triangle transform factors. cellMask: cells of the physics (default all). Automatic PML direction: against the
 * bounding box of the live cells outside every PML domain (the interior). Throws when a direction cannot be inferred.
 */
export function modeTransform(mesh: Mesh, o: { pml?: PmlRegion[]; bend?: BendOptions; cellMask?: Uint8Array; domainName?: (d: number) => string }): TransformOut {
  const nc = nCells(mesh);
  const { cx, cy } = centroids(mesh);
  const live = (c: number) => !o.cellMask || o.cellMask[c] === 1;
  const W = bbox(mesh, live);
  const tol = 1e-9 * Math.max(W.x1 - W.x0, W.y1 - W.y0);
  const name = o.domainName ?? ((d: number) => `domain ${d}`);
  const xs = new Float64Array(nc).fill(NaN), xe = new Float64Array(nc), ys = new Float64Array(nc).fill(NaN), ye = new Float64Array(nc);
  const strength = new Float64Array(nc), power = new Float64Array(nc);
  const layers: TransformOut['layers'] = [];
  const owner = new Int32Array(nc).fill(-1);
  let anyX = false, anyY = false;
  // interior = live cells in no PML entry; a PML domain is stretched along x when it lies entirely beyond the interior's
  // x range (inner edge = the domain's edge facing the interior), and likewise along y (corner domains: both)
  const pmlDom = new Set((o.pml ?? []).flatMap((r) => r.domains));
  const I = bbox(mesh, (c) => live(c) && !pmlDom.has(mesh.cells.domain[c]!));
  if (pmlDom.size && !Number.isFinite(I.x0)) throw new Error('em-modes pml: every cell of the selection is in a PML');
  for (const [ri, r] of (o.pml ?? []).entries()) {
    if (!(r.strength > 0) || !(r.power >= 0)) throw new Error(`em-modes pml[${ri}]: strength must be > 0 and power >= 0`);
    for (const d of r.domains) {
      const B = bbox(mesh, (c) => live(c) && mesh.cells.domain[c] === d);
      if (!Number.isFinite(B.x0)) throw new Error(`em-modes pml[${ri}]: ${name(d)} has no cells in the physics selection`);
      const axis = (lo: number, hi: number, Lo: number, Hi: number, expl: [number, number] | undefined, ax: string): [number, number] | undefined => {
        if (expl) { if (!(expl[0] !== expl[1])) throw new Error(`em-modes pml[${ri}].${ax}: inner and outer must differ`); return expl; }
        if (lo >= Hi - tol) return [lo, hi];
        if (hi <= Lo + tol) return [hi, lo];
        return undefined;
      };
      const ax = axis(B.x0, B.x1, I.x0, I.x1, r.x, 'x'), ay = axis(B.y0, B.y1, I.y0, I.y1, r.y, 'y');
      if (!ax && !ay) throw new Error(`em-modes pml[${ri}]: cannot infer the stretch direction of ${name(d)} (it overlaps the interior in both x and y); give x: [inner, outer] and / or y: [inner, outer]`);
      layers.push({ domain: d, ...(ax ? { x: ax } : {}), ...(ay ? { y: ay } : {}) });
      for (let c = 0; c < nc; c++) {
        if (mesh.cells.domain[c] !== d || !live(c)) continue;
        if (owner[c]! >= 0 && owner[c] !== ri) throw new Error(`em-modes pml: ${name(d)} is listed in more than one pml entry`);
        owner[c] = ri;
        strength[c] = r.strength; power[c] = r.power;
        if (ax) { xs[c] = ax[0]; xe[c] = ax[1]; anyX = true; }
        if (ay) { ys[c] = ay[0]; ye[c] = ay[1]; anyY = true; }
      }
    }
  }
  const sx = anyX ? new Float64Array(2 * nc) : null, sy = anyY ? new Float64Array(2 * nc) : null;
  const xt = new Float64Array(2 * nc); // complex stretched x (for the bend metric)
  for (let c = 0; c < nc; c++) {
    xt[2 * c] = cx[c]!;
    const st = (v: number, a: number, b: number, out: Float64Array | null, cplx: boolean) => {
      if (!out) return;
      if (Number.isNaN(a)) { out[2 * c] = 1; out[2 * c + 1] = 0; return; }
      const xi = Math.min(1, Math.max(0, (v - a) / (b - a)));
      const p = power[c]!, s = strength[c]!;
      out[2 * c] = 1; out[2 * c + 1] = -s * xi ** p;
      // x~ = x - j a (x - inner) xi^p / (p + 1)
      if (cplx) xt[2 * c + 1] = -s * (v - a) * xi ** p / (p + 1);
    };
    st(cx[c]!, xs[c]!, xe[c]!, sx, true);
    st(cy[c]!, ys[c]!, ye[c]!, sy, false);
  }
  let h: Float64Array | null = null;
  if (o.bend) {
    const R = o.bend.radius, x0 = o.bend.x0 ?? 0;
    if (!(Number.isFinite(R) && R !== 0)) throw new Error('em-modes bend: radius must be finite and nonzero');
    h = new Float64Array(2 * nc);
    for (let c = 0; c < nc; c++) {
      h[2 * c] = 1 + (xt[2 * c]! - x0) / R;
      h[2 * c + 1] = xt[2 * c + 1]! / R;
      if (live(c) && !(h[2 * c]! > 0)) throw new Error(`em-modes bend: the window reaches the bend centre (x = ${x0 - R} m); shrink the window or increase |radius|`);
    }
  }
  return { sx, sy, h, model: o.bend?.model ?? 'metric', layers };
}
