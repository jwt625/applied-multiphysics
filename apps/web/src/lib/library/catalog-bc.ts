// SPDX-License-Identifier: GPL-3.0-or-later
// Example library entries for the class-b / class-c sims (lane W4 owns this file's contents; DevLog-021 s.3, DevLog-022).
// Shape: CatalogEntry from ./catalog.ts (type-only import, no cycle at runtime). One entry per new sims/<id>.yaml.
// Entries already in catalog.ts CATALOG_A (the pre-existing sims, incl. two-spheres EM-02, coplanar-rings EM-03,
// cylinder-cavity* RF-01, si-rib-waveguide WO-02) win on a duplicate id. `ref` records run outcomes only (no values);
// the numbers are in DevLog-022 s.3 and the log. Runs: scratch runner (spec validate + prepareRun + module run, nested
// levels hFactor 1 / 0.5 / 0.25 unless noted), compared with the case reference / eval/expected.

import type { CatalogEntry } from './catalog';

const RUN = { date: '2026-11-06', via: 'engine', log: 'logs/w4-library-bc-20261106T205541.jsonl' } as const;

export const CATALOG_BC: CatalogEntry[] = [
	// heat transfer
	{ id: 'poisson-square', title: 'Poisson on the unit square', category: 'heat', physics: ['heat'], dimension: '2D', evalCases: ['HT-61'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '1/1 gated' },
		analog: 'dimensionless -lap u = 1 as steady conduction (k 1 W/(m K), Q 1 W/m^3, T = u in K)', tags: ['scikit-fem', 'Poisson', 'steady'] },
	{ id: 'heated-wire', title: 'Heated wire, convection', category: 'heat', physics: ['heat'], dimension: 'axisym', evalCases: ['CP-03'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '3/3 gated (2 independent: q per ft restates T_surface)', note: 'q per ft from the energy balance h (T_surface - T_inf) 2 pi r0 L' },
		tags: ['Ansys VM58', 'Rohsenow-Choi', 'heat source', 'convection', '1D radial'] },
	// electrostatics / magnetostatics
	{ id: 'micro-coax-lgeom', title: 'Micro-coax geometric inductance', category: 'em-static', physics: ['electrostatics'], dimension: '2D', evalCases: ['EM-61'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '1/3 gated (L_kin, L_total pending: no London-film model)' },
		analog: "L_geom = L' l with the TEM L' = mu0 eps0 / C'_vacuum from 2D electrostatics", tags: ['Palace', 'coax', 'inductance', 'superconductor'] },
	// RF / microwave
	{ id: 'cpw-halfspace', title: 'CPW on a half-space', category: 'rf', physics: ['electrostatics'], dimension: '2D', evalCases: ['RF-62'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '3/3 gated (after Richardson; finest-level C off by 3e-4)', note: 'truncation R 3 vs 12 mm changes C by 9e-6 relative' },
		tags: ['CPW', 'quasi-static', 'Z0', 'conformal map'] },
	{ id: 'cpw-sapphire', title: 'CPW on C-axis sapphire', category: 'rf', physics: ['electrostatics'], dimension: '2D', evalCases: ['RF-03'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '1/1 gated (+2 info pass: isotropic 9.3 variant, Palace printed value)' },
		analog: 'uniaxial substrate mapped to an isotropic layer (y scaled by sqrt(eps_perp / eps_par), eps = sqrt(eps_perp eps_par)), exact for planar interfaces',
		tags: ['Palace', 'CPW', 'sapphire', 'anisotropic', 'Z0'] },
	// wave optics / photonics
	{ id: 'hadley-rib-wo02', title: 'Hadley rib waveguide (WO-02)', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-02'], evalClass: ['b'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pending', targets: '7/8 thicknesses pass on 3 nested levels; t = 0 not modelled', note: 'levels non-monotone (Richardson unavailable); last-level change <= 2.5e-7, |finest - ref| <= 1.0e-6 (tol 5e-6); t 0.1 / 0.2 on a 2x coarser base mesh (DevLog-022 s.8); pending only for the t = 0 point' },
		tags: ['Hadley', 'femwell', 'rib', 'mode solver', 'sweep'] },
	{ id: 'hadley-square-core', title: 'Square core in a metal box', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-41'], evalClass: ['b'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: 'variants A, B (eps_core 2.25 / 8)', note: 'B within tolerance at the finest of 4 levels, not converged (last level changes about the tolerance)' },
		tags: ['Hadley', 'femwell', 'quarter symmetry', 'PEC / PMC', 'mode solver'] },
	{ id: 'hadley-square-hole', title: 'Low-index core in a metal box', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-41'], evalClass: ['b'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: 'variants C, D (eps_clad 2.25 / 8)' },
		tags: ['Hadley', 'femwell', 'quarter symmetry', 'PEC / PMC', 'mode solver'] },
	{ id: 'si-strip-te0', title: 'Si strip waveguide TE0', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-65'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '1/1 gated (ng_energy non-gated: not comparable)', note: 'case ng includes Sellmeier dispersion; the sim uses the case constant indices. n_eff converges at p ~ 1 (core corners)' },
		tags: ['SOI', 'strip', 'mode solver', 'EO atlas K1'] },
	{ id: 'phc-square-rods-lower', title: 'Square rod lattice, TM gap lower edge (scalar analog)', category: 'optics', physics: ['acoustics'], dimension: '2D', evalCases: ['WO-04'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: 'gap_lower 1/1 gated (gap_upper on phc-square-rods-upper)' },
		analog: 'TM E_z as the scalar wave equation (c = c_vac / sqrt(eps), uniform rho); M-point class even about both mirrors on the quarter cell',
		tags: ['MPB', 'photonic crystal', 'band gap', 'analog'] },
	{ id: 'phc-square-rods-upper', title: 'Square rod lattice, TM gap upper edge (scalar analog)', category: 'optics', physics: ['acoustics'], dimension: '2D', evalCases: ['WO-04'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: 'gap_upper 1/1 gated (gap_lower on phc-square-rods-lower)' },
		analog: 'TM E_z as the scalar wave equation (c = c_vac / sqrt(eps), uniform rho); X-point class odd in x, even in y on the quarter cell',
		tags: ['MPB', 'photonic crystal', 'band gap', 'analog'] },
	{ id: 'phc-point-defect', title: 'Photonic-crystal point defect (scalar analog)', category: 'optics', physics: ['acoustics'], dimension: '2D', evalCases: ['WO-63'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'info', targets: 'defect frequency (non-gated) within tolerance', note: 'reference is MPB at resolution 16 (not converged); energy-fraction target not computed' },
		analog: 'TM E_z as the scalar wave equation; supercell M point, defect mode even about both mirrors on the quarter supercell',
		tags: ['MPB', 'photonic crystal', 'defect mode', 'analog'] },
];
