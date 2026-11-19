// SPDX-License-Identifier: GPL-3.0-or-later
// Example library entries for the photonic waveguide mode sims (loss, PML, bends, dispersion, couplers).
// Shape: CatalogEntry from ./catalog.ts (type-only import). One entry per new sims/<id>.yaml; `ref` records run
// outcomes only (pass / fail / pending / info / not-run, ISO date, repo-relative log), never physical values.

import type { CatalogEntry } from './catalog';

const RUN = { date: '2026-11-18', via: 'harness', log: 'logs/E2-cli-final-20261118.log' } as const;

export const CATALOG_MODES: CatalogEntry[] = [
	{ id: 'au-air-spp', title: 'Gold / air surface plasmon', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-80'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '6/6 gated (2 mesh levels)', note: 'analytic planar plasmon; gold n and kappa from the library at the mode wavelength' },
		tags: ['plasmonics', 'lossy metal', 'complex index', 'Johnson and Christy'] },
	{ id: 'leaky-si-wire', title: 'Silicon wire substrate leakage', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-81'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '4/4 gated (2 mesh levels)', note: 'Bienstman et al. 2006 mode solver comparison (Opt. Quantum Electron. 38, p.751)' },
		tags: ['SOI', 'leaky mode', 'PML', 'substrate leakage', 'benchmark'] },
	{ id: 'tfln-rib-air', title: 'Thin-film lithium niobate rib, air clad', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-82'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', date: '2026-11-18', log: 'logs/G5-cli-final-20261118T190421.log', targets: '8/8 gated (+4 info)', note: 'EO modulator atlas references (vector FEM with Richardson, and an independent finite-difference run with its uncertainty band); group index with library dispersion' },
		tags: ['TFLN', 'x-cut', 'uniaxial', 'rib', 'group index'] },
	{ id: 'tfln-rib-oxide', title: 'Thin-film lithium niobate rib, oxide clad', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-83'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', date: '2026-11-18', log: 'logs/G5-cli-final-20261118T190421.log', targets: '8/8 gated (+4 info)', note: 'EO modulator atlas references (vector FEM with Richardson, and an independent finite-difference run with its uncertainty band); group index with library dispersion' },
		tags: ['TFLN', 'x-cut', 'uniaxial', 'rib', 'group index'] },
	{ id: 'si-dc-supermodes', title: 'Silicon directional coupler supermodes', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-84'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '2/2 gated (+6 info)', note: 'coupling length vs a Tidy3D example (other solver and material models; tolerance is an estimate)' },
		tags: ['SOI', 'directional coupler', 'supermodes', 'coupling length'] },
	{ id: 'si-wire-bend', title: 'Silicon wire bend loss vs radius', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-85'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...RUN, status: 'pass', targets: '8/8 gated (+10 info)', note: 'Kakihara et al. 2006 Fig. 4 (digitized; tolerance is the reading resolution)' },
		tags: ['SOI', 'bend', 'radiation loss', 'PML', 'sweep'] },
	{ id: 'si-strip-te0-ng', title: 'Si strip group index with dispersion', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-65'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'info', date: '2026-11-18', via: 'engine', log: 'logs/E2-cli-final-20261118.log', note: 'group index vs the EO modulator atlas reference on 2 levels (informative: the Richardson level needs more than 2 GB)' },
		tags: ['SOI', 'strip', 'group index', 'dispersion'] },
	// photonics examples, part 2
	{ id: 'tfln-mzm-pushpull', title: 'Thin-film LN push-pull modulator VpiL', category: 'multiphysics', physics: ['electrostatics', 'em-modes'], dimension: '2D', evalCases: ['WO-86'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', via: 'harness', log: 'logs/G5-cli-final-20261118T190421.log', targets: '6/6 gated (2 mesh levels)', note: 'VpiL and dn/dV vs an independent FEM chain (EO modulator atlas push-pull reference)' },
		couplings: [{ type: 'electro-optic', from: 'electrostatics', to: 'em-modes' }], tags: ['Pockels', 'lithium niobate', 'MZM', 'VpiL', 'x-cut', 'push-pull', 'GSG', '1550 nm'] },
	{ id: 'si-slot-slab', title: 'Silicon slot waveguide (1D slot)', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-88'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', via: 'harness', log: 'logs/G5-cli-final-20261118T190421.log', targets: '2/2 gated (2 mesh levels)', note: 'slot-mode index vs the exact five-layer slab dispersion relation' },
		tags: ['slot waveguide', 'field enhancement', 'TM', 'slab', 'analytic'] },
	{ id: 'sin-strip', title: 'Silicon nitride strip waveguide group index', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-89'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'info', date: '2026-11-18', via: 'harness', log: 'logs/G5-cli-final-20261118T190421.log', note: 'group index vs a measured value (Munoz et al. 2017; informative: measured guide type and film indices not stated)' },
		tags: ['silicon nitride', 'LPCVD', 'strip', 'group index', 'dispersion', 'measured'] },
];
