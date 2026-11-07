// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/physics (C4): physics modules, the registry of modules for the eval harness (`modules`, `registry`), the
// `prepareRun` hook (spec + eval case -> RunContext), and the spec registrations of the physics types.

import type { PhysicsModule } from '@amp/spec/types';
import { heatModule } from './heat/index.ts';
import { elasticModule } from './elastic/index.ts';
import { electrostaticsModule } from './electrostatics/index.ts';
import { magnetostaticsModule } from './magnetostatics/index.ts';
import { emModes } from './modes/index.ts';
import { emwModule } from './em3d/index.ts';
import { acousticsModule } from './acoustics/index.ts';

export const modules: PhysicsModule[] = [heatModule, elasticModule, electrostaticsModule, magnetostaticsModule, emModes, emwModule, acousticsModule];
export const registry: Record<string, PhysicsModule> = Object.fromEntries(modules.map((m) => [m.type, m]));

export { heatModule, solveHeat, SIGMA_SB, type HeatProblem, type HeatBc } from './heat/index.ts';
export { elasticModule, solveElastic, stressErrorL2, dMatrix, type ElasticProblem, type ElasticBc } from './elastic/index.ts';
export { electrostaticsModule, solveElectrostatics, EPS0, MU0, type ElectrostaticsProblem } from './electrostatics/index.ts';
export { magnetostaticsModule, solveMagnetostatics, type MagnetostaticsProblem } from './magnetostatics/index.ts';
export { emModes, solveModes } from './modes/index.ts';
export { emwModule, solveCavity } from './em3d/index.ts';
export { acousticsModule, solveAcousticModes } from './acoustics/index.ts';
export { prepareRun, type PrepareArgs, type CaseCtx } from './prepare.ts';
export { physicsRegistry, registerPhysics, L4_REGISTRATIONS, RESULT_NAMES } from './registrations.ts';
export { ENGINE, PHYSICS_VERSION } from './common/solution.ts';
