// SPDX-License-Identifier: GPL-3.0-or-later
// C4 / C5 types from @amp/spec (packages/spec/src/types, lane L2). Imported by relative path until @amp/eval lists
// "@amp/spec": "workspace:*" and the workspace is re-installed (contract request in DevLog-009 s.7); then switch the
// specifier to '@amp/spec/types'. Type-only: erased at run time.

export type { FieldSpace, FieldData, Platform, RunRecord, Solution, RunContext, PhysicsModule, Mesh } from '../../spec/src/types/index.ts';
