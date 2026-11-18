// SPDX-License-Identifier: GPL-3.0-or-later
// Eigenmode table data: one row per mode (solution step of an eigen solution) with the step value (frequency in Hz,
// or n_eff for mode solvers whose step unit is 1) and every per-mode scalar the physics module reports, named
// `<name>_<k>` with k the 0-based step index (`Q_k`, `neff_k`, `ng_k`, `lossDbPerM_k`, `ezFraction_k`, ...; merged
// multiphysics solutions prefix `<physics>.`). Pair scalars (`g0_i_j`) are not per mode and are left out. A scalar
// column that repeats the step value is dropped. Values are shown as reported (no recomputation).
import type { Solution } from '@amp/spec/types';

export interface ModeColumn { key: string; name: string; unit: string }
export interface ModeRow { k: number; value: number; cells: Array<number | null> }
export interface ModeTable { stepName: string; stepUnit: string; columns: ModeColumn[]; rows: ModeRow[] }

const PER_MODE = /^(.*[^\d_])_(\d+)$/;

export function modeTable(sol: Pick<Solution, 'steps' | 'scalars'> | null | undefined): ModeTable | null {
	const st = sol?.steps;
	if (!st || st.kind !== 'eigen' || !st.values.length) return null;
	const n = st.values.length;
	const hz = st.unit === 'Hz';
	const cols = new Map<string, { unit: string; v: Array<number | null> }>();
	for (const [key, s] of Object.entries(sol!.scalars ?? {})) {
		const m = PER_MODE.exec(key);
		if (!m) continue;
		const base = m[1]!, k = Number(m[2]);
		// pair scalars g0_i_j: the base itself ends in _<digits>
		if (/_\d+$/.test(base) || k >= n) continue;
		const c = cols.get(base) ?? { unit: s.unit, v: new Array<number | null>(n).fill(null) };
		cols.set(base, c);
		c.v[k] = Number.isFinite(s.value) ? s.value : null;
	}
	// a column equal to the step value (f_k for Hz steps, neff_k for n_eff steps) repeats it
	for (const [base, c] of cols) {
		const same = c.v.every((x, k) => x === null || Math.abs(x - st.values[k]!) <= 1e-12 * Math.max(1, Math.abs(st.values[k]!)));
		if (same && c.unit === st.unit && c.v.some((x) => x !== null)) cols.delete(base);
	}
	const columns = [...cols].map(([name, c]) => ({ key: name, name, unit: c.unit === '1' ? '' : c.unit }));
	const rows = Array.from({ length: n }, (_, k) => ({ k, value: st.values[k]!, cells: [...cols.values()].map((c) => c.v[k] ?? null) }));
	const neff = st.unit === '1' && Object.keys(sol!.scalars ?? {}).some((k) => /(^|\.)neff(_\d+)?$/.test(k));
	return { stepName: hz ? 'f' : neff ? 'n_eff' : 'eigenvalue', stepUnit: st.unit === '1' ? '' : st.unit, columns, rows };
}
