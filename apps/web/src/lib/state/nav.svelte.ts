// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation trail (DevLog-001 A11, R5 s.4.3; shapes of @amp/agent src/nav.ts, DevLog-012): navigation changes UI
// state only, never the spec, and every call is listed in its own visible trail, separate from the operation log.
import { nowIso } from '../engine/protocol';

export type ViewMode = 'geometry' | 'mesh' | 'results';
export type CameraRequest =
	| { kind: 'fit' }
	| { kind: 'preset'; preset: 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' }
	| { kind: 'look_at'; target: [number, number, number]; distance?: number };
export interface NavResult { ok: boolean; message?: string }
export interface Screenshot { mediaType: 'image/png'; base64: string; width?: number; height?: number }
export interface NavEntry { seq: number; ts: string; actor: string; tool: string; args: Record<string, unknown>; ok: boolean; message?: string }

/** Same method set as @amp/agent NavigationHost (structural; switch to the import once @amp/agent has an index). */
export interface NavigationHost {
	focusNode(pointer: string): NavResult;
	openSettings(pointer: string, field?: string): NavResult;
	highlightSelection(ids: string[], color?: string): NavResult;
	setCamera(req: CameraRequest): NavResult;
	setViewMode(mode: ViewMode): NavResult;
	screenshot(view?: 'graphics' | 'workbench'): Promise<Screenshot | null>;
}

class NavTrail {
	entries = $state<NavEntry[]>([]);
	record(actor: string, tool: string, args: Record<string, unknown>, r: NavResult): NavResult {
		this.entries.push({ seq: this.entries.length + 1, ts: nowIso(), actor, tool, args, ok: r.ok, ...(r.message ? { message: r.message } : {}) });
		return r;
	}
}
export const navTrail = new NavTrail();

/** Resolve `@id` pointer tokens (amp-oplog/1) to array indices against the data. */
export function resolvePointer(data: unknown, pointer: string): string | null {
	if (pointer === '' || pointer === '/') return '';
	let cur: unknown = data;
	const out: string[] = [];
	for (const raw of pointer.slice(1).split('/')) {
		const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
		if (Array.isArray(cur)) {
			const i = k.startsWith('@') ? cur.findIndex((e) => !!e && typeof e === 'object' && (e as { id?: unknown }).id === k.slice(1)) : Number(k);
			if (!(i >= 0 && i < cur.length)) return null;
			out.push(String(i));
			cur = cur[i];
		} else if (cur && typeof cur === 'object' && Object.hasOwn(cur, k)) {
			out.push(raw);
			cur = (cur as Record<string, unknown>)[k];
		} else return null;
	}
	return '/' + out.join('/');
}
