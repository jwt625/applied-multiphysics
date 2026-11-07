// SPDX-License-Identifier: GPL-3.0-or-later
// Code a page will dynamic-import, named in the prerendered HTML as modulepreload links so the download starts while
// the HTML parses (eo-modulator-atlas DevLog-046 pattern). From the client build manifest; none in dev.
import { existsSync, readFileSync } from 'node:fs';

export function preloadFor(entry: string): string[] {
	const file = '.svelte-kit/output/client/.vite/manifest.json';
	if (!existsSync(file)) return [];
	const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { file: string; imports?: string[]; dynamicImports?: string[] }>;
	const seen = new Set<string>();
	const walk = (k: string) => {
		if (seen.has(k) || !manifest[k]) return;
		seen.add(k);
		manifest[k].imports?.forEach(walk);
	};
	walk(entry);
	return [...seen].map((k) => `/${manifest[k]!.file}`);
}
