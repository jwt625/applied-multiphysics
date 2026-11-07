// SPDX-License-Identifier: GPL-3.0-or-later
// The hero models (sims/*.yaml, L2), loaded lazily as raw text; ids are known without loading any of them.
const files = import.meta.glob<string>('../../../../sims/*.yaml', { query: '?raw', import: 'default' });

const idOf = (path: string) => path.replace(/^.*\//, '').replace(/\.yaml$/, '');
const byId = new Map(Object.entries(files).map(([p, load]) => [idOf(p), load] as const));

export const SIM_IDS: string[] = [...byId.keys()].sort();
export const DEFAULT_SIM = 'kirsch-plate';

export async function loadSimText(id: string): Promise<string> {
	const load = byId.get(id);
	if (!load) throw new Error(`unknown model '${id}'`);
	return load();
}
