// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation tools (DevLog-001 A11, R5 s.4.3): they change UI state only, never the spec. The workbench (L5)
// implements NavigationHost; every call is recorded in a visible navigation trail, separate from the undo log.

import { isoNow } from '@amp/spec';

export type ViewMode = 'geometry' | 'mesh' | 'results';
export type CameraRequest =
  | { kind: 'fit' }
  | { kind: 'preset'; preset: CameraPreset }
  | { kind: 'look_at'; target: [number, number, number]; distance?: number; preset?: CameraPreset };
export type CameraPreset = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';

export interface NavResult { ok: boolean; message?: string }
export interface Screenshot { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string; width?: number; height?: number }

/** Implemented by the workbench. Pointers are RFC 6901 with @id tokens, as in the op log. */
export interface NavigationHost {
  focusNode(pointer: string): Promise<NavResult> | NavResult;
  openSettings(pointer: string, field?: string): Promise<NavResult> | NavResult;
  highlightSelection(ids: string[], color?: string): Promise<NavResult> | NavResult;
  setCamera(req: CameraRequest): Promise<NavResult> | NavResult;
  setViewMode(mode: ViewMode): Promise<NavResult> | NavResult;
  /** Null when the view cannot be captured (e.g. headless). */
  screenshot(view?: 'graphics' | 'workbench'): Promise<Screenshot | null> | Screenshot | null;
  /** Select and draw a plot group (results.plots id; lane R2 implements it in the workbench). Absent: show_plot is unavailable. */
  showPlot?(id: string): Promise<NavResult> | NavResult;
  /** Stop the running mesh / solve / sweep / accuracy sequence of the view. Absent: cancel_run is unavailable. */
  cancelRun?(): Promise<NavResult> | NavResult;
  /** Points of the last parametric sweep, null when there is none. Absent: select_sweep_point is unavailable. */
  sweep?(): SweepInfo | null;
  /** Show one sweep point (dataset) in the view, the probes and the headline numbers. */
  selectSweepPoint?(index: number): Promise<NavResult> | NavResult;
  /** Add a probe-table row: the drawn field at a point (m), in the colorbar unit. Absent: probe is unavailable. */
  probeAdd?(at: [number, number, number]): Promise<NavResult & { probe?: ProbeInfo }>;
  probeList?(): ProbeInfo[] | null;
  /** Remove one probe row by its number, or all rows. */
  probeRemove?(n: number | 'all'): NavResult;
  /** Quick-view settings of the graphics view (null when no field is drawn). Absent: quick_view is unavailable. */
  quickView?(): QuickViewInfo | null;
  setQuickView?(patch: QuickViewPatch): Promise<NavResult> | NavResult;
}

export interface SweepPointInfo { index: number; label: string; values: Record<string, { value: number; unit: string }>; status: string; shown: boolean; selectable: boolean }
export interface SweepInfo { study: string; inner: string; done: number; total: number; shown: number; points: SweepPointInfo[] }
export interface ProbeInfo { n: number; at_m: number[]; field: string; value: number | null; unit: string; dataset: string }
export type RangeRule = 'full' | 'p1-99';
export interface QuickViewInfo {
  field: string | null;
  fields: string[];
  /** -1 = magnitude; null for a scalar field */
  component: number | null;
  components: string[];
  /** 'auto' or a colormap name */
  colormap: string;
  colormaps: string[];
  range: RangeRule;
  log: boolean;
  logAvailable: boolean;
  contours: boolean;
  wire: boolean;
  /** a plot group is drawn: its items set the view, the quick view applies after returning to it */
  plotGroup: string | null;
}
export interface QuickViewPatch { field?: string; component?: number; colormap?: string; range?: RangeRule; log?: boolean; contours?: boolean; wire?: boolean }

export interface NavEntry {
  seq: number;
  ts: string;
  actor: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Turn index of the agent session that made the call. */
  turn?: number;
}

/** Append-only, visible navigation trail. */
export class NavTrail {
  readonly entries: NavEntry[] = [];
  private listeners = new Set<(e: NavEntry) => void>();
  private clock: () => string;
  constructor(clock: () => string = () => isoNow()) { this.clock = clock; }
  record(e: Omit<NavEntry, 'seq' | 'ts'>): NavEntry {
    const entry: NavEntry = { seq: this.entries.length + 1, ts: this.clock(), ...e };
    this.entries.push(entry);
    for (const l of this.listeners) l(entry);
    return entry;
  }
  subscribe(fn: (e: NavEntry) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

/** A recording NavigationHost for Node, tests and the eval suite (no UI). */
export class RecordingNavHost implements NavigationHost {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  state: { focused: string | null; settings: string | null; highlighted: string[]; camera: CameraRequest | null; mode: ViewMode; plot: string | null; cancelled: number } =
    { focused: null, settings: null, highlighted: [], camera: null, mode: 'geometry', plot: null, cancelled: 0 };
  /** Test state for the sweep, probe and quick-view tools (null: nothing to show). */
  sweepState: SweepInfo | null = null;
  probes: ProbeInfo[] = [];
  /** probeAdd value: a function of the point (m), null = outside the mesh */
  probeValue: (at: [number, number, number]) => number | null = () => null;
  view: QuickViewInfo | null = null;
  private probeN = 0;
  private shot: Screenshot | null;
  constructor(shot: Screenshot | null = null) { this.shot = shot; }
  focusNode(pointer: string): NavResult { this.calls.push({ method: 'focusNode', args: [pointer] }); this.state.focused = pointer; return { ok: true }; }
  openSettings(pointer: string, field?: string): NavResult { this.calls.push({ method: 'openSettings', args: [pointer, field] }); this.state.settings = pointer; return { ok: true }; }
  highlightSelection(ids: string[], color?: string): NavResult { this.calls.push({ method: 'highlightSelection', args: [ids, color] }); this.state.highlighted = [...ids]; return { ok: true }; }
  setCamera(req: CameraRequest): NavResult { this.calls.push({ method: 'setCamera', args: [req] }); this.state.camera = req; return { ok: true }; }
  setViewMode(mode: ViewMode): NavResult { this.calls.push({ method: 'setViewMode', args: [mode] }); this.state.mode = mode; return { ok: true }; }
  screenshot(view?: 'graphics' | 'workbench'): Screenshot | null { this.calls.push({ method: 'screenshot', args: [view] }); return this.shot; }
  showPlot(id: string): NavResult { this.calls.push({ method: 'showPlot', args: [id] }); this.state.plot = id; this.state.mode = 'results'; return { ok: true }; }
  cancelRun(): NavResult { this.calls.push({ method: 'cancelRun', args: [] }); this.state.cancelled++; return { ok: true, message: 'nothing was running' }; }
  sweep(): SweepInfo | null { this.calls.push({ method: 'sweep', args: [] }); return this.sweepState ? structuredClone(this.sweepState) : null; }
  selectSweepPoint(index: number): NavResult {
    this.calls.push({ method: 'selectSweepPoint', args: [index] });
    const sw = this.sweepState;
    const p = sw?.points.find((x) => x.index === index);
    if (!sw || !p) return { ok: false, message: `no sweep point ${index}` };
    if (!p.selectable) return { ok: false, message: `point ${index} is ${p.status}` };
    for (const q of sw.points) q.shown = q.index === index;
    sw.shown = index;
    return { ok: true };
  }
  async probeAdd(at: [number, number, number]): Promise<NavResult & { probe?: ProbeInfo }> {
    this.calls.push({ method: 'probeAdd', args: [at] });
    if (!this.view?.field) return { ok: false, message: 'no field is drawn' };
    const probe: ProbeInfo = { n: ++this.probeN, at_m: [...at], field: this.view.field, value: this.probeValue(at), unit: 'K', dataset: '' };
    this.probes.push(probe);
    return { ok: true, probe };
  }
  probeList(): ProbeInfo[] { this.calls.push({ method: 'probeList', args: [] }); return this.probes.map((p) => ({ ...p })); }
  probeRemove(n: number | 'all'): NavResult {
    this.calls.push({ method: 'probeRemove', args: [n] });
    if (n === 'all') { this.probes = []; return { ok: true }; }
    const k = this.probes.findIndex((p) => p.n === n);
    if (k < 0) return { ok: false, message: `no probe ${n}` };
    this.probes.splice(k, 1);
    return { ok: true };
  }
  quickView(): QuickViewInfo | null { this.calls.push({ method: 'quickView', args: [] }); return this.view ? structuredClone(this.view) : null; }
  setQuickView(patch: QuickViewPatch): NavResult {
    this.calls.push({ method: 'setQuickView', args: [patch] });
    const v = this.view;
    if (!v) return { ok: false, message: 'no field is drawn' };
    if (patch.field !== undefined && !v.fields.includes(patch.field)) return { ok: false, message: `no field ${patch.field}` };
    if (patch.colormap !== undefined && patch.colormap !== 'auto' && !v.colormaps.includes(patch.colormap)) return { ok: false, message: `no colormap ${patch.colormap}` };
    Object.assign(v, patch);
    return { ok: true };
  }
}
