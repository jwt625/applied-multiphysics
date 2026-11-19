// SPDX-License-Identifier: GPL-3.0-or-later
// Example library entries for the driven 2D wave optics and RF sims (frequency-domain Helmholtz with PML and ports).
// Shape: CatalogEntry from ./catalog.ts (type-only import). One entry per new sims/<id>.yaml; `ref` records run
// outcomes only (pass / fail / pending / info / not-run, ISO date, repo-relative log), never physical values.
// Numbers and references: DevLog-047 s.4.

import type { CatalogEntry } from './catalog';

export const CATALOG_DRIVEN: CatalogEntry[] = [
	// scattering (plane wave, PML, far field)
	{ id: 'si-nanowire-scattering', title: 'Silicon nanowire scattering (TM plane wave)', category: 'optics', physics: ['emw-2d'], dimension: '2D',
		evalCases: ['WO-70'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', targets: '18/18 gated (2 mesh levels, 3 wavelengths)', via: 'harness', log: 'logs/eval-20261118T141640.jsonl', note: 'scattering width back / forward / total vs the Bessel series' },
		tags: ['scattering', 'Mie', 'nanowire', 'silicon', 'PML', 'far field', 'scattering width', 'plane wave', '1550 nm', 'author model inputs'] },
	{ id: 'pec-post-scattering', title: 'Metal post scattering at 10 GHz (TM plane wave)', category: 'rf', physics: ['emw-2d'], dimension: '2D',
		evalCases: ['RF-70'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', targets: '6/6 gated (2 mesh levels)', via: 'harness', log: 'logs/eval-20261118T141637.jsonl', note: 'scattering width back / forward / total vs the Bessel series (Balanis 2012)' },
		tags: ['scattering', 'PEC', 'cylinder', 'radar cross section', 'PML', 'far field', 'plane wave', 'Balanis', 'author model inputs'] },
	// ports and S-parameters
	{ id: 'bragg-mirror-ports', title: 'Bragg mirror reflection spectrum (Si3N4 / SiO2 quarter-wave stack)', category: 'optics', physics: ['emw-2d'], dimension: '2D',
		evalCases: ['WO-71'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', targets: '42/42 gated (2 mesh levels, 5 wavelengths, normal and oblique)', via: 'harness', log: 'logs/eval-20261118T141651.jsonl', note: '|S11|, |S21| vs the transfer matrix; peak reflectance vs the quarter-wave closed form' },
		tags: ['Bragg', 'DBR', 'thin film', 'transfer matrix', 'S-parameters', 'ports', 'stopband', 'silicon nitride', 'author model inputs'] },
	{ id: 'mmi-1x2-splitter', title: 'MMI 1x2 power splitter (silicon, 2D in-plane model)', category: 'optics', physics: ['emw-2d'], dimension: '2D',
		evalCases: ['WO-72'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', targets: '18/18 gated (2 mesh levels, 3 wavelengths)', via: 'harness', log: 'logs/eval-20261118T141705.jsonl', note: '|S11|, |S21| vs eigenmode expansion; reciprocity, energy and balance' },
		tags: ['MMI', 'splitter', 'self-imaging', 'silicon photonics', 'S-parameters', 'ports', 'eigenmode expansion', 'reciprocity', 'author model inputs'] },
	{ id: 'ring-resonator-bus', title: 'Add-drop ring resonator (silicon, 2D in-plane model)', category: 'optics', physics: ['emw-2d'], dimension: '2D',
		evalCases: ['WO-73'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', targets: '8/8 gated (2 mesh levels): reciprocity and energy', via: 'harness', log: 'logs/eval-20261118T141734.jsonl', note: 'resonances, free spectral range and loaded Q vs the exact isolated-ring modes: scripted scan on two mesh levels (not a harness gate)' },
		tags: ['ring resonator', 'add-drop', 'microring', 'free spectral range', 'Q factor', 'whispering gallery', 'silicon photonics', 'S-parameters', 'author model inputs'] },
	// acoustics, frequency domain
	{ id: 'acoustic-duct', title: 'Duct with a matched end (plane wave)', category: 'acoustics', physics: ['acoustics'], dimension: '2D',
		evalCases: ['AC-01'], evalClass: ['b'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', targets: '2/2 gated (max and min along the axis)', via: 'harness', log: 'logs/eval-20261118T141921.jsonl', note: 'pressure magnitude vs rho c v along the duct (EAA benchmark duct, 2D)' },
		tags: ['duct', 'plane wave', 'impedance', 'frequency domain', 'EAA benchmark', 'Hornikx 2015'] },
	// grating coupler (photonics examples, part 2)
	{ id: 'si-grating-coupler-2d', title: 'SOI grating coupler, upward power (2D)', category: 'optics', physics: ['emw-2d'], dimension: '2D',
		evalCases: ['WO-74'], evalClass: ['c'], caseStatus: 'unvalidated',
		ref: { status: 'pass', date: '2026-11-18', targets: '4/4 gated (2 mesh levels) + 10 info', via: 'harness', log: 'logs/G5-cli-final-20261118T190421.log', note: 'input-mode index vs the exact slab, Poynting balance; upward fraction vs Taillaert et al. 2006 Fig. 3 informative (number of periods not given in the paper)' },
		tags: ['grating coupler', 'SOI', 'fiber coupling', 'directionality', 'Poynting flux', 'PML', 'ports', 'Taillaert 2006'] },
];
