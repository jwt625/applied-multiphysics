// SPDX-License-Identifier: GPL-3.0-or-later
// Value artifacts of results nodes in session memory (lane R3, DevLog-028; C10 "values and artifacts"): keyed by
// artifactKey(resultNodeHash(spec, id), runId). An edit under `results` changes the hashes of the edited nodes and of
// the nodes that read them (changedResultNodes), so exactly those miss here and are recomputed; untouched nodes hit.
// Nothing is persisted or exported (DevLog-023 s.5.1). Shared by the post worker and the Node hosts.
import { artifactKey, canonicalJson, resultNodeHash, sha256Hex } from '@amp/spec';
import type { ParamMap } from './api.ts';

/** Bounded map, least recently used evicted first. */
export class Lru<V> {
	private m = new Map<string, V>();
	readonly max: number;
	constructor(max: number) { this.max = max; }
	get(k: string): V | undefined {
		const v = this.m.get(k);
		if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
		return v;
	}
	set(k: string, v: V): void {
		this.m.delete(k);
		this.m.set(k, v);
		while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
	}
	delete(k: string): boolean { return this.m.delete(k); }
	/** drop every key containing `part` (e.g. a run key) */
	dropMatching(part: string): number { let n = 0; for (const k of [...this.m.keys()]) if (k.includes(part)) { this.m.delete(k); n++; } return n; }
	get size(): number { return this.m.size; }
	clear(): void { this.m.clear(); }
}

/** Hash of a params map (SI values and dimensions, sorted by name). */
export async function paramsHash(p: ParamMap): Promise<string> {
	return sha256Hex(canonicalJson(Object.fromEntries([...p].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, [v.si, [...v.dim]]]))));
}

/** Artifact key of a results node over runs, or null when `id` is not a results node. */
export async function nodeArtifactKey(spec: unknown, id: string, runKeys: readonly string[], extra = ''): Promise<string | null> {
	const h = await resultNodeHash(spec, id);
	return h === null ? null : `${artifactKey(h, runKeys.join('+'))}${extra ? `|${extra}` : ''}`;
}
