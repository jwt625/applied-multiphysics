// SPDX-License-Identifier: GPL-3.0-or-later
// Hero example texts for tests and gates. sims/ is owned by lane I1 (coordinator 2026-11-06); known breaks caused by
// spec changes are listed in DevLog-003 s.9 for I1, and patched here in memory only so the gates keep their coverage.
import { readFileSync } from 'node:fs';

export const HEROES = ['kirsch-plate', 'heat-plate-fin', 'helmholtz-coil', 'si-rib-waveguide', 'cylinder-cavity', 'box-acoustics'] as const;
const SIMS = new URL('../../../sims/', import.meta.url);

/** Raw file text. */
export const readSim = (id: string): string => readFileSync(new URL(`${id}.yaml`, SIMS), 'utf8');

/**
 * Known breaks pending I1 (contracts v1): si-rib-waveguide uses the param name `t`, now a reserved field symbol.
 * In-memory port: rename the param to t_slab. Applied only when the file still has the old name.
 */
const PORTS: Record<string, (t: string) => string> = {
  'si-rib-waveguide': (t) => (/^ {2}t: /m.test(t)
    ? t.replace(/^ {2}t: /m, '  t_slab: ').replace('["W_win", "t"]', '["W_win", "t_slab"]').replace('"t/2"', '"t_slab/2"').replace('"t/4"', '"t_slab/4"').replace('{param: t,', '{param: t_slab,').replace('params.t: {', 'params.t_slab: {')
    : t),
};

/** Text used by tests and gates: the file with any pending in-memory port applied. */
export const readHero = (id: string): string => (PORTS[id] ?? ((t: string) => t))(readSim(id));
