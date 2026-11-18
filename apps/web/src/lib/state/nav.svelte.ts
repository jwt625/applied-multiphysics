// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation trail (DevLog-001 A11, R5 s.4.3; types of @amp/agent src/nav.ts, DevLog-012): navigation changes UI
// state only, never the spec, and every call is listed in its own visible trail, separate from the operation log.
// One nav-host factory for the workbench and the Play view (DevLog-040): each view passes the methods it implements;
// the others answer with the view's "not available here" message; every call is recorded in the trail.
import type { CameraRequest, NavigationHost, NavResult, ViewMode, NavEntry as AgentNavEntry } from '@amp/agent';
import { nowIso } from '../engine/protocol';
import { captureGraphics } from '../gfx/capture';

export type { CameraRequest, NavigationHost, NavResult, Screenshot, ViewMode } from '@amp/agent';
/** Trail entry: the agent's entry (seq, ts, actor, tool, args, ok) plus the host's message. */
export type NavEntry = Omit<AgentNavEntry, 'turn'> & { message?: string };

/** Reactive trail of the open page (the Navigation tab lists it). */
class NavTrail {
	entries = $state<NavEntry[]>([]);
	record(actor: string, tool: string, args: Record<string, unknown>, r: NavResult): NavResult {
		this.entries.push({ seq: this.entries.length + 1, ts: nowIso(), actor, tool, args, ok: r.ok, ...(r.message ? { message: r.message } : {}) });
		return r;
	}
}
export const navTrail = new NavTrail();

/** Synchronous navigation methods a view implements (screenshot defaults to the graphics canvas capture). */
export interface NavImpl {
	focusNode?(pointer: string): NavResult;
	openSettings?(pointer: string, field?: string): NavResult;
	highlightSelection?(ids: string[], color?: string): NavResult;
	setCamera?(req: CameraRequest): NavResult;
	setViewMode?(mode: ViewMode): NavResult;
	/** select and draw a results plot group; absent = the agent's show_plot is unavailable in this view */
	showPlot?(id: string): NavResult;
}
/** The host built by `makeNavHost` (synchronous results; `showPlot` only when the view implements it). */
export type SyncNavHost = { [K in Exclude<keyof NavImpl, 'showPlot'>]-?: NonNullable<NavImpl[K]> } & Pick<NavigationHost, 'screenshot'> & Pick<NavImpl, 'showPlot'>;

/**
 * NavigationHost (@amp/agent) of one view for one actor: every call is recorded in `navTrail`; a method the view does
 * not implement answers `{ ok: false, message: missing(tool) }`.
 */
export function makeNavHost(actor: string, impl: NavImpl, missing: (tool: string) => string): SyncNavHost {
	const rec = (tool: string, args: Record<string, unknown>, r: NavResult) => navTrail.record(actor, tool, args, r);
	const no = (tool: string): NavResult => ({ ok: false, message: missing(tool) });
	const host: SyncNavHost = {
		focusNode: (pointer) => rec('focus_node', { pointer }, impl.focusNode ? impl.focusNode(pointer) : no('focus_node')),
		openSettings: (pointer, field) => rec('open_settings', { pointer, ...(field ? { field } : {}) }, impl.openSettings ? impl.openSettings(pointer, field) : no('open_settings')),
		highlightSelection: (ids, color) => rec('highlight_selection', { ids }, impl.highlightSelection ? impl.highlightSelection(ids, color) : no('highlight_selection')),
		setCamera: (req) => rec('set_camera', { ...req }, impl.setCamera ? impl.setCamera(req) : no('set_camera')),
		setViewMode: (m) => rec('set_view_mode', { mode: m }, impl.setViewMode ? impl.setViewMode(m) : no('set_view_mode')),
		screenshot: async (view) => {
			const c = captureGraphics();
			rec('screenshot', { view: view ?? 'graphics' }, c ? { ok: true } : { ok: false, message: 'graphics canvas not available' });
			return c ? { mediaType: 'image/png', ...c } : null;
		}
	};
	if (impl.showPlot) { const sp = impl.showPlot; host.showPlot = (id) => rec('show_plot', { plot: id }, sp(id)); }
	return host;
}

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
