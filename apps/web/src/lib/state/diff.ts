// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal RFC 6902 patch between two JSON values (YAML tab edits, share URLs): per-key recursion for objects, per-index
// recursion for equal-length arrays, whole replacement otherwise. Applying the patch to `a` gives `b` exactly.
import type { JsonPatchOp } from '@amp/spec/types';

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const esc = (k: string | number) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

export function jsonEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEq(v, b[i]));
	if (isObj(a) && isObj(b)) {
		const ka = Object.keys(a), kb = Object.keys(b);
		return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEq(a[k], b[k]));
	}
	return false;
}

export function diffPatch(a: unknown, b: unknown, path = ''): JsonPatchOp[] {
	if (jsonEq(a, b)) return [];
	if (isObj(a) && isObj(b)) {
		const out: JsonPatchOp[] = [];
		for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) out.push({ op: 'remove', path: `${path}/${esc(k)}` });
		for (const k of Object.keys(b)) {
			if (!Object.hasOwn(a, k)) out.push({ op: 'add', path: `${path}/${esc(k)}`, value: b[k] });
			else out.push(...diffPatch(a[k], b[k], `${path}/${esc(k)}`));
		}
		return out;
	}
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
		const out: JsonPatchOp[] = [];
		for (let i = 0; i < a.length; i++) out.push(...diffPatch(a[i], b[i], `${path}/${i}`));
		return out;
	}
	if (path === '') throw new Error('root replacement is not an edit');
	return [{ op: 'replace', path, value: b }];
}

/** Value at a JSON Pointer, or undefined. */
export function getAt(data: unknown, pointer: string): unknown {
	if (pointer === '') return data;
	let cur: unknown = data;
	for (const raw of pointer.slice(1).split('/')) {
		const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
		if (Array.isArray(cur)) cur = cur[Number(k)];
		else if (isObj(cur)) cur = cur[k];
		else return undefined;
	}
	return cur;
}

/** Set (add or replace) or remove (value undefined) at a pointer, as a one-op patch. */
export function setOp(data: unknown, pointer: string, value: unknown): JsonPatchOp[] {
	const cur = getAt(data, pointer);
	if (value === undefined) return cur === undefined ? [] : [{ op: 'remove', path: pointer }];
	if (cur === undefined) return [{ op: 'add', path: pointer, value }];
	return jsonEq(cur, value) ? [] : [{ op: 'replace', path: pointer, value }];
}

export const pointer = (keys: ReadonlyArray<string | number>): string => keys.map((k) => `/${esc(k)}`).join('');

// share-by-URL: base64url of the JSON patch from the original spec (DevLog-011 s.1.7)
export function encodeShare(patch: JsonPatchOp[]): string {
	const bytes = new TextEncoder().encode(JSON.stringify(patch));
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(code: string): JsonPatchOp[] {
	const s = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
	const v = JSON.parse(new TextDecoder().decode(bytes));
	if (!Array.isArray(v)) throw new Error('share code: not a patch list');
	return v as JsonPatchOp[];
}
