// SPDX-License-Identifier: GPL-3.0-or-later
// C4 physics module interface (CONTRACTS-v0). Spec = amp-spec/0 data validated by @amp/spec.

import type { Spec, StudyNode } from '../schema.ts';
import type { Mesh } from './mesh.ts';
import type { Solution } from './solution.ts';
import type { SpaceDim } from '../registry.ts';

export interface RunContext {
  spec: Spec;
  physicsId: string;
  mesh: Mesh;
  /** Resolved material properties per material id (SI values); the resolver lives with the materials package. */
  materials: Record<string, Record<string, number>>;
  study: StudyNode;
  progress(stage: string, frac: number, msg?: string): void;
  signal: AbortSignal;
  /** Coupled inputs from upstream physics, filled by the study driver for downstream physics (C11). */
  inputs?: CoupledInput[];
}

/** One upstream result mapped for a downstream physics by a coupling (C11); kind = coupling type. */
export interface CoupledInput { coupling: string; from: string; kind: string; data: Record<string, unknown> }

export interface PhysicsModule {
  type: string;
  dims: SpaceDim[];
  readiness(spec: Spec, physicsId: string): { ready: boolean; reasons: string[] };
  run(ctx: RunContext): Promise<Solution>;
}
