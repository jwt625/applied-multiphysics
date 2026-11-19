# DevLog-059: interface-aware post-processing (lane G2, chunk 3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | G2 (DevLog-037 s.4.2) |
| Owns | `packages/post/**`, `apps/web/src/lib/post/**` (recovery only), new tests there, this file |
| Not owned | `packages/physics/**` (elastic producers: lane G3), `packages/spec/**`, `CONTRACTS-v0.md` (coordinator), `apps/web/src/lib/results/**`, `gfx/**` (G7), `validation/c/cases_ext/pkg.py` (G6 / coordinator), sims |

Conventions: F = fact read from code, files or runs; E = estimate; D = decision; O = open item; R = request.

## 1. Plan (2026-11-18 18:20 PST)

### 1.1 Facts at start
- F: derived stresses are produced by `packages/physics/src/elastic/index.ts` `nodalStress` and `elastic/axisym.ts` (element stresses at the element nodes, summed over every active cell at a node, divided by the count). The element values are dropped; the Solution carries only the cross-domain nodal mean (H1P1 / H1P2). `mises`, `s1`..`s3` are computed from the averaged components.
- F: `@amp/post` reads H1 fields only through `f.data` (`interpolate`, `evaluateField`, `integrate`, `extrema`); `average` / `integral` evaluate the nodal interpolant at quadrature points. So a Cu / Si interface node carries a Cu / Si mix (DevLog-049 R2: PK-02 Cu `sxx` volume mean -3.1 % / -1.6 % at hFactor 1 / 0.5).
- F: post cannot rebuild element stresses itself: the Solution carries no E, nu, alpha, T_ref per cell (prepared in `prepareRun`, not stored).
- F: other cross-domain nodal averages: magnetostatics `Br` / `Bz`, em3d / em-axisym nodal projections (not in scope; open item).
- F: static elastic cases (stress read by result items or `sample`): a/SM-01, SM-02, SM-21, SM-22, CP-02, CP-21; b/SM-42; c/CP-04, PK-01, PK-02, PK-06.

### 1.2 Design (D)
1. Contract extension (request to the coordinator, optional field, additive): `FieldData.elementNodal?: Float64Array`: the producer's element values at the cell nodes before nodal averaging, index `(cell * k + a) * components + j` (k = nodes per cell, VTK order), NaN for inactive cells. Producers: elastic (3D / planar / axisym) for every derived field (`sxx`.., `mises`, `s1`..`s3`). Request with exact lines to the elastic owner (G3) / coordinator.
2. `@amp/post` `recoverPerDomain(mesh, f)`: per (cell, local node) values: at a node touched by one domain the producer's `f.data` (bitwise); at a node touched by several domains, the mean of the element values of the cells of the same domain at that node (count-weighted, the producer's rule restricted to the domain). null when the field has no `elementNodal` or no node is shared by two domains (then every path is the old one, bitwise). Cached per (field, mesh).
3. `interpolate` / `evaluateField` / `sample` / expressions: option `derived: 'recovered' | 'element' | 'averaged'` (default `recovered`): point, cut line, nodal / lattice / quad max-min read the per-domain values of the cell that holds the point; `element` reads the cell's own element values; `averaged` = the producer's nodal mean (old behaviour).
4. `evalIntegral` / `evalAverage` (and `integrate`): default `derived: 'element'`: quadrature points read the element values of their cell (exact element stresses for straight cells: the P1 / P2 element-node interpolant reproduces the element stress polynomial; curved cells: the interpolant of the element's own nodal values). Method string gets `_element_values` when an element-valued field was read. `max` / `min` keep their `method` option (values: recovered).
5. Measurement before the physics change lands: a scratch Node module-load hook substitutes the two elastic files with the proposed patch (scratch only, nothing tracked), so the CLI runs the real cases with `elementNodal` present. The table states which rows come from the hook.
6. Web display (`apps/web/src/lib/post/**`): unchanged unless cheap; the 2D view builds per-element coefficients, so it can take per-domain values when its caller passes them (request to G7 if wanted).

### 1.3 Gates
- post tests green (new tests: single-domain field bitwise unchanged; interface node keeps one value per domain; point sampling picks the domain of the cell; element-value integral exact for a field linear per domain with a jump; primary fields unchanged).
- physics / web tests green.
- CLI before / after for the case list above; no gated target regresses; PK-02 means vs the closed form at both levels; PK-01 point stresses; kirsch / NAFEMS stress targets.

## 2. TODO
- [x] baseline CLI (before)
- [x] post: `recoverPerDomain`, `derived` option in interpolate / evaluateField / sample / expr; element-value integrals
- [x] tests (post 5 new, web 2 new)
- [x] proposed elastic patch (scratch) + load hook; CLI after
- [x] before / after table
- [x] requests (contract + elastic producer, pkg.py re-gate, sim labels, 2D display caller)
- [x] hand-off

## 3. Progress log
- 2026-11-18 18:17 PST: read DevLog-037 s.4.1 / 4.2, DevLog-049 R2 / O2, DevLog-055 s.5, `packages/post/src/*`, elastic producers (read only).
- 2026-11-18 18:20 PST: plan written; baseline CLI started (`logs/G2-cli-before-*.log`, records `logs/eval-*.jsonl`).
- 2026-11-18 18:19 PST: baseline CLI done: 11 cases, 41 targets (`logs/G2-cli-before-20261118T181840.log`, records `logs/eval-20261118T1818{40..57}.jsonl`, `-181903`).
- 2026-11-18 18:22 PST: `@amp/post` changes (s.4) in; post 16 / 16 still green; producer patch built in scratch with a module-load hook (served in place of the two elastic files, refuses when the live file changed: G3 edits `elastic/index.ts` concurrently, so the patch was rebased twice at 18:28 and 18:30, same hunks).
- 2026-11-18 18:23-18:24 PST: CLI post-only (no producer patch): all 41 targets bitwise identical to the baseline at every level (`logs/G2-cli-postonly-20261118T182316.log`). CLI with the producer patch (`logs/G2-cli-after-20261118T182354.log`): s.5.
- 2026-11-18 18:25-18:29 PST: tests `packages/post/test/interface-recovery.test.ts` (5), `apps/web/test/g2-interface-display.test.ts` (2); 2D display per-domain values (`apps/web/src/lib/post/field2d.ts` `withPerDomain`, `post.worker.ts`).
- 2026-11-18 18:29-18:31 PST: post 21 / 21 (`logs/G2-post-test-20261118T182847.log`), web 136 / 136 (`logs/G2-web-test-20261118T182847.log`), web check 0 errors (`logs/G2-web-check-20261118T182916.log`), post tsc clean; patched physics + spec typecheck clean in a scratch mirror; PK-01 axisym means (scratch script, producer patch) s.5.2.
- 2026-11-18 18:33 PST: physics 196 / 196 (`logs/G2-physics-test-20261118T182936.log`; tracked tree, without the producer patch). Lane done; hand-off s.8.
- 2026-11-18 18:36 PST (resumed, coordinator relay of lane G7): R1 is now in the tree; `apps/web/test/results-eval.test.ts` "R1 gate 3" (Kirsch cut-line integral of `sxx` along x = 0, a single-domain field) failed: 4973767.67 vs 4974664.35 N/m at hFactor 1, method `..._element_values`. Cause: the element-value default of integrals (D4 of s.1.2) applied to every field with element values, interface or not. Evidence: closed form 4974750.00 N/m (fixture note); nodal reading -85.7 N/m (1.7e-5), element values -982 N/m (2.0e-4): on a line along cell edges the one-sided element stresses are less accurate than the nodal mean. D (replaces D4): integrals and averages read the per-domain recovery by default (`recovered`; bitwise the old reading for fields without interfaces); `element` stays an option. PK-01 means with `recovered` (scratch script, hF 0.5): Cu `srr` +4.6e-6, Cu `szz` +2.1e-6, Si `szz` +2.8e-6 (element: +5.4e-6, +2.0e-6, -4.0e-7), so the interface gain is kept. Gate 3 bitwise again at all 4 levels; test expectation not changed.
- 2026-11-18 18:38 PST: R3 (2D click probes): `apps/web/src/lib/post/probe.ts` `probe2d` sends `elementNodal`; the worker's `evalAt` applies `withPerDomain` (clicked cell's domain). `probe3d` already reads the recovery through `sample`. Test added to `apps/web/test/g2-interface-display.test.ts`.
- 2026-11-18 18:40-18:42 PST: post 21 / 21, post tsc clean, web 137 / 137 (`logs/G2-web-test-20261118T184055.log`), web check 0 errors (`logs/G2-web-check-20261118T184055.log`). CLI on the tree with R1 (`logs/G2-cli-recovered-20261118T184140.log`): PK-02, CP-21, SM-01, PK-01 pass; 16 of 20 targets bitwise equal to the baseline; changed: PK-02 means and CP-21 (s.5.1, recovered column).

## 4. What changed (`@amp/post`, API)
- `FieldData.elementNodal?: Float64Array` is read when present (contract extension, R1): element values at the cell nodes before nodal averaging, `(cell * k + a) * components + j`, NaN for cells outside the physics. Local type until R1 lands; no producer sets it yet.
- `DerivedMode = 'recovered' | 'element' | 'averaged'` (points.ts); exported `recoverPerDomain(mesh, f)`, `elementNodalOf(mesh, f)`, `derivedValues(mesh, f, mode)`.
- `recoverPerDomain`: at nodes whose active cells lie in one domain: the producer's `data` (bitwise); at nodes shared by several domains: count-weighted mean of the element values of the same domain. null when there are no element values or no interface node (every reader then takes the old path).
- Option `derived` on `interpolate`, `evaluateField`, `sample` (`SampleOptions`), `ExprOptions` (expressions, `evalPoint`, `evalMax` / `evalMin`, datasets), `integrate`, `extrema`. Default `recovered` everywhere (point / line / max / min / probes / `sample` / `evalIntegral` / `evalAverage` / `integrate`), so fields without interfaces read bitwise as before; `derived: 'element'` gives element values (integrals: method suffix `_element_values`, `continuous: false`). (Revised 18:36 PST: integrals first defaulted to element values; see s.3.) `max` / `min` keep `method` (nodal / lattice / quad / points), reading recovered values. Cells with NaN element values fall back to `data` in element mode.
- `FieldExpr.elementValued: boolean`.
- Web 2D display (`apps/web/src/lib/post/field2d.ts`): `Field2D.perCell` / `elementNodal`, `withPerDomain(m2, f)` (local copy of the rule; a web test asserts equality with `@amp/post`), used by the post worker for `field`, `lattice`, `evalAt`; colorbar note adds "nodal values averaged within each material domain". Active only once the caller passes `elementNodal` (R3). 3D views unchanged (O2).

## 5. Results

### 5.1 CLI before / after (finest level unless stated; rel. err vs the case reference; "after" = post change + producer patch R1 through the scratch hook)
| case / target | gated | before (per level) | after (per level) | reference | note |
|---|---|---|---|---|---|
| PK-02 `cu_sxx_mean` (hF 1, 0.5) | info | 164.758, 167.420 MPa (-3.14e-2, -1.58e-2) | element: +8.58e-5, +6.12e-6; recovered (default, R1 in tree, 18:41): +9.00e-5, +6.14e-6 | 170.1001 MPa, two-phase Lame closed form (`validation/pkg/tsv_lame.py`) | element-value quadrature |
| PK-02 `si_szz_mean` (hF 1, 0.5) | info | 39.4808, 39.3022 MPa (+9.11e-3, +4.55e-3) | element: -6.54e-6, -4.64e-7; recovered (default): -7.90e-6, -8.41e-7 | 39.12438 MPa, same | element-value quadrature |
| CP-21 `sigma_yy_D` (max over the membrane, nodal; 3 levels) | gate 1.5 % after Richardson | 48.886, 49.399, 49.765 MPa; Richardson 50.676 (+1.35e-2 of 1.5e-2) | 50.440, 50.445, 50.445 MPa; Richardson 50.4457 (+8.9e-3) | 50.0 MPa target (infinite plate); finite quarter: atlas scikit-fem P2 Richardson 50.4475 MPa (case `reference_results`) | per-domain recovery: interface nodes no longer mix in the hot spot; matches the finite-plate reference within 4e-5 |
| CP-21 `sigma_yy_D_infinite` | info | 48.450, 48.956, 49.373 MPa (-1.25e-2) | 49.956, 50.002, 50.003 MPa (+6.6e-5) | 50.0 MPa closed form | as above |
| PK-01 `cu_srr`, `cu_szz`, `si_srr_2a`, `si_sphi_2a`, `rim_ur`; PK-02 point targets; PK-06 | gate / info | unchanged | bitwise unchanged | | points at r = a/2 and 2a are not interface nodes; the Si point oscillation (DevLog-049 O2) is from nodal averaging inside one material, not from the interface (O3) |
| SM-01 (Kirsch), SM-02 / CP-02 (NAFEMS LE1 / LE11), SM-21, SM-22, SM-42, CP-04 | gate / pending | unchanged | bitwise unchanged | | one material domain (or pending) |

Post-only (no producer patch): all 41 targets bitwise identical at every level. No gated target changes status; CP-21's gated error drops from 1.35e-2 to 8.9e-3.

### 5.2 PK-01 volume means (axisym, 2 pi r weight; scratch script, producer patch; not case targets)
| mean | hF 1 averaged -> element | hF 0.5 averaged -> element | reference |
|---|---|---|---|
| Cu `srr` | -1.95e-3 -> +7.59e-5 | -3.10e-4 -> +5.40e-6 | 170.1001 MPa |
| Cu `szz` | -4.25e-2 -> +2.82e-5 | -2.10e-2 -> +1.99e-6 | 323.8484 MPa |
| Si `szz` | +1.58e-2 -> -5.61e-6 | +7.86e-3 -> -3.95e-7 | 39.12438 MPa |

Reading: the averaged means converge at first order (the interface layer); the element-value means drop about 14x per halving in both cases (observed order about 3.8). E (reasoning, not a proof): the domain mean of the element strain equals a boundary integral of the continuous displacement u_h, so it converges with the displacement trace rather than with the stress.

## 6. Requests (coordinator)
- R1 (elastic owner G3 / coordinator; contract C5 additive): the producer patch below (`FieldData.elementNodal` in `packages/spec/src/types/solution.ts`; `nodalStress` keeps the element values, invariants factored into `stressInvariants` / `axisymInvariants` with the same arithmetic, so `data` of every field is bitwise unchanged). Checked: `patch -p1 --dry-run` applies on the tree of 18:30 PST; physics + spec typecheck clean in a scratch mirror; CLI 41 targets as s.5.1. Memory: one Float64Array of cells x nodes-per-cell per derived field (3D: 10 fields). PK-02 at hFactor 0.5 (prepareRun, 18:33 PST): 21,264 tet10, so 10 x 212,640 x 8 B = 17.0 MB extra per solution. CONTRACTS-v0 changelog line: "C5 FieldData.elementNodal (optional): element values at the cell nodes of derived H1 fields; @amp/post reads them for per-domain recovery and element-value integrals (DevLog-059)".
```diff
--- a/packages/spec/src/types/solution.ts
+++ b/packages/spec/src/types/solution.ts
@@ -7,6 +7,10 @@
   name: string; unit: string; space: FieldSpace; components: 1 | 2 | 3; data: Float64Array; step?: number;
   /** physics id of the field; set by the study driver on merged multiphysics solutions (C11) */
   physics?: string;
+  /** derived H1 fields whose `data` is a nodal average of element values (stresses): the element values at the cell
+   * nodes before averaging, index (cell * k + a) * components + j (k nodes per cell, VTK order), NaN for cells
+   * outside the physics. Read by @amp/post for per-domain recovery and element-value integrals (DevLog-059). */
+  elementNodal?: Float64Array;
 }
 
 export interface Platform { runtime: 'node' | 'browser'; ua?: string; cores?: number; gpu?: string; crossOriginIsolated?: boolean }
--- a/packages/physics/src/elastic/index.ts
+++ b/packages/physics/src/elastic/index.ts
@@ -231,33 +231,26 @@
   for (let i = 0; i < N; i++) u[i] = free[i] ? uf[R.map[i]!]! : uc[i]!;
   // stresses: nodal averages of element stresses evaluated at the element nodes
   const t0 = performance.now();
-  const sig = nodalStress(p, u, mask);
+  const { nodal: sig, element: sigE } = nodalStress(p, u, mask);
   const nsc = dim === 2 ? 4 : 6;  // 2D: sxx syy sxy szz
   const mises = new Float64Array(nn), s1 = new Float64Array(nn), s2 = new Float64Array(nn), s3 = dim === 3 ? new Float64Array(nn) : null;
-  for (let v = 0; v < nn; v++) {
-    const s = sig.subarray(nsc * v, nsc * v + nsc);
-    if (dim === 2) {
-      const [xx, yy, xy, zz] = s as unknown as [number, number, number, number];
-      mises[v] = Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * xy * xy);
-      const c = 0.5 * (xx + yy), r = Math.hypot(0.5 * (xx - yy), xy);
-      s1[v] = c + r; s2[v] = c - r;
-    } else {
-      const [xx, yy, zz, yz, xz, xy] = s as unknown as number[];
-      mises[v] = Math.sqrt(0.5 * ((xx! - yy!) ** 2 + (yy! - zz!) ** 2 + (zz! - xx!) ** 2) + 3 * (yz! ** 2 + xz! ** 2 + xy! ** 2));
-      const ev = symEig3(xx!, yy!, zz!, yz!, xz!, xy!);
-      s1[v] = ev[0]!; s2[v] = ev[1]!; s3![v] = ev[2]!;
-    }
-  }
+  for (let v = 0; v < nn; v++) stressInvariants(sig, nsc, dim, v, mises, s1, s2, s3);
+  // element values at the cell nodes before averaging (FieldData.elementNodal: per-domain recovery and element-value
+  // integrals in @amp/post, DevLog-059); NaN for cells outside the physics
+  const nE = sigE.length / nsc;
+  const eMises = new Float64Array(nE), eS1 = new Float64Array(nE), eS2 = new Float64Array(nE), eS3 = dim === 3 ? new Float64Array(nE) : null;
+  for (let i = 0; i < nE; i++) stressInvariants(sigE, nsc, dim, i, eMises, eS1, eS2, eS3);
+  const eComp = (j: number) => Float64Array.from({ length: nE }, (_, i) => sigE[nsc * i + j]!);
   const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
   const comp = (j: number) => Float64Array.from({ length: nn }, (_, v) => sig[nsc * v + j]!);
   const names = dim === 2 ? ['sxx', 'syy', 'sxy', 'szz'] : ['sxx', 'syy', 'szz', 'syz', 'sxz', 'sxy'];
   const fields: Solution['fields'] = [
     { name: 'u', unit: 'm', space, components: dim as 2 | 3, data: u },
-    ...names.map((nm, j) => ({ name: nm, unit: 'Pa', space, components: 1 as const, data: comp(j) })),
-    { name: 'mises', unit: 'Pa', space, components: 1, data: mises },
-    { name: 's1', unit: 'Pa', space, components: 1, data: s1 },
-    { name: 's2', unit: 'Pa', space, components: 1, data: s2 },
-    ...(s3 ? [{ name: 's3', unit: 'Pa', space, components: 1 as const, data: s3 }] : []),
+    ...names.map((nm, j) => ({ name: nm, unit: 'Pa', space, components: 1 as const, data: comp(j), elementNodal: eComp(j) })),
+    { name: 'mises', unit: 'Pa', space, components: 1, data: mises, elementNodal: eMises },
+    { name: 's1', unit: 'Pa', space, components: 1, data: s1, elementNodal: eS1 },
+    { name: 's2', unit: 'Pa', space, components: 1, data: s2, elementNodal: eS2 },
+    ...(s3 ? [{ name: 's3', unit: 'Pa', space, components: 1 as const, data: s3, elementNodal: eS3! }] : []),
   ];
   let mmax = 0, umax = 0;
   for (let v = 0; v < nn; v++) if (active[v]) { mmax = Math.max(mmax, mises[v]!); let s = 0; for (let d = 0; d < dim; d++) s += u[dim * v + d]! ** 2; umax = Math.max(umax, Math.sqrt(s)); }
@@ -358,24 +351,42 @@
   if (dim === 2) out[3] = p.model === 'plane-strain' ? nu * (out[0]! + out[1]!) - E * al * dT : 0;
 }
 
-function nodalStress(p: ElasticProblem, u: Float64Array, mask: Uint8Array): Float64Array {
+/** Nodal averages of the element stresses at the element nodes, and the element values themselves
+ *  ((cell * k + a) * nsc + j; NaN for masked cells). */
+function nodalStress(p: ElasticProblem, u: Float64Array, mask: Uint8Array): { nodal: Float64Array; element: Float64Array } {
   const m = p.mesh, dim = m.dim, k = NPC[m.cells.type], nn = nNodes(m), nc = nCells(m);
   const nsc = dim === 2 ? 4 : 6;
-  const acc = new Float64Array(nn * nsc), cnt = new Float64Array(nn);
+  const acc = new Float64Array(nn * nsc), cnt = new Float64Array(nn), el = new Float64Array(nc * k * nsc).fill(NaN);
   const rn = refNodes(m.cells.type), s = new Float64Array(nsc);
   for (let e = 0; e < nc; e++) {
     if (!mask[e]) continue;
     for (let a = 0; a < k; a++) {
       cellStress(p, u, e, rn[a]!, s);
       const v = m.cells.conn[k * e + a]!;
-      for (let j = 0; j < nsc; j++) acc[nsc * v + j]! += s[j]!;
+      for (let j = 0; j < nsc; j++) { acc[nsc * v + j]! += s[j]!; el[(k * e + a) * nsc + j] = s[j]!; }
       cnt[v]!++;
     }
   }
   for (let v = 0; v < nn; v++) if (cnt[v]) for (let j = 0; j < nsc; j++) acc[nsc * v + j]! /= cnt[v]!;
-  return acc;
+  return { nodal: acc, element: el };
 }
 
+/** von Mises and principal stresses of entry i of a Voigt stress array (2D: xx yy xy zz; 3D: xx yy zz yz xz xy). */
+function stressInvariants(sig: Float64Array, nsc: number, dim: number, i: number, mises: Float64Array, s1: Float64Array, s2: Float64Array, s3: Float64Array | null): void {
+  const s = sig.subarray(nsc * i, nsc * i + nsc);
+  if (dim === 2) {
+    const [xx, yy, xy, zz] = s as unknown as [number, number, number, number];
+    mises[i] = Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * xy * xy);
+    const c = 0.5 * (xx + yy), r = Math.hypot(0.5 * (xx - yy), xy);
+    s1[i] = c + r; s2[i] = c - r;
+  } else {
+    const [xx, yy, zz, yz, xz, xy] = s as unknown as number[];
+    mises[i] = Math.sqrt(0.5 * ((xx! - yy!) ** 2 + (yy! - zz!) ** 2 + (zz! - xx!) ** 2) + 3 * (yz! ** 2 + xz! ** 2 + xy! ** 2));
+    const ev = symEig3(xx!, yy!, zz!, yz!, xz!, xy!);
+    s1[i] = ev[0]!; s2[i] = ev[1]!; s3![i] = ev[2]!;
+  }
+}
+
 /** Eigenvalues (descending) of a symmetric 3x3 tensor (closed form, trigonometric). */
 export function symEig3(xx: number, yy: number, zz: number, yz: number, xz: number, xy: number): number[] {
   const p1 = xy * xy + xz * xz + yz * yz;
--- a/packages/physics/src/elastic/axisym.ts
+++ b/packages/physics/src/elastic/axisym.ts
@@ -78,13 +78,16 @@
   for (let i = 0; i < N; i++) u[i] = free[i] ? uf[R.map[i]!]! : active[i >> 1] ? value[i]! : 0;
   const t0 = performance.now();
   // nodal stresses: average of the element values at the element nodes
+  // element values at the cell nodes are kept (FieldData.elementNodal: per-domain recovery and element-value integrals
+  // in @amp/post, DevLog-059); NaN for masked cells
   const acc = new Float64Array(nn * 4), cnt = new Float64Array(nn), s = new Float64Array(4), ref = REF[m.cells.type]!;
+  const el = new Float64Array(nc * k * 4).fill(NaN);
   for (let e = 0; e < nc; e++) {
     if (!mask[e]) continue;
     for (let a = 0; a < k; a++) {
       axisymCellStress(p, u, e, ref[a]!, s);
       const v = m.cells.conn[k * e + a]!;
-      for (let j = 0; j < 4; j++) acc[4 * v + j]! += s[j]!;
+      for (let j = 0; j < 4; j++) { acc[4 * v + j]! += s[j]!; el[4 * (k * e + a) + j] = s[j]!; }
       cnt[v]!++;
     }
   }
@@ -93,22 +96,22 @@
   const mises = new Float64Array(nn), s1 = new Float64Array(nn), s2 = new Float64Array(nn), s3 = new Float64Array(nn);
   let mmax = 0, umax = 0;
   for (let v = 0; v < nn; v++) {
-    const rr = acc[4 * v]!, zz = acc[4 * v + 1]!, pp = acc[4 * v + 2]!, rz = acc[4 * v + 3]!;
-    mises[v] = Math.sqrt(0.5 * ((rr - zz) ** 2 + (zz - pp) ** 2 + (pp - rr) ** 2) + 3 * rz * rz);
-    const c = 0.5 * (rr + zz), h = Math.hypot(0.5 * (rr - zz), rz);
-    const ps = [c + h, c - h, pp].sort((x, y) => y - x);
-    s1[v] = ps[0]!; s2[v] = ps[1]!; s3[v] = ps[2]!;
+    axisymInvariants(acc, v, mises, s1, s2, s3);
     if (active[v]) { mmax = Math.max(mmax, mises[v]!); umax = Math.max(umax, Math.hypot(u[2 * v]!, u[2 * v + 1]!)); }
   }
+  const nE = nc * k;
+  const eComp = (j: number) => Float64Array.from({ length: nE }, (_, i) => el[4 * i + j]!);
+  const eMises = new Float64Array(nE), eS1 = new Float64Array(nE), eS2 = new Float64Array(nE), eS3 = new Float64Array(nE);
+  for (let i = 0; i < nE; i++) axisymInvariants(el, i, eMises, eS1, eS2, eS3);
   timer.add('post', performance.now() - t0);
   const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
   const fields: Solution['fields'] = [
     { name: 'u', unit: 'm', space, components: 2, data: u },
-    ...(['srr', 'szz', 'sphi', 'srz'] as const).map((nm, j) => ({ name: nm, unit: 'Pa', space, components: 1 as const, data: comp(j) })),
-    { name: 'mises', unit: 'Pa', space, components: 1, data: mises },
-    { name: 's1', unit: 'Pa', space, components: 1, data: s1 },
-    { name: 's2', unit: 'Pa', space, components: 1, data: s2 },
-    { name: 's3', unit: 'Pa', space, components: 1, data: s3 },
+    ...(['srr', 'szz', 'sphi', 'srz'] as const).map((nm, j) => ({ name: nm, unit: 'Pa', space, components: 1 as const, data: comp(j), elementNodal: eComp(j) })),
+    { name: 'mises', unit: 'Pa', space, components: 1, data: mises, elementNodal: eMises },
+    { name: 's1', unit: 'Pa', space, components: 1, data: s1, elementNodal: eS1 },
+    { name: 's2', unit: 'Pa', space, components: 1, data: s2, elementNodal: eS2 },
+    { name: 's3', unit: 'Pa', space, components: 1, data: s3, elementNodal: eS3 },
   ];
   const sol = await makeSolution({
     mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'elastic', model: 'axisym', bcs: p.bcs.map((x) => x.type), nn } }),
@@ -119,3 +122,12 @@
   attachMesh(sol, m);
   return Object.assign(sol, { detail: { dof: R.pat.n }, u });
 }
+
+/** von Mises and principal stresses (s1 >= s2 >= s3) of entry i of [srr, szz, sphi, srz] values. */
+function axisymInvariants(acc: Float64Array, i: number, mises: Float64Array, s1: Float64Array, s2: Float64Array, s3: Float64Array): void {
+  const rr = acc[4 * i]!, zz = acc[4 * i + 1]!, pp = acc[4 * i + 2]!, rz = acc[4 * i + 3]!;
+  mises[i] = Math.sqrt(0.5 * ((rr - zz) ** 2 + (zz - pp) ** 2 + (pp - rr) ** 2) + 3 * rz * rz);
+  const c = 0.5 * (rr + zz), h = Math.hypot(0.5 * (rr - zz), rz);
+  const ps = [c + h, c - h, pp].sort((x, y) => y - x);
+  s1[i] = ps[0]!; s2[i] = ps[1]!; s3[i] = ps[2]!;
+}
```
- R2 (after R1 only; `validation/c/cases_ext/pkg.py`, lane G6 / coordinator): gate the PK-02 means. Replace lines 121-126 with:
```python
            tref("PK-02", "cu_srr", "cu_sxx_mean", {"rel": 1e-3}, citation=LAME, locator=LAME_LOC, tid="cu_sxx_mean",
                 quantity="volume mean of the Cu stress sxx (stress recovered within each material)",
                 note="per-material stress recovery (DevLog-059): +9.0e-5 / +6.1e-6 at hFactor 1 / 0.5"),
            tref("PK-02", "si_szz", "si_szz_mean", {"rel": 1e-3}, citation=LAME, locator=LAME_LOC, tid="si_szz_mean",
                 quantity="volume mean of the Si axial stress (stress recovered within each material)",
                 note="per-material stress recovery (DevLog-059): -7.9e-6 / -8.4e-7 at hFactor 1 / 0.5"),
```
  then rebuild `eval/cases/c/PK-02.yaml` (`validation/c/build_cases.py`) and run `test_build_matches`. Tolerance 1e-3 = the point gates of the case; about 160x headroom at the finest level.
- R3 (G7; the click-probe part in `probe.ts` done by this lane 18:38) (`apps/web/src/lib/gfx/Graphics.svelte` l.470, 480, 529 and any other `{ space: f.space as Space, data: f.data, components: ... }` sent to the post worker; `apps/web/src/lib/post/probe.ts` l.35 is mine but unchanged pending this): add `...(f.elementNodal ? { elementNodal: f.elementNodal } : {})` to the field object, e.g. l.480 `field: { space: f.space as Space, data: f.data, components: f.components, ...(f.elementNodal ? { elementNodal: f.elementNodal } : {}) }`. The post worker then draws stresses with one value per material at interfaces (2D); no effect on other fields.
- R4 (coordinator, sims): after R1, the labels of `sims/tsv-stress-3d.yaml` l.78-79 still say "informative: the displayed stress is averaged at nodes shared with the Si"; proposed: l.78 label "volume mean of the Cu in-plane stress", l.79 label "volume mean of the Si axial stress".

## 7. Open items
- O1: closed: R1 is in the tree (seen 18:36 PST).
- O2: 3D display (`solid3d.ts` exterior / slices: nodal arrays) still draws the producer's nodal mean; per-domain values there need per (cell, node) display arrays (not done).
- O3: PK-01 Si point stress (DevLog-049 O2) is unchanged: the point is not on an interface; its h-oscillation comes from nodal averaging inside the Si (a superconvergent patch recovery would address it; not in scope).
- O4: other cross-domain nodal averages: magnetostatics `Br` / `Bz`, em3d / em-axisym nodal projections. Same contract applies if their producers set `elementNodal`.
- O5: at interface nodes `mises`, `s1`..`s3` are per-domain means of element invariants (inside a domain they stay invariants of the averaged components, as before); differences are at the recovery-error level.
- O6: the eval harness `sample` path (probe / field extracts) reads recovered values by default; no case currently samples a stress next to an interface.

## 8. Hand-off
- Owned files changed: `packages/post/src/{points,evaluate,expr,evaluations,derived,sample,index}.ts`, new `packages/post/test/interface-recovery.test.ts`; `apps/web/src/lib/post/{field2d,post.worker}.ts`, new `apps/web/test/g2-interface-display.test.ts`.
- State 18:42 PST: R1 in the tree; R2 (re-gate PK-02 means at 1e-3) and R4 (labels) ready; R3 remaining part is G7's `Graphics.svelte` field objects. Owned files also: `apps/web/src/lib/post/probe.ts`.
- Scratch (not tracked): producer patch, hook, rebase script and record extractor under the lane scratch folder (`<scratch>/g2/patch/`).
