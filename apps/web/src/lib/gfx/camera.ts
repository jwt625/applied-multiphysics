// SPDX-License-Identifier: GPL-3.0-or-later
// 3D camera presets (DevLog-052 s.2 item 7; the agent tool `set_camera` calls `setCameraPreset`). Model frame: x, y,
// z in metres with z up. A preset is the direction from the look-at point to the camera; the distance is the fit
// distance of the shown model box. The mounted 3D view registers itself here (Canvas3D); with no 3D view mounted every
// call answers false. Pure parts are tested in test/e6-camera.test.ts.

export const CAMERA_PRESETS = ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

export const PRESET_TIP: Record<CameraPreset, string> = {
	iso: 'isometric-like view from +x, -y, +z',
	top: 'from +z, looking down (x right, y up)',
	bottom: 'from -z, looking up',
	front: 'from -y, looking along +y (x right, z up)',
	back: 'from +y, looking along -y',
	left: 'from -x, looking along +x',
	right: 'from +x, looking along -x (y right, z up)'
};

/** small offset off the z axis for top / bottom: the orbit keeps z as its up axis, which must not be the view axis */
const EPS = 1e-3;

/** Unit vector from the look-at point to the camera. */
export function presetDirection(p: CameraPreset): [number, number, number] {
	const v: [number, number, number] =
		p === 'iso' ? [0.62, -0.55, 0.56]
		: p === 'top' ? [0, -EPS, 1]
		: p === 'bottom' ? [0, -EPS, -1]
		: p === 'front' ? [0, -1, 0]
		: p === 'back' ? [0, 1, 0]
		: p === 'left' ? [-1, 0, 0]
		: [1, 0, 0];
	const n = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / n, v[1] / n, v[2] / n];
}

export function isPreset(p: unknown): p is CameraPreset {
	return typeof p === 'string' && (CAMERA_PRESETS as readonly string[]).includes(p);
}

/** Exact camera (model frame, m): position and look-at point. */
export interface CameraPose { pos: [number, number, number]; target: [number, number, number] }

export interface CameraTarget {
	/** move the camera along `dir` from `lookAt` (model frame, m; null = the model centre) at the fit distance */
	preset(dir: [number, number, number], lookAt: [number, number, number] | null): void;
	pose(): CameraPose | null;
	setPose(p: CameraPose): void;
}

let target: CameraTarget | null = null;
let last: CameraPreset | null = null;
let pending: CameraPose | CameraPreset | null = null;

/** Canvas3D registers the mounted view; returns the unregister function. A pose queued before the mount is applied. */
export function registerCameraTarget(t: CameraTarget): () => void {
	target = t;
	if (pending) {
		const p = pending;
		pending = null;
		if (typeof p === 'string') t.preset(presetDirection(p), null);
		else t.setPose(p);
	}
	return () => { if (target === t) target = null; };
}

const finite3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Point the mounted 3D view along a preset, optionally at `lookAt` (model coordinates, m). False when no 3D view is
 * mounted, the preset is unknown or lookAt is not three finite numbers.
 */
export function setCameraPreset(preset: string, lookAt?: [number, number, number]): boolean {
	if (!isPreset(preset) || !target) return false;
	if (lookAt !== undefined && !finite3(lookAt)) return false;
	target.preset(presetDirection(preset), lookAt ?? null);
	last = preset;
	return true;
}

/** Last preset applied through setCameraPreset (null after a free orbit is not tracked). */
export function lastPreset(): CameraPreset | null {
	return last;
}

export function hasCameraView(): boolean {
	return target !== null;
}

/** Current pose of the mounted 3D view (model frame), null without one. */
export function cameraPose(): CameraPose | null {
	return target?.pose() ?? null;
}

/** Apply a pose or preset now, or when the next 3D view mounts (link restore). */
export function applyCamera(p: CameraPose | CameraPreset): void {
	if (target) {
		if (typeof p === 'string') target.preset(presetDirection(p), null);
		else target.setPose(p);
	} else pending = p;
}
