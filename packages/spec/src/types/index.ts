// SPDX-License-Identifier: GPL-3.0-or-later
// Shared contract types (CONTRACTS-v0: "all shared types live in packages/spec/src/types/").
export type * from './mesh.ts';
export type * from './solution.ts';
export type * from './physics.ts';
export type * from './worker.ts';
export type { Operation, Genesis, TextDelta, OpKind, OpMeta, Effect, ApplyOptions } from '../oplog.ts';
export type { JsonPatchOp } from '../patch.ts';
export type { Artifact } from '../invalidation.ts';
export type { Spec, FeatureNode, PhysicsNode, BcNode, CouplingNode, StudyNode, MaterialNode, ResultNode, MeshBlock, ParamDef, ProvenanceEntry } from '../schema.ts';
export type { Actor } from '../ids.ts';
