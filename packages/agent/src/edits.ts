// SPDX-License-Identifier: GPL-3.0-or-later
// Model-tree and sweep-definition edits for the agent (DevLog-053). The host supplies pure patch builders (the web
// app: state/edit-ops.ts treeOpPatch, state/sweep.ts setSweepPatch / removeSweepPatch); the session applies each
// patch through its own operation log, so every edit is one agent op with the reason, undoable and revertible.

import type { JsonPatchOp } from '@amp/spec';

export type TreeOp =
  | { op: 'add'; parent: string; type: string; id?: string }
  | { op: 'delete'; pointer: string }
  | { op: 'duplicate'; pointer: string; id?: string }
  | { op: 'rename'; pointer: string; id: string };

export interface SweepAxisDef { param: string; mode: 'values' | 'range'; values: string[]; start: string; stop: string; n: number; unit: string }
/** id: the parametric study (new or existing); study: the inner study it sweeps. */
export interface SweepDef { id: string; study: string; axes: SweepAxisDef[] }

export type EditPatch = { ok: true; patch: JsonPatchOp[]; id: string; pointer: string; note?: string } | { ok: false; reason: string };

export interface ModelEditor {
  treeOp(data: unknown, op: TreeOp): EditPatch;
  /** node types allowed under a parent pointer (a disabled one carries the reason) */
  addChoices?(data: unknown, parent: string): Array<{ type: string; disabled?: string }>;
  sweepSet(data: unknown, def: SweepDef): EditPatch;
  sweepRemove(data: unknown, id: string): EditPatch;
  sweepGet(data: unknown, id: string): SweepDef | null;
  /** after a sweep definition is applied: make it the study the host runs (workbench study picker) */
  chooseStudy?(id: string): void;
}
