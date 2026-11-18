// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation trail (DevLog-001 A11, R5 s.4.3; types of @amp/agent src/nav.ts, DevLog-012): navigation changes UI
// state only, never the spec, and every call is listed in its own visible trail, separate from the operation log.
// One nav-host factory for the workbench and the Play view (DevLog-040): each view passes the methods it implements;
// the others answer with the view's "not available here" message; every call is recorded in the trail.
import type { CameraPreset, CameraRequest, NavigationHost, NavResult, ProbeInfo, QuickViewInfo, QuickViewPatch, SweepInfo, ViewMode, NavEntry as AgentNavEntry } from '@amp/agent';
import type { ProbeRow } from '../post/probe';
import { nowIso } from '../engine/protocol';
import { captureGraphics } from '../gfx/capture';

export type { CameraRequest, NavigationHost, NavResult, Screenshot, ViewMode, QuickViewInfo, QuickViewPatch } from '@amp/agent';
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

// ---- agent parity (DevLog-053): host methods for cancel, sweep point, probes, quick view and camera presets ----

/**
 * Hooks of the mounted graphics view for the agent's probe and quick-view tools. The graphics view registers them
 * (registerViewHooks) and unregisters on destroy; the most recently registered view answers.
 */
export interface ViewHooks {
	/** the probe table the view adds rows to (null: the view has no probe table) */
	probes: { rows: readonly ProbeRow[]; remove(n: number): void; clear(): void } | null;
	/** add a probe row at a point (m) for the drawn field, as a click would; row null with a message when not possible */
	probeAt(p: [number, number, number]): Promise<{ row: ProbeRow | null; message?: string }>;
	/** quick-view settings (null when no field is drawn) */
	quickView(): QuickViewInfo | null;
	setQuickView(patch: QuickViewPatch): NavResult;
}
const hookStack: ViewHooks[] = [];
export function registerViewHooks(h: ViewHooks): () => void {
	hookStack.push(h);
	return () => { const i = hookStack.lastIndexOf(h); if (i >= 0) hookStack.splice(i, 1); };
}
export const viewHooks = (): ViewHooks | null => hookStack.at(-1) ?? null;

/** What the agent host reads and calls on the workbench session (Session satisfies it; tests pass a fake). */
export interface SessionLike {
	status: string;
	acc: { status: string } | null;
	pointLoading: number;
	sweep: { studyId: string; innerId: string; axes: ReadonlyArray<{ param: string; unit: string }>; points: ReadonlyArray<{ index: number; label: string; values: Record<string, number>; status: string; held: boolean }>; done: number } | null;
	active: number;
	cancel(): void;
	selectPoint(i: number): void;
}

/** Camera presets of the 3D view (gfx/camera.ts setCameraPreset): true when applied, false when no 3D view is shown. */
export type CameraFn = (preset: CameraPreset, lookAt?: [number, number, number]) => boolean;

export const probeInfo = (r: ProbeRow): ProbeInfo => ({ n: r.n, at_m: r.dim === 2 ? [r.p[0], r.p[1]] : [...r.p], field: r.field, value: r.value, unit: r.unit, dataset: r.dataset });

/** What is running in the session (empty: nothing to cancel). */
export function running(s: SessionLike): string[] {
	const out: string[] = [];
	if (s.status === 'meshing') out.push('mesh');
	if (s.status === 'solving') out.push('solve');
	if (s.sweep?.points.some((p) => p.status === 'pending' || p.status === 'solving')) out.push('sweep');
	if (s.acc?.status === 'running') out.push('accuracy refinement');
	if (s.pointLoading >= 0) out.push('sweep point re-solve');
	return out;
}

export function sweepInfo(s: SessionLike): SweepInfo | null {
	const sw = s.sweep;
	if (!sw) return null;
	const unit = new Map(sw.axes.map((a) => [a.param, a.unit]));
	return {
		study: sw.studyId, inner: sw.innerId, done: sw.done, total: sw.points.length, shown: s.active,
		points: sw.points.map((p) => ({
			index: p.index, label: p.label, status: p.status, shown: p.index === s.active, selectable: p.held || p.status === 'solved',
			values: Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, { value: v, unit: unit.get(k) ?? '' }]))
		}))
	};
}

/**
 * The agent's NavigationHost: the view's host (`base`, from makeNavHost) plus the parity methods. Session methods are
 * the ones the toolbar and the dataset selector call; probe and quick-view calls go to the registered graphics view;
 * camera presets and look_at go to `camera` when given (else to the base host). Every call is recorded in `navTrail`.
 */
export function agentNavHost(base: NavigationHost, actor: string, deps: { session: SessionLike | null; camera?: CameraFn | null; hooks?: () => ViewHooks | null }): NavigationHost {
	const rec = (tool: string, args: Record<string, unknown>, r: NavResult) => navTrail.record(actor, tool, args, r);
	const hooks = deps.hooks ?? viewHooks;
	const noView = 'no results view with a drawn field is open';
	const host: NavigationHost = {
		focusNode: (p) => base.focusNode(p),
		openSettings: (p, f) => base.openSettings(p, f),
		highlightSelection: (ids, c) => base.highlightSelection(ids, c),
		setViewMode: (m) => base.setViewMode(m),
		screenshot: (v) => base.screenshot(v),
		setCamera: (req) => {
			const cam = deps.camera;
			if (req.kind === 'fit' || !cam) return base.setCamera(req);
			const done = req.kind === 'preset' ? cam(req.preset) : cam(req.preset ?? 'iso', req.target);
			const note = req.kind === 'look_at' && req.distance !== undefined ? 'distance is not applied (the view keeps its zoom)' : undefined;
			return rec('set_camera', { ...req }, done ? { ok: true, ...(note ? { message: note } : {}) } : { ok: false, message: 'camera presets act on the 3D view; no 3D view is shown' });
		}
	};
	if (base.showPlot) { const sp = base.showPlot.bind(base); host.showPlot = (id) => sp(id); }
	const s = deps.session;
	if (s) {
		host.cancelRun = () => {
			const r = running(s);
			if (!r.length) return rec('cancel_run', {}, { ok: true, message: 'nothing was running' });
			s.cancel();
			return rec('cancel_run', {}, { ok: true, message: `cancelled: ${r.join(', ')}` });
		};
		host.sweep = () => sweepInfo(s);
		host.selectSweepPoint = (i) => {
			const p = s.sweep?.points[i];
			if (!p) return rec('select_sweep_point', { index: i }, { ok: false, message: `no sweep point ${i}` });
			if (!p.held && p.status !== 'solved') return rec('select_sweep_point', { index: i }, { ok: false, message: `point ${i} is ${p.status}` });
			s.selectPoint(i);
			return rec('select_sweep_point', { index: i }, { ok: true });
		};
	}
	host.probeAdd = async (at) => {
		const h = hooks();
		if (!h?.probes) return rec('probe', { action: 'add', at }, { ok: false, message: noView });
		const r = await h.probeAt(at);
		rec('probe', { action: 'add', at }, r.row ? { ok: true } : { ok: false, message: r.message ?? 'not added' });
		return r.row ? { ok: true, probe: probeInfo(r.row) } : { ok: false, message: r.message ?? 'not added' };
	};
	host.probeList = () => hooks()?.probes?.rows.map(probeInfo) ?? null;
	host.probeRemove = (n) => {
		const t = hooks()?.probes;
		if (!t) return rec('probe', { action: 'remove', n }, { ok: false, message: noView });
		if (n === 'all') { t.clear(); return rec('probe', { action: 'clear' }, { ok: true }); }
		if (!t.rows.some((r) => r.n === n)) return rec('probe', { action: 'remove', n }, { ok: false, message: `no probe ${n}` });
		t.remove(n);
		return rec('probe', { action: 'remove', n }, { ok: true });
	};
	host.quickView = () => hooks()?.quickView() ?? null;
	host.setQuickView = (patch) => {
		const h = hooks();
		return rec('quick_view', { ...patch }, h ? h.setQuickView(patch) : { ok: false, message: noView });
	};
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
