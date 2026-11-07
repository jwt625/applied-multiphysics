# DevLog-033: solid modal analysis, axisymmetric elasticity, monolithic piezoelectric and acoustic-structure couplings (lane MT)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | MT (DevLog-029 s.3.2) |
| Owns | `packages/physics/src/elastic/modal.ts`, `elastic/axisym.ts` (new), the eigen / axisym dispatch in `elastic/index.ts` `run` (and the `Model` type + model default in `elasticProblemFromContext`, an axisym guard in `solveElastic`), `packages/physics/src/coupled/**` (new: shared assembly, tensors, piezo, unsymmetric eigen driver, acoustic-structure), `packages/physics/src/couplings/twoway.ts`, `packages/physics/test/mt-*.test.ts`, `packages/physics/gates/mt-{gates,common}.ts`, this file (no `validation/mt/**` was needed: every reference is a closed form or a benchmark target) |
| Parallel | MC (031: driver, couplings/core.ts + index.ts, prepare.ts, registrations.ts, index.ts, spec types, the thermal-input path of `elastic/index.ts`), MO (032), LP (030), MX (035: sims, materials) |
| Read | DevLog-029 s.2.3, 3.1-3.3; CONTRACTS-v0 C4, C5, C11; DevLog-031 s.1; `packages/physics/src/{index,prepare,registrations}.ts`, `elastic/index.ts`, `acoustics/index.ts`, `electrostatics/index.ts`, `common/{eigen,scalar,mesh,lagrange,ctx,solution}.ts`; `packages/spec/src/{registry,schema}.ts` (tensor property forms); `packages/materials/src/properties.ts`; `materials/{pzt-4,linbo3-congruent}.yaml`; eval cases CP-02, CP-06; advanced-packaging-atlas `validation/cases/B/nafems-LE11.yaml` (read only) |
| Status | done (s.4); requests s.5; open items s.6 |

Conventions: "F" = fact read from code or a run; "D" = decision of this lane (reason given); "O" = open item.

## 1. Plan (2026-11-07 08:30 PST)

### 1.1 Facts (F)
- `elastic` (elastic/index.ts): isotropic, 2D plane stress / strain (tri3/tri6) and 3D (tet4/tet10), stationary only; `ElasticProblem.thermal` exists (MC binds it from `ctx.inputs`). Registered dims `2d`, `3d`; `settings.model` enum without axisym (registrations.ts, MC-owned).
- `common/eigen.ts` `shiftInvertEigen`: symmetric pencil, K - sigma M factored by Cholesky (sigma < 0, K PSD) or supernodal LDL^T; Rayleigh-quotient refine and M-normalisation (needs x^T M x > 0, so M may be semidefinite but the pencil must be symmetric).
- `@amp/core/la` has Cholesky and symmetric LDL^T, block Arnoldi (general operators), no sparse LU.
- `RunContext.materials` is scalar per property (`Record<string, number>`); prepare.ts resolves `NEEDS[type]` only (elastic: E, nu, alpha; no rho).
- Spec registry supports tensor property forms (`tensor: {symmetry: [components]}`); the physics registry has scalar `eps_r`, `rho`, `E`, `nu` only; no `C`, no piezo `e`. `@amp/materials` has `C` (cubic only), no 6mm / 3m stiffness, no piezo tensor.
- `materials/pzt-4.yaml`: every value N/A (Boucher 1981 not read). `materials/linbo3-congruent.yaml`: eps^S (Weis-Gaylord), no stiffness, no e, rho N/A. MX (DevLog-035 plan item 2b) is researching open primary sources for both.
- LE11 meridian (atlas case, FeenoX `nafems-le11.geo`): sphere shell r 1.0 .. 1.4 below z = 0.70711, then polygon P4 (0.70711, 0.70711), P5 (1.20830, 0.70711), P7 (1.0, 1.39711), I (1.0, 1.79711), H (0.70711, 1.79711), P6 (0.70711, 1.39711); T = r + z (degC), Tref 0 (assumed in the case), E 210 GPa, nu 0.3, alpha 2.3e-4 /K; target sigma_zz(A = (1, 0)) = -105 MPa (rel 1 %).

### 1.2 Design (D)
- **Generic elastic assembly** (`coupled/assemble.ts`): per-cell constitutive matrix in Voigt form (isotropic via E, nu, or anisotropic 6x6 rotated to the model frame), models `plane-stress`, `plane-strain`, `3d`, `axisym` (strain [e_rr, e_zz, e_phiphi, g_rz], weight r, azimuthal order 0), consistent mass `int rho u . v`. A DOF map (node x component -> global DOF, -1 = fixed) gives the pattern, so constraints, merged (floating) DOFs and several fields on one mesh share one code path. The existing `solveElastic` is not touched (existing sims bit-identical by construction).
- **Solid modal** (`elastic/modal.ts`): `solveElasticModes(problem + rho + nModes + shiftHz)`. K u = omega^2 M u via `shiftInvertEigen` (Cholesky below the spectrum, LDL^T for a positive shift). Free bodies keep their rigid modes (reported f = 0 when |lambda| < 1e-8 of the spectral scale, as acoustics does); `shift` skips them. Outputs: `u` per step (H1P1/H1P2), `steps {kind: eigen, Hz}`, scalars `f_<k>`; normalisation exported as `ELASTIC_MODAL_NORMALIZATION`: int rho u . u dV = 1 (SI numbers, kg m^2; 2D per unit thickness, axisym per radian), arbitrary sign.
- **Axisymmetric elastic** (`elastic/axisym.ts`): stationary solve on the meridional (r, z) mesh, x = r, y = z, with the same loads / constraints / thermal input as `ElasticProblem` (`model: 'axisym'`); nodes on r = 0 get u_r = 0. Stress output names `srr`, `szz`, `srz`, `sphi` (+ `mises`, `s1..s3`). Dispatch in `elastic/index.ts` `run`: eigen study -> modal; model axisym -> axisym; else unchanged `solveElastic`. The model defaults to `axisym` on an axisym mesh.
- **Piezoelectric** (`coupled/piezo.ts`, coupling type `piezoelectric`, elastic -> electrostatics, monolithic): fields u (dim comps) and V on the shared mesh; strain-charge form with stress-charge constants: T = c^E S - e^T E, D = e S + eps^S E. Symmetric block system [[K_uu, K_uV], [K_uV^T, -K_VV]]; eigen with M = [[M_uu, 0], [0, 0]] through `shiftInvertEigen` (LDL^T; infinite eigenvalues of the singular M map to mu = 0 and are never selected). Electrodes from the electrostatics BCs: `ground` (V = 0), `potential` (V fixed; homogeneous in eigen), `terminal` = floating electrode (one shared DOF, net charge 0; open circuit), `zero-charge` natural. Short circuit = both electrodes `ground`; open circuit = one `ground`, one `terminal`. Stationary: applied potentials, floating terminals, elastic loads. Material tensors c^E (Pa), e (C/m^2), eps^S (relative) in the crystal frame with symmetry `hexagonal-6mm` or `trigonal-3m` (or `isotropic` for a non-piezo solid in the piezo group), rotated by ZXZ Euler angles `settings.euler` (Bond transformation). 2D: plane strain in x-y (u_z = 0, E_z = 0), 3D tets. Domains of the elastic physics without e are plain anisotropic / isotropic solids; electrostatic-only domains (air gap) carry V only.
- **Acoustic-structure** (`coupled/fsi.ts`, type `acoustic-structure`, elastic -> acoustics, monolithic eigen): u-p formulation, K = [[K_s, -C], [0, K_f]], M = [[M_s, 0], [C^T, M_f]] with the acoustics module's scaling (K_f = int (1/rho) grad p . grad q, M_f = int p q / (rho c^2)) and C = int_Gamma N_u n_f N_p dS (n_f = fluid outward normal). The pencil is unsymmetric; shift-invert needs a solve with K - sigma M, which becomes symmetric after scaling the fluid rows by -1/sigma and flipping the sign of p, so it is factored by LDL^T (sigma != 0). Eigenvalues by block Arnoldi on the unsymmetric operator (own small driver, `coupled/eigen-ns.ts`, no change to common/eigen.ts); residual reported per pair. Interface faces found as faces shared by a solid cell and a fluid cell. Fluid walls not on the interface: sound-hard (natural) or p = 0.
- **Spec level**: couplings registered in `TWOWAY_REGISTRATIONS` (`piezoelectric`: settings `euler` optional; `acoustic-structure`: no settings). Material tensors: spec override tensor objects `C` (Pa), `e_piezo` (C/m^2), `eps_rS` (1) read by the coupling directly from `spec.materials[].override` (prepareRun resolves scalars only). The property registrations are requested from the materials owner (s.5), not added by MT.
- **Normalisation strings** for piezo / FSI are exported from MT modules (`PIEZO_NORMALIZATION`, `FSI_NORMALIZATION`).

### 1.3 Gates (all against closed forms derived or cited in s.4; test inputs for synthetic cases are labelled, not material data)
1. Elastic modal: 2D plane-stress cantilever, slender (L/h = 50), f1..f3 vs Euler-Bernoulli (root of 1 + cos x cosh x = 0); 3D tet10 free-free bar axial modes f_n = n c / (2 L), c = sqrt(E / rho) (slender, Rayleigh-Love correction stated); 3D cantilever f1 vs Euler-Bernoulli.
2. Axisym elastic: Lame thick cylinder in plane strain (axisym slice with rollers top / bottom) vs closed form; axisym modal vs 3D modal of the same solid cylinder (n = 0 modes found in the 3D spectrum); LE11 sigma_zz(A) with the thermal input set directly (MC's coupling path rechecked once it lands).
3. Piezo: 1D thickness mode of a laterally constrained plate (3D tet10 column and 2D plane strain), open circuit f_n = n v^D / (2 t), short circuit tan X = X / k_t^2 (derivation s.4); rotation invariance (crystal + geometry rotated together); CP-06 PZT-4 cube when sourced constants exist (else reported N/A).
4. Acoustic-structure: rho_air -> small reproduces the separate elastic and acoustics eigenvalues; coupled 1D layered column (elastic layer on a rigid base under a fluid layer with a rigid lid) vs the transmission-line equation rho_s c_s tan(omega b / c_f) + rho_f c_f tan(omega a / c_s) = 0 (derivation s.4). A primary-source coupled benchmark: searched, report in s.4.
5. Regression: every existing elastic test / sim unchanged; `pnpm -C packages/physics check` and `test`.

## 2. TODO
- [x] coupled/assemble.ts (DOF map, pattern, elastic blocks, mass, axisym)
- [x] elastic/modal.ts + axisym.ts + dispatch in elastic/index.ts
- [x] tests: cantilever, bar, axisym Lame, axisym vs 3D, LE11
- [x] coupled/piezo.ts (tensors, rotation, electrodes, eigen + stationary)
- [x] coupled/eigen-ns.ts + coupled/fsi.ts
- [x] couplings/twoway.ts impls + registrations (against MC's core.ts)
- [x] gates script, performance table (dof, ms)
- [x] CONTRACTS changelog entry, requests to MC / MX

## 3. Progress log
- 2026-11-07 08:30 PST: plan written.
- 2026-11-07 08:51 PST: `coupled/assemble.ts`, `coupled/tensors.ts`, `coupled/piezo.ts`, `coupled/eigen-ns.ts`, `coupled/fsi.ts`, `elastic/modal.ts`, `elastic/axisym.ts`, dispatch in `elastic/index.ts` (Model + `axisym`, model default on axisym meshes, guard in `solveElastic`, `run` dispatch, dims + `2d-axisym`). Tests `test/mt-{elastic-modal,piezo,fsi}.test.ts` pass (7 + 8 + 3). Two numerical findings: (1) the piezo u-V system spans ~20 orders of magnitude in SI (K_uu ~ 1e8, K_VV ~ 1e-12): the supernodal LDL^T perturbed the small pivots silently (stationary relative residual 1.0); fixed by symmetric Jacobi scaling before factorisation, and the stationary solve now throws when the refined residual exceeds 1e-8. (2) The unsymmetric u-p Arnoldi on unscaled (u, p) vectors returned wrong (negative / complex) values for strong coupling while the dense eigenvalues of the same pencil scaled by diag(M)^-1/2 were exact (433.22 Hz vs 433.2198 Hz analytic): the driver now runs on the diag(M)^-1/2-scaled pencil and uses the Arnoldi Ritz values (repeated inverse iteration drifted to the mode nearest sigma).
- 2026-11-07 08:56 PST: `couplings/twoway.ts`: `piezoelectric` and `acoustic-structure` impls (with `readiness(spec, node)`), registrations; spec-level tests through MC's `runStudy` (`test/mt-spec.test.ts`). Class a eval after the MT changes: `logs/eval-20261107T085550.jsonl` vs MC's pre-change baseline `logs/eval-20261107T082912.jsonl`: 136 / 136 targets identical (stdout `logs/MT-eval-a-20261107T085550.log`). MC's own class-a runs at 08:41 and 08:50 (after the `elastic/index.ts` dispatch edit of about 08:36) were also identical.
- 2026-11-07 09:00 PST: lane MX's `sims/pzt4-cube.yaml` (VM175 listing values) read: it used `eps_r` (uniaxial) after MT's first registration; a brief rename to `eps_rS` was reverted, the property name is `eps_r` (as `@amp/materials` and `materials/linbo3-congruent.yaml`, whose eps_r tensor is the clamped one). Added symmetry `tetragonal-4mm` (independent C66) for data sets that list C66 apart from (C11 - C12) / 2 (VM175 does). Flattened `<prop>.<component>` keys are matched to the symmetry with the most components first.
- 2026-11-07 09:03 PST: 3D tet10 acoustic-structure column test; physics package `node --test` 87 / 87 (`logs/MT-physics-test-20261107T090323.log`), `tsc` clean.
- 2026-11-07 09:07 PST: full gates `logs/MT-gates-20261107T090736.jsonl` (s.4); CP-06 with MX's `sims/pzt4-cube.yaml` within the 3 % tolerance on all four targets; electrically active modes identified by the floating-electrode potential. Sim drafts for LN FBAR and plate-in-air checked against the schema (s.5 X4).
- 2026-11-07 09:10 PST: MC's `prepareRun` now flattens tensor overrides; end-to-end piezo test through `prepareRun` + `runStudy` added (`mt-spec` 7 / 7). Rayleigh-Love estimate in s.4.1 corrected (factor 1/2, not 1/4; now matches the FE value).
- 2026-11-07 09:11 PST: CONTRACTS-v0 changelog entry (MT); final `tsc` clean and physics `node --test` 97 / 97 (`logs/MT-physics-test-20261107T091109.log`). Lane done; requests s.5, open items s.6.
- 2026-11-07 09:13 PST: lane MX's `sims/ln-fbar-2d.yaml` (LN trigonal-3m overrides, gapped electrodes, air) and `sims/membrane-air.yaml` run end to end through `prepareRun` + `studyReadiness` (ready) + `runStudy`: 230570 dof, 9.4 s (20 modes near 6.6 GHz) and 111671 dof, 1.8 s (modes 0, 0, 66, 1952, 2688 Hz; two f = 0 u-p pairs, one per closed air region, if the geometry has two). Run check only: these frequencies are not compared with a reference by MT.
- 2026-11-07 09:14 PST: coordinator follow-ups F1-F3 (orientation convention, NaN rendering in the web, CP-06 offset); plan: F1 accept `settings.crystals` in the piezo coupling (exactly one of crystals / euler), F2 vite dev on 47471 + headless screenshots, F3 bounded sensitivity run, no fitting.
- 2026-11-07 09:17 PST: F1 done: `couplings/twoway.ts` `rotationsOf`: `settings.crystals` (schema `crystalsSchema` of `couplings/photonic.ts`; per material A from `modes/crystal.mjs` `labFromCrystal`, merged with the electrostatics physics' and its couplings' crystals through `electrostatics/aniso.ts` `electrostaticsCrystals`, as the anisotropic electrostatics does) or `settings.euler` (advanced, every material); both = validation error (registration `check`) and run error. Materials without a crystals entry keep crystal frame = model frame. Gate on MX's `sims/ln-fbar-2d.yaml` (scratch copy, its `euler: [pi/2, 0, 0]` replaced by `crystals: [{material: LN, cut: x, propagation: z}]`): 20 modes, max rel difference 1.6e-14, 230570 dof, 9.5 s each (`logs/MT-gates-20261107T091659.jsonl`). Test `mt-spec` "settings.crystals ... and settings.euler ... identical" (3m test tensor).
- 2026-11-07 09:19 PST: F2 done (vite dev 127.0.0.1:47471, `logs/MT-dev-20261107T091719.log`; stopped 09:19, port free). Workbench `?sim=membrane-air` and `?sim=ln-fbar-2d` solved in headless Chromium (swiftshader), screenshots in the session scratchpad (not tracked), looked at: (a) `ac.p` of membrane-air (NaN on the solid cells, e.g. the steel mass): those cells are blank (background), the colour range is finite (+-2.82e7 at 66.4 Hz; 2.50e9 for the f = 0 mode) and ignores them; (b) `es.V` of ln-fbar-2d (no NaN: the dielectric covers LN + air; electrode holes blank) renders with a balanced map; (c) the evaluation `uz_centre` (point) shows 4.003 m on the f = 0 mode (normalisation of that mode by the solid term only, s.1.2) and a value on the other modes; (d) code read: `@amp/post` evaluations skip NaN in max / min and count `nNaN`; `results/adapter.ts` reports a point / global item without a finite value as an error ("no finite value ... NaN"), never as a number. No gfx change needed; nothing in apps/web touched (a temporary screenshot driver in `apps/web/scripts/` was deleted). Seen, not MT's: `solid.u` is 0 (not blank) on the air cells (u = 0 off the solid, the `solveElastic` convention), and the dev server logged 404s for `/_app/immutable/chunks/*` (build-chunk requests in dev, probably the service worker; not investigated).
- 2026-11-07 09:20 PST: F3 done (bounded, `logs/MT-gates-20261107T092027.jsonl`, n = 4, MX's current 4mm file): (1) the open / short ratios match the measurement: f1 1.2265 vs 1.2258 (+0.06 %), f2 1.0613 vs 1.0614 (-0.01 %). The open-circuit stiffening depends on e and eps^S (d ln f1_open / d ln eps33 = -0.143, short -0.019; d ln f1_open / d ln e33 = +0.218, short +0.030), so a c^E / c^D or eps^S / eps^T mix-up would break these ratios; the electrical constants and their convention are consistent with the data. (2) C66 is not the cause (6mm vs 4mm <= 0.03 %, s.4.3). (3) f1 in both conditions is dominated by C13 (d ln f / d ln C13 = -0.97 short, -0.62 open), C33 (+0.79 / +0.45), C11 (+0.43 / +0.39), C12 (+0.21 / +0.12); C44, e15, eps11 < 0.02. The common -2.2 % on f1 with f2 at +0.2 % points to the mechanical constants (C13 / C33 / C11) of the listed set or to the measurement; not resolved, no fitting (O1).
- 2026-11-07 09:28 PST: coordinator follow-ups E1 (point constraints), E2 (hex8 box meshes for elastic), then the three blocked sims (MC's run `logs/MC-mp-sims-20261107T092141.json`: bimetal-strip and chip-warpage-2d stop at `pnt:` selections, hot-arm-actuator at `refNodes: hex8`). Plan: E1 node sets from `Mesh.pointNode` (the 2D mesher already maps geometry vertices `pnt:<feature>.p<k>` / `.v<k>` to nodes; no request to MG needed); E2 option chosen: split the axis-aligned hex8 grid into conforming Kuhn tets + P2 (tet10) for studies with elastic. Reason: trilinear hex8 locks in bending (hot-arm arms, warpage strips) and a locking-free hex (B-bar / incompatible modes) is more code and more risk than reusing the validated tet10 path; the conversion is about 70 lines and exact for boxes.
- 2026-11-07 09:35 PST: E1 done: `coupled/assemble.ts` `bcNodes(mesh, select)` (`pnt:` through `Mesh.pointNode`, other ids through boundary facets; a point selection on a mesh without point entities is an error naming it) used by `fixed` / `displacement` in `solveElastic` (one-line swap of the node source; boundary selections give the same node sets) and in the MT solvers; roller on a point is an error (no normal). New spec BC `displacement` (elastic; `bnd` / `pnt`; settings `ux`, `uy`, `uz`, any non-empty subset; registered from `couplings/twoway.ts` so it reaches `L4_REGISTRATIONS`; MC may move it). E2 done: `elastic/hex2tet.ts` `hexToTet10` (canonical corner order by coordinates, 6 Kuhn tets per hex around the min-max diagonal, quad facets split along the same diagonal, `@amp/mesh` `toP2`); `solveElastic` now throws a clear error on hex8 instead of `refNodes: hex8`. Tests `test/mt-hex2tet.test.ts` (two-box union: every interior face in exactly 2 tets, exterior faces = facets, volume exact; converted hex8 cantilever L/a = 20 within 2 % of Euler-Bernoulli). The call site is `prepare.ts` (MC-owned): request s.5 R7. Class a after E1 / E2: `logs/eval-20261107T093338.jsonl` vs the coordinator's `logs/eval-20261107T092519.jsonl`: 136 / 136 identical. Physics tests 104 / 104 (`logs/MT-physics-test-20261107T093450.log`).
- 2026-11-07 09:33 PST: the three sims through validate + `prepareRun` + `runStudy` (hot-arm with `hexToTet10` applied to the prepared mesh, as R7 would; `logs/MT-gates-20261107T093316.jsonl`):
  - bimetal-strip (9664 tri6, 58490 dof, 0.66 s): kappa 0.03934040528 1/m vs Timoshenko 0.03934040547 (rel -5.1e-9; dw centre to quarter 4.4257956e-6 m vs 4.4257956e-6 m).
  - chip-warpage-2d (39568 tri6, 239026 dof, 2.3 s): bow over the interposer half-length 162.751 um vs the laminate closed form 162.833 um (rel -5.1e-4; kappa 1.35484 vs 1.35553 1/m); bow to the substrate edge 280.6 um vs 306.1 um (-8.3 %), expected: the closed form assumes every layer full length (validation/mp/references.json note), the substrate overhang carries no interposer.
  - hot-arm-actuator (17256 hex8 -> 103536 tet10, 840085 dof, 86 s): tip (2582, -330, 20) um u_y -7.717 um, |u| 7.717 um; T_max 630.8 K, P 0.148 W. CP-04 target 27 um is informative only (the sim uses constant 300 K properties, no NLGEOM, no radiation, as its assumptions say). Mesh check on scratch copies (`logs/MT-hotarm-coarse-*.log`): hmax D1/2 -> 13056 tet10, 126125 dof, 8.4 s, u_y -7.719 um; D1/1 -> 3522 tet10, 36175 dof, 2.4 s, u_y -7.719 um: P2 tets need far fewer cells than the hex grid.
- 2026-11-07 09:38 PST: membrane-air zero modes (coordinator; MX DevLog-035 s.10 item 2): the two f = 0 modes are the u-p form's null space, one per closed fluid region, not spurious solver output and not vibration modes. At lambda = 0 the pencil only requires K_f p = 0 (p uniform in each connected fluid region) and K_s u = C p (the static deformation under those pressures); membrane-air has two closed regions (air below and above the membrane, which spans the tube radius), hence two (checked: in both zero modes p is uniform to 5 digits in each cavity; MT run). For lambda != 0 the fluid rows tested with w = 1 give int p / (rho c^2) = -int u . n_f, i.e. the cavity compressibility, so the non-zero modes are exact. Gate: new test fluid | free elastic layer | fluid with rigid ends: two f = 0 modes, then the first three roots of the 4 x 4 interface determinant (derivation in the test) within 1e-4. `coupled/fsi.ts` now counts the closed regions (`detail.closedRegions`) and adds a Solution note. The fundamental of membrane-air is index 2 (`solid.f_2`, 66.385 Hz): right. Not removed (a deflation would change the indices MX already uses).
- 2026-11-07 09:39 PST: CONTRACTS-v0 MT entry extended (09:38 additions); `tsc` clean for MT files (one error in another lane's `test/mom-common.ts`), physics tests 105 / 105 (`logs/MT-physics-test-20261107T093824.log`).
- 2026-11-07 10:35 PST: gate fix (coordinator; `logs/FE-mt-gates-stdout-20261107T102752.log`): `sims/pzt4-cube.yaml` now takes PZT-4 from `ref: materials/pzt-4`, so `cp06` / `cp06sens` (which edited `override.C` and set rho 7500 by hand) failed. `gates/mt-gates.ts` `pztCube()` now materializes a `ref:` material from the `@amp/materials` default library (rho, C, e_piezo, eps_r with the library's symmetry and SI values) into overrides of a scratch copy (dropping the copy's `materials.pzt4.ref` provenance key) and takes rho from it; the 6mm variant sets `hexagonal-6mm` and drops C66, the 4mm variant keeps the listed C66; active-mode frequencies are now logged to 0.1 Hz. `--only=cp06,cp06sens` (`logs/MT-gates-20261107T103521.jsonl`, `logs/MT-gates-20261107T103145.jsonl`): 4mm at the sim mesh (n = 8, 36449 dof) short 65101.5 / 88146.3 Hz, open 79810.0 / 93584.3 Hz, equal to the earlier override-based run; 6mm n = 4 / 6 / 8 and the sensitivity table unchanged from 09:07 / 09:20.

## 4. Gate results and derivations

Records: `logs/MT-gates-20261107T090736.jsonl` from `packages/physics/gates/mt-gates.ts` (stdout `logs/MT-gates-stdout-20261107T090530.log`); unit tests `test/mt-{elastic-modal,piezo,fsi,spec}.test.ts`. Node 23.7, `nice -n 10`, `--max-old-space-size=1536`, single thread. "Test numbers" are arbitrary coefficients (E 1e11 Pa, nu 0.25, rho 5000 kg/m^3 for the modal gates), not material data.

### 4.1 Solid modal

| Gate | Result | Reference (source) |
|---|---|---|
| 2D plane stress cantilever, L/h = 50, tri6 100 x 2, 2000 dof | f1 14.448861 Hz (rel +1.9e-5), f2 rel -1.75e-3, f3 rel -4.59e-3 | Euler-Bernoulli clamped-free: omega_n = x_n^2 sqrt(E I / (rho A L^4)), x_n roots of 1 + cos x cosh x = 0 (from w'''' = beta^4 w, w(0) = w'(0) = 0, w''(L) = w'''(L) = 0; derivation; roots by bisection, 1.8751 / 4.6941 / 7.8548). The continuum is below EB by shear and rotary inertia, growing with (x_n h / L)^2 |
| 3D tet10 cantilever, L/a = 20, 40 x 2 x 2, 6000 dof | degenerate pair f 36.1390 / 36.1437 Hz vs 36.1215 Hz (rel +4.9e-4 / +6.2e-4) | as above |
| 3D tet10 free-free bar, axial mode, shift-invert at c / (2 L), 6075 dof | 2235.780 Hz vs 2236.068 Hz (rel -1.29e-4), u_x share 0.9996 | rod: f_n = n c / (2 L), c = sqrt(E / rho) (derivation); Rayleigh-Love lateral inertia: omega^2 = omega_0^2 (1 - nu^2 k^2 r_p^2), k = pi / L, r_p^2 = a^2 / 6 (square), i.e. rel -nu^2 pi^2 a^2 / (12 L^2) = -1.29e-4 here (estimate, matches the FE value) |
| axisym vs 3D, free solid cylinder R 0.1, H 0.3 | axisym n = 0 f_1 7293.388 Hz vs nearest 3D 7293.429 Hz (rel 5.6e-6); f_2 12612.906 vs 12614.223 Hz (rel 1.0e-4) | consistency (3D tet10 meshCylinder, side nodes on the exact cylinder) |
| axisym static, Lame thick cylinder (plane strain, rollers on z faces), p 1e8 Pa | u_r(a) rel -3.2e-6; sigma_phi(a) within 2e-3; sigma_zz = 2 nu A within 2e-2 (nodal average at the corner) | Lame: u_r = ((1 + nu) / E) ((1 - 2 nu) A r + B / r), A = p a^2 / (b^2 - a^2), B = p a^2 b^2 / (b^2 - a^2) (derivation) |
| axisym static, free uniform heating | u_r = alpha dT r (max err < 1e-12 m), mises < 1e-3 E alpha dT | exact |
| spec: elastic eigen study through `elasticModule.run` | dispatch to the modal solver, `steps.kind = eigen`, normalization set; f_0 within 1 % of EB (h / L = 0.05) | as above |

### 4.2 Axisymmetric elasticity, NAFEMS LE11 (CP-02)

| Run | sigma_zz(A) | rel to -105 MPa | dof | ms |
|---|---|---|---|---|
| direct thermal input T = r + z, hmax 0.1 / 0.05 / 0.025 m | -105.542 / -105.714 / -105.328 MPa | +0.52 % / +0.68 % / +0.31 % | 1522 / 5728 / 22830 | 57 / 111 / 363 (coupled through runStudy incl. heat: 115 / 138 / 436) |
| heat -> thermal-expansion (MC) -> axisym, through `runStudy` (MT spec `gates/mt-common.ts` le11Spec), same meshes | identical to the direct runs to 1e-10 MPa (the heat solve reproduces T = r + z with Q = -k / r, max err < 1e-4 K) | as left | as left | |
| lane MX's `sims/nafems-le11.yaml` through `runStudy` (requested registry, s.5 R1) | -105.936 MPa | +0.89 % | 9261 | 162 |

Target -105 MPa, rel 1 % (CP-02: NAFEMS LE11 via Altair OS-V 0070). Other solvers on the same benchmark (from the atlas case file, not rerun): FeenoX -105.04 MPa, atlas scikit-fem Q2s finest -105.54 MPa. The nodal-averaged stress at the corner A converges non-monotonically (-105.54, -105.71, -105.33); all within the 1 % band.

### 4.3 Piezoelectric

Derivation (1D thickness mode, laterally constrained plate, thickness t, z = poling, free faces): with D uniform (div D = 0, no free charge) the stress-charge form gives T = c^D S - h D, E = -h S + D / eps^S (c^D = c^E_33 + e_33^2 / eps^S_33, h = e_33 / eps^S_33). rho u_tt = T_z with D uniform: wave speed v^D = sqrt(c^D / rho). Open circuit (floating electrode, net charge 0): D = 0, T(+-t/2) = 0, f_n = n v^D / (2 t). Short circuit (int E dz = 0): for u = A sin(k z), T(t/2) = 0 and the voltage condition give tan X = X / k_t^2, X = omega t / (2 v^D), k_t^2 = e_33^2 / (eps^S_33 c^D); the even modes (no net voltage) stay at n v^D / (2 t). Static: clamped C = eps^S A / t; free (T = 0) C = eps^S A / (t (1 - k_t^2)).

| Gate (test numbers, 6mm) | Result | Reference |
|---|---|---|
| 3D tet10 column 1 x 1 x 16, open circuit, thickness modes 1-3 | rel < 1e-4 (mode 3: +4.8e-5, P2 dispersion with 16 elements) | open-circuit closed form above |
| 3D tet10 column, short circuit | rel < 1e-4 | tan X = X / k_t^2 |
| 3D rotated: column along x, crystal c axis along x (Euler ZXZ 90, 90, 0) | same frequencies, rel < 1e-4 | rotation invariance |
| 2D plane strain, c axis along model y (Euler 0, -90, 0), open / short | rel < 1e-4 (mode 3 +6.4e-5) | closed forms above |
| stationary, laterally constrained plate | clamped Q = eps^S A V / t (rel < 1e-10); free Q = eps^S A V / (t (1 - k_t^2)) (rel < 1e-10); Q_ground = -Q_top | static closed forms |
| tensors | isotropic C invariant under any rotation; 6mm C, e invariant about z; 3m C, e invariant under the 3-fold rotation and the x -> -x mirror | crystal symmetry |
| spec: 2D column through `runStudy`, `settings.euler` (0, -90, 0) deg, tensor overrides `C`, `e_piezo`, `eps_r` | open-circuit modes 1-3 rel < 1e-3 (unstructured tri6); fields tagged `solid` / `es` | as above |

CP-06 (PZT-4 cube 20 mm, quarter model, lane MX's `sims/pzt4-cube.yaml` with the VM175-listing constants; measured targets Boucher et al. 1981 Table 1 via Ansys VM175; case tolerance 3 %, proposed in the case). Breathing modes identified as the electrically active ones (open circuit: floating-electrode potential |V_top| > 1 % of the largest; short circuit: modes absent from the open-circuit spectrum); the other modes carry no net electrode charge and are identical in both spectra.

| Mesh (tet10 Kuhn, n x n x 2n) | short f1 / f2 (Hz) | open f1 / f2 (Hz) | rel to 66560 / 88010 / 81590 / 93410 | dof | ms per study |
|---|---|---|---|---|---|
| 6mm, n = 4 | 65106 / 88283 | 79855 / 93696 | -2.19 % / +0.31 % / -2.13 % / +0.31 % | 5041 | 1442 |
| 6mm, n = 6 | 65102 / 88188 | 79820 / 93628 | -2.19 % / +0.20 % / -2.17 % / +0.23 % | 15913 | 5391 |
| 6mm, n = 8 | 65102 / 88169 | 79813 / 93614 | -2.19 % / +0.18 % / -2.18 % / +0.22 % | 36449 | 15316 |
| 4mm (C66 = 3.0e10 as listed), n = 8 | 65101 / 88146 | 79810 / 93584 | -2.19 % / +0.16 % / -2.18 % / +0.19 % | 36449 | 26403 (machine shared with other lanes; same matrix size as the 6mm run) |

All four within the 3 % tolerance on every mesh. Mode indices (shift 50 kHz, nModes 10, the f = 0 rigid z translation at index 0): short f1, f2 = `solid.f_2`, `solid.f_7`; open f1, f2 = `solid.f_4`, `solid.f_8` (the same on n = 4, 6, 8). The f1 offset of about -2.2 % in both conditions is above the mesh error (f1 changes by 4 Hz from n = 4 to 8); its cause (constant set, or the measured target) is not determined here (O).

### 4.4 Acoustic-structure

Derivation (1D layered column: elastic layer 0 < y < a on a rigid base, fluid a < y < a + b, rigid lid; plane waves, lateral motion constrained): u = A sin(k_s y), p = B cos(k_f (y - a - b)); traction continuity M_s u'(a) = -p(a) and (1 / rho_f) dp/dy = omega^2 u(a) give rho_s c_s tan(omega b / c_f) + rho_f c_f tan(omega a / c_s) = 0, c_s = sqrt(M_s / rho_s), M_s = lambda + 2 mu (constrained modulus). Light fluid: roots -> omega b / c_f = n pi (rigid-walled cavity) and omega a / c_s = (n + 1/2) pi (fixed-free layer).

| Gate | Result | Reference |
|---|---|---|
| decoupled limit, 2D plane strain, rho_f = 1e-9 rho_s | 8 lowest coupled frequencies = union of separate elastic and acoustics spectra, rel < 1e-6 | `solveElasticModes` + `solveAcousticModes` |
| decoupled limit, axisym | 6 lowest, rel < 1e-6; wet measure int r dr = 0.125 exact | as above |
| 1D layered column, 2D tri6 (1 x 60), test numbers E 1 GPa, nu 0.25, rho 1000; c_f 1500 m/s, rho_f 1000 | modes 1-4 rel < 1e-5 (433.22 Hz first); solid energy share 0.01-0.99 (genuinely coupled) | transmission-line equation above |
| same, 3D tet10 (1 x 1 x 30) | modes 1-3 rel < 1e-4; wet area = w^2 exact | as above |
| same, spec through `runStudy` (two rect features, unstructured tri6) | modes 1-4 rel < 1e-4; fields `p` tagged `air` | as above |

The u-p form of a closed cavity has an f = 0 pair (uniform pressure with the static deformation it causes); it is reported as f_0 = 0. A coupled benchmark from a primary source was not searched for in this lane's time; the 1D derivation above is the coupled reference (O).

### 4.5 Performance (3D cases, Node, wall time per study including assembly, factorisation and Arnoldi)

| Case | dof | ms |
|---|---|---|
| 3D tet10 cantilever, 2 modes, sigma < 0 (Cholesky) | 6000 | 604 |
| 3D tet10 free-free bar, 4 modes at a shift (LDL^T) | 6075 | 633 |
| 3D tet10 cylinder, 4 modes at a shift (LDL^T, nnz(L) 4.1e7) | 41175 | 12693 / 11789 (two shifts) |
| CP-06 piezo cube, 10 modes at 50 kHz (LDL^T, Jacobi-scaled), n = 4 / 6 / 8 | 5041 / 15913 / 36449 | 1442 / 5391 / 15316 |
| 3D tet10 acoustic-structure column (1 x 1 x 30), 4 modes | 589 | 142 |

Element assembly uses a binary search per entry (as `solveElastic`); it is about a quarter of the 41k-dof cylinder time (3.4 s of 13.5 s in a probe run).

## 5. Requests to other lanes

### To MC (DevLog-031; files MC owns)

- R1 (status 09:13 PST: registration landed by MC; `RESULT_NAMES.elastic` still without the axisym / eigen names) `registrations.ts`, elastic: axisym and eigen (needed by LE11 / CP-02 and every axisym elastic sim; MX's `sims/nafems-le11.yaml` fails validation today with `physics.1.settings.model: Invalid option`). Replace the elastic entry with:
  ```ts
  { kind: 'physics', type: 'elastic', ...own, dims: ['2d', '2d-axisym', '3d'], description: 'Linear elasticity (small strain), P2 by default; stationary and eigen (solid modes); axisym = torsion-free (r, z), azimuthal order 0',
    settings: z.strictObject({ model: z.enum(['plane-stress', 'plane-strain', '3d', 'axisym']), thickness: quantity('m', { gt: 0 }).optional() }) },
  ```
  and in `RESULT_NAMES.elastic`: fields add `'srr', 'sphi', 'srz'` (axisym; `szz` is the axial stress there), scalars add `'f_<k>'` (eigen).
- R2 (status 09:13 PST: landed by MC) `registrations.ts`, electrostatics: `dims: ['2d', '2d-axisym', '3d']` (3D piezo: CP-06 / `sims/pzt4-cube.yaml` fails validation today). Note for whoever owns `electrostatics/index.ts`: a standalone 3D electrostatics run assembles correctly (`assembleCells` on tets) but labels capacitances `F/m`; the unit should be `axi || m.dim === 3 ? 'F' : 'F/m'`.
- R3 (status 09:13 PST: MC skips the module readiness inside monolithic groups; the call of the coupling's own `readiness` is still open) `driver.ts` `studyReadiness` and `couplings/core.ts` `CouplingImpl`: physics inside a monolithic group must not get their single-module readiness (today `pzt4-cube` std_sc reports "solid: materials.pzt4 has no E / nu" and "es_sc: no terminal or potential condition", both wrong for a piezo run). Add to `CouplingImpl` `readiness?(spec: Spec, node: CouplingNode): string[]`, and in `studyReadiness`:
  ```ts
  const grouped = new Set(plan.groups.flatMap((g) => (g.coupling ? g.ids : [])));
  for (const pid of plan.physics) { if (grouped.has(pid)) continue; /* module readiness as today */ }
  for (const g of plan.groups) if (g.coupling) reasons.push(...(couplingImpl(g.coupling.type, impls)?.readiness?.(spec, g.coupling) ?? []));
  ```
  MT's two impls already carry `readiness` (they also call it at the start of `run`).
- R4 `prepare.ts` `resolveMaterials`: (a) tensor overrides and (c) library tensors flattened to `<prop>.<component>`: done by MC (read 2026-11-07 09:10 PST; a 2D piezo spec now runs end to end through `prepareRun` + `runStudy`, test `mt-spec` "end to end through prepareRun"). Remaining: (b) `NEEDS.elastic` add `'rho'` (elastic eigen and acoustic-structure need it for `ref:` materials; overrides already resolve).
- R5 `index.ts`: no NORMALIZATION entry for `elastic` (stationary elastic has none); the modal and coupled solvers set `Solution.normalization` themselves and `wrap` must keep not overwriting it. Exports wanted: `export { solveElasticModes, ELASTIC_MODAL_NORMALIZATION } from './elastic/modal.ts'; export { solveElasticAxisym } from './elastic/axisym.ts'; export { solvePiezo, PIEZO_NORMALIZATION } from './coupled/piezo.ts'; export { solveAcousticStructure, FSI_NORMALIZATION } from './coupled/fsi.ts';`.
  Normalisation strings (verbatim, from the modules): ELASTIC_MODAL_NORMALIZATION 'u per mode is M-orthonormal: int rho u . u dV = 1 (SI numbers, kg m^2; 2D per unit thickness, axisym per radian); arbitrary sign'; PIEZO_NORMALIZATION 'u per mode is M-orthonormal: int rho u . u dV = 1 (SI numbers, kg m^2; 2D per unit thickness); V scaled with u; arbitrary sign'; FSI_NORMALIZATION 'per mode: int rho_s u . u dV + int p^2 / (rho_f c^2 omega^2) dV = 1 (SI numbers, kg m^2; 2D per unit thickness, axisym per radian; the fluid term is dropped for omega = 0); arbitrary sign'.
- R7 `prepare.ts` `baseMesh` (E2): for a 3D box-union hex8 mesh in a spec with an elastic physics, split it into tet10 (no other change for other specs):
  ```ts
  import { hexToTet10 } from './elastic/hex2tet.ts';
  // in baseMesh, at the generic path:
  const m0 = meshFromSpec(raw, { order });
  const toTets = G.dim === 3 && m0.cells.type === 'hex8' && (spec.physics ?? []).some((p) => p.type === 'elastic');
  const m = toTets ? hexToTet10(m0) : m0;
  if (toTets) notes.push('mesh: hex8 box grid split into tet10 for elasticity (elastic/hex2tet.ts; trilinear hexes lock in bending)');
  ```
  (nested refinement stays unavailable for that path, as today for hex8; `refineUniform` on the tet10 mesh would be possible later.)
- R6 (info) `elastic/index.ts`: MT's edits are the imports, `Model` + `'axisym'`, the model default / check in `elasticProblemFromContext` (before your thermal block, untouched), a guard line at the top of `solveElastic`, `dims`, and `run`. The thermal input reaches the axisym path through `ElasticProblem.thermal` (verified: LE11 coupled = direct to 1e-10 MPa).

### To MX (DevLog-035; sims and materials)

- X5 (E1 / E2 sims, 2026-11-07 09:38 PST): bimetal-strip and chip-warpage-2d need no change (they run; numbers in the progress log 09:33). hot-arm-actuator runs once MC applies R7 (tet10); its `mesh.size.hmax: "D1/4"` gives 840085 dof and 86 s in Node: use `"D1/2"` (126125 dof, 8.4 s) or `"D1"` (36175 dof, 2.4 s); the tip u_y is -7.719 um on both, -7.717 um on D1/4. Point constraints: `fixed` on `pnt:` works; for a single component use the new BC `displacement` (`settings: {uy: 0 m}`, selections `bnd:` or `pnt:`). membrane-air: indices right (two f = 0 modes = two closed cavities; fundamental `solid.f_2`).

- X1 `sims/pzt4-cube.yaml`: runs with R2 (+ R3 for the web readiness); results s.4.3. Change the evaluation items to the electrically active modes (shift 50 kHz, nModes 10; index 0 is the f = 0 rigid z translation, absent from VM175's 50-150 kHz list): short f1 = `solid.f_2` (65102 Hz), f2 = `solid.f_7` (88169 Hz); open f1 = `solid.f_4` (79813 Hz), f2 = `solid.f_8` (93614 Hz). VM175's "mode 5" for short f2 is our index 7 (index 4 / 5 are 71298 / 83119 Hz, no electrode charge, identical in the open spectrum). Optional: `C: {symmetry: tetragonal-4mm, components: {..., C66: 3.0e10}}` reproduces the listing's C66 exactly (6mm derives 3.05e10); effect on the four targets <= 0.03 %.
- X2 `sims/nafems-le11.yaml`: runs with R1: sigma_zz(A) -105.936 MPa (+0.89 %, 9261 dof). MT's exact-coordinate variant (s = sqrt(0.5), `gates/mt-common.ts`) gives -105.33 .. -105.71 MPa; the 0.70711 rounding and the mesh account for the difference (not separated).
- X3 material tensors (exact names; values only from primary or cited sources with locators):
  - `materials/pzt-4.yaml`: `C` (symmetry `hexagonal-6mm`: C11 C12 C13 C33 C44, Pa; or `tetragonal-4mm` with C66), `e_piezo` (`hexagonal-6mm`: e15 e31 e33, C/m^2), `eps_r` uniaxial perp / par = clamped eps^S / eps0, `rho`. (The package `@amp/materials` must first register `hexagonal-6mm` / `tetragonal-4mm` / `trigonal-3m` for `C` and a property `e_piezo`; until then the sims carry spec overrides, as pzt4-cube does.)
  - `materials/linbo3-congruent.yaml`: `C` (`trigonal-3m`: C11 C12 C13 C14 C33 C44, Pa, constant field), `e_piezo` (`trigonal-3m`: e15 e22 e31 e33, C/m^2), `rho` (kg/m^3); `eps_r` (clamped, present). Matrix forms and axis convention (x = a, y-z mirror plane, the convention of the r_eo entry) in `coupled/tensors.ts` header; the source's axis convention (IEEE 1949 vs 1987 changes the signs of C14 and e15 / e22) must be stated with the values.
- X4 sims drafts (values N/A until sourced; geometry has no N/A form, so the drafts validate only once MX fills the sizes: with the sizes filled by placeholder numbers in a scratch copy, both validated against the registry with R1, 2026-11-07 09:09 PST):
  - LN FBAR (2D plane strain, c axis along the film normal y via `settings.euler` (0, -90, 0) deg for a Z-cut film; thickness mode ~ v^D / (2 t) for the shift):
    ```yaml
    schema: amp-spec/0
    id: ln-fbar-2d
    title: Thin-film LN FBAR thickness mode (piezo, 2D)
    geometry: {dim: 2, features: [{id: film, type: rect, settings: {size: {value: [N/A, N/A], unit: um}, center: {value: [N/A, N/A], unit: um}}}]}
    materials:
      - {id: ln, ref: materials/linbo3-congruent, select: ["dom:film"], override: {rho: {value: N/A, unit: kg/m^3}}}
    physics:
      - {id: solid, type: elastic, select: ["dom:film"], settings: {model: plane-strain}, bcs: [{id: ends, type: free, select: ["bnd:film.left", "bnd:film.right"]}]}
      - {id: es, type: electrostatics, select: ["dom:film"], bcs: [{id: bot, type: ground, select: ["bnd:film.bottom"]}, {id: top, type: terminal, select: ["bnd:film.top"]}]}
    couplings: [{id: pz, type: piezoelectric, from: solid, to: es, settings: {euler: {value: [0, -90, 0], unit: deg}}}]
    mesh: {size: {hmax: {value: N/A, unit: um}}}
    studies: [{id: eig, type: eigen, physics: [solid, es], settings: {nModes: 8, shift: {value: N/A, unit: Hz}}}]
    missing:
      - {path: geometry.features.film.settings.size, what: "resonator width and LN film thickness (Wentao's LN_FBAR inputs or a cited device)", needed_for: [geometry]}
      - {path: geometry.features.film.settings.center, what: "half of size (film from (0, 0))", needed_for: [geometry]}
      - {path: mesh.size.hmax, what: "film thickness / 8 (modelling choice once the thickness is known)", needed_for: [mesh]}
      - {path: materials.ln.override.rho.value, what: "LN density, primary source", needed_for: [solution]}
      - {path: studies.eig.settings.shift.value, what: "shift near v^D / (2 t_ln) once the constants are sourced", needed_for: [solution]}
      - {what: "LN C (trigonal-3m: C11 C12 C13 C14 C33 C44) and e_piezo (e15 e22 e31 e33) with the source's axis convention: override tensors or materials/linbo3-congruent", needed_for: [solution]}
    ```
    (a short-circuit study needs a second electrostatics physics with both electrodes `ground`, as pzt4-cube does). Gate: the thickness-mode closed forms of s.4.3 with LN's c33^D, e33, eps33^S (rotated) once sourced; for a laterally finite film the lateral modes also appear (identify by u_y share or V_top).
  - Membrane (thin plate) in an air cavity, axisym (`acoustic-structure`):
    ```yaml
    schema: amp-spec/0
    id: membrane-air-axisym
    title: Clamped plate in a closed air cylinder (acoustic-structure)
    geometry:
      dim: 2
      axisym: true
      features:
        - {id: plate, type: rect, settings: {size: {value: [N/A, N/A], unit: mm}, center: {value: [N/A, N/A], unit: mm}}}
        - {id: cav, type: rect, settings: {size: {value: [N/A, N/A], unit: mm}, center: {value: [N/A, N/A], unit: mm}}}
    materials:
      - {id: pm, select: ["dom:plate"], override: {E: {value: N/A, unit: GPa}, nu: N/A, rho: {value: N/A, unit: kg/m^3}}}
      - {id: am, select: ["dom:cav"], override: {c: {value: N/A, unit: m/s}, rho: {value: N/A, unit: kg/m^3}}}
    physics:
      - {id: solid, type: elastic, select: ["dom:plate"], settings: {model: axisym}, bcs: [{id: rim, type: fixed, select: ["bnd:plate.right"]}]}
      - {id: ac, type: acoustics, select: ["dom:cav"]}
    couplings: [{id: fsi, type: acoustic-structure, from: solid, to: ac}]
    mesh: {size: {hmax: {value: N/A, unit: mm}}, refine: [{select: ["dom:plate"], h: {value: N/A, unit: mm}}]}
    studies: [{id: eig, type: eigen, physics: [solid, ac], settings: {nModes: 8}}]
    missing:
      - {path: geometry.features.plate.settings.size, what: "plate radius R and thickness (Wentao's mass_loaded_membrane_acoustics inputs)", needed_for: [geometry]}
      - {path: geometry.features.plate.settings.center, what: "(R/2, thickness/2)", needed_for: [geometry]}
      - {path: geometry.features.cav.settings.size, what: "cavity radius R and height", needed_for: [geometry]}
      - {path: geometry.features.cav.settings.center, what: "(R/2, plate thickness + height/2)", needed_for: [geometry]}
      - {path: mesh.size.hmax, what: "about R/20 (modelling choice)", needed_for: [mesh]}
      - {path: mesh.refine.0.h, what: "plate thickness (modelling choice; check by a mesh study)", needed_for: [mesh]}
      - {path: materials.pm.override.E.value, what: "plate E", needed_for: [solution]}
      - {path: materials.pm.override.nu, what: "plate nu", needed_for: [solution]}
      - {path: materials.pm.override.rho.value, what: "plate density", needed_for: [solution]}
      - {path: materials.am.override.c.value, what: "air speed of sound (materials/air or cited)", needed_for: [solution]}
      - {path: materials.am.override.rho.value, what: "air density", needed_for: [solution]}
    ```
    Gates: decoupled limit (air rho scaled down) = plate modes in vacuo (closed form for a clamped circular plate, Kirchhoff, needs a cited source) and the rigid-cylinder cavity modes; the u-p f = 0 pair (uniform pressure) appears at index 0. A plate whose thickness is resolved by only a few P2 elements is stiff in bending (no plate element); h / R and the refinement must be checked by a mesh study.

## 6. Open items (O)

- O1 CP-06: f1 is about -2.2 % below the measured target in both short and open circuit on every mesh (f2 +0.2 %); within the case's proposed 3 % tolerance. Electrical constants / convention ruled out by the open / short ratios (+0.06 %, -0.01 %); C66 ruled out; f1 is most sensitive to C13, C33, C11 (progress log 09:20). Remaining candidates: the listed mechanical constants or the measurement; not resolved.
- O2 Acoustic-structure: no primary-source coupled benchmark was searched for; the coupled reference is the 1D transmission-line derivation (s.4.4). Eigen only (no driven response). The closed-cavity f = 0 pair of the u-p form is reported as f_0 = 0.
- O3 Piezo: 3D and 2D plane strain only (no plane stress, no axisym). 2D plane strain sets u_z = 0, E_z = 0 (exact only when the x-y plane decouples, e.g. 6mm / 4mm with the c axis in-plane or normal; an approximation for rotated 3m crystals). Orientation: `settings.crystals` (user-facing, shared with em-modes / electrostatics; per material) or `settings.euler` (advanced, every material), exactly one (coordinator decision 2026-11-07, done 09:17). Eigen output has no per-mode electrode charge; stationary potentials are constants (no field expressions).
- O4 Modal: loads and thermal strain do not enter the eigenproblem (no prestress stiffening); rigid modes are reported as f = 0 below 1e-8 of the spectral scale. Axisym modes are azimuthal order 0 only (no torsion, no n >= 1).
- O5 Field values outside a physics' cells: piezo V and acoustic-structure p are NaN on nodes without that field; checked in the workbench (blank cells, finite colour range, evaluations report an error, progress log 09:19). u is 0 off the solid (as `solveElastic`), so `solid.u` paints the air as 0 rather than blank; making u NaN there would need a check of the deformation plots first.
- O6 Performance: element scatter uses a binary search per entry (as `solveElastic`), about a quarter of the 41k-dof 3D time; precomputed element slots would remove most of it.
- O7 Browser: membrane-air and ln-fbar-2d solved and rendered in the dev workbench (headless, swiftshader); not audited by a fresh-context agent (coordinator).
