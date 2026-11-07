// SPDX-License-Identifier: GPL-3.0-or-later
// Example library catalog (lane W3, DevLog-021): one entry per sims/<id>.yaml, grouped by category, with the paired
// eval case and the result of the last engine run against its reference. Entries for the class-b / class-c sims of
// lane W4 live in ./catalog-bc.ts. No physical value is stated here; `ref` records only run outcomes (pass / fail /
// pending / not run) and where they were logged (logs/, repo-relative).

import { CATALOG_BC } from './catalog-bc';

export type Category = 'heat' | 'structural' | 'em-static' | 'rf' | 'optics' | 'acoustics' | 'fluids-rt' | 'coupled';
export type Dim = '2D' | 'axisym' | '3D';
export type EvalClass = 'a' | 'b' | 'c';
/** pass / fail / error / pending: gated targets of the case on this sims file; info: only non-gated targets ran; not-run: no harness run of this file (e.g. a hero variant) */
export type RefStatus = 'pass' | 'fail' | 'error' | 'pending' | 'info' | 'not-run';

export interface RefInfo {
	status: RefStatus;
	/** ISO date of the run */
	date?: string;
	/** e.g. '7/7 gated' */
	targets?: string;
	/** how it was run: 'harness' (cli.ts with the case's own spec), 'harness-api' (case spec replaced in memory), 'engine' (direct calls) */
	via?: 'harness' | 'harness-api' | 'engine';
	/** repo-relative log path */
	log?: string;
	note?: string;
}

export interface CatalogEntry {
	/** sims file id (sims/<id>.yaml) */
	id: string;
	title: string;
	category: Category;
	/** engine physics module types in the spec */
	physics: string[];
	/** dimension of the model as solved (a 1D case solved on a 2D strip is 2D) */
	dimension: Dim;
	/** paired eval cases (first = the one whose reference `ref` reports) */
	evalCases: string[];
	evalClass: EvalClass[];
	/** `status` field of the first eval case (amp-eval/0) */
	caseStatus?: string;
	ref: RefInfo;
	tags: string[];
	/** has a Play view (sims.ts HEROES) */
	hero?: boolean;
	/** solved with another module's identical equation (e.g. TE cutoffs with the acoustics eigen solver) */
	analog?: string;
}

export const CATEGORIES: ReadonlyArray<{ id: Category; label: string; tip: string }> = [
	{ id: 'heat', label: 'Heat transfer', tip: 'Conduction, convection, radiation; steady and transient' },
	{ id: 'structural', label: 'Structural mechanics', tip: 'Linear elasticity, plane stress / strain, 3D' },
	{ id: 'em-static', label: 'Electrostatics / magnetostatics', tip: 'Capacitance, inductance, static fields' },
	{ id: 'rf', label: 'RF / microwave', tip: 'Cavities, waveguides, transmission lines' },
	{ id: 'optics', label: 'Wave optics / photonics', tip: 'Waveguide modes, photonic band edges' },
	{ id: 'acoustics', label: 'Acoustics', tip: 'Pressure acoustics eigenmodes' },
	{ id: 'fluids-rt', label: 'Fluids / real-time', tip: 'Flow and real-time (Play) kernels' },
	{ id: 'coupled', label: 'Coupled', tip: 'Multiphysics couplings' },
];

const BASE = { date: '2026-11-06' } as const;
const CLI_A = 'logs/W3-eval-class-a-20261106T205440.log';
const CLI_C = 'logs/W3-eval-c-20261106T205756.log';

export const CATALOG_A: CatalogEntry[] = [
	// heat transfer
	{ id: 'nafems-t4', title: 'NAFEMS T4 plate', category: 'heat', physics: ['heat'], dimension: '2D', evalCases: ['HT-01'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '1/1 gated (+1 info)', via: 'harness', log: CLI_A }, tags: ['NAFEMS', 'convection', 'steady'] },
	{ id: 'heat-plate-fin', title: 'Heat-spreading plate', category: 'heat', physics: ['heat'], dimension: '2D', evalCases: ['HT-01'], evalClass: ['a'], caseStatus: 'unvalidated', hero: true,
		ref: { status: 'not-run', note: 'hero model built on NAFEMS T4; the HT-01 gate runs on nafems-t4' }, tags: ['hero', 'convection', 'steady'] },
	{ id: 'nafems-t3', title: 'NAFEMS T3 transient bar', category: 'heat', physics: ['heat'], dimension: '2D', evalCases: ['HT-02'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '1/1 gated (+1 info)', via: 'harness', log: CLI_A }, tags: ['NAFEMS', 'transient', '1D on a strip'] },
	{ id: 'nafems-t2', title: 'NAFEMS T2 radiating rod', category: 'heat', physics: ['heat'], dimension: '2D', evalCases: ['HT-03'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '1/1 gated (+1 info)', via: 'harness', log: CLI_A }, tags: ['NAFEMS', 'radiation', 'nonlinear', '1D on a strip'] },
	{ id: 'semi-infinite-convection', title: 'Semi-infinite solid, sudden convection', category: 'heat', physics: ['heat'], dimension: '2D', evalCases: ['HT-04'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '4/4 gated', via: 'harness', log: CLI_A }, tags: ['Carslaw-Jaeger', 'transient', 'convection', '1D on a strip'] },
	// structural mechanics
	{ id: 'kirsch-plate', title: 'Plate with a hole', category: 'structural', physics: ['elastic'], dimension: '2D', evalCases: ['SM-01', 'SM-02'], evalClass: ['a'], caseStatus: 'unvalidated', hero: true,
		ref: { status: 'not-run', note: 'hero model; the SM-01 gate runs on kirsch-exact' }, tags: ['hero', 'stress concentration', 'plane stress'] },
	{ id: 'kirsch-exact', title: 'Kirsch plate, exact traction', category: 'structural', physics: ['elastic'], dimension: '2D', evalCases: ['SM-01'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '5/5 gated', via: 'harness', log: CLI_A }, tags: ['Kirsch', 'stress concentration', 'plane stress'] },
	{ id: 'nafems-le1', title: 'NAFEMS LE1 elliptic membrane', category: 'structural', physics: ['elastic'], dimension: '2D', evalCases: ['SM-02'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '1/1 gated', via: 'harness', log: CLI_A }, tags: ['NAFEMS', 'plane stress'] },
	{ id: 'lame-cylinder', title: 'Lame thick cylinder (SSLV04A)', category: 'structural', physics: ['elastic'], dimension: '2D', evalCases: ['SM-21'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '7/7 gated', via: 'harness-api', log: 'logs/W3-run-new-20261106T205928.log', note: 'case spec and probe extracts set in memory (case file has no extracts; length unit taken as m)' }, tags: ['Code_Aster', 'Lame', 'pressure', 'plane stress'] },
	// electrostatics / magnetostatics
	{ id: 'coax-line', title: 'Coaxial line', category: 'em-static', physics: ['electrostatics'], dimension: '2D', evalCases: ['EM-01'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '3/3 gated', via: 'harness', log: CLI_A }, tags: ['TEM', 'capacitance', 'Z0'] },
	{ id: 'two-spheres', title: 'Two conducting spheres', category: 'em-static', physics: ['electrostatics'], dimension: 'axisym', evalCases: ['EM-02'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '3/3 gated', via: 'harness', log: CLI_C }, tags: ['Palace', 'capacitance matrix'] },
	{ id: 'helmholtz-em04', title: 'Helmholtz coil (EM-04 gate model)', category: 'em-static', physics: ['magnetostatics'], dimension: 'axisym', evalCases: ['EM-04'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '3/3 gated (2 pending)', via: 'harness', log: CLI_A }, tags: ['coil', 'B field'] },
	{ id: 'helmholtz-coil', title: 'Helmholtz coil', category: 'em-static', physics: ['magnetostatics'], dimension: 'axisym', evalCases: ['EM-04', 'EM-03'], evalClass: ['a', 'c'], caseStatus: 'unvalidated', hero: true,
		ref: { status: 'not-run', note: 'hero model; the EM-04 gate runs on helmholtz-em04' }, tags: ['hero', 'coil', 'B field'] },
	{ id: 'coplanar-rings', title: 'Coplanar current rings', category: 'em-static', physics: ['magnetostatics'], dimension: 'axisym', evalCases: ['EM-03'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '3/3 gated (+1 info)', via: 'harness', log: CLI_C }, tags: ['Palace', 'inductance matrix'] },
	// RF / microwave
	{ id: 'cylinder-cavity-axisym', title: 'Cylindrical cavity eigenmodes (axisymmetric)', category: 'rf', physics: ['emw-axisym'], dimension: 'axisym', evalCases: ['RF-21', 'RF-01'], evalClass: ['a', 'c'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: '6/6 gated', via: 'harness', log: CLI_A, note: 'RF-01 (class c): frequencies info only, 2 Q targets pending (no conductor-loss Q)' }, tags: ['cavity', 'eigenmodes', 'Palace'] },
	{ id: 'cylinder-cavity-qd', title: 'Cylindrical cavity, dielectric Q (3D)', category: 'rf', physics: ['emw'], dimension: '3D', evalCases: ['RF-21'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'info', targets: 'Q_dielectric (non-gated)', via: 'harness', log: CLI_A }, tags: ['cavity', 'eigenmodes', 'loss'] },
	{ id: 'cylinder-cavity', title: 'Cylindrical cavity eigenmodes', category: 'rf', physics: ['emw'], dimension: '3D', evalCases: ['RF-21', 'RF-01'], evalClass: ['a', 'c'], caseStatus: 'unvalidated', hero: true,
		ref: { status: 'not-run', note: 'hero model (3D); the RF-21 gate runs on cylinder-cavity-axisym' }, tags: ['hero', 'cavity', 'eigenmodes'] },
	{ id: 'wr90-te-cutoffs', title: 'WR-90 TE cutoffs (scalar analog)', category: 'rf', physics: ['acoustics'], dimension: '2D', evalCases: ['RF-02'], evalClass: ['a'], caseStatus: 'unvalidated',
		analog: 'TE cutoffs = Neumann eigenvalues of the cross-section, solved with the acoustics eigen solver at c = c0',
		ref: { ...BASE, status: 'pass', targets: '3/3 gated (2 S-parameter targets pending)', via: 'harness-api', log: 'logs/W3-run-new-20261106T205928.log', note: 'case spec and eigen extracts set in memory' }, tags: ['waveguide', 'cutoff', 'analog'] },
	// wave optics / photonics
	{ id: 'si-slab-te0', title: 'Si slab waveguide TE0', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-01'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: 'neff_TE0 gated', via: 'harness', log: CLI_A }, tags: ['slab', 'mode solver', 'SOI'] },
	{ id: 'si-slab-tm0', title: 'Si slab waveguide TM0', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-01'], evalClass: ['a'], caseStatus: 'unvalidated',
		ref: { ...BASE, status: 'pass', targets: 'neff_TM0 gated', via: 'harness', log: CLI_A }, tags: ['slab', 'mode solver', 'SOI'] },
	{ id: 'si-rib-waveguide', title: 'Rib waveguide modes', category: 'optics', physics: ['em-modes'], dimension: '2D', evalCases: ['WO-02', 'WO-01'], evalClass: ['b', 'a'], caseStatus: 'unvalidated', hero: true,
		ref: { status: 'pending', note: 'WO-02 spec pending in the case (slab-thickness sweep targets not in the harness)' }, tags: ['hero', 'rib', 'mode solver', 'SOI'] },
	{ id: 'bragg-edge-lower', title: 'Bragg stack, lower gap edge (scalar analog)', category: 'optics', physics: ['acoustics'], dimension: '2D', evalCases: ['WO-21'], evalClass: ['a'], caseStatus: 'unvalidated',
		analog: 'normal-incidence scalar wave equation (c = c0 / n, uniform rho); zone-edge mode of the half cell',
		ref: { ...BASE, status: 'pass', targets: '3/3 with bragg-edge-upper', via: 'engine', log: 'logs/W3-run-bragg-20261106T205736.log', note: 'ratios f / f0 computed in the run script; relative error <= 2e-9 at the finest level' }, tags: ['photonic crystal', 'band gap', 'analog', '1D on a strip'] },
	{ id: 'bragg-edge-upper', title: 'Bragg stack, upper gap edge (scalar analog)', category: 'optics', physics: ['acoustics'], dimension: '2D', evalCases: ['WO-21'], evalClass: ['a'], caseStatus: 'unvalidated',
		analog: 'normal-incidence scalar wave equation (c = c0 / n, uniform rho); zone-edge mode of the half cell',
		ref: { ...BASE, status: 'pass', targets: '3/3 with bragg-edge-lower', via: 'engine', log: 'logs/W3-run-bragg-20261106T205736.log', note: 'ratios f / f0 computed in the run script; relative error <= 2e-9 at the finest level' }, tags: ['photonic crystal', 'band gap', 'analog', '1D on a strip'] },
	// acoustics
	{ id: 'box-acoustics', title: 'Room acoustics, box modes', category: 'acoustics', physics: ['acoustics'], dimension: '3D', evalCases: ['AC-02'], evalClass: ['a'], caseStatus: 'unvalidated', hero: true,
		ref: { ...BASE, status: 'pass', targets: '10/10 gated', via: 'harness', log: CLI_A }, tags: ['hero', 'room modes', 'eigenmodes'] },
];

/** Every catalog entry (class a + existing sims here, W4 class b / c in catalog-bc.ts); first entry per id wins. */
export const CATALOG: CatalogEntry[] = (() => {
	const seen = new Set<string>();
	return [...CATALOG_A, ...CATALOG_BC].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
})();

export interface Filters {
	categories?: readonly Category[];
	physics?: readonly string[];
	dims?: readonly Dim[];
	classes?: readonly EvalClass[];
}

/** Case-insensitive match of every whitespace-separated word against id, title, physics, case ids, tags, category. */
export function matches(e: CatalogEntry, query: string, f: Filters = {}): boolean {
	if (f.categories?.length && !f.categories.includes(e.category)) return false;
	if (f.physics?.length && !e.physics.some((p) => f.physics!.includes(p))) return false;
	if (f.dims?.length && !f.dims.includes(e.dimension)) return false;
	if (f.classes?.length && !e.evalClass.some((c) => f.classes!.includes(c))) return false;
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const cat = CATEGORIES.find((c) => c.id === e.category)?.label ?? '';
	const hay = [e.id, e.title, cat, ...e.physics, ...e.evalCases, ...e.tags, e.analog ?? ''].join(' ').toLowerCase();
	return words.every((w) => hay.includes(w));
}

/** Catalog restricted to the sims files that exist (`available` = sims.ts SIM_IDS), plus bare entries for files without one. */
export function libraryFor(available: readonly string[], entries: readonly CatalogEntry[] = CATALOG): { entries: CatalogEntry[]; uncatalogued: string[] } {
	const have = new Set(available);
	const listed = new Set(entries.map((e) => e.id));
	return { entries: entries.filter((e) => have.has(e.id)), uncatalogued: available.filter((id) => !listed.has(id)) };
}

/** Tooltip text of an entry: eval case(s), reference, run status, physics. */
export function entryTip(e: CatalogEntry): string {
	const r = e.ref;
	const lines = [
		`${e.title} (sims/${e.id}.yaml)`,
		`Eval: ${e.evalCases.join(', ') || 'none'}${e.evalClass.length ? ` (class ${e.evalClass.join(' / ')})` : ''}${e.caseStatus ? `, case ${e.caseStatus}` : ''}`,
		`Reference: ${r.status}${r.targets ? `, ${r.targets}` : ''}${r.date ? `, ${r.date}` : ''}${r.via ? ` (${r.via})` : ''}`,
	];
	if (r.note) lines.push(r.note);
	if (r.log) lines.push(`log: ${r.log}`);
	lines.push(`Physics: ${e.physics.join(', ')}; ${e.dimension}`);
	if (e.analog) lines.push(`Analog: ${e.analog}`);
	if (e.tags.length) lines.push(`Tags: ${e.tags.join(', ')}`);
	return lines.join('\n');
}
