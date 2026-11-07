# DevLog-036: anisotropic electrostatics (R3) and shared-edge names (G1) (lane MG)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | MG (DevLog-029; requests R3 and G1 of lane MO, DevLog-032 s.4) |
| Owns | `packages/physics/src/electrostatics/**`; `packages/geom/**` (naming / selection only); `packages/physics/test/photonic-tfln*.ts` (gate switch only); new `packages/physics/test/es-aniso.test.ts`; G2 (coordinator 09:0x): `packages/mesh/src/boxgrid.ts` naming, new `packages/mesh/test/boxgrid-names.test.ts`; this file |
| Parallel | MC (031: driver, prepare, registrations, couplings core/index, currents, spec types, post), MO (032: modes, couplings/photonic), MT (033: elastic modal / axisym, piezo, couplings/twoway), MX (035: sims, materials, catalog-mp) |
| Read | DevLog-029, DevLog-031, DevLog-032 s.4; CONTRACTS-v0 C2, C11 and changelog; `packages/physics/src/{prepare,registrations,index,driver}.ts`, `common/{ctx,scalar}.ts`, `modes/{crystal.mjs,coupled.ts}`, `couplings/{photonic,twoway}.ts`, `coupled/tensors.ts`; `packages/geom/src/{model,spec}.ts` |
| Status | done (gates s.2); requests s.3 |

Conventions: "F" = fact read from code or a run; "D" = decision of this lane (reason given); "O" = open item.

## 1. Plan (2026-11-07 09:06 PST)

### 1.1 Facts (F)
- electrostatics takes a scalar `eps_r` per cell (`cellProps(ctx, ['eps_r'])`, which throws when a material has no number) and assembles with `assembleCells` (scalar `k` per cell). The registration has no `settings` (so `settings.crystals` fails spec validation today).
- prepareRun (as of 09:06) keeps only scalar library values (`typeof pv.value === 'number'`); LN `eps_r` is a uniaxial tensor in `materials/linbo3-congruent.yaml` (perp 44.3, par 27.9, Weis-Gaylord 1985 Table 1, clamped). MC is to flatten tensors to `rec['<prop>.<comp>']` (SI). MT's `couplings/twoway.ts` already reads `eps_r.perp` / `eps_r.par` (flattened) or an override tensor object.
- Crystal frame math: `modes/crystal.mjs` `labFromCrystal(cut, propagation, rotDeg)` (lab x lateral, y film normal, z propagation; v_lab = A v_crystal); crystal merge + rotation quantity resolution: `modes/coupled.ts` `mergeCrystals(spec, lists)`.
- `couplings/twoway.ts` imports `EPS0` from `electrostatics/index.ts`, so electrostatics must not import twoway (cycle).
- G1: an electrode rect used as a difference tool on a layer (`air0 = top - sig`, `sig.bottom` on `top.bottom` = slab top) is consumed; in `combine('difference')` the coincident sub `sig.bottom` / `top.bottom` has exterior on both sides and is dropped, so the later fragment knows only `slab.top` there. Coincident edges present in the same arrangement already list both sources in `parent` (e.g. `slab.top#k` with `bnd:ribA.e0`).

### 1.2 Design (D)
R3 (electrostatics):
- Per cell permittivity: scalar `eps_r` (as now) or uniaxial `eps_r.perp`, `eps_r.par` (flattened keys) with a crystal orientation; lab tensor `A diag(perp, perp, par) A^T`, in-plane block `[xx, xy, yy]` (2D: fields invariant along z, so `D_z` does not enter div D; the xz / yz parts need no restriction). A uniaxial material without a crystal orientation is an error (no default axis).
- Crystals: `mergeCrystals` of MO (one definition per material; conflicting definitions are an error) over `physics.settings.crystals` (needs MC's registration change, request below) and the `crystals` of every spec coupling node whose `from` or `to` is this physics (the electro-optic coupling already carries them; one statement in the spec serves both physics).
- Assembly: all cells isotropic -> the existing `assembleCells` call, unchanged (bit-identical isotropic path). Any anisotropic cell -> own tensor assembly in `electrostatics/aniso.ts` (same shape tables / quadrature / pattern as `assembleCells`, `G_a . eps G_b`). 2D-axisymmetric with an anisotropic cell: error (a body of revolution needs an azimuthally symmetric tensor; not in scope).
- Vacuum capacitance C0 (TEM L', Z0) unchanged (eps0 everywhere).

G1 (geometry names):
- `combine('difference')`: tool edge pieces dropped from the result (exterior on both sides) are kept on the result object as "footprints" `{curve, id, anc}`; footprints propagate through later booleans. In the final geometry, a boundary entity whose every piece lies on footprints of id X gets `bnd:X` added to `parent` (and X's ancestors to `ancestors`). So the electrode bottom `slab.top#k` resolves from both `bnd:slab.top` and `bnd:sig.bottom`. Partial overlaps are not named (whole-entity rule).
- Check script `packages/geom/scripts/dump-selections.ts`: for every `sims/*.yaml`, mesh entity table from `meshFromSpec`, resolve every `dom:` / `bnd:` / `pnt:` string of the spec, dump id -> matched entity ids; run before and after, diff.

G2 (box-grid names, coordinator request 09:0x from MX DevLog-035 O4):
- F: `packages/mesh/src/boxgrid.ts` owns an interface by the minus-side box (`<q>.xmax`, parent `bnd:<p>.xmin`); the exterior remainder of the plus-side face keeps the plain id `<p>.xmin`, so `bnd:<p>.xmin` selects the remainder and every interface.
- D: a min-side face (xmin, ymin, zmin) with more than one piece (exterior remainder and / or interfaces owned by neighbours) is numbered over all pieces, exterior first, then neighbour box order: remainder `bnd:<p>.<dir>#1` (parent `bnd:<p>.<dir>`), interfaces list `bnd:<p>.<dir>#k` (k >= 2) in `parent` instead of `bnd:<p>.<dir>`. `bnd:<p>.<dir>` still resolves to every piece (piece rule); `bnd:<p>.<dir>#1` = exterior only. Single-piece faces keep their plain id. Same "#k exterior first" rule the file header already states for owned faces.

### 1.3 Gates
1. Isotropic path bit-identical: every electrostatics sim (coax-line, two-spheres, cpw-halfspace, cpw-sapphire, micro-coax-lgeom; others if they run) scalars and V field hashes before / after.
2. Uniaxial slab capacitor, rotated crystal: slab whose normal is along the crystal c axis (rotation convention of `labFromCrystal`), natural side walls; closed form C' = eps0 eps_par w / d (and eps_perp with the normal across c). A linear potential is exact in P1 / P2, so the gate is at round-off.
3. TFLN gates of MO through the electrostatics module + runStudy (spec couplings node, G1 selections incl. `bnd:sig.bottom`), VpiL vs MO's test-side P1 numbers CP-43 4.241 V cm, CP-44 4.015 V cm.
4. Selection dump identical for all sims; tsc + `pnpm -r test`; class-a eval identical to the latest `logs/eval-*.jsonl`.

### 1.4 TODO
- [x] baselines: electrostatics sims, selection dump, class a (latest coordinator-visible run `logs/eval-20261107T085550.jsonl`)
- [x] R3 electrostatics anisotropic + gate 2
- [x] G1 footprints + geom test + selection diff
- [x] G2 box-grid min-face numbering + mesh test + selection diff
- [x] TFLN gate switch (gate 3)
- [x] tsc, pnpm -r test, class a
- [x] fresh-context audit (s.4)
- [x] 3D electrostatics capacitance unit F (coordinator 09:2x)
- [ ] MT point-entity (pnt:) request: none filed by 09:30

## 2. Progress
- 2026-11-07 09:06 PST: plan written.
- 2026-11-07 09:07 PST: baselines. Selection dump `packages/geom/scripts/dump-selections.ts` (47 sims, 0 errors; ids + mesh-entity hash per selection, deterministic on rerun): `logs/MG-selections-before-20261107T091055.json` (an ids-only first version, `...T090712`, was replaced by this one before any geometry change). Electrostatics regression `packages/physics/src/electrostatics/check-sims.ts`: `logs/MG-es-before-20261107T090741.json` (coax-line, cpw-halfspace, cpw-sapphire, micro-coax-lgeom, two-spheres solve; ln-fbar-2d, pzt4-cube, tfln-mzm-eo fail standalone: no scalar LN / pzt4 eps_r).
- 2026-11-07 09:09 PST: R3 in `electrostatics/aniso.ts` + `index.ts`; after: `logs/MG-es-after-20261107T090856.json`: the five isotropic sims bit-identical (scalars as exact strings, sha-256 of V); tfln-mzm-eo now solves standalone (override tensor + coupling crystals): C' 1.5032387411298458e-10 F/m; ln-fbar-2d / pzt4-cube still fail standalone with clearer messages (LN there is oriented by the piezo coupling's `euler`, not `crystals`; pzt4-cube is 3D) - they run through MT's monolithic coupling, not this path.
- 2026-11-07 09:10 PST: gate 2 `test/es-aniso.test.ts` pass (`logs/MG-es-aniso-test-20261107T090946.log`): C' / closed form - 1 within 1e-15 for normal along c at t = 30 deg (2.470318399771202e-9 F/m) and across c (3.9224052010703994e-9), unrotated both ways, c along z; wrong rotation sign gives 3.5527e-9 (44 % off); coupling-node crystals used; missing / conflicting orientation errors.
- 2026-11-07 09:11-09:12 PST: G1 first version (every dropped tool piece) changed phc-square-rods-lower / -upper (`bnd:cutx.right` gained `bnd:cell.left`, `bnd:cuty.top` gained `bnd:cell.bottom`: cut-rect edges in free space lying on the later cell edge); restricted to dropped tool pieces coincident with a target edge; diff vs baseline identical (`logs/MG-selections-g1-20261107T091214.json`).
- 2026-11-07 09:12 PST: G2 in `boxgrid.ts`; dump identical incl. ids (`logs/MG-selections-g2-20261107T091245.json`). hot-arm-actuator: `bnd:conn.xmin` -> {hot.xmax, conn.xmin#1, cold.xmax} (76 facets, as before), `bnd:conn.xmin#1` -> exterior only (16 facets); `bnd:cold.xmin` -> {cold.xmin#1, flex.xmax} (52), `bnd:cold.xmin#1` (44).
- 2026-11-07 09:14-09:15 PST: TFLN gates switched to runStudy (`logs/MG-tfln-before-20261107T091405.log` = MO's test-side P1: 4.241246069373774 / 4.015274860514563 V cm). After (`logs/MG-tfln-after-20261107T091539.log`): CP-43 VpiL 4.252671374772967 V cm (+0.27 %), CP-44 4.022805003057128 V cm (+0.19 %; atlas vector 4.022). First after-run (`...T091454`) failed MO's direct-vs-first-order assertion (rel 1.2e-4 vs tol 1e-6): the direct re-solve uses the triangle-mean d eps, first order the quadrature-point d eps, which agree to round-off only for a P1 (piecewise constant) E. Tolerance 1e-3 with the reason in the test header.
- 2026-11-07 09:17 PST: P1 equivalence (scratch script, em-modes order 1 -> tri3 mesh): module V vs MO's former test-side P1 Poisson max |dV| 3.8e-14 V (CP-43) and 5.1e-14 V (CP-44), terminal-node mismatch 0 (`logs/MG-tfln-p1-equiv-20261107T091703.log`). So the VpiL shift is the P1 -> P2 field order only, and the G1 name selections equal MO's geometric electrode selection. (A first try at 09:16 hit `materials/pzt-4.yaml` invalid symmetry during MX's edit; rerun after the file validated.)
- 2026-11-07 09:16 PST: tsc clean for geom, mesh, physics.
- 2026-11-07 09:17-09:24 PST: `pnpm -r --workspace-concurrency=1 test` exit 0, 11 packages, 506 / 506 (`logs/MG-pnpm-test-20261107T091713.log`; includes G-ES1/2, G-EO2/3, G1, G2 tests).
- 2026-11-07 09:25 PST: class a `logs/eval-20261107T092539.jsonl` (stdout `logs/MG-eval-a-20261107T092538.log`) vs `logs/eval-20261107T085550.jsonl` (before this lane): 137 / 137 records identical after dropping wall times and `run.startedAt` (status, values, levels, mesh hashes); 37 pass, 95 pending, 4 info.
- 2026-11-07 09:26 PST: audit fixes (s.4): duplicate material selection is an error in the anisotropic path too; boxgrid header wording; CP-44 rel in the TFLN test comment. Rechecks: electrostatics regression `logs/MG-es-final-20261107T092716.json` (isotropic five unchanged vs before); selection dump `logs/MG-selections-final-20261107T092822.json`: 47 / 47 baseline sims identical (MX added `gaas-microdisk-om.yaml` meanwhile: no baseline, resolves without unknowns).
- 2026-11-07 09:28 PST: coordinator item: 3D electrostatics capacitance unit `F` (was `F/m`); module `dims` now `['2d', '2d-axisym', '3d']` (the registration already lists 3d). Gate G-ES3: box 2 x 1 x 0.5 mm, eps_r 3.9, terminal zmax, ground zmin, natural sides: C 1.3812532987967981e-13 F vs eps0 eps_r A / d 1.3812532987968001e-13 F (rel -1.4e-15), unit F (`logs/MG-es-aniso-test-20261107T092852.log`). Physics tests 98 / 98 (`logs/MG-physics-test-20261107T092912.log`). Physics tsc: one error in `test/mom-common.ts` (another lane's file, created 09:28), none in MG files.

## 3. Requests
- R-MC-1 (registrations.ts, MC): electrostatics physics settings, so `physics[].settings.crystals` validates (until then crystals come from a coupling node, which the module also reads):
```ts
import { crystalsSchema } from './couplings/photonic.ts';
  { kind: 'physics', type: 'electrostatics', ...own, dims: [...as now...], description: 'Electrostatics; terminals give the Maxwell capacitance matrix; anisotropic eps_r (uniaxial perp / par) with settings.crystals (2D)',
    settings: z.strictObject({ crystals: crystalsSchema.optional() }) },
```
  (registrations.ts already imports from `./couplings/index.ts`; `crystalsSchema` is exported by photonic.ts; no cycle: photonic.ts does not import registrations.) Note: the registration now lists `'3d'` in dims while the module's `dims` are `['2d', '2d-axisym']`.
- R-MX-1 (sims/hot-arm-actuator.yaml, MX; G2): convection on the exterior remainders only: add `"bnd:conn.xmin#1", "bnd:cold.xmin#1"` to `h_side.select`. `bnd:conn.xmin` / `bnd:cold.xmin` keep selecting every piece.
- R-MO-1 (info, modes/coupled.ts): with a P2 potential the direct check (triangle-mean d eps) and the first-order value (quadrature-point d eps) differ at discretization level (1.2e-4 rel on CP-43); a quadrature-consistent direct path would restore round-off agreement if wanted.
- Contracts changelog (coordinator): C2 naming additions G1 (difference footprints add the tool edge to `parent` of a coincident final edge) and G2 (box-grid min-side faces numbered over all pieces, exterior `#1`).

## 4. Audit (fresh context, 2026-11-07 09:2x PST)
No bug found. Acted on: (1) `cellPermittivity` took the first material on a doubly selected domain silently (cellProps throws): now throws the same error. (3) boxgrid header said exterior = `#1` and interfaces `#k >= 2` unconditionally; a face without exterior numbers its interfaces from `#1`: wording fixed. (9) test comment gained the CP-44 rel (1.9e-4). Noted, not changed: (2) a footprint matches any later edge lying on the dropped piece by geometry (stated semantics; previously such a selection was unknown); (4) G2 renames affected box-grid boundary ids (`tagHash` changes; no exact-id consumer found); (5) MO's `mergeCrystals` compares orientations as strings (`x` vs `+x`, deg vs rad round-off give a spurious conflict) - now also on the electrostatics path, for MO; (6) keepTools can duplicate footprints (cost only); (7) the selection dump covers `sims/*.yaml` only, G1 / G2 evidence is the two new tests; (8) the ln-fbar-2d standalone message suggests `crystals` though that sim orients LN with the piezo `euler`; (10) the wrong-sign estimate in G-ES1 is the infinite-slab value (assertion unaffected).
