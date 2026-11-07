// SPDX-License-Identifier: GPL-3.0-or-later
// Browser stand-in for `@amp/materials/node` (aliased in vite.config.ts): @amp/physics prepareRun calls
// defaultLibrary(); in the browser the library is built from materials/*.yaml loaded through import.meta.glob
// (lib/materials.ts) and must be preloaded with preloadMaterials() before prepareRun runs. Same documents, same
// @amp/materials evaluation; only the file access differs.
import type { Library } from '@amp/materials';
import { loadMaterials } from '../materials';

let lib: Library | null = null;

export async function preloadMaterials(): Promise<string[]> {
	const r = await loadMaterials();
	lib = r.lib;
	return r.issues;
}

export function defaultLibrary(): Library {
	if (!lib) throw new Error('materials library not preloaded in the browser');
	return lib;
}

export function loadLibrary(): Library {
	return defaultLibrary();
}

export function getProperty(materialId: string, prop: string, opts = {}) {
	return defaultLibrary().getProperty(materialId, prop, opts);
}
