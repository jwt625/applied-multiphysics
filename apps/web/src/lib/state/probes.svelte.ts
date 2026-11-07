// SPDX-License-Identifier: GPL-3.0-or-later
// Probe table of one workbench (DevLog-020 s.1.4): rows added by clicks in the Results view, shown in the bottom
// panel's Table tab and marked on the plot. UI state only (not in the operation log, not in the spec).
import { nowIso } from '../engine/protocol';
import type { ProbeRow } from '../post/probe';

export class ProbeTable {
	rows = $state.raw<ProbeRow[]>([]);
	private n = 0;
	add(r: Omit<ProbeRow, 'n' | 'ts'>): ProbeRow {
		const row = { ...r, n: ++this.n, ts: nowIso() };
		this.rows = [...this.rows, row];
		return row;
	}
	remove(n: number) { this.rows = this.rows.filter((r) => r.n !== n); }
	clear() { this.rows = []; this.n = 0; }
}
