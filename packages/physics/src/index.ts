// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/physics (C4): physics modules, the registry of modules for the eval harness (`modules`, `registry`), the
// `prepareRun` hook (spec + eval case -> RunContext), and the spec registrations of the physics types.
// Every exported module is wrapped: readiness adds the spec-level checks (N/A values, T0, nModes; audit S4); run
// checks readiness on the prepared spec, merges the prepareRun stage times (validate, geometry + mesh, materials) into
// Solution.timing (audit S5), and attaches `notes` (prepareRun notes incl. mesh warnings; audit S7) and the eigenvector
// `normalization` statement (L5 request 7).

import type { PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { heatModule as heat0 } from './heat/index.ts';
import { elasticModule as elastic0 } from './elastic/index.ts';
import { electrostaticsModule as es0 } from './electrostatics/index.ts';
import { magnetostaticsModule as ms0 } from './magnetostatics/index.ts';
import { emModes as modes0 } from './modes/index.ts';
import { emwModule as emw0 } from './em3d/index.ts';
import { acousticsModule as ac0 } from './acoustics/index.ts';
import { specReadiness, type ReadinessNeeds } from './common/ctx.ts';

export type SolutionExt = Solution & { notes?: string[]; normalization?: string };

const NEEDS: Record<string, ReadinessNeeds> = {
  heat: { props: ['k'], t0: true },
  elastic: { props: ['E', 'nu'] },
  electrostatics: { props: ['eps_r'] },
  magnetostatics: { props: ['mu_r'] },
  'em-modes': { props: [] },             // n or eps_r: checked by the module (either one)
  emw: { props: ['eps_r', 'mu_r'], eigen: true },
  acoustics: { props: ['c'], propsIfMulti: ['rho'], eigen: true },
};

export const NORMALIZATION: Record<string, string> = {
  emw: 'E (NED coefficients and E_nodal) per mode is M-orthonormal: int eps_r E . E dV = 1 V^2 m (arbitrary amplitude and sign)',
  acoustics: 'p per mode is M-orthonormal: int p^2 / (rho c^2) dV = 1 (rho = 1 kg/m^3 when a single fluid has no density); arbitrary sign',
  'em-modes': 'fields per mode scaled to max |E| = 1 V/m over the triangle centroids (EO convention: E_t, H_t real, E_z = j ez, H_z = j hz)',
};

function wrap(m: PhysicsModule): PhysicsModule {
  const needs = NEEDS[m.type];
  return {
    type: m.type,
    dims: m.dims,
    readiness(spec, physicsId) {
      const r = m.readiness(spec, physicsId);
      let extra: string[] = [];
      try { extra = needs ? specReadiness(spec as Spec, physicsId, needs) : []; } catch (e) { extra = [(e as Error).message]; }
      const reasons = [...r.reasons, ...extra.filter((x) => !r.reasons.includes(x))];
      return { ready: reasons.length === 0, reasons };
    },
    async run(ctx: RunContext) {
      const rd = this.readiness(ctx.spec, ctx.physicsId);
      if (!rd.ready) throw new Error(`${m.type} not ready: ${rd.reasons.join('; ')}`);
      const c = ctx as RunContext & { timing?: Record<string, number>; notes?: string[] };
      const sol = (await m.run(ctx)) as SolutionExt;
      if (c.timing) sol.timing = { ...c.timing, ...sol.timing };
      const notes = [...(c.notes ?? []), ...((ctx.mesh as { warnings?: string[] }).warnings ?? []).map((w) => `mesh warning: ${w}`)];
      if (notes.length) sol.notes = [...new Set([...(sol.notes ?? []), ...notes])];
      if (NORMALIZATION[m.type]) sol.normalization = NORMALIZATION[m.type];
      return sol;
    },
  };
}

export const heatModule = wrap(heat0);
export const elasticModule = wrap(elastic0);
export const electrostaticsModule = wrap(es0);
export const magnetostaticsModule = wrap(ms0);
export const emModes = wrap(modes0);
export const emwModule = wrap(emw0);
export const acousticsModule = wrap(ac0);

export const modules: PhysicsModule[] = [heatModule, elasticModule, electrostaticsModule, magnetostaticsModule, emModes, emwModule, acousticsModule];
export const registry: Record<string, PhysicsModule> = Object.fromEntries(modules.map((x) => [x.type, x]));

export { solveHeat, SIGMA_SB, type HeatProblem, type HeatBc } from './heat/index.ts';
export { solveElastic, stressErrorL2, dMatrix, type ElasticProblem, type ElasticBc } from './elastic/index.ts';
export { solveElectrostatics, EPS0, MU0, type ElectrostaticsProblem } from './electrostatics/index.ts';
export { solveMagnetostatics, type MagnetostaticsProblem } from './magnetostatics/index.ts';
export { solveModes } from './modes/index.ts';
export { solveCavity } from './em3d/index.ts';
export { solveAcousticModes } from './acoustics/index.ts';
export { prepareRun, type PrepareArgs, type CaseCtx, type MaterialLibrary } from './prepare.ts';
export { physicsRegistry, registerPhysics, L4_REGISTRATIONS, RESULT_NAMES } from './registrations.ts';
export { ENGINE, PHYSICS_VERSION } from './common/solution.ts';
export { compileField, type FieldValue } from './common/field.ts';
