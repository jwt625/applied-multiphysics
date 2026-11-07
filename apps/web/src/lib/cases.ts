// SPDX-License-Identifier: GPL-3.0-or-later
// Eval case paired with each hero (DevLog-010 s.1.3 gate table, DevLog-003 s.4.2). The heroes' own material values are
// N/A in sims/*.yaml (no authored source yet); the paired eval case carries sourced benchmark values in its `materials`
// block, which @amp/physics prepareRun uses for N/A properties when the case is passed. The UI shows which case
// supplied them (with its source text) and the user can switch it off.
import { parseYaml } from '@amp/spec';

export const SIM_CASE: Record<string, string> = {
	'kirsch-plate': 'a/SM-01',
	'heat-plate-fin': 'a/HT-01',
	'helmholtz-coil': 'a/EM-04',
	'si-rib-waveguide': 'b/WO-02',
	'cylinder-cavity': 'a/RF-21',
	'box-acoustics': 'a/AC-02'
};

const files = import.meta.glob<string>('../../../../eval/cases/*/*.yaml', { query: '?raw', import: 'default' });

export interface CaseInfo { id: string; data: Record<string, unknown>; materials: string }

export async function loadCaseFor(simId: string): Promise<CaseInfo | null> {
	const key = SIM_CASE[simId];
	if (!key) return null;
	const load = Object.entries(files).find(([p]) => p.endsWith(`/${key}.yaml`))?.[1];
	if (!load) return null;
	const y = parseYaml(await load());
	if (!y.data || typeof y.data !== 'object') return null;
	const data = y.data as Record<string, unknown>;
	const mats = (data.materials ?? {}) as Record<string, Record<string, unknown>>;
	const materials = Object.entries(mats).map(([k, v]) => `${k}: ${Object.entries(v).filter(([p]) => p !== 'source').map(([p, x]) => `${p} ${x}`).join(', ')} (source: ${String(v.source ?? 'not stated')})`).join('\n');
	return { id: key.split('/')[1]!, data, materials };
}
