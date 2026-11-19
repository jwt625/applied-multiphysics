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
	/** look-at point of a preset without lookAt (the view centre, model frame, m) */
	centre?(): [number, number, number];
}

let target: CameraTarget | null = null;
let last: CameraPreset | null = null;
/** look-at point of the last preset applied with an explicit lookAt (model frame); null = the view centre */
let lastLook: [number, number, number] | null = null;
let pending: CameraPose | CameraPreset | null = null;

/** Canvas3D registers the mounted view; returns the unregister function. A pose queued before the mount is applied. */
export function registerCameraTarget(t: CameraTarget): () => void {
	target = t;
	if (pending) {
		const p = pending;
		pending = null;
		if (typeof p === 'string') { t.preset(presetDirection(p), null); lastLook = null; }
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
	lastLook = lookAt ? [lookAt[0], lookAt[1], lookAt[2]] : null;
	return true;
}

/**
 * The preset whose direction the pose looks along (camera minus look-at point, within `tolDeg` degrees), else null
 * (a free orbit: the camera select shows "custom"). With `lookAt` (a look-at point of a preset view: currentPreset() passes the view centre and the last explicit lookAt), the
 * pose's look-at point must also lie within tan(tolDeg) x the camera distance of it (a pan is not a preset view).
 */
export function presetOfPose(p: CameraPose | null, tolDeg = 0.5, lookAt?: [number, number, number] | null): CameraPreset | null {
	if (!p) return null;
	const d = [p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]];
	const n = Math.hypot(d[0]!, d[1]!, d[2]!);
	if (!(n > 0) || !Number.isFinite(n)) return null;
	if (lookAt && Math.hypot(p.target[0] - lookAt[0], p.target[1] - lookAt[1], p.target[2] - lookAt[2]) > n * Math.tan((tolDeg * Math.PI) / 180)) return null;
	const c = Math.cos((tolDeg * Math.PI) / 180);
	for (const k of CAMERA_PRESETS) {
		const u = presetDirection(k);
		if ((u[0] * d[0]! + u[1] * d[1]! + u[2] * d[2]!) / n >= c) return k;
	}
	return null;
}

/** Last preset applied through setCameraPreset (null after a free orbit is not tracked). */
export function lastPreset(): CameraPreset | null {
	return last;
}

export function hasCameraView(): boolean {
	return target !== null;
}

/** Preset of the mounted view's pose (camera select): the view direction of a preset and a look-at point a preset
 *  view has (the view centre, or the last preset's explicit lookAt); null after a free orbit or a pan. */
export function currentPreset(tolDeg = 0.5): CameraPreset | null {
	const p = cameraPose();
	const looks = [target?.centre?.() ?? null, lastLook].filter((x): x is [number, number, number] => x !== null);
	if (!looks.length) return presetOfPose(p, tolDeg);
	for (const L of looks) { const k = presetOfPose(p, tolDeg, L); if (k) return k; }
	return null;
}

/** Current pose of the mounted 3D view (model frame), null without one. */
export function cameraPose(): CameraPose | null {
	return target?.pose() ?? null;
}

/** Apply a pose or preset now, or when the next 3D view mounts (link restore). */
export function applyCamera(p: CameraPose | CameraPreset): void {
	if (target) {
		if (typeof p === 'string') { target.preset(presetDirection(p), null); lastLook = null; }
		else target.setPose(p);
	} else pending = p;
}
