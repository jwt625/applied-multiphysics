// SPDX-License-Identifier: GPL-3.0-or-later
// Example library entries for the multiphysics sims (lane MX owns this file's contents; DevLog-029, DevLog-035).
// Shape: CatalogEntry from ./catalog.ts (type-only import, no cycle at runtime); category 'multiphysics' and the
// `couplings` chain ({type, from, to} with physics types, C11). One entry per new sims/<id>.yaml; `ref` records run
// outcomes only (no values; numbers in DevLog-035 s.12). `physics` lists the chain in coupling order. Runs: scratch
// runner (validate + prepareRun + runStudy + the sim's evaluation tables), default mesh, single level (no Richardson).

import type { CatalogEntry } from './catalog';

const RUN = { date: '2026-11-07', via: 'engine', log: 'logs/MX-run-all-20261107T094211.jsonl' } as const;
// rerun after the audit fixes (lane FC, DevLog-035 s.13): LE11 exact arc points; gaas after the modal-mass quadrature fix
const RUN_FC = { ...RUN, log: 'logs/FC-run-20261107T101942.jsonl' } as const;

export const CATALOG_MP: CatalogEntry[] = [
	// thermal stress
	{ id: 'nafems-t1-hotspot', title: 'NAFEMS T1 hot spot (heat -> stress)', category: 'multiphysics', physics: ['heat', 'elastic'], dimension: '2D',
		evalCases: ['CP-21'], evalClass: ['a'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '1/1 gated (single level)', note: 'sigma_yy at D vs 50 MPa (CP-21)' },
		couplings: [{ type: 'thermal-expansion', from: 'heat', to: 'elastic' }], tags: ['NAFEMS', 'thermal stress', 'plane stress', 'inclusion'] },
	{ id: 'nafems-le11', title: 'NAFEMS LE11 thermal stress (axisym)', category: 'multiphysics', physics: ['heat', 'elastic'], dimension: 'axisym',
		evalCases: ['CP-02'], evalClass: ['a'], caseStatus: 'unvalidated', ref: { ...RUN_FC, status: 'pass', targets: '1/1 gated (single level)', note: 'sigma_zz at A vs -105 MPa (CP-02)' },
		couplings: [{ type: 'thermal-expansion', from: 'heat', to: 'elastic' }], tags: ['NAFEMS', 'thermal stress', 'axisymmetric', 'heat source'] },
	{ id: 'bimetal-strip', title: 'Bimetal strip, Cu on Al (heat -> stress)', category: 'multiphysics', physics: ['heat', 'elastic'], dimension: '2D',
		evalCases: [], evalClass: [], ref: { ...RUN, status: 'info', note: 'uy(L/4) - uy(0) vs Timoshenko 1925 closed form (validation/mp)' },
		couplings: [{ type: 'thermal-expansion', from: 'heat', to: 'elastic' }], tags: ['Timoshenko', 'bimorph', 'curvature', 'plane stress', 'author model inputs'] },
	{ id: 'chip-warpage-2d', title: 'Interposer-on-substrate warpage (2D)', category: 'multiphysics', physics: ['heat', 'elastic'], dimension: '2D',
		evalCases: [], evalClass: [], ref: { ...RUN, status: 'info', note: 'bow vs laminate closed form; ECTC 2011 3D value qualitative only' },
		couplings: [{ type: 'thermal-expansion', from: 'heat', to: 'elastic' }], tags: ['packaging', 'warpage', 'CTE mismatch', 'plane strain', 'ECTC'] },
	// Joule heating
	{ id: 'joule-wire', title: 'Joule-heated wire (currents -> heat)', category: 'multiphysics', physics: ['currents', 'heat'], dimension: 'axisym',
		evalCases: ['CP-03'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '2/2 gated (single level)', note: 'T_center, T_surface vs the CP-03 closed form' },
		couplings: [{ type: 'joule-heating', from: 'currents', to: 'heat' }], tags: ['Joule', 'convection', 'Rohsenow-Choi', 'Ansys VM58'] },
	{ id: 'hot-arm-actuator', title: 'Si hot-arm electrothermal actuator (currents -> heat -> stress)', category: 'multiphysics', physics: ['currents', 'heat', 'elastic'], dimension: '3D',
		evalCases: ['CP-04'], evalClass: ['c'], caseStatus: 'untestable', ref: { ...RUN, status: 'info', note: 'informative: 300 K properties; the VM223 target needs k(T), alpha(T), h(T), radiation, NLGEOM' },
		couplings: [{ type: 'joule-heating', from: 'currents', to: 'heat' }, { type: 'thermal-expansion', from: 'heat', to: 'elastic' }], tags: ['MEMS', 'electrothermal', 'actuator', 'Ansys VM223'] },
	// photonic couplings
	{ id: 'si-microheater-to', title: 'Si microheater phase shifter (currents -> heat -> optics)', category: 'multiphysics', physics: ['currents', 'heat', 'em-modes'], dimension: '2D',
		evalCases: [], evalClass: [], ref: { ...RUN, status: 'info', note: 'Ppi vs measured P_pi 8.5 mW (Wang 2020); out-of-plane heater current I = sqrt(P / R)' },
		couplings: [{ type: 'joule-heating', from: 'currents', to: 'heat' }, { type: 'thermo-optic', from: 'heat', to: 'em-modes' }], tags: ['thermo-optic', 'Joule', 'silicon photonics', 'phase shifter', 'P_pi', '1550 nm'] },
	{ id: 'tfln-mzm-eo', title: 'TFLN modulator VpiL (electrostatics -> optics)', category: 'multiphysics', physics: ['electrostatics', 'em-modes'], dimension: '2D',
		evalCases: ['CP-43'], evalClass: ['b'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '1/1 VpiL (single level)', note: 'push-pull VpiL vs paper-simulated 4.06 V cm (CP-43)' },
		couplings: [{ type: 'electro-optic', from: 'electrostatics', to: 'em-modes' }], tags: ['Pockels', 'lithium niobate', 'MZM', 'VpiL', 'x-cut', '1957 nm'] },
	// two-way (monolithic) couplings
	{ id: 'pzt4-cube', title: 'PZT-4 cube breathing modes (piezo)', category: 'multiphysics', physics: ['elastic', 'electrostatics'], dimension: '3D',
		evalCases: ['CP-06'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '4/4 (two studies, single level)', note: 'short / open breathing modes vs Boucher 1981 measured (CP-06), tol 3 %' },
		couplings: [{ type: 'piezoelectric', from: 'elastic', to: 'electrostatics' }], tags: ['piezoelectric', 'PZT-4', 'eigenfrequency', 'Ansys VM175'] },
	{ id: 'ln-fbar-2d', title: 'LiNbO3 lateral-field plate resonator (piezo)', category: 'multiphysics', physics: ['elastic', 'electrostatics'], dimension: '2D',
		evalCases: [], evalClass: [], ref: { ...RUN, status: 'info', note: 'electrically active and piston-like modes vs the thickness-mode closed form' },
		couplings: [{ type: 'piezoelectric', from: 'elastic', to: 'electrostatics' }], tags: ['piezoelectric', 'lithium niobate', 'BAW', 'lateral field', 'author model inputs'] },
	{ id: 'membrane-air', title: 'Mass-loaded membrane in air (structure-acoustics)', category: 'multiphysics', physics: ['elastic', 'acoustics'], dimension: 'axisym',
		evalCases: [], evalClass: [], ref: { ...RUN, status: 'info', note: 'coupled vs in-vacuo fundamental; uncoupled checks in validation/mp' },
		couplings: [{ type: 'acoustic-structure', from: 'elastic', to: 'acoustics' }], tags: ['acoustic-structure', 'membrane', 'metamaterial', 'axisymmetric', 'author model inputs'] },
	{ id: 'gaas-microdisk-om', title: 'GaAs microdisk optomechanical coupling g0', category: 'multiphysics', physics: ['elastic', 'emw-axisym'], dimension: 'axisym',
		evalCases: [], evalClass: [], ref: { ...RUN_FC, status: 'info', note: 'RBM1 frequency and |g0| x 2 pi vs Baker 2014 Table 3 (FEM, rad/s); engine gates in DevLog-034 s.4 (no eval case)' },
		couplings: [{ type: 'optomechanical', from: 'elastic', to: 'emw-axisym' }], tags: ['optomechanics', 'g0', 'whispering gallery', 'radial breathing mode', 'photoelastic', 'moving boundary', 'GaAs', 'Baker 2014'] },
];
