// SPDX-License-Identifier: GPL-3.0-or-later
// Field material for the 3D viewer, written in TSL and rendered by WebGLRenderer through WebGLNodesHandler (three r187;
// evidence in DevLog-011 s.4.1). Pattern from advanced-packaging-atlas app/src/lib/sim/graphics/FieldLayer.ts at
// fe39985 (GPL-3.0-or-later): 256x1 LUT texture, linear or log scale, deformation p + s u in the vertex stage, flat
// shading from screen-space derivatives. Changes: TSL instead of GLSL; clipping by an explicit Discard (three's
// clipping planes do not apply under the handler); an animation amplitude cos(phase) on displacement and, for
// eigenmodes, on the value (Re(u e^{i phase}) of a real mode).
import * as THREE from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { Discard, Fn, If, abs, attribute, clamp, cross, dFdx, dFdy, dot, float, log, max, mix, normalize, positionLocal, positionView, positionWorld, select, texture, uniform, vec2 } from 'three/tsl';

export interface FieldUniforms {
	vmin: { value: number };
	vmax: { value: number };
	log: { value: number };
	dscale: { value: number };
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
export function fieldMaterial(lut: THREE.Texture, u: FieldUniforms, opts: { shade?: boolean; clip?: boolean } = {}): MeshBasicNodeMaterial {
	const U = u as unknown as Record<keyof FieldUniforms, N>;
	const m = new MeshBasicNodeMaterial({ side: THREE.DoubleSide });
	const amp = mix(float(1), U.amp, U.animValue);
	const v = attribute('value', 'float').mul(amp);
	const tLin = v.sub(U.vmin).div(U.vmax.sub(U.vmin));
	const tLog = log(max(v, float(1e-30))).sub(log(U.vmin)).div(log(U.vmax).sub(log(U.vmin)));
	const t = clamp(select(U.log.greaterThan(0.5), tLog, tLin), float(0), float(1));
	const base = texture(lut, vec2(t.mul(255 / 256).add(0.5 / 256), 0.5)).rgb;
	const shade = opts.shade ?? true;
	m.colorNode = Fn(() => {
		if (opts.clip ?? true) If(U.clipOn.greaterThan(0.5).and(dot(positionWorld, U.clipN as never).greaterThan(U.clipD)), () => { Discard(); });
		if (!shade) return base;
		const n = normalize(cross(dFdx(positionView), dFdy(positionView)));
		return base.mul(float(0.62).add(abs(n.z).mul(0.38)));
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
