// SPDX-License-Identifier: GPL-3.0-or-later
// Hero example texts for tests and gates: frozen fixtures under test/fixtures (DevLog-003 s.10), independent of the
// live sims/ files, which lane I1 owns. The live files are covered by test/sims-live.test.ts only.
import { readFileSync, readdirSync } from 'node:fs';

export const HEROES = ['kirsch-plate', 'heat-plate-fin', 'helmholtz-coil', 'si-rib-waveguide', 'cylinder-cavity', 'box-acoustics'] as const;
export const FIXTURES = new URL('./fixtures/', import.meta.url);
export const SIMS = new URL('../../../sims/', import.meta.url);

/** Frozen fixture text (copy of the L2 hero spec, 2026-11-06). */
export const readHero = (id: string): string => readFileSync(new URL(`${id}.yaml`, FIXTURES), 'utf8');
export const fixtureIds = (): string[] => readdirSync(FIXTURES).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort();
