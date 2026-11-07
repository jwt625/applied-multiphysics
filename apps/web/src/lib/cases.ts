// SPDX-License-Identifier: GPL-3.0-or-later
// Eval case paired with a model (the `# eval: [...]` line of its sims file). Since 2026-11-06 16:48 the heroes carry
// their own material values; the case is passed to prepareRun only when the user switches it on (e.g. a model with an
// N/A property), and the UI credits it only for the properties prepareRun reports it filled (audit S2).
import { parseYaml } from '@amp/spec';

/** Paired eval cases from the `# eval: [ID, ...]` line of a sims file (I1 convention until amp-spec has a field). */
export function pairedCases(specText: string): string[] {
	const m = /^#\s*eval:\s*\[([^\]]*)\]/m.exec(specText);
	return m ? m[1]!.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

const files = import.meta.glob<string>('../../../../eval/cases/*/*.yaml', { query: '?raw', import: 'default' });

export interface CaseInfo { id: string; data: Record<string, unknown>; materials: string }

export async function loadCaseFor(_simId: string, specText: string): Promise<CaseInfo | null> {
	const id = pairedCases(specText)[0];
	if (!id) return null;
	const load = Object.entries(files).find(([p]) => p.endsWith(`/${id}.yaml`))?.[1];
	if (!load) return null;
	const y = parseYaml(await load());
	if (!y.data || typeof y.data !== 'object') return null;
	const data = y.data as Record<string, unknown>;
	const mats = (data.materials ?? {}) as Record<string, Record<string, unknown>>;
	const materials = Object.entries(mats).map(([k, v]) => `${k}: ${Object.entries(v).filter(([p]) => p !== 'source').map(([p, x]) => `${p} ${x}`).join(', ')} (source: ${String(v.source ?? 'not stated')})`).join('\n');
	return { id, data, materials };
}
