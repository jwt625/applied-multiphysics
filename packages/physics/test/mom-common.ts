// SPDX-License-Identifier: GPL-3.0-or-later
// Shared setup of the lane MOM tests (DevLog-034): load a sim with the optomechanical coupling, prepare and run it.
// Until couplings/index.ts lists OPTOMECH_COUPLINGS (request to MC, DevLog-034 s.5), prepareRun's validation does not
// know the type: the coupling node (and its provenance / assumption paths) is removed before prepareRun and put back
// into the prepared spec, and runStudy gets the coupling list explicitly. Once registered, the spec goes through as is.

import { existsSync, readFileSync } from 'node:fs';
import { parseSpecText } from '@amp/spec';
import type { Spec, Solution } from '@amp/spec/types';
import { physicsRegistry, prepareRun, runStudy, COUPLINGS } from '../src/index.ts';
import { OPTOMECH_COUPLINGS, OPTOMECH_REGISTRATIONS } from '../src/couplings/optomech.ts';

export const root = new URL('../../../', import.meta.url).pathname;
const registered = COUPLINGS.some((c) => c.type === 'optomechanical');
export const couplings = registered ? COUPLINGS : [...COUPLINGS, ...OPTOMECH_COUPLINGS];

export function registry() {
  const reg = physicsRegistry();
  if (!registered) for (const r of OPTOMECH_REGISTRATIONS) reg.register(r);
  return reg;
}

/** sims/<id>.yaml, else the staged copy validation/mom/sims/<id>.yaml (held there until R-MC1 registers the coupling type:
 *  the spec package's live-sims test validates every sims/*.yaml against the registry). */
export function loadSim(id: string): Spec {
  const path = existsSync(`${root}sims/${id}.yaml`) ? `${root}sims/${id}.yaml` : `${root}validation/mom/sims/${id}.yaml`;
  const parsed = parseSpecText(readFileSync(path, 'utf8'), registry()) as { data: unknown; issues?: unknown[] };
  if (parsed.issues?.length) throw new Error(`sims/${id}.yaml: ${JSON.stringify(parsed.issues)}`);
  return parsed.data as Spec;
}

export async function prepare(spec: Spec) {
  const s = structuredClone(spec) as Spec & { couplings?: unknown[]; provenance?: { values?: Record<string, unknown> }; assumptions?: Array<string | { paths?: string[] }> };
  const cpl = s.couplings;
  if (!registered) {
    delete s.couplings;
    for (const k of Object.keys(s.provenance?.values ?? {})) if (k.startsWith('couplings.')) delete s.provenance!.values![k];
    if (s.assumptions) s.assumptions = s.assumptions.filter((a) => typeof a === 'string' || !(a.paths ?? []).some((x: string) => x.startsWith('couplings')));
  }
  const p = await prepareRun(s as Spec, {});   // default Node material library (the sim uses ref: materials/gaas since 2026-11-07)
  if (!registered) (p.spec as { couplings?: unknown[] }).couplings = cpl;
  return p;
}

export type Sol = Solution & { notes?: string[]; normalization?: string };
export const sv = (sol: Solution, k: string): number => { const v = sol.scalars[k]; if (!v) throw new Error(`no scalar '${k}'`); return v.value; };

export async function run(spec: Spec): Promise<{ p: Awaited<ReturnType<typeof prepare>>; sol: Sol }> {
  const p = await prepare(spec);
  return { p, sol: (await runStudy(p, { couplings })) as Sol };
}
