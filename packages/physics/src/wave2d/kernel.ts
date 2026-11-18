// SPDX-License-Identifier: GPL-3.0-or-later
// wave2d kernel (DevLog-042 s.1.2-1.4): complex scalar Helmholtz on 2D Lagrange meshes (tri6 P2, tri3 P1),
//   -div(Lambda a grad u) - m s_x s_y u = 0,  Lambda = diag(s_y / s_x, s_x / s_y)  (PML stretch s, = 1 outside PML),
// with per-cell complex a, m (frequency dependent, supplied by the module), facet conditions (Dirichlet, Robin,
// Neumann source), the scattered-field plane-wave source, and modal ports (exact discrete DtN over all port modes).
// Time convention exp(+j omega t). Unconjugated bilinear form: the matrix is complex symmetric and is factored once
// per frequency by the complex supernodal LDL^T of @amp/core (nested-dissection ordering on node coordinates, symbolic
// analysis reused across frequencies), with iterative refinement; several right-hand sides (port excitations) share
// the factor.

import type { Mesh } from '@amp/spec/types';
import { buildElementPattern, elementSlots, analyze } from '@amp/core/la/sparse';
import { makeFactor, type FactorKind } from '@amp/core/la/ldlt-select';
import type { SymbolicAnalysis } from '@amp/core/la/types';
import { NPC, nCells, nNodes, nFacets } from '../common/mesh.ts';
import { defaultRule, facetJac, gatherX, physGrad, shapeTable, type ShapeTable } from '../common/lagrange.ts';
import { stretch, type PmlModel } from './pml.ts';
import { symGenEig, cplxGenEig } from './dense.ts';
import { BlochReduction, type PeriodicMap, type V2 } from './bloch.ts';
import { EnvelopeLU } from './lu.ts';

export interface Csr { n: number; rowptr: Int32Array; colidx: Int32Array; nnz: number }
export type Cx = [number, number];

/** Per-cell coefficients at one frequency. */
export interface Coeffs {
  aRe: Float64Array; aIm: Float64Array; mRe: Float64Array; mIm: Float64Array;
  /** real wavenumber per cell (1/m) for the PML strength */
  kPml: Float64Array;
}

export type FacetBc =
  /** u = value (default 0); `wall`: a physical boundary (total-field condition under a plane wave) */
  | { kind: 'dirichlet'; id: string; facets: number[]; value?: (x: number, y: number) => Cx; wall: boolean }
  /** -a dn u = c u  ->  + c int u v ds (c per adjacent cell) */
  | { kind: 'robin'; id: string; facets: number[]; coef: (cell: number) => Cx; wall: boolean }
  /** natural (a dn u = 0) physical wall: listed so that a plane wave sees it */
  | { kind: 'wall'; id: string; facets: number[] }
  /** inward flux a dn u = g (dn outward): RHS + int g v ds */
  | { kind: 'neumann'; id: string; facets: number[]; g: (x: number, y: number, cell: number) => Cx };

export interface PortDef { id: string; facets: number[]; nModes: number; power: number; excite: boolean }

export interface PlaneWave { dir: number; amp: number; aB: Cx; mB: Cx }

export interface FreqInput {
  omega: number;
  coeffs: Coeffs;
  bcs: FacetBc[];
  ports: PortDef[];
  planeWave?: PlaneWave;
  /** power constant C of P = Re(beta) |b|^2 / (2 omega C): mu0 (TM), eps0 (TE), 1 (acoustics) */
  powerC: number;
  /** periodic cells (DevLog-050): Bloch wave vector k = kRe + j kIm (1/m); u(x + a) = u(x) exp(-j k.a) */
  bloch?: { kRe: V2; kIm: V2 };
}

export interface PortMode { beta: Cx; phiRe: Float64Array; phiIm: Float64Array; propagating: boolean }
export interface PortResult {
  id: string; nodes: Int32Array; modes: PortMode[];
  /** Ma phi_k per mode (projection rows) */
  projRe: Float64Array[]; projIm: Float64Array[];
}

export interface FreqResult {
  /** total field */
  uRe: Float64Array; uIm: Float64Array;
  /** scattered field (plane wave only) */
  usRe?: Float64Array; usIm?: Float64Array;
  ports: PortResult[];
  /** S[i][j] for (port, mode) pairs listed in sKeys */
  S?: { keys: Array<{ port: number; mode: number }>; re: Float64Array; im: Float64Array };
  /** incident power per unit depth of the excited port mode (W/m) */
  Pin?: number;
  /** ports with sources (Neumann sources, non-zero Dirichlet values): power per unit depth (W/m) that the sources
   *  alone send out through each port, summed over its propagating modes (S-parameters are computed with sources off) */
  srcPower?: number[];
  relResidual: number;
  nPerturbed: number;
  notes: string[];
  timing: { assemble: number; factor: number; solve: number; ports: number };
}

const isZero = (v: Cx) => v[0] === 0 && v[1] === 0;
const cmul = (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a: Cx, b: Cx): Cx => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
/** principal sqrt, then the branch with Im <= 0 (outgoing / decaying for exp(+j omega t)) */
export function csqrtOut(z: Cx): Cx {
  const r = Math.hypot(z[0], z[1]);
  let re = Math.sqrt((r + z[0]) / 2), im = Math.sign(z[1]) * Math.sqrt(Math.max(0, (r - z[0]) / 2));
  if (z[1] === 0 && z[0] < 0) { re = 0; im = Math.sqrt(-z[0]); }
  if (im > 0) { re = -re; im = -im; }
  return [re, im];
}

/** Merge extra dense blocks (node lists) into a symmetric CSR pattern. */
function mergePattern(base: Csr, blocks: Int32Array[]): Csr {
  if (!blocks.length) return base;
  const n = base.n;
  const extra: Array<Set<number> | undefined> = new Array(n);
  for (const b of blocks) for (const i of b) { const s = (extra[i] ??= new Set()); for (const j of b) s.add(j); }
  const rowptr = new Int32Array(n + 1);
  const rows: Int32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r0 = base.colidx.subarray(base.rowptr[i]!, base.rowptr[i + 1]!);
    const ex = extra[i];
    if (!ex) { rows[i] = r0; rowptr[i + 1] = rowptr[i]! + r0.length; continue; }
    const s = new Set<number>(r0); for (const j of ex) s.add(j);
    const r = Int32Array.from(s).sort();
    rows[i] = r; rowptr[i + 1] = rowptr[i]! + r.length;
  }
  const colidx = new Int32Array(rowptr[n]!);
  for (let i = 0; i < n; i++) colidx.set(rows[i]!, rowptr[i]!);
  return { n, rowptr, colidx, nnz: colidx.length };
}

function slotOf(p: Csr, i: number, j: number): number {
  let lo = p.rowptr[i]!, hi = p.rowptr[i + 1]! - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = p.colidx[mid]!;
    if (c === j) return mid;
    if (c < j) lo = mid + 1; else hi = mid - 1;
  }
  throw new Error(`wave2d: entry (${i}, ${j}) not in the pattern`);
}

interface FacetInfo { cell: number; nodes: Int32Array; outward: 1 | -1 }

/** Mesh-level data shared by all frequencies. */
export class Wave2DSolver {
  readonly mesh: Mesh;
  readonly active: Uint8Array;
  readonly pml: PmlModel | null;
  readonly nn: number;
  readonly k: number;
  readonly activeNode: Uint8Array;
  pat!: Csr;
  sym!: SymbolicAnalysis;
  cellSlots!: Int32Array;
  readonly tab: ShapeTable;
  readonly ftab: ShapeTable;
  private edgeCells = new Map<number, number[]>();
  private facetInfo = new Map<number, FacetInfo>();
  private portNodes = new Map<string, Int32Array>();
  factorKind: FactorKind | null;
  readonly periodic: PeriodicMap | null;
  private bloch: { red: BlochReduction; lu: EnvelopeLU; key: string } | null = null;
  /** factor-storage budget of the Floquet envelope LU (default ENVELOPE_LU_MAX_BYTES; tests pass a small one) */
  private envelopeMaxBytes: number | undefined;

  constructor(mesh: Mesh, active: Uint8Array, pml: PmlModel | null, ports: Array<{ id: string; facets: number[] }>, dirichletFacets: number[], o: { factor?: FactorKind | null; periodic?: PeriodicMap | null; envelopeMaxBytes?: number } = {}) {
    if (mesh.dim !== 2 || (mesh.cells.type !== 'tri6' && mesh.cells.type !== 'tri3')) throw new Error(`wave2d: needs a 2D tri3 / tri6 mesh (got ${mesh.dim}D ${mesh.cells.type})`);
    if (mesh.axisym) throw new Error('wave2d: axisymmetric meshes are not supported (planar 2D only)');
    this.mesh = mesh; this.active = active; this.pml = pml;
    this.nn = nNodes(mesh); this.k = NPC[mesh.cells.type];
    this.factorKind = o.factor ?? null;
    this.periodic = o.periodic ?? null;
    this.envelopeMaxBytes = o.envelopeMaxBytes;
    if (this.periodic && ports.length) throw new Error('wave2d: ports in a periodic (Floquet) cell are not supported; use a plane wave with PML layers');
    const ord = mesh.cells.type === 'tri6' ? 2 : 1;
    this.tab = shapeTable(mesh.cells.type, defaultRule(mesh.cells.type, 2 * ord));
    this.ftab = shapeTable(mesh.facets.type, defaultRule(mesh.facets.type, 2 * ord + 3));
    const nc = nCells(mesh), k = this.k;
    this.activeNode = new Uint8Array(this.nn);
    for (let c = 0; c < nc; c++) {
      if (!active[c]) continue;
      for (let a = 0; a < k; a++) this.activeNode[mesh.cells.conn[k * c + a]!] = 1;
      for (let a = 0; a < 3; a++) {
        const v0 = mesh.cells.conn[k * c + a]!, v1 = mesh.cells.conn[k * c + ((a + 1) % 3)]!;
        const key = Math.min(v0, v1) * this.nn + Math.max(v0, v1);
        const l = this.edgeCells.get(key);
        if (l) l.push(c); else this.edgeCells.set(key, [c]);
      }
    }
    // port node lists (Dirichlet nodes removed)
    const dirNodes = new Set<number>();
    const kf = NPC[mesh.facets.type];
    for (const f of dirichletFacets) for (let a = 0; a < kf; a++) dirNodes.add(mesh.facets.conn[kf * f + a]!);
    const blocks: Int32Array[] = [];
    for (const p of ports) {
      const s = new Set<number>();
      for (const f of p.facets) { this.facet(f, `port '${p.id}'`, true); for (let a = 0; a < kf; a++) s.add(mesh.facets.conn[kf * f + a]!); }
      const nodes = Int32Array.from([...s].filter((n) => !dirNodes.has(n))).sort();
      if (nodes.length < 1) throw new Error(`port '${p.id}': no free nodes on the port boundary`);
      this.portNodes.set(p.id, nodes);
      blocks.push(nodes);
    }
    const base = buildElementPattern(this.nn, mesh.cells.conn, k) as Csr;
    this.pat = mergePattern(base, blocks);
    this.cellSlots = elementSlots(this.pat, mesh.cells.conn, k) as Int32Array;
    const x = new Float64Array(this.nn), y = new Float64Array(this.nn);
    for (let i = 0; i < this.nn; i++) { x[i] = mesh.nodes[2 * i]!; y[i] = mesh.nodes[2 * i + 1]!; }
    // periodic cells solve the reduced (non-symmetric) system with the envelope LU instead (DevLog-050)
    if (!this.periodic) this.sym = analyze(this.pat, { ordering: 'nd', x, y });
  }

  /** Adjacent active cell of a facet and the sign that makes the node-order normal point out of that cell. */
  facet(f: number, what: string, exterior = false): FacetInfo {
    const hit = this.facetInfo.get(f);
    if (hit) return hit;
    const m = this.mesh, kf = NPC[m.facets.type], k = this.k;
    const nodes = m.facets.conn.subarray(kf * f, kf * f + kf);
    const v0 = nodes[0]!, v1 = nodes[1]!;
    const cells = this.edgeCells.get(Math.min(v0, v1) * this.nn + Math.max(v0, v1)) ?? [];
    if (!cells.length) throw new Error(`${what}: facet ${f} touches no cell of the physics selection`);
    if (exterior && cells.length > 1) throw new Error(`${what}: facet ${f} is an interior interface (cells on both sides); this condition needs an exterior boundary`);
    const c = cells[0]!;
    let cx = 0, cy = 0;
    for (let a = 0; a < 3; a++) { const n = m.cells.conn[k * c + a]!; cx += m.nodes[2 * n]! / 3; cy += m.nodes[2 * n + 1]! / 3; }
    const x0 = m.nodes[2 * v0]!, y0 = m.nodes[2 * v0 + 1]!, x1 = m.nodes[2 * v1]!, y1 = m.nodes[2 * v1 + 1]!;
    const nx = y1 - y0, ny = -(x1 - x0);
    const out: 1 | -1 = nx * ((x0 + x1) / 2 - cx) + ny * ((y0 + y1) / 2 - cy) >= 0 ? 1 : -1;
    const info = { cell: c, nodes: Int32Array.from(nodes), outward: out };
    this.facetInfo.set(f, info);
    return info;
  }

  /** Solve one frequency. */
  solve(fi: FreqInput): FreqResult {
    const { mesh, pat, k, nn, tab } = this;
    const notes: string[] = [];
    const tA = performance.now();
    const nc = nCells(mesh);
    const Are = new Float64Array(pat.nnz), Aim = new Float64Array(pat.nnz);
    const bRe = new Float64Array(nn), bIm = new Float64Array(nn);
    const X = new Float64Array(2 * k), G = new Float64Array(2 * k);
    const KeR = new Float64Array(k * k), KeI = new Float64Array(k * k), FeR = new Float64Array(k), FeI = new Float64Array(k);
    const s = new Float64Array(4);
    const { coeffs: C, planeWave: pw } = fi;
    const kb: Cx | null = pw ? csqrtOut(cdiv(pw.mB, pw.aB)) : null;   // k_b: Re > 0, Im <= 0 for a passive background
    const dx = pw ? Math.cos(pw.dir) : 0, dy = pw ? Math.sin(pw.dir) : 0;
    const uinc = (x: number, y: number): Cx => {
      // U0 exp(-j k_b (x dx + y dy))
      const ph: Cx = cmul([0, -1], cmul(kb!, [x * dx + y * dy, 0]));
      const e = Math.exp(ph[0]);
      return [pw!.amp * e * Math.cos(ph[1]), pw!.amp * e * Math.sin(ph[1])];
    };
    const relTol = 1e-12;
    const differs = (c: number) => pw && (Math.abs(C.aRe[c]! - pw.aB[0]) + Math.abs(C.aIm[c]! - pw.aB[1]) > relTol * Math.hypot(...pw.aB) || Math.abs(C.mRe[c]! - pw.mB[0]) + Math.abs(C.mIm[c]! - pw.mB[1]) > relTol * Math.hypot(...pw.mB));
    const P = new Float64Array(2);
    for (let c = 0; c < nc; c++) {
      if (!this.active[c]) continue;
      gatherX(mesh.nodes, 2, mesh.cells.conn, c, k, X);
      KeR.fill(0); KeI.fill(0); FeR.fill(0); FeI.fill(0);
      const aR = C.aRe[c]!, aI = C.aIm[c]!, mR = C.mRe[c]!, mI = C.mIm[c]!;
      const isPml = !!this.pml?.cell[c];
      const src = differs(c);
      if (src && isPml) throw new Error(`plane wave: PML cell ${c} has a material other than the background; PML domains must hold the background medium`);
      const daR = src ? aR - pw!.aB[0] : 0, daI = src ? aI - pw!.aB[1] : 0, dmR = src ? mR - pw!.mB[0] : 0, dmI = src ? mI - pw!.mB[1] : 0;
      for (let q = 0; q < tab.rule.n; q++) {
        const det = physGrad(tab, q, X, 2, G);
        const w = det * tab.rule.wts[q]!;
        const Nq = tab.N.subarray(q * k, q * k + k);
        let xr = 0, yr = 0;
        for (let a = 0; a < k; a++) { xr += Nq[a]! * X[2 * a]!; yr += Nq[a]! * X[2 * a + 1]!; }
        P[0] = xr; P[1] = yr;
        // coefficients at q: axx = a sy/sx, ayy = a sx/sy, mm = m sx sy
        let axxR = aR, axxI = aI, ayyR = aR, ayyI = aI, mmR = mR, mmI = mI;
        if (isPml) {
          stretch(this.pml!, c, xr, yr, C.kPml[c]!, s);
          const sx: Cx = [s[0]!, s[1]!], sy: Cx = [s[2]!, s[3]!];
          const ax = cmul([aR, aI], cdiv(sy, sx)), ay = cmul([aR, aI], cdiv(sx, sy)), mm = cmul([mR, mI], cmul(sx, sy));
          [axxR, axxI] = ax; [ayyR, ayyI] = ay; [mmR, mmI] = mm;
        }
        let ui: Cx = [0, 0];
        if (src) ui = uinc(xr, yr);
        for (let a = 0; a < k; a++) {
          const gxa = G[2 * a]!, gya = G[2 * a + 1]!, Na = Nq[a]!;
          if (src) {
            // f(v) = -[(a - a_b) grad u_inc . grad v - (m - m_b) u_inc v],  grad u_inc = -j k_b d u_inc
            const gu: Cx = cmul(cmul([0, -1], kb!), ui);    // scalar factor; grad u_inc = gu * d
            const gdot = gxa * dx + gya * dy;
            const t1 = cmul([daR, daI], [gu[0] * gdot, gu[1] * gdot]);
            const t2 = cmul([dmR, dmI], [ui[0] * Na, ui[1] * Na]);
            FeR[a]! += -w * (t1[0] - t2[0]); FeI[a]! += -w * (t1[1] - t2[1]);
          }
          for (let b = a; b < k; b++) {
            const gxb = G[2 * b]!, gyb = G[2 * b + 1]!, NN = Na * Nq[b]!;
            KeR[k * a + b]! += w * (axxR * gxa * gxb + ayyR * gya * gyb - mmR * NN);
            KeI[k * a + b]! += w * (axxI * gxa * gxb + ayyI * gya * gyb - mmI * NN);
          }
        }
      }
      const base = k * k * c;
      for (let a = 0; a < k; a++) {
        const na = mesh.cells.conn[k * c + a]!;
        bRe[na]! += FeR[a]!; bIm[na]! += FeI[a]!;
        for (let b = 0; b < k; b++) {
          const v = a <= b ? k * a + b : k * b + a;
          const sl = this.cellSlots[base + k * a + b]!;
          Are[sl]! += KeR[v]!; Aim[sl]! += KeI[v]!;
        }
      }
    }
    // facet conditions
    const ft = this.ftab, kf = ft.nn;
    const Xf = new Float64Array(2 * kf), nrm = new Float64Array(2);
    const touchesPml = (cell: number) => !!this.pml?.cell[cell];
    const dirVal = new Map<number, Cx>();
    for (const bc of fi.bcs) {
      if (bc.kind === 'dirichlet') {
        for (const f of bc.facets) {
          const inf = this.facet(f, `BC '${bc.id}'`);
          const wall = bc.wall && pw && !touchesPml(inf.cell);
          for (const n of inf.nodes) {
            const x = mesh.nodes[2 * n]!, y = mesh.nodes[2 * n + 1]!;
            let g: Cx = bc.value ? bc.value(x, y) : [0, 0];
            if (wall) { const ui = uinc(x, y); g = [g[0] - ui[0], g[1] - ui[1]]; }
            dirVal.set(n, g);
          }
        }
        continue;
      }
      for (const f of bc.facets) {
        const inf = this.facet(f, `BC '${bc.id}'`, bc.kind !== 'robin');
        gatherX(mesh.nodes, 2, inf.nodes, 0, kf, Xf);
        const coef: Cx = bc.kind === 'robin' ? bc.coef(inf.cell) : [0, 0];
        // physical boundaries (walls, wall-type Robin, Neumann sources) act on the total field under a plane wave
        const wallSrc = pw && (bc.kind === 'wall' || bc.kind === 'neumann' || (bc.kind === 'robin' && bc.wall)) && !touchesPml(inf.cell);
        for (let q = 0; q < ft.rule.n; q++) {
          const J = facetJac(ft, q, Xf, 2, nrm);
          const w = J * ft.rule.wts[q]!;
          const Nq = ft.N.subarray(q * kf, q * kf + kf);
          let xr = 0, yr = 0;
          for (let a = 0; a < kf; a++) { xr += Nq[a]! * Xf[2 * a]!; yr += Nq[a]! * Xf[2 * a + 1]!; }
          let g: Cx = [0, 0];
          if (bc.kind === 'neumann') g = bc.g(xr, yr, inf.cell);
          if (wallSrc) {
            // total-field wall a dn u_t + c u_t = g: a dn u_s + c u_s = g - (a dn u_inc + c u_inc). The volume source
            // integrates only (a - a_b) grad u_inc . grad v, which implies + closed-int (a - a_b) dn u_inc v on the
            // boundary, so the wall RHS is + int (g - a_b dn u_inc - c u_inc) v with the BACKGROUND a_b (DevLog-042 s.7.2)
            const nx = inf.outward * nrm[0]!, ny = inf.outward * nrm[1]!;
            const ui = uinc(xr, yr);
            const dn: Cx = cmul(cmul([0, -1], kb!), [ui[0] * (dx * nx + dy * ny), ui[1] * (dx * nx + dy * ny)]);
            const t = cmul(pw!.aB, dn), cu = cmul(coef, ui);
            g = [g[0] - t[0] - cu[0], g[1] - t[1] - cu[1]];
          }
          for (let a = 0; a < kf; a++) {
            const na = inf.nodes[a]!;
            if (!isZero(g)) { bRe[na]! += w * g[0] * Nq[a]!; bIm[na]! += w * g[1] * Nq[a]!; }
            if (bc.kind === 'robin' && !isZero(coef)) for (let b = 0; b < kf; b++) {
              const sl = slotOf(pat, na, inf.nodes[b]!);
              const v = w * Nq[a]! * Nq[b]!;
              Are[sl]! += coef[0] * v; Aim[sl]! += coef[1] * v;
            }
          }
        }
      }
    }
    const tAssemble = performance.now() - tA;
    // ports: modes and DtN
    const tP = performance.now();
    const ports: PortResult[] = fi.ports.map((p) => this.portModes(p, fi, dirVal, notes));
    for (const pr of ports) {
      // D = sum_k j beta_k v_k v_k^T (v_k = M_a phi_k), dense on the port nodes
      const np = pr.nodes.length, nm = pr.modes.length;
      const DR = new Float64Array(np * np), DI = new Float64Array(np * np);
      for (let kk = 0; kk < nm; kk++) {
        const [br, bi] = pr.modes[kk]!.beta;
        const jbR = -bi, jbI = br;   // j beta
        const vr = pr.projRe[kk]!, vi = pr.projIm[kk]!;
        for (let i = 0; i < np; i++) {
          const wr = jbR * vr[i]! - jbI * vi[i]!, wi = jbR * vi[i]! + jbI * vr[i]!;
          if (wr === 0 && wi === 0) continue;
          const row = i * np;
          for (let j = 0; j < np; j++) { const xr = vr[j]!, xi = vi[j]!; DR[row + j]! += wr * xr - wi * xi; DI[row + j]! += wr * xi + wi * xr; }
        }
      }
      for (let i = 0; i < np; i++) for (let j = 0; j < np; j++) {
        const sl = slotOf(pat, pr.nodes[i]!, pr.nodes[j]!);
        Are[sl]! += DR[i * np + j]!; Aim[sl]! += DI[i * np + j]!;
      }
    }
    const tPorts = performance.now() - tP;
    // Dirichlet rows: identity; inactive nodes too. Lifting list for every RHS.
    const t1 = performance.now();
    for (let i = 0; i < nn; i++) if (!this.activeNode[i]) dirVal.set(i, [0, 0]);
    const lift: Array<[number, number, number, number]> = [];   // (row j, dir node d, Re A_jd, Im A_jd)
    for (const [d] of dirVal) {
      for (let p = pat.rowptr[d]!; p < pat.rowptr[d + 1]!; p++) {
        const j = pat.colidx[p]!;
        if (j === d) continue;
        if (!dirVal.has(j) && (Are[p] !== 0 || Aim[p] !== 0)) lift.push([j, d, Are[p]!, Aim[p]!]);
        Are[p] = 0; Aim[p] = 0;
        const q = slotOf(pat, j, d);
        Are[q] = 0; Aim[q] = 0;
      }
      const dd = slotOf(pat, d, d);
      Are[dd] = 1; Aim[dd] = 0;
    }
    const applyDir = (br: Float64Array, bi: Float64Array, withValues: boolean) => {
      if (withValues) for (const [j, d, ar, ai] of lift) { const g = dirVal.get(d)!; br[j]! -= ar * g[0] - ai * g[1]; bi[j]! -= ar * g[1] + ai * g[0]; }
      for (const [d, g] of dirVal) { br[d] = withValues ? g[0] : 0; bi[d] = withValues ? g[1] : 0; }
    };
    let relResidual = 0;
    let solveOne: (br: Float64Array, bi: Float64Array) => { re: Float64Array; im: Float64Array };
    let nPerturbed = 0;
    if (this.periodic) {
      // Floquet cell: reduce to the free node classes, R = Q^T A P (q = 1 / p), envelope LU, expand u = P u_r
      const key = [...dirVal.keys()].sort((a, b) => a - b).join(',');
      if (!this.bloch || this.bloch.key !== key) {
        const ex = new Uint8Array(nn);
        for (const d of dirVal.keys()) ex[d] = 1;
        const red = new BlochReduction(mesh, this.periodic, pat, ex);
        this.bloch = { red, lu: new EnvelopeLU(red.pat, this.envelopeMaxBytes !== undefined ? { maxBytes: this.envelopeMaxBytes } : {}), key };
      }
      const { red, lu } = this.bloch;
      const ph = this.periodic.phases(fi.bloch?.kRe ?? [0, 0], fi.bloch?.kIm ?? [0, 0]);
      const R = red.reduce(pat, Are, Aim, ph);
      lu.factor(R.re, R.im);
      nPerturbed = lu.nPerturbed;
      solveOne = (br, bi) => {
        const rb = red.reduceVec(br, bi, ph);
        const x = lu.solveRefined(R.re, R.im, rb.re, rb.im);
        relResidual = Math.max(relResidual, x.relResidual);
        // excluded (Dirichlet, inactive) nodes keep the values applyDir put into the RHS
        const ur = Float64Array.from(br), ui = Float64Array.from(bi);
        for (let i = 0; i < nn; i++) if (red.red[i]! >= 0) { ur[i] = 0; ui[i] = 0; }
        red.expand(x.re, x.im, ph, ur, ui);
        return { re: ur, im: ui };
      };
    } else {
      const fac = makeFactor(this.factorKind, this.sym);
      const fr = fac.factor(Are, Aim);
      nPerturbed = fr.nPerturbed;
      solveOne = (br, bi) => {
        const r = fac.solveRefined(pat, Are, Aim, br, bi, { maxSteps: 3, tol: 1e-13 });
        relResidual = Math.max(relResidual, r.relResidual);
        return r;
      };
    }
    const tFactor = performance.now() - t1;
    const t2 = performance.now();
    const res: FreqResult = { uRe: new Float64Array(nn), uIm: new Float64Array(nn), ports, relResidual: 0, nPerturbed, notes, timing: { assemble: tAssemble, factor: tFactor, solve: 0, ports: tPorts } };
    if (!ports.length) {
      applyDir(bRe, bIm, true);
      const r = solveOne(bRe, bIm);
      if (pw) {
        res.usRe = r.re; res.usIm = r.im;
        const ur = Float64Array.from(r.re), ui2 = Float64Array.from(r.im);
        for (let i = 0; i < nn; i++) {
          if (!this.activeNode[i]) continue;
          const v = uinc(mesh.nodes[2 * i]!, mesh.nodes[2 * i + 1]!);
          ur[i]! += v[0]; ui2[i]! += v[1];
        }
        res.uRe = ur; res.uIm = ui2;
      } else { res.uRe = r.re; res.uIm = r.im; }
    } else {
      if (pw) throw new Error('wave2d: a plane wave and ports in one run are not supported');
      // one RHS per reported propagating (port, mode), all sources off (S-parameters); the sources (Neumann data,
      // non-zero Dirichlet values) get one RHS of their own. Field output = excited-port field + source field.
      const keys: Array<{ port: number; mode: number }> = [];
      ports.forEach((pr, pi) => { for (let q = 0; q < Math.min(fi.ports[pi]!.nModes, pr.modes.length); q++) if (pr.modes[q]!.propagating) keys.push({ port: pi, mode: q }); });
      const nk = keys.length;
      const Sre = new Float64Array(nk * nk), Sim = new Float64Array(nk * nk);
      const exc = Math.max(0, fi.ports.findIndex((p) => p.excite));
      const amp = (pi: number, q: number): number => {
        const be = ports[pi]!.modes[q]!.beta[0];
        return Math.sqrt((2 * fi.omega * fi.powerC * fi.ports[pi]!.power) / be);
      };
      const project = (po: PortResult, qi: number, xr: Float64Array, xi: Float64Array): Cx => {
        let bR = 0, bI = 0;
        for (let i = 0; i < po.nodes.length; i++) {
          const t = cmul([po.projRe[qi]![i]!, po.projIm[qi]![i]!], [xr[po.nodes[i]!]!, xi[po.nodes[i]!]!]);
          bR += t[0]; bI += t[1];
        }
        return [bR, bI];
      };
      for (let col = 0; col < nk; col++) {
        const { port: pj, mode: qj } = keys[col]!;
        const pr = ports[pj]!, md = pr.modes[qj]!;
        const A = amp(pj, qj);
        const br = new Float64Array(nn), bi = new Float64Array(nn);
        const isExc = pj === exc && qj === 0;
        // 2 j beta A Ma phi
        const c2: Cx = cmul([0, 2 * A], md.beta);
        for (let i = 0; i < pr.nodes.length; i++) {
          const t = cmul(c2, [pr.projRe[qj]![i]!, pr.projIm[qj]![i]!]);
          br[pr.nodes[i]!]! += t[0]; bi[pr.nodes[i]!]! += t[1];
        }
        applyDir(br, bi, false);
        const r = solveOne(br, bi);
        if (isExc) { res.uRe = r.re; res.uIm = r.im; res.Pin = fi.ports[pj]!.power; }
        for (let row = 0; row < nk; row++) {
          const { port: pi, mode: qi } = keys[row]!;
          const po = ports[pi]!;
          let [bR, bI] = project(po, qi, r.re, r.im);
          if (pi === pj && qi === qj) bR -= A;
          // power-normalised: S = b sqrt(Re beta_i) / (A sqrt(Re beta_j))
          const f = Math.sqrt(po.modes[qi]!.beta[0] / md.beta[0]) / A;
          Sre[row * nk + col] = bR * f; Sim[row * nk + col] = bI * f;
        }
      }
      let hasSrc = false;
      for (let i = 0; i < nn && !hasSrc; i++) if (bRe[i] !== 0 || bIm[i] !== 0) hasSrc = true;
      for (const g of dirVal.values()) if (g[0] !== 0 || g[1] !== 0) { hasSrc = true; break; }
      const excProp = keys.some((kk) => kk.port === exc && kk.mode === 0);
      if (hasSrc) {
        applyDir(bRe, bIm, true);
        const r = solveOne(bRe, bIm);
        if (excProp) { res.uRe = Float64Array.from(res.uRe, (v, i) => v + r.re[i]!); res.uIm = Float64Array.from(res.uIm, (v, i) => v + r.im[i]!); }
        else { res.uRe = r.re; res.uIm = r.im; }
        // outgoing power of the sources alone: P = Re(beta) |b|^2 / (2 omega C) per propagating mode (no incident wave)
        res.srcPower = ports.map((po) => {
          let P = 0;
          po.modes.forEach((m, qi) => { if (m.propagating) { const b = project(po, qi, r.re, r.im); P += (m.beta[0] * (b[0] * b[0] + b[1] * b[1])) / (2 * fi.omega * fi.powerC); } });
          return P;
        });
        notes.push('ports with sources: S-parameters with the sources off; P_src_<i> = power per unit depth the sources alone send out through port i (all propagating modes); fields = excited-port field + source field');
      }
      if (!excProp) notes.push(`excited port '${fi.ports[exc]!.id}': fundamental mode not propagating; ${hasSrc ? 'fields hold the source response only' : 'fields are zero'}`);
      res.S = { keys, re: Sre, im: Sim };
    }
    res.relResidual = relResidual;
    res.timing.solve = performance.now() - t2;
    return res;
  }

  /** 1D modes of a port: (M_m - K_a) phi = beta^2 M_a phi on the port nodes; projections M_a phi. */
  private portModes(p: PortDef, fi: FreqInput, dirVal: Map<number, Cx>, notes: string[]): PortResult {
    const mesh = this.mesh, ft = this.ftab, kf = ft.nn;
    const nodes = this.portNodes.get(p.id)!;
    const np = nodes.length;
    const loc = new Map<number, number>(); nodes.forEach((n, i) => loc.set(n, i));
    const KR = new Float64Array(np * np), KI = new Float64Array(np * np), MaR = new Float64Array(np * np), MaI = new Float64Array(np * np), MmR = new Float64Array(np * np), MmI = new Float64Array(np * np);
    const Xf = new Float64Array(2 * kf), nrm = new Float64Array(2), s = new Float64Array(4);
    // straightness: every port node on the line through the first facet
    let tx = 0, ty = 0, ox = 0, oy = 0, len = 0;
    for (const f of p.facets) {
      const inf = this.facet(f, `port '${p.id}'`, true);
      const a = inf.nodes[0]!, b = inf.nodes[1]!;
      const ex = mesh.nodes[2 * b]! - mesh.nodes[2 * a]!, ey = mesh.nodes[2 * b + 1]! - mesh.nodes[2 * a + 1]!;
      if (len === 0) { ox = mesh.nodes[2 * a]!; oy = mesh.nodes[2 * a + 1]!; tx = ex; ty = ey; }
      len += Math.hypot(ex, ey);
    }
    const tl = Math.hypot(tx, ty); tx /= tl; ty /= tl;
    for (const f of p.facets) for (const n of this.facet(f, `port '${p.id}'`, true).nodes) {
      const off = (mesh.nodes[2 * n]! - ox) * ty - (mesh.nodes[2 * n + 1]! - oy) * tx;
      if (Math.abs(off) > 1e-9 * len) throw new Error(`port '${p.id}': the port boundary must be straight (node ${n} is ${off.toExponential(2)} m off the line)`);
    }
    if (dirVal.size) for (const n of nodes) if (dirVal.has(n)) throw new Error(`port '${p.id}': node ${n} is also on a Dirichlet boundary`);
    const C = fi.coeffs;
    const horizontalNormal = Math.abs(ty) > Math.abs(tx);   // port tangent ~ y: normal ~ x
    for (const f of p.facets) {
      const inf = this.facet(f, `port '${p.id}'`, true);
      gatherX(mesh.nodes, 2, inf.nodes, 0, kf, Xf);
      const c = inf.cell;
      const aC: Cx = [C.aRe[c]!, C.aIm[c]!], mC: Cx = [C.mRe[c]!, C.mIm[c]!];
      for (let q = 0; q < ft.rule.n; q++) {
        const J = facetJac(ft, q, Xf, 2, nrm);
        const w = J * ft.rule.wts[q]!;
        const Nq = ft.N.subarray(q * kf, q * kf + kf);
        const dN = ft.dN.subarray(q * kf, q * kf + kf);
        let xr = 0, yr = 0;
        for (let a = 0; a < kf; a++) { xr += Nq[a]! * Xf[2 * a]!; yr += Nq[a]! * Xf[2 * a + 1]!; }
        let st: Cx = [1, 0];
        if (this.pml?.cell[c]) {
          stretch(this.pml, c, xr, yr, C.kPml[c]!, s);
          const sn: Cx = horizontalNormal ? [s[0]!, s[1]!] : [s[2]!, s[3]!];
          st = horizontalNormal ? [s[2]!, s[3]!] : [s[0]!, s[1]!];
          if (Math.abs(sn[0] - 1) + Math.abs(sn[1]) > 1e-12) throw new Error(`port '${p.id}': the port lies in a PML that stretches along the port normal; put the port outside such layers`);
        }
        const aS = cmul(aC, st), aOverS = cdiv(aC, st), mS = cmul(mC, st);
        for (let a = 0; a < kf; a++) {
          const ia = loc.get(inf.nodes[a]!);
          if (ia === undefined) continue;
          for (let b = 0; b < kf; b++) {
            const ib = loc.get(inf.nodes[b]!);
            if (ib === undefined) continue;
            const NN = w * Nq[a]! * Nq[b]!, DD = (w * dN[a]! * dN[b]!) / (J * J);
            const at = ia * np + ib;
            KR[at]! += aOverS[0] * DD; KI[at]! += aOverS[1] * DD;
            MaR[at]! += aS[0] * NN; MaI[at]! += aS[1] * NN;
            MmR[at]! += mS[0] * NN; MmI[at]! += mS[1] * NN;
          }
        }
      }
    }
    const AR = MmR.map((v, i) => v - KR[i]!), AI = MmI.map((v, i) => v - KI[i]!);
    const real = AI.every((v) => v === 0) && MaI.every((v) => v === 0);
    const modes: PortMode[] = [];
    let sA = 0, sM = 0;
    for (let i = 0; i < np * np; i++) { sA = Math.max(sA, Math.abs(AR[i]!), Math.abs(AI[i]!)); sM = Math.max(sM, Math.abs(MaR[i]!), Math.abs(MaI[i]!)); }
    const scale = sA / sM;
    let sym: { d: Float64Array; X: Float64Array } | null = null;
    if (real) { try { sym = symGenEig(AR, MaR, np); } catch { sym = null; } }   // M_a not definite (e.g. eps_r < 0 in TE): complex path
    if (sym) {
      const { d, X } = sym;
      for (let kk = np - 1; kk >= 0; kk--) {
        const phi = Float64Array.from({ length: np }, (_, i) => X[i * np + kk]!);
        const b2 = d[kk]!;
        modes.push({ beta: csqrtOut([b2, 0]), phiRe: phi, phiIm: new Float64Array(np), propagating: b2 > 1e-10 * scale });
      }
    } else {
      const e = cplxGenEig(AR, AI, MaR, MaI, np);
      const ord = Array.from({ length: np }, (_, i) => i).sort((a, b) => e.lr[b]! - e.lr[a]!);
      for (const kk of ord) {
        const pr = Float64Array.from({ length: np }, (_, i) => e.Xr[i * np + kk]!), pi = Float64Array.from({ length: np }, (_, i) => e.Xi[i * np + kk]!);
        const beta = csqrtOut([e.lr[kk]!, e.li[kk]!]);
        modes.push({ beta, phiRe: pr, phiIm: pi, propagating: beta[0] > 10 * Math.abs(beta[1]) && e.lr[kk]! > 1e-10 * scale });
      }
      if (modes.slice(0, p.nModes).some((m) => m.propagating && Math.abs(m.beta[1]) > 1e-6 * m.beta[0])) notes.push(`port '${p.id}': lossy or leaky reported mode (Im beta / Re beta > 1e-6); S-parameters use Re(beta) for the power normalisation`);
    }
    // sign convention: int a phi ds > 0, else the first moment along the global +x / +y axis of the port tangent
    const coordAlong = (n: number) => (Math.abs(tx) >= Math.abs(ty) ? mesh.nodes[2 * n]! : mesh.nodes[2 * n + 1]!);
    const projRe: Float64Array[] = [], projIm: Float64Array[] = [];
    for (const md of modes) {
      const vR = new Float64Array(np), vI = new Float64Array(np);
      for (let i = 0; i < np; i++) {
        let sr = 0, si = 0;
        const row = i * np;
        for (let j = 0; j < np; j++) {
          const mr = MaR[row + j]!, mi = MaI[row + j]!, pr = md.phiRe[j]!, pi = md.phiIm[j]!;
          sr += mr * pr - mi * pi; si += mr * pi + mi * pr;
        }
        vR[i] = sr; vI[i] = si;
      }
      let s0 = 0, s1 = 0, nrm2 = 0;
      for (let i = 0; i < np; i++) { s0 += vR[i]!; s1 += vR[i]! * coordAlong(nodes[i]!); nrm2 += Math.abs(vR[i]!); }
      const sign = Math.abs(s0) > 1e-6 * nrm2 ? Math.sign(s0) : Math.sign(s1) || 1;
      if (sign < 0) for (let i = 0; i < np; i++) { md.phiRe[i] = -md.phiRe[i]!; md.phiIm[i] = -md.phiIm[i]!; vR[i] = -vR[i]!; vI[i] = -vI[i]!; }
      projRe.push(vR); projIm.push(vI);
    }
    return { id: p.id, nodes, modes, projRe, projIm };
  }
}

/** Number of facets helper re-export for modules. */
export const facetCount = nFacets;
