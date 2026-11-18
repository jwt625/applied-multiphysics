# DevLog-050: Bloch / Floquet periodic conditions and photonic-crystal band structures (lane E4)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E4, chunk 2 (DevLog-037 s.4.1) |
| Owns | `packages/physics/src/wave2d/**`, `packages/mesh/**`, new `validation/bloch/**`, `validation/c/cases_ext/bloch.py`, new sims (`sims/phc-*-bands*.yaml`, `sims/floquet-*.yaml`), their case files (WO-90..WO-94) and expected JSON, the phc entries of `apps/web/src/lib/library/catalog-bc.ts`, new tests `packages/physics/test/bloch-*.test.ts`, `packages/mesh/test/periodic.test.ts`, this file |
| Read | CLAUDE.md; DevLog-037 s.4.1; DevLog-042 (wave2d, all sections); `packages/physics/src/wave2d/**`; `packages/mesh/src/{index,spec,mesh2d,cdt2d}`; `packages/physics/src/{driver,prepare}.ts`, `common/{eigen,scalar,ctx}.ts`; `packages/spec/src/{schema,registry,provisional/wave1}.ts`; sims `phc-*`; `validation/c/{gen_pwe.py,mpb/}`; `eval/cases/c/WO-04.yaml`, `eval/expected/WO-04.json`; `catalog-bc.ts` |
| Status | done (gates s.4); requests s.5; open items s.6; hand-off s.7 |

Conventions: F = fact read from code or a run; D = decision of this lane (reason given); E = estimate; O = open item; R = request to the coordinator.

## 1. Plan (2026-11-18 13:32 PST, before coding)

### 1.1 Facts
- F: wave2d solves only `frequency` studies (`studyFrequencies` throws otherwise); emw-2d readiness requires a frequency study.
- F: the `eigen` study (wave1.ts, coordinator) has strict settings `nModes`, `shift` (Hz). Study types are registered through `Registration` (kind `study`) and the spec schema is built from the registry, so a new study type can be registered from `wave2d/spec.ts` (spread by `registrations.ts`).
- F: C5 `steps.kind` is `time | eigen | freq | param`; no kind for a k index.
- F: the 2D mesher (`mesh2d` + `cdt2d.meshDomain`) discretises each geometry edge from the size field and splits boundary segments during Ruppert refinement (encroachment, midpoint), so opposite cell sides do not in general carry the same nodes.
- F: `prepareRun` nested levels are `refineUniform` of the hFactor = 1 mesh (midpoint split of straight facets), so a base mesh with matched sides keeps matched sides on every level.
- F: `prepareRun` caches the base mesh by `{geometry, mesh, params, physics type}` (prepare.ts `chains` key, owned by E2): a periodic and a non-periodic spec with the same geometry and mesh blocks would share one cached mesh in one process (R2).
- F: core has a complex-symmetric supernodal LDL^T, complex GMRES, real LDL^T / Cholesky and the shift-invert block Arnoldi driver `shiftInvertEigen` (real symmetric pencils; `common/eigen.ts`, E8 owns common/**, used read-only here). No sparse non-symmetric complex LU.
- F: MPB references for the rod lattice (r 0.2 a, eps 12, TM): `eval/expected/WO-04.json` gap_lower 0.2806643916748245, gap_upper 0.4171623956235006 (c/a; MPB 1.34.0 resolutions 16-256 Richardson, agrees with the PWE limit to 7.7e-6 rel); tolerance rel 1e-4 after Richardson (WO-04 case). PWE function `bands()` in `validation/c/gen_pwe.py` (TM, eps Fourier series).

### 1.2 Bloch condition and its discrete form
Lattice translation a (from side A to side B of a periodic pair). Bloch (Floquet) field: u(x + a) = u(x) exp(-j k.a) (time convention exp(+j omega t), same as wave2d).

Weak form. Trial space: P2 (or P1) functions with u_B = lambda u_A at paired nodes, lambda = exp(-j k.a). Boundary terms of the integration by parts on the pair: int_A a dn u v ds + int_B a dn u v ds. The co-normal flux of a Bloch solution satisfies (a dn u)_B = -lambda (a dn u)_A (outward normals opposite). The terms cancel for every u if and only if the test functions satisfy v_B = v_A / lambda. For real k (|lambda| = 1) that is v_B = conj(lambda) v_A.

Discrete reduction: union-find over all periodic pairs with a translation offset per node: node i = root r(i) translated by T_i (x_i = x_r + T_i). Then u_i = p_i u_r with p_i = exp(-j k.T_i), and the test reduction uses q_i = 1 / p_i. Reduced matrix R = Q^T A P, i.e. R[r(i), r(j)] += q_i A_ij p_j; reduced RHS b_r += q_i b_i; expansion u_i = p_i u_r. Several pairs (x and y sides; corner nodes in up to three pairs) are consistent when the offsets agree (checked: a node reached by two paths with different total translation is an error).
- Eigen / bands (lossless, no PML): A = K - lambda M with K, M real symmetric; |p_i| = 1 so R = P^H A P is Hermitian; M_red Hermitian positive definite. Real embedding of a Hermitian pencil H = Hr + j Hi: [[Hr, -Hi], [Hi, Hr]] is real symmetric (Hi^T = -Hi), every eigenvalue doubled ((x, y) and (-y, x)); solved with `shiftInvertEigen` (Cholesky of K - sigma M, sigma below the spectrum), block size 8 (multiplicity up to 4 physical x 2). When every phase is real (Gamma, X, M of a rectangular lattice), Hi = 0 and the n x n real problem is solved instead (no doubling). Eigenvalue lambda = k0^2; f = c0 sqrt(lambda) / (2 pi).
  - TM (E_z): K = int (1/mu_r) grad u . grad v, M = int eps_r u v. TE (H_z): K = int (1/eps_r) grad u . grad v, M = int mu_r u v. Lossless real eps_r, mu_r only (lossy media make the pencil non-Hermitian: rejected with a message).
- Driven (frequency study, Floquet unit cell): A is complex symmetric (PML, losses); R = Q^T A P is neither symmetric nor Hermitian for k.a not in {0, pi}, so the complex LDL^T cannot be used. D: a new sparse complex LU without pivoting on the reduced, structurally symmetric pattern (envelope / skyline storage after reverse Cuthill-McKee ordering; static pivot perturbation counted; iterative refinement on the reduced matrix). Rationale: unit cells are small (a strip of 10^3-10^4 nodes); the envelope LU is short and deterministic. Bloch phase from the plane wave: k = Re(k_b) (cos phi, sin phi) (lossy background: the complex k_b d gives |lambda| != 1 and q = 1 / p handles it); without a plane wave the periodic condition's `k` setting gives the phase.
- Dirichlet and inactive nodes are excluded before the reduction (existing lifting); a periodic class must be all Dirichlet or all free (else an error naming both nodes).

### 1.3 Mesh: matched opposite sides (`packages/mesh`)
- `mesh2d` option `periodic: [{select: string[]}]` (boundary ids of both sides of one pair). Per pair: the selected geometry edges must be straight and parallel, and their offsets along the common normal must take exactly two values (side A = smaller offset, normal oriented +x, or +y when vertical); translation d from the tangential extents. After the boundary discretisation, both sides get the union of their PSLG vertex positions (side B = side A + d); after the CDT, the boundary nodes on both sides are compared; if refinement split a segment on one side only, the union of the final positions is fed back and the domain is re-meshed (up to 4 rounds; else an error). Deterministic (same input, same output; no randomness).
- `meshFromSpec`: periodic selections are read from `physics[*].bcs` of type `periodic` (2D only). Specs without periodic conditions take the unchanged code path, so all 48 sims keep their mesh hash and tagHash (checked, s.4).
- `pairPeriodicNodes(mesh, facets)`: splits the facets of one condition into the two sides, computes d, pairs every node of side A with the node of side B at x + d (tolerance 1e-9 x cell size), and throws a plain error naming the first unmatched node when the meshes do not match.

### 1.4 Spec additions (`wave2d/spec.ts`, registered through the existing spread)
- bc `periodic` (emw-2d; select bnd: both sides of one pair): settings `k` (optional, quantity '1': Bloch wave-vector component along this pair's reciprocal vector, in units of |b|, i.e. k.a / (2 pi); used by `eigen` studies and by driven runs without a plane wave; the `bands` study and the plane wave set k themselves).
- study `bands`: settings `kPath` (array of {label, k: [k1, k2]}: reduced coordinates on the reciprocal vectors b1, b2 of the periodic conditions in their listed order; MPB convention), `interpolate` (points inserted between consecutive path points, default 4, as MPB `interpolate`), `nBands` (default 8).
- emw-2d also accepts the existing `eigen` study (closed PEC / PMC cavities and periodic cells at the condition's k): `nModes`, `shift` (Hz).
- Results. bands: scalars `f_<b>_<k>` (Hz; band b, path point k, both from 0), `fmax_<b>`, `fmin_<b>` (Hz over the path), `kx_<k>`, `ky_<k>` (1/m); fields (`Ez_*` or `Hz_*`, real and imaginary part and modulus) for every band at the distinct labelled path points, steps kind `eigen` with the eigenfrequencies (Hz) as values; extra property `wave2d.bands` = {labels, k (1/m), kReduced, distance (1/m, cumulative path length for the plot axis), f (Hz, per k per band), lattice (a_i, b_i), fieldSteps [{step, label, band}]}. eigen: scalars `f_<i>` (Hz), fields per mode.

### 1.5 Gates (>= 2 mesh levels; tests `packages/physics/test/bloch-*.test.ts`)
| Id | Case | Reference | Target |
|---|---|---|---|
| G-B1 | empty lattice, eps 2.25, square cell a = 1 m, TM and TE, k at Gamma, X, M and a generic point | folded light line f = c0 |k + G| / (2 pi n), G over the reciprocal lattice (analytic) | first 8 bands rel <= 1e-6 fine, decreasing |
| G-B2 | 1D Bragg stack in a 2D cell (layers along x, periodic in x and y), TM and TE, generic (K, k_y) | transfer-matrix Bloch dispersion cos(K a) = cos(q1 d1) cos(q2 d2) - (1/2)(p1/p2 + p2/p1) sin(q1 d1) sin(q2 d2), q_i = sqrt(eps_i k0^2 - k_y^2), p_i = a_i q_i (a = 1 TM, 1/eps TE) (Yariv and Yeh, Optical Waves in Crystals, 1984, ch. 6; derivation in the reference script), roots over the folded k_y + 2 pi m / b | rel <= 1e-5 fine, decreasing |
| G-B3 | MPB tutorial rods r 0.2 a, eps 12, TM, path Gamma-X-M-Gamma interpolate 4 | WO-04 expected gap_lower 0.2806644, gap_upper 0.4171624 (c/a) | rel <= 1e-4 at the finest of 2 levels, error decreasing; full band diagram vs PWE (nmax 24) informative |
| G-B4 | Floquet driven: dielectric slab eps 4, thickness 0.3 lambda, plane wave at 30 and 60 deg, TM and TE, periodic strip with PML top / bottom | Airy slab at oblique incidence (closed form, cross-checked by a 2 x 2 transfer matrix in `validation/bloch/oblique_refs.py`) | complex r, t error <= 1e-3 (lambda/20), <= 1e-4 (lambda/40) |
| G-B5 | eigen study at fixed k = band study at the same k | self-consistency | <= 1e-10 rel |
| G-M1 | mesh: matched sides on rectangular and parallelogram cells with an off-centre refinement source; mismatch error; determinism; 48 sims unchanged | | exact |

### 1.6 Sims and cases
- `sims/phc-square-rods-bands.yaml`: emw-2d TM bands of the r 0.2 a, eps 12 rod lattice (full unit cell, two periodic conditions, Gamma-X-M-Gamma, 8 bands), a = 1 um (scale choice; results scale with c / a). Cases WO-90 (gap edges vs WO-04 MPB values) and WO-91 (full TM band diagram vs PWE at named points, informative / gated as the PWE floor allows).
- `sims/phc-square-rods-te-bands.yaml` (TE of the same lattice) with WO-92 vs a TE PWE (Ho inverse rule) if its floor is usable, else informative.
- `sims/floquet-slab-oblique.yaml`: Floquet slab at oblique incidence, WO-93 (r, t vs Airy).
- WO-94 reserved: triangular rod lattice (WO-61 MPB values) on a parallelogram cell if time allows.
- Catalog: new entries appended next to the phc entries of `catalog-bc.ts`; analog entries stay (hidden by the existing rule).

### 1.7 Audit minor (DevLog-037 s.7 audit 2)
`scattering` next to a non-background cell under a plane wave: the first-order ABC acts on u_s with the adjacent cell's k, while u_s near a non-background cell is not an outgoing wave of that medium only (it contains the incident-field correction of the cell), so it is ill-posed. D: reject in `checkOpenBoundaries` (plain message, same style), test added.

## 2. TODO
- [x] mesh: periodic option in mesh2d + meshFromSpec, pairPeriodicNodes, tests, sim regression
- [x] wave2d: bloch.ts (union-find, phases, reduction), lu.ts (RCM + envelope LU), bands.ts (bands / eigen), index.ts dispatch + readiness, kernel periodic path
- [x] spec.ts: periodic bc, bands study, result names
- [x] reference scripts validation/bloch (empty lattice inline in the test; Bragg stack; oblique Airy; PWE band table)
- [x] gates G-B1..G-B5, tests; audit minor (scattering)
- [x] sims, cases (bloch.py), expected JSON, harness CLI, catalog entries (WO-90..WO-93; the TE PWE case of s.1.6 was replaced by the triangular lattice, which reuses MPB references)
- [x] existing wave2d tests; physics test + check; requests; hand-off
- [ ] (coordinator) requests s.5

## 3. Progress log
- 2026-11-18 13:22-13:32 PST: read the files listed above; plan written (this section).
- 2026-11-18 13:33 PST: baseline mesh dump of all sims (scratch script: `meshFromSpec` order 1 and 2, mesh hash + tagHash + node count): `logs/E4-mesh-regress-before-20261118T133337.json` (50 sims at that time).
- 2026-11-18 13:35-13:40 PST: `packages/mesh/src/periodic.ts` (`periodicSides`, `pairPeriodicNodes`, `periodicSelections`), `mesh2d` option `periodic`, `meshFromSpec` reads the periodic conditions; mesh test `periodic.test.ts` 4/4.
- 2026-11-18 13:40-13:46 PST: `wave2d/bloch.ts` (PeriodicMap union-find with translation offsets, BlochReduction, bandPath), `lu.ts` (RCM + envelope complex LU, refinement), `media.ts` (moved from index.ts unchanged), `bands.ts` (bands / eigen), kernel periodic path, index dispatch + readiness, spec registrations.
- 2026-11-18 13:46 PST: F: first empty-lattice run at h 1/16 failed to mesh: Ruppert refinement kept splitting boundary segments on one side only (5 matching rounds not enough). D: periodic sides start at half the local size (mult 2 on those edges) and up to 9 rounds; now one round (rectangular cells, rods, parallelogram).
- 2026-11-18 13:47 PST: F: one early G-B5 run (rods, k = (0.3, 0.1), embedding path) returned band 3 = 241.28 MHz where the PWE (nmax 16) has 194.99 MHz: the block Arnoldi had missed an eigenvalue pair. D: every eigen solve is now checked by the Sylvester inertia of K - theta M (LDL^T) at a point in the first gap after the wanted eigenvalues; a mismatch retries with a larger search space (up to 4 attempts, then a Solution note). The same case now gives 194.989 MHz (PWE 194.988).
- 2026-11-18 13:48 PST: `validation/bloch/bloch_refs.py` -> `bloch_reference.json`: Bragg stack route 1 vs 2 max 2.3e-13 (on the dispersion function), slab route 2 2.3e-16 and |r|^2 + |tau|^2 - 1 2.2e-16, rod PWE table nmax 24 (floor nmax 20 vs 24: 2.8e-5 c/a).
- 2026-11-18 13:50 PST: coordinator relay (E9, DevLog-055 s.9 R1) applied in `packages/mesh/src/stack.ts`: `FLAT_TET_DEG = 5` (design threshold, comment says so) and the flat-tetrahedra warning in `meshStack`. Mesh regression after it and after the periodic mesher changes: `logs/E4-mesh-regress-after1-*.json`: 50 / 50 sims of the baseline identical (hash, tagHash, node count at order 1 and 2); 14 sims added by other lanes since the baseline are not in the comparison.
- 2026-11-18 13:52 PST: Floquet slab gate G-B4 passes on the first run (s.4). Audit minor: scattering condition next to a non-background cell rejected (`checkOpenBoundaries`), test added.
- 2026-11-18 13:55-14:03 PST: sims `phc-square-rods-bands`, `floquet-slab-oblique`, `phc-triangular-rods-bands` (rhombic cell, two periodic pairs with a tangential offset); `validation/bloch/gen_expected.py` -> `eval/expected/WO-90..WO-93.json`; `validation/c/cases_ext/bloch.py` (4 cases, built into a scratch directory and only WO-90..93.yaml copied; `test_build_matches` 55 / 55 identical); harness CLI: WO-90, WO-91, WO-92, WO-93 pass (logs/eval-20261118T135812.jsonl, -135856, -135806, -140228). Catalog entries appended after the phc entries of `catalog-bc.ts` (analog entries unchanged).
- 2026-11-18 14:00-14:08 PST: Bloch gates 12 / 12 (`logs/E4-bloch-gates-20261118T140017.log`, peak RSS 0.54 GB); mesh tests 24 / 24 (`logs/E4-mesh-test-20261118T140354.log`); physics tests 190 / 190 (`logs/E4-physics-test-20261118T140438.log`); mesh and physics `tsc` clean; apps/web check: 2 errors, both in `src/lib/workbench/session.svelte.ts` (lane E5's file, in progress), none in `catalog-bc.ts` (`logs/E4-web-check-20261118T140722.log`). Final mesh regression `logs/E4-mesh-regress-after-20261118T140752.json`: 50 / 50 baseline sims identical; of the 70 sims now present only this lane's three carry periodic conditions, so every other sim takes the unchanged mesher path.
- 2026-11-18 13:53 PST: existing wave2d tests 20 / 20 (`logs/E4-wave2d-existing-*.log`); PEC cylinder TM sigma_back 1.6395419737563295 / 1.639881313291007 m (DevLog-042 s.4: 1.639542 / 1.639881), DOF 15,947 / 62,413 as before. F: the dielectric cylinder (keepTools circle) now meshes with 19,523 / 75,449 DOF (DevLog-042: 26,950 / 81,160) and sigma_back 2.880430 (2.880401): the geometry changed under lane E9 (curved keepTools pieces merged, DevLog-055), not this lane's code; still within its gate.

## 4. Results (Node v23.7.0, Apple M4 Pro, nice 10, other lanes running; frequencies in Hz unless c/a)

### 4.1 Gates
| Gate | Case | Levels | Value / error | Tolerance | Result |
|---|---|---|---|---|---|
| G-B1 | empty lattice eps 2.25, a = 1 m, 7 k points (Gamma, X, M, generic), 8 bands, TM | h 1/8, 1/16 | max error / f_8: 3.0e-4, 1.9e-5 (ratio 15.8, P2 order 4) | ratio > 12; fine < 3e-5 | pass |
| G-B1 | same, TE | same | 3.0e-4, 1.9e-5 | same | pass |
| G-B2 | Bragg stack eps 4 / 1, d1 0.4, ax 1, ay 0.5 m, 3 generic (K, k_y), 8 bands, TM | h 1/16, 1/32 | max rel 2.5e-4, 1.5e-5 | ratio > 12; fine < 3e-5 | pass |
| G-B2 | same, TE (a = 1/eps, interface kinks) | same | 2.7e-4, 1.7e-5 | same | pass |
| G-B3 | MPB rods r 0.2 a, eps 12, TM, Gamma-X-M-Gamma (16 k), 8 bands | h a/10 (rod a/40), a/20 (a/80); 3,024 / 7,916 DOF | gap lower 0.2806623 / 0.2806618 (MPB 0.2806644: 7.4e-6 / 9.1e-6; PWE limit 0.2806622: 2.2e-7 / -1.5e-6); gap upper 0.4171642 / 0.4171630 (MPB 0.4171624: 4.4e-6 / 1.5e-6; PWE limit: 2.5e-6 / -3.9e-7); all 128 band values vs PWE nmax 24: max 8.5e-5 / 2.0e-5 c/a (PWE floor 2.8e-5) | rel 1e-4 vs MPB on both levels; level change < 1e-5; fine vs PWE limit < 5e-6; table < 1e-4 c/a | pass |
| G-B4 | Floquet slab eps 4, t 0.3 lambda, TM 30 deg | h lambda/20, lambda/40 (slab h/2); 11,340 / 43,612 nodes | complex r, tau error 3.2e-5 / 1.6e-6 | 1e-3 / 1e-4, decreasing | pass |
| G-B4 | TM 60 deg | same | 3.8e-5 / 1.6e-5 (PML: R0 1e-10, R0^cos60 = 1e-5) | same | pass |
| G-B4 | TE 30 deg | same | 3.3e-5 / 1.7e-6 | same | pass |
| G-B4 | TE 60 deg | same | 4.6e-5 / 1.9e-5 | same | pass |
| G-B5 | eigen study at k = (0.3, 0.1) vs bands study, rods, 4 bands | h 0.1 | identical to the last digit | 1e-10 rel | pass |
| G-M1 | mesh: rectangular cell with off-centre rod (P1, P2, after nested refinement), parallelogram cell, determinism, error messages | | pairs exact to 1e-12; same hash twice | exact | pass (4 tests) |
| audit minor | scattering condition next to the film cell under a plane wave | | rejected with a plain message naming boundary and domain | | pass |
| readiness | port in a periodic cell | | rejected | | pass |

References: `validation/bloch/bloch_reference.json` (`bloch_refs.py`: Bragg stack closed form vs transfer-matrix trace 2.3e-13 on the dispersion function; Airy vs transfer matrix 2.3e-16, |r|^2 + |tau|^2 - 1 2.2e-16; PWE table nmax 24, floor 2.8e-5 c/a); `eval/expected/WO-04.json` (MPB, PWE limit). The rod-lattice FE values settle between the MPB Richardson value and the PWE limit estimate, which differ by 7.7e-6 rel; a 'decreasing vs MPB' test would test the references, so G-B3 gates both levels against the case tolerance and the level change.

### 4.2 Cases (harness CLI, `pnpm eval` engine adapter, h_factors [1, 0.5])
| Case | Sim | Targets | L0 / L1 error | Wall L0 / L1 | Log |
|---|---|---|---|---|---|
| WO-90 | phc-square-rods-bands | gap_lower, gap_upper vs MPB (rel 1e-4), PWE limit (info) | lower 7.5e-6 / 9.3e-6, upper 4.7e-6 / 5.7e-7; vs PWE limit 2.0e-7 / 1.7e-6, 2.8e-6 / 1.4e-6 | 9.2 s / 34 s (3,048 / 12,192 DOF) | logs/eval-20261118T135812.jsonl |
| WO-91 | same | bands 3 and 8 at X and M vs PWE (abs 2e-4 / 1e-4 c/a) | 1.2e-6..8.9e-5 / 6.4e-6..3.2e-5 c/a | 8.2 s / 31 s | logs/eval-20261118T135856.jsonl |
| WO-92 | floquet-slab-oblique | abs(r), abs(tau) vs Airy (rel 5e-4 / 1e-4) | 6.9e-6 / 4.1e-7, 2.3e-6 / 3.2e-7 | 0.37 s / 0.96 s (11,467 / 45,053 DOF) | logs/eval-20261118T135806.jsonl |
| WO-93 | phc-triangular-rods-bands | gap_lower, gap_upper vs MPB (WO-61 values, rel 1e-4) | lower 4.9e-6 / 6.1e-6, upper 2.0e-6 / 3.4e-6 | 16 s / 48 s (4,240 / 16,960 DOF) | logs/eval-20261118T140228.jsonl |

### 4.3 Performance and memory
- Bands: about 0.5 s per k point at 3k DOF and 2 s at 12k DOF (real embedding of size 2n at generic k, block Arnoldi block 8, plus one LDL^T for the inertia check). Peak RSS of the whole Bloch test file 0.54 GB.
- Floquet driven: envelope LU after RCM, 45k reduced unknowns of a 0.5 x 3.3 lambda strip in 0.8 s.

## 5. Requests to the coordinator (shared files)
- R1 CONTRACTS-v0 changelog (C3 conditions, C6 studies, C5 results): "2026-11-18 (DevLog-050): bc `periodic` (emw-2d; select both opposite sides of one pair; optional setting `k` = k.a / 2 pi for eigen studies and source-driven frequency runs); the mesher gives both sides of each periodic pair the same nodes (2D; `mesh2d` option `periodic`, read by `meshFromSpec` from the physics conditions; meshes of specs without periodic conditions unchanged). Study `bands` (settings `kPath` [{label, k: [k1, k2]}] in units of the reciprocal lattice vectors of the periodic conditions in listed order, `interpolate` (default 4), `nBands` (default 8)); emw-2d also runs the `eigen` study (closed PEC / PMC cavities, periodic cells at the conditions' k). emw-2d frequency studies with a plane wave and periodic conditions solve a Floquet cell (Bloch phase from the incident wave). Results: scalars `f_<b>` (eigen), `f_<b>_<k>`, `fmax_<b>`, `fmin_<b>` (Hz), `kx_<k>`, `ky_<k>` (1/m); fields `Ez_*` / `Hz_*` (re, im, abs) per field step, steps kind `eigen` with the eigenfrequencies; extra Solution property `wave2d.bands` = {labels [{index, label}], k (1/m), kReduced, distance (1/m), f (Hz, per k per band), lattice {a, b}, fieldSteps [{step, label, k, band}]}. A scattering condition next to a non-background cell under a plane wave is rejected. @amp/mesh exports `periodicSides`, `pairPeriodicNodes`, `periodicSelections`, `FLAT_TET_DEG`."
- R2 `packages/physics/src/prepare.ts` (lane E2 owns it now), `levelMesh`: the nested-mesh cache key ignores the periodic conditions, so a periodic and a non-periodic spec with the same geometry, mesh and params blocks would share a mesh within one process. Exact change: `const key = JSON.stringify({ g: raw.geometry, m: raw.mesh, p: raw.params, type, elastic, per: periodicSelections(raw) });` with `import { periodicSelections } from '@amp/mesh';` (adds `"per":[]` for every other spec: harmless).
- R3 `packages/physics/src/driver.ts` `stepKindOf`: `case 'emw-2d': return study.type === 'frequency' ? 'freq steps' : 'eigen steps';` (eigen and bands studies produce eigen steps; only readiness messages of coupled studies use it).
- R4 (web, lane E6): band diagram plot from `sol.wave2d.bands`: x = `distance` (1/m) with tick labels at `labels[i].index`, y = `f` (Hz; offer f a / c0 when the user gives a), one line per band; the field step selector can label steps from `fieldSteps` (point label and band). The runner must pass `wave2d` through the worker protocol (DevLog-042 R4 (f)).
- R5 (class c, coordinator or lane E9): `eval/cases/c/WO-61.yaml` `spec:` is pending with the proposal `sims/phc-triangular-rods.yaml`; `sims/phc-triangular-rods-bands.yaml` now solves that lattice (WO-93 gates it against the same MPB values). WO-04's `spec:` could likewise point to `sims/phc-square-rods-bands.yaml` (extract `f * a / c` with `fmax_0` / `fmin_1`, a = 1 um, c = 299792458 m/s) instead of the two acoustics-analog sims; both changes are in files this lane does not own.

## 6. Open items
- O1 Bands in a browser: 9 s (a/10) for 16 k points vs the 2 s estimate in WO-04 `speed` (R3 estimate, not a measurement). Options: reuse the symbolic analysis across k points (the embedding pattern is fixed), skip the inertia check at the real-phase points after a passing neighbour, a complex Hermitian Lanczos instead of the real embedding (halves the size), worker-parallel k points.
- O2 Per-frequency material values (DevLog-042 O4): done after the hand-off (s.8).
- O3 Ports in periodic cells (Floquet port modes, diffraction orders) are rejected; reflection / transmission of a periodic structure are read from the fields (as WO-92). Zero-order R and T scalars (Fourier projection on a line above / below) are a cheap next step.
- O4 Lossy media and PML are rejected in band / eigen studies (non-Hermitian pencil; complex-frequency bands need a non-Hermitian eigensolver).
- O5 Periodic sides must be straight and parallel (unit cells of any 2D Bravais lattice qualify); curved or non-matching sides fail with a message.
- O6 TE bands of the rod lattice have no external gate (G-B1 and G-B2 gate TE analytically); a TE plane-wave expansion (inverse rule) would add one.
- O7 The block Arnoldi of `common/eigen.ts` missed an eigenvalue pair once on the real embedding (s.3, 13:47); the inertia check now catches it here. Other eigen modules use the same driver without such a check (no failure observed there; noted for lane E8, owner of common/**).

## 7. Hand-off
- Code: `packages/mesh/src/periodic.ts`, `mesh2d.ts` (option `periodic`), `spec.ts`, `index.ts`, `stack.ts` (E9 request); `packages/physics/src/wave2d/{bloch,lu,bands,media}.ts` (new), `kernel.ts`, `index.ts`, `spec.ts`.
- Tests: `packages/mesh/test/periodic.test.ts`; `packages/physics/test/bloch-common.ts`, `bloch-bands.test.ts`, `bloch-floquet.test.ts` (verbose numbers with W2D_VERBOSE=1).
- References: `validation/bloch/bloch_refs.py` -> `bloch_reference.json`; `validation/bloch/gen_expected.py` -> `eval/expected/WO-90..WO-93.json`; cases `validation/c/cases_ext/bloch.py` -> `eval/cases/c/WO-90..WO-93.yaml`.
- Sims: `sims/phc-square-rods-bands.yaml`, `sims/phc-triangular-rods-bands.yaml`, `sims/floquet-slab-oblique.yaml`; catalog entries in `catalog-bc.ts`. The acoustics-analog phc sims and entries are unchanged (hidden by the existing rule).
- Behaviour for non-periodic runs: unchanged code paths (driven kernel factor / solve identical; `media` moved verbatim; readiness changes only when every study of an emw-2d physics is eigen or bands). New rejection: scattering condition next to a non-background cell under a plane wave.

## 8. Addendum after the hand-off: per-frequency materials (brief item 6; E2 API relayed by the coordinator)
- 2026-11-18 14:08-14:13 PST: `solveWave2D` (emw-2d, several frequencies) builds the media of each frequency from `ctx.materialsAt(c0 / f, notes)` (prepareRun, DevLog-048 R2) when the context provides it; a single frequency keeps `ctx.materials` (code path unchanged). Solution note per run: "materials: library values evaluated at lambda = c0 / f for each of the N frequencies" (or, without `materialsAt`, that one evaluation is used).
- F (found while testing): with a plain `ref:` to a library material that holds both a low-frequency `eps_r` and an optical `n` (e.g. sio2-thermal-oxide: eps_r 3.9, n 1.447 at 1.3 um), `media` took eps_r, i.e. n = 1.975 at optical wavelengths. D (wave2d precedence, `media.ts`): an eps_r written as an override wins; otherwise a library n resolved at the wavelength (inside its range) wins over a library eps_r, with a Solution note naming the material. No sim is affected (no emw-2d sim uses `ref:` materials); prepare-materials tests unchanged and passing.
- Test `packages/physics/test/wave2d-dispersion.test.ts`: floquet-slab-oblique with a library SiO2 film at 1.3 and 1.55 um: each step of the two-wavelength study equals the single-wavelength run bitwise (Ez_re); without `materialsAt` the fields differ (max 0.67 V/m). wave2d + Bloch + prepare-materials tests 38 / 38 (`logs/E4-wave2d-after-matat-20261118T141215.log`), physics tsc clean.
- R6 (coordinator): the prepare.ts note "resolved once, without a wavelength" no longer holds for emw-2d frequency studies run through wave2d (it does for direct callers without `materialsAt`).

## 9. Audit fixes (chunk 2) (fix lane FX-engine; engine / numerics audit of 2026-11-18 14:39, DevLog-037 s.5)

### 9.1 Plan (written 2026-11-18 14:41 PST, before any code edit; edits start at 14:50 after the e2e run)
Facts (read or reproduced in the scratchpad, repo untouched):
- Repro of item 1 (auditor probe): phc-square-rods-bands with rods `ref: materials/borofloat33` gives f_0 at X = 1.3188e14 Hz (n 1.471 used) vs 1.0618e14 Hz with override eps_r 4.6. The library n of borofloat33 is valid at 587.6 nm only; prepareRun resolves it without a wavelength in eigen / bands studies. Library eps_r 4.6, tan_delta 0.0037.
- `media()` callers: `bands.ts` (eigen, bands: no wavelength), `index.ts` driven path (single frequency: bound at c0 / f by prepareRun; several frequencies: per frequency through `materialsAt`, else one wavelength-free evaluation).
- `EnvelopeLU` computes the envelope size in its constructor; `factor` allocates 4 x 8 B per envelope entry + 2 x 8 B per unknown; `ptr` is Int32 (overflows above 2^31 entries).
- WO-72 measured errors (DevLog-047 s.4): |S21| at 1.60 um 8.7e-4 (level 0) -> 9.3e-5 (level 1), ratio 9.4; 1.55 um |S11| 7.1e-4 -> 2.6e-4. Reference changes between dy 0.01 and 0.005 um in eval/expected/WO-72.json: |S11| up to 3.1e-5, |S21| up to 1.0e-5. The builder citation says 7e-6 for |S21| (wrong) and the note blames first-order corner convergence (the level-1 data do not show it at 1.60 um).

Fixes:
1. `media(ctx, kind, { wavelength })`: the library-n-over-library-eps_r rule only when the caller states a bound wavelength (driven single frequency; several frequencies with `materialsAt`). Otherwise the library eps_r (with library tan_delta, so a lossy library material is rejected by band / eigen studies as before) and a per-material note stating the eps_r used and that n was not used. Test: borofloat33 rods with override tan_delta 0 equal the override eps_r 4.6 run bitwise; without it the band study refuses with the lossy message; floquet-slab with library SiO2 at 1.55 um still uses n (existing dispersion test plus a value check).
2. `EnvelopeLU` constructor: envelope summed in a JS number before filling `ptr`; estimated factor storage 32 B x envelope + 16 B x n; refuse above `ENVELOPE_LU_MAX_BYTES` = 1 GiB (design limit, half the 2 GB RSS rule) with unknowns, estimate and limit in the message; override option threaded through `Wave2DSolver` and `solveWave2D` (`envelopeMaxBytes`) for tests. Test: floquet-slab-oblique with a 1 MiB budget refuses with that message; default budget unchanged results.
3. prepare.ts: drop the note "emw-2d uses eps_r (library) over n" (media notes state what is used, with the run's actual rule); update any test asserting it.
4. WO-72: keep level-0 gates at 2e-3 with the corrected reason (level 0 is pre-asymptotic; measured 8.7e-4 -> 9.3e-5 for |S21| at 1.60 um; level-1 gates stay 5e-4); citation strings corrected to 3.1e-5 / 1.0e-5. eval/expected/WO-72.json has no convergence text (values only), so unchanged unless found otherwise. Catalog note states no tolerance: unchanged. Rebuild into a scratch dir, copy WO-72.yaml only; test_build_matches; WO-72 CLI.
5. bands.ts: per degenerate cluster, complex Gram-Schmidt in the M inner product of the reduced (complex) system over the cluster's real-embedding vectors, keep the first vector as is, take the next vectors whose orthogonal remainder is not negligible; frequencies untouched. Test at a degenerate generic-k point of the empty lattice (embedding path): |<v1, M v2>| / (|v1|_M |v2|_M) small.
6. physics `index.ts` wrapper readiness: an eigen study that solves this physics with `solver: ams` or `auto` while the physics is not `emw` (3D) is refused with a plain message; `rtol` without such a solver on a non-emw eigen run gets a Solution note that it is not used.
7. `wave2d/index.ts` periodic path: perturbed-pivot note names the envelope LU.
Skipped (routed): WO-82 / WO-83 reference independence (s.9.4).

### 9.2 Progress log
- 2026-11-18 14:44 PST: baseline before edits: Bloch + wave2d tests 33 / 33 with verbose numbers (`logs/FX-engine-wave2d-before-20261118T144450.log`).
- 2026-11-18 14:50 PST: edits applied (items 1-7) from a prepared patch; physics `tsc` clean; new test file `packages/physics/test/wave2d-audit-fixes.test.ts` 5 / 5.
- 2026-11-18 14:50-14:51 PST: auditor repro after the fix: borofloat33 rods (library) with tan_delta 0 override give f at X = 1.0618435698305662e14 Hz, bitwise the override eps_r 4.6 value (before: 1.3188e14 Hz with n 1.471); without the override the band study refuses the lossy library medium (tan_delta 0.0037), as eps_r with tan_delta did before. Note text: "emw-2d: 'rod_mat': this study has no wavelength (eigen or bands study, or one material evaluation for several frequencies), so the library eps_r (4.6, tan_delta 0) is used; the library refractive index n (1.471) is not, since it is stated at a wavelength. Give n (or eps_r) as an override to choose the optical value".
- 2026-11-18 14:50-14:51 PST: envelope sizes (auditor probe, floquet-slab-oblique level 0, factor storage 32 B x envelope): w 0.5 um 16 MiB, 2 um 249 MiB, 4 um 1002 MiB (under the 1 GiB limit); a 2 um cell at level 1 (auditor estimate about 2.1 GB; not run here) is over the limit and would be refused before allocation. Message at a 1 MiB test budget: "periodic cell: the envelope LU of the reduced system (2156 unknowns, 42113 envelope entries) needs an estimated factor storage 1.3 MiB, over the limit 1.0 MiB (a design limit of this solver that keeps one run inside 2 GB of memory). Use a coarser mesh or a smaller unit cell".
- 2026-11-18 14:51 PST: class-c builder into a scratch directory: only WO-72.yaml differs (locator and note text); copied; `test_build_matches` 57 / 57 identical.
- 2026-11-18 14:50-14:56 PST: physics check clean (`logs/FX-engine-physics-check-20261118T145053.log`); physics tests 196 / 196 (191 before + 5 new; `logs/FX-engine-physics-test-20261118T145053.log`); every verbose Bloch / wave2d number (68 lines) identical to the baseline log, only timings differ; mesh tests 24 / 24 (`logs/FX-engine-mesh-test-*.log`). No emw-2d sim uses `ref:` materials, so no sim result changes from item 1.
- 2026-11-18 14:54-14:58 PST: harness CLI, one case at a time (`logs/FX-engine-cli-20261118T145423.log`): WO-90 4 pass + 4 info, WO-91 8, WO-92 4, WO-93 4, WO-70 18, WO-71 42, WO-72 18, RF-70 6: all pass (records logs/eval-20261118T145423 / 145503 / 145545 / 145547 / 145647 / 145701 / 145714 / 145748.jsonl).

### 9.3 Results and decisions
| Item | Change | Check |
|---|---|---|
| 1 major | `media(ctx, kind, { wavelength })`: library n over library eps_r only when the run binds a wavelength (one frequency, or `materialsAt` per frequency); otherwise library eps_r with tan_delta and a per-material note naming the values used | new test: borofloat33 rods bitwise equal to override eps_r 4.6; lossy library refused in bands; library SiO2 film at 1.55 um bitwise equal to override n = library n |
| 2 major | `ENVELOPE_LU_MAX_BYTES` = 1 GiB of factor storage (design limit, labelled in code and message); estimate before allocation; option `envelopeMaxBytes` through `solveWave2D` / `Wave2DSolver` / `EnvelopeLU` | new test with a 1 MiB budget (message has unknowns, estimate, limit) |
| 3 minor | prepare.ts: the "eps_r (library) over n" note removed (the module notes what it used); the override-n skip note no longer claims eps_r takes precedence | prepare-materials tests unchanged and passing |
| 4 minor | D: keep level-0 gates at 2e-3 (choice: gated, not informative) with the corrected reason (pre-asymptotic, 8.7e-4 -> 9.3e-5 for |S21| at 1.60 um); level 1 stays 5e-4; locators now say 3.1e-5 (|S11|) and 1.0e-5 (|S21|). eval/expected/WO-72.json holds no convergence text (unchanged); the catalog note states no tolerance (unchanged) | builder: only WO-72.yaml differs; test_build_matches 57 / 57; WO-72 CLI 18 / 18 |
| 5 minor | `clusterVectors`: clusters of multiplicity > 2 in the real embedding give complex M-orthogonal vectors (first vector kept, greedy Gram-Schmidt in M, two passes); isolated pairs unchanged; frequencies untouched | new synthetic test (order that made the old choice return v and j v): overlap < 1e-12; Bloch numbers identical |
| 6 minor | wrapper readiness refuses `solver: ams` / `auto` on an eigen study of a non-emw physics (unless the study also solves an emw physics); `rtol` on such a run adds a Solution note | new test (acoustics refused for ams / auto, direct accepted; em3d cavity with ams ready) |
| 7 minor | periodic runs name the envelope LU in the perturbed-pivot note | code read |

Behaviour changes: emw-2d eigen / bands studies with a `ref:` material holding both eps_r and n now use eps_r (and refuse when its tan_delta is nonzero); multi-frequency emw-2d runs without `materialsAt` likewise use eps_r; Floquet cells above 1 GiB of factor storage are refused; non-emw eigen studies with solver ams / auto are refused. No sim or eval case changes result (no emw-2d sim uses `ref:` materials; no sim sets an eigen solver).

### 9.4 Open items
- WO-82 / WO-83 reference independence (TFLN rib cases checked against the same formulation; the atlas Tidy3D results are unused): skipped by brief, for the owner of the em-modes cases.
- A library material with n only (no eps_r) in an eigen / bands study still uses the n resolved without a wavelength (borofloat33 returns n 1.471 without a wavelength; tabulated entries not checked). A note or refusal there needs a rule for which wavelength-free n is acceptable.
- The 1 GiB envelope limit counts factor storage only; the reduced matrix, refinement vectors and mesh add to the run's memory (a 4 um cell at level 0, 1002 MiB of factor, is just under the limit and was not run).
