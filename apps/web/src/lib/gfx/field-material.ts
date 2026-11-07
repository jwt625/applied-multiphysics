// SPDX-License-Identifier: GPL-3.0-or-later
// Field material for the 3D viewer, written in TSL and rendered by WebGLRenderer through WebGLNodesHandler (three r187;
// evidence in DevLog-011 s.4.1). Pattern from advanced-packaging-atlas app/src/lib/sim/graphics/FieldLayer.ts at
// fe39985 (GPL-3.0-or-later): 256x1 LUT texture, linear or log scale, deformation p + s u in the vertex stage, flat
// shading from screen-space derivatives. Changes: TSL instead of GLSL; clipping by an explicit Discard (three's
// clipping planes do not apply under the handler); an animation amplitude cos(phase) on displacement and, for
// eigenmodes, on the value (Re(u e^{i phase}) of a real mode). DevLog-019: with opts.p2 the value is the P2 basis of
// the parent face evaluated per fragment (attributes fb = face barycentrics, pa = corner values, pb = mid-edge values
// 01 12 20; viewer3d.ts builds them for tet10 exterior faces, and for other surfaces pa = pb = the vertex value, which
// reduces to linear interpolation), then the LUT per fragment.
import * as THREE from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { Discard, Fn, If, abs, attribute, clamp, cross, dFdx, dFdy, dot, float, log, max, mix, normalView, normalize, pow, positionLocal, positionView, positionWorld, select, texture, uniform, vec2, vec3 } from 'three/tsl';

export interface FieldUniforms {
	vmin: { value: number };
	vmax: { value: number };
	log: { value: number };
	dscale: { value: number };
	/** animation amplitude: cos(phase), or |cos(phase)| for a magnitude */
	amp: { value: number };
	animValue: { value: number };
	clipOn: { value: number };
	clipN: { value: THREE.Vector3 };
	clipD: { value: number };
	opacity: { value: number };
}

export function makeUniforms(): FieldUniforms {
	return {
		vmin: uniform(0), vmax: uniform(1), log: uniform(0), dscale: uniform(0), amp: uniform(1), animValue: uniform(0),
		clipOn: uniform(0), clipN: uniform(new THREE.Vector3(1, 0, 0)), clipD: uniform(0), opacity: uniform(1)
	} as unknown as FieldUniforms;
}

type N = ReturnType<typeof float>;

/** One material per drawable; uniforms are shared so a range or clip change is one uniform write. */
/**
 * Lighting (DevLog-015, R4 s.5.4): a luminance modulation of the LUT colour, so the colormap stays readable. View space:
 * a key light from the upper left front and a weak fill from the lower right (Lambert), a hemisphere ambient, a small
 * Blinn specular from the key, and darkening at grazing view angles that outlines silhouettes. Normals: the smooth
 * per-vertex `normal` attribute (opts.normals) or the flat face normal from screen-space derivatives; face-forwarded so
 * sections and back faces are lit too.
 */
export function fieldMaterial(lut: THREE.Texture, u: FieldUniforms, opts: { shade?: boolean; clip?: boolean; normals?: boolean; p2?: boolean } = {}): MeshBasicNodeMaterial {
	const U = u as unknown as Record<keyof FieldUniforms, N>;
	// pushed back slightly so edge lines lying on the surface do not z-fight with it
	const m = new MeshBasicNodeMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
	const amp = mix(float(1), U.amp, U.animValue);
	let raw: N = attribute('value', 'float') as unknown as N;
	if (opts.p2) {
		const fb = attribute('fb', 'vec3'), pa = attribute('pa', 'vec3'), pb = attribute('pb', 'vec3');
		const Nc = vec3(fb.x.mul(fb.x.mul(2).sub(1)), fb.y.mul(fb.y.mul(2).sub(1)), fb.z.mul(fb.z.mul(2).sub(1)));
		const Nm = vec3(fb.x.mul(fb.y), fb.y.mul(fb.z), fb.z.mul(fb.x)).mul(4);
		raw = dot(Nc, pa).add(dot(Nm, pb)) as unknown as N;
	}
	const v = raw.mul(amp);
	const tLin = v.sub(U.vmin).div(U.vmax.sub(U.vmin));
	const tLog = log(max(v, float(1e-30))).sub(log(U.vmin)).div(log(U.vmax).sub(log(U.vmin)));
	const t = clamp(select(U.log.greaterThan(0.5), tLog, tLin), float(0), float(1));
	const base = texture(lut, vec2(t.mul(255 / 256).add(0.5 / 256), 0.5)).rgb;
	const shade = opts.shade ?? true;
	m.colorNode = Fn(() => {
		if (opts.clip ?? true) If(U.clipOn.greaterThan(0.5).and(dot(positionWorld, U.clipN as never).greaterThan(U.clipD)), () => { Discard(); });
		if (!shade) return base;
		const V = normalize(positionView.negate());
		const n0 = opts.normals ? normalize(normalView) : normalize(cross(dFdx(positionView), dFdy(positionView)));
		const n = select(dot(n0, V).lessThan(0), n0.negate(), n0);
		const L1 = normalize(vec3(-0.42, 0.55, 0.72)), L2 = normalize(vec3(0.6, -0.3, 0.5));
		const d1 = max(dot(n, L1), float(0)), d2 = max(dot(n, L2), float(0));
		const light = float(0.4).add(n.y.mul(0.08)).add(d1.mul(0.5)).add(d2.mul(0.14));
		const H = normalize(L1.add(V));
		const spec = pow(max(dot(n, H), float(0)), float(56)).mul(0.2);
		const rim = pow(float(1).sub(abs(dot(n, V))), float(3));
		return clamp(base.mul(light).mul(float(1).sub(rim.mul(0.45))).add(spec), float(0), float(1));
	})();
	m.opacityNode = U.opacity as unknown as N;
	m.positionNode = positionLocal.add(attribute('disp', 'vec3').mul(U.dscale).mul(U.amp));
	return m;
}

/** Wireframe material with the same deformation and clip. */
export function lineMaterial(u: FieldUniforms, color: number, opacity = 0.35): LineBasicNodeMaterial {
	const U = u as unknown as Record<keyof FieldUniforms, N>;
	const lm = new LineBasicNodeMaterial({ transparent: true, depthWrite: false });
	const col = uniform(new THREE.Color(color));
	lm.colorNode = Fn(() => {
		If(U.clipOn.greaterThan(0.5).and(dot(positionWorld, U.clipN as never).greaterThan(U.clipD)), () => { Discard(); });
		return col;
	})();
	lm.opacityNode = float(opacity);
	lm.positionNode = positionLocal.add(attribute('disp', 'vec3').mul(U.dscale).mul(U.amp));
	return lm;
}

/** 256x1 RGBA8 LUT texture (sRGB bytes). */
export function lutTexture(bytes: Uint8Array, nearest = false): THREE.DataTexture {
	const t = new THREE.DataTexture(bytes, bytes.length / 4, 1, THREE.RGBAFormat);
	t.colorSpace = THREE.SRGBColorSpace;
	t.magFilter = t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
	t.needsUpdate = true;
	return t;
}
