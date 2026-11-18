// SPDX-License-Identifier: GPL-3.0-or-later
// Patch builders behind the agent's edit_tree and define_sweep tools (DevLog-053): the workbench's own tree and sweep
// builders (state/edit-ops.ts, state/sweep.ts, DevLog-051), so an agent edit is the same patch a tree action or the
// sweep editor makes. The agent session applies each patch through its op log (one agent op with the reason).
import type { ModelEditor } from '@amp/agent';
import { validateSpec, type Registry } from '@amp/spec';
import { modelAddMenu, treeOpPatch } from '../state/edit-ops.ts';
import { removeSweepPatch, setSweepPatch, sweepDefOf } from '../state/sweep.ts';

/** Tree and sweep patch builders of the workbench (state/edit-ops.ts, state/sweep.ts) for edit_tree and define_sweep;
 *  the agent session applies each patch through its own op log. A new sweep becomes the chosen study (as the editor). */
export function modelEditor(reg: Registry, choose?: (id: string) => void): ModelEditor {
	return {
		treeOp: (data, op) => treeOpPatch(data, op, { reg, validate: (d) => validateSpec(d, reg).issues }),
		addChoices: (data, parent) => modelAddMenu(data, reg, parent).map((m) => ({ type: m.type, ...(m.disabled ? { disabled: m.disabled } : {}) })),
		sweepSet: (data, def) => setSweepPatch(data, def),
		sweepRemove: (data, id) => removeSweepPatch(data, id),
		sweepGet: (data, id) => sweepDefOf(data, id),
		...(choose ? { chooseStudy: choose } : {})
	};
}

