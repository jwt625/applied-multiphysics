// SPDX-License-Identifier: GPL-3.0-or-later
// Example library entries for the advanced packaging sims (TSV, interposer, die stacks, interconnect lines).
// Shape: CatalogEntry from ./catalog.ts (type-only import). One entry per new sims/<id>.yaml; `ref` records run
// outcomes only (pass / fail / pending / info / not-run, ISO date, repo-relative log), never physical values.
// Runs: eval harness CLI (packages/eval/src/cli.ts --case PK-xx) on the case's own spec; numbers in DevLog-049.

import type { CatalogEntry } from './catalog';

const RUN = { date: '2026-11-18', via: 'harness', log: 'logs/E3-cli-pk-all-20261118T140900.log' } as const;
const TE = [{ type: 'thermal-expansion', from: 'heat', to: 'elastic' }];

export const CATALOG_PKG: CatalogEntry[] = [
	{ id: 'tsv-stress-axisym', title: 'TSV thermal stress, Cu via in Si (axisymmetric)', category: 'packaging', physics: ['heat', 'elastic'], dimension: 'axisym',
		evalCases: ['PK-01'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '5/5 gated', note: 'Cu and Si stresses, rim displacement vs the plane-strain Lame closed form (2 levels)' },
		couplings: TE, tags: ['TSV', 'thermal stress', 'Lame', 'axisymmetric', 'CTE mismatch'] },
	{ id: 'tsv-stress-3d', title: 'TSV thermal stress, Cu via in Si (3D quarter cell)', category: 'packaging', physics: ['heat', 'elastic'], dimension: '3D',
		evalCases: ['PK-02'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '4/4 gated (+4 info)', note: 'same closed form as the axisymmetric model; layer-stack extrude' },
		couplings: TE, tags: ['TSV', 'thermal stress', 'Lame', 'layer stack', 'cross-check'] },
	{ id: 'microstrip-rdl', title: "RDL microstrip line, C', L' and Z0", category: 'packaging', physics: ['electrostatics'], dimension: '2D',
		evalCases: ['PK-03'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '3/3 gated', note: 'vs Hammerstad-Jensen 1980 closed forms (Richardson, 3 levels)' },
		tags: ['microstrip', 'RDL', 'polyimide', 'Hammerstad-Jensen', 'impedance', 'quasi-static'] },
	{ id: 'cpw-si-interposer', title: "CPW on a Si interposer, C', L' and Z0", category: 'packaging', physics: ['electrostatics'], dimension: '2D',
		evalCases: ['PK-04'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '1/1 gated (+2 info)', note: "L' vs the exact conformal map; C', Z0 vs the finite-substrate form informative" },
		tags: ['CPW', 'interposer', 'conformal mapping', 'impedance', 'high-resistivity Si'] },
	{ id: 'interposer-thermal-3d', title: '2.5D interposer thermal map, three dies', category: 'packaging', physics: ['heat'], dimension: '3D',
		evalCases: ['PK-05'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '1/1 gated (+3 info)', note: 'power-weighted junction temperature rise within two closed-form bounds' },
		tags: ['2.5D', 'interposer', 'junction-to-case', 'thermal resistance', 'micro-bumps', 'layer stack'] },
	{ id: 'die-warpage-3d', title: 'Die-on-substrate warpage (3D)', category: 'packaging', physics: ['heat', 'elastic'], dimension: '3D',
		evalCases: ['PK-06'], evalClass: ['c'], caseStatus: 'unvalidated', ref: { ...RUN, status: 'pass', targets: '1/1 gated (+2 info)', note: 'centre curvature vs laminated-plate (biaxial Timoshenko) theory' },
		couplings: TE, tags: ['warpage', 'Timoshenko', 'bilayer', 'CTE mismatch', 'BT laminate', 'layer stack'] },
];
