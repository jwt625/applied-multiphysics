// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation tools (DevLog-001 A11, R5 s.4.3): they change UI state only, never the spec. The workbench (L5)
// implements NavigationHost; every call is recorded in a visible navigation trail, separate from the undo log.

import { isoNow } from '@amp/spec';

export type ViewMode = 'geometry' | 'mesh' | 'results';
export type CameraRequest =
  | { kind: 'fit' }
  | { kind: 'preset'; preset: 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' }
  | { kind: 'look_at'; target: [number, number, number]; distance?: number };

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
}

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
  state: { focused: string | null; settings: string | null; highlighted: string[]; camera: CameraRequest | null; mode: ViewMode; plot: string | null } =
    { focused: null, settings: null, highlighted: [], camera: null, mode: 'geometry', plot: null };
  private shot: Screenshot | null;
  constructor(shot: Screenshot | null = null) { this.shot = shot; }
  focusNode(pointer: string): NavResult { this.calls.push({ method: 'focusNode', args: [pointer] }); this.state.focused = pointer; return { ok: true }; }
  openSettings(pointer: string, field?: string): NavResult { this.calls.push({ method: 'openSettings', args: [pointer, field] }); this.state.settings = pointer; return { ok: true }; }
  highlightSelection(ids: string[], color?: string): NavResult { this.calls.push({ method: 'highlightSelection', args: [ids, color] }); this.state.highlighted = [...ids]; return { ok: true }; }
  setCamera(req: CameraRequest): NavResult { this.calls.push({ method: 'setCamera', args: [req] }); this.state.camera = req; return { ok: true }; }
  setViewMode(mode: ViewMode): NavResult { this.calls.push({ method: 'setViewMode', args: [mode] }); this.state.mode = mode; return { ok: true }; }
  screenshot(view?: 'graphics' | 'workbench'): Screenshot | null { this.calls.push({ method: 'screenshot', args: [view] }); return this.shot; }
  showPlot(id: string): NavResult { this.calls.push({ method: 'showPlot', args: [id] }); this.state.plot = id; this.state.mode = 'results'; return { ok: true }; }
}
