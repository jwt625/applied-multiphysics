// SPDX-License-Identifier: GPL-3.0-or-later
// Rasterization of canvas paint operations onto a cell grid. Shared by GPU kernels and CPU references.

import type { PaintOp } from "./types.ts";

/** Calls cb(idx, i, j) for every cell covered by op; returns [jmin, jmax] of touched rows or null. */
export function rasterize(
  op: PaintOp,
  nx: number,
  ny: number,
  cb: (idx: number, i: number, j: number) => void,
): [number, number] | null {
  const r = Math.max(0, op.r ?? 0);
  let jmin = Infinity;
  let jmax = -Infinity;
  const visit = (i: number, j: number): void => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return;
    cb(j * nx + i, i, j);
    if (j < jmin) jmin = j;
    if (j > jmax) jmax = j;
  };
  if (op.shape === "rect") {
    const x1 = op.x1 ?? op.x0;
    const y1 = op.y1 ?? op.y0;
    const ia = Math.round(Math.min(op.x0, x1));
    const ib = Math.round(Math.max(op.x0, x1));
    const ja = Math.round(Math.min(op.y0, y1));
    const jb = Math.round(Math.max(op.y0, y1));
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) visit(i, j);
  } else if (op.shape === "disc") {
    const ia = Math.floor(op.x0 - r);
    const ib = Math.ceil(op.x0 + r);
    const ja = Math.floor(op.y0 - r);
    const jb = Math.ceil(op.y0 + r);
    for (let j = ja; j <= jb; j++)
      for (let i = ia; i <= ib; i++) {
        const dx = i - op.x0;
        const dy = j - op.y0;
        if (dx * dx + dy * dy <= r * r + 1e-9) visit(i, j);
      }
    if (r < 0.5) visit(Math.round(op.x0), Math.round(op.y0));
  } else {
    // thick line segment: cells within distance r of the segment (r = 0 gives a 1-cell line)
    const x1 = op.x1 ?? op.x0;
    const y1 = op.y1 ?? op.y0;
    const rr = Math.max(r, 0.5);
    const ia = Math.floor(Math.min(op.x0, x1) - rr);
    const ib = Math.ceil(Math.max(op.x0, x1) + rr);
    const ja = Math.floor(Math.min(op.y0, y1) - rr);
    const jb = Math.ceil(Math.max(op.y0, y1) + rr);
    const ex = x1 - op.x0;
    const ey = y1 - op.y0;
    const l2 = ex * ex + ey * ey;
    for (let j = ja; j <= jb; j++)
      for (let i = ia; i <= ib; i++) {
        let t = l2 > 0 ? ((i - op.x0) * ex + (j - op.y0) * ey) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const dx = i - (op.x0 + t * ex);
        const dy = j - (op.y0 + t * ey);
        if (dx * dx + dy * dy <= rr * rr + 1e-9) visit(i, j);
      }
  }
  return jmin <= jmax ? [jmin, jmax] : null;
}
