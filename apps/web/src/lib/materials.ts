// SPDX-License-Identifier: GPL-3.0-or-later
// Materials library in the browser (@amp/materials, DevLog-013): materials/*.yaml loaded lazily as raw text, parsed and
// validated by the package loader. Display rows evaluate a property at T = 293.15 K only when it depends on T alone
// (stated in the row); N/A values stay unavailable with their `missing` text; provenance goes to the tooltip.
import { createLibrary, materialIdFromRef, parseMaterialText, MaterialNAError, type Library } from '@amp/materials';

const files = import.meta.glob<string>('../../../../materials/*.yaml', { query: '?raw', import: 'default' });
let lib: Promise<{ lib: Library; issues: string[] }> | null = null;

export function loadMaterials(): Promise<{ lib: Library; issues: string[] }> {
	return (lib ??= (async () => {
		const docs = [];
		const issues: string[] = [];
		for (const [path, load] of Object.entries(files)) {
			const stem = path.replace(/^.*\//, '').replace(/\.yaml$/, '');
			const r = parseMaterialText(await load(), stem);
			if (r.ok && r.doc) docs.push(r.doc);
			else issues.push(`${stem}: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
		}
		return { lib: createLibrary(docs), issues };
	})());
}

export const T_DISPLAY = 293.15;

export interface MatRow { prop: string; text: string; unit: string; na: boolean; tip: string }

export function materialRows(l: Library, ref: string): { id: string; name: string; rows: MatRow[] } | null {
	const id = materialIdFromRef(ref);
	const doc = l.get(id);
	if (!doc) return null;
	const rows: MatRow[] = [];
	for (const prop of Object.keys(doc.properties ?? {})) {
		try {
			const v = l.getProperty(id, prop, { T: T_DISPLAY });
			const val = typeof v.value === 'number' ? fmt(v.value) : Object.entries(v.value).map(([k, x]) => `${k} ${fmt(x)}`).join(', ');
			rows.push({ prop, text: val, unit: v.unit, na: false, tip: `${prop} = ${val} ${v.unit}${dependsOnT(doc, prop) ? ` at T = ${T_DISPLAY} K` : ''}\nbasis: ${v.basis}\nsource: ${v.source}\nlocator: ${v.locator}\naccessed: ${v.accessed}${v.derived ? `\nderived: ${v.derived}` : ''}${v.extrapolated ? '\nextrapolated' : ''}` });
		} catch (e) {
			if (e instanceof MaterialNAError) rows.push({ prop, text: 'unavailable', unit: '', na: true, tip: `N/A: ${e.missing}` });
			else rows.push({ prop, text: dependsOn(e) ?? 'unavailable', unit: '', na: true, tip: (e as Error).message });
		}
	}
	return { id, name: (doc as { name?: string }).name ?? id, rows };
}

function dependsOnT(doc: unknown, prop: string): boolean {
	return JSON.stringify((doc as { properties: Record<string, unknown> }).properties[prop] ?? '').includes('"name":"T"');
}
function dependsOn(e: unknown): string | null {
	const m = /depends on (\w+)/.exec((e as Error).message);
	return m ? `f(${m[1]})` : null;
}
function fmt(v: number): string {
	if (v === 0) return '0';
	const a = Math.abs(v);
	return a >= 1e5 || a < 1e-3 ? v.toExponential(3).replace('e+', 'e') : String(Number(v.toPrecision(4)));
}
