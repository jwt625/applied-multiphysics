// SPDX-License-Identifier: GPL-3.0-or-later
// DevLog-011 s.1.5: does a TSL field material run on WebGLRenderer through WebGLNodesHandler (three r187)?
// Needs: custom float attribute (value), custom vec3 attribute (disp) with a uniform scale in the vertex stage, a LUT
// DataTexture sampled at a uniform-mapped coordinate, a material clipping plane. Result goes to window.__probe.
import * as THREE from 'three';
import { WebGLNodesHandler } from 'three/addons/tsl/WebGLNodesHandler.js';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, uniform, texture, vec2, vec3, positionLocal, positionWorld, clamp, float, dot, If, Discard, Fn } from 'three/tsl';

const out: Record<string, unknown> = { ok: false, steps: [] as string[] };
const step = (s: string) => (out.steps as string[]).push(s);
try {
	const canvas = document.getElementById('c') as HTMLCanvasElement;
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
	renderer.localClippingEnabled = true;
	(renderer as unknown as { setNodesHandler(h: unknown): void }).setNodesHandler(new WebGLNodesHandler());
	step('handler set');
	// LUT: red (t=0) -> green (t=1)
	const lut = new Uint8Array(256 * 4);
	for (let i = 0; i < 256; i++) { lut[4 * i] = 255 - i; lut[4 * i + 1] = i; lut[4 * i + 3] = 255; }
	const tex = new THREE.DataTexture(lut, 256, 1, THREE.RGBAFormat);
	tex.colorSpace = THREE.SRGBColorSpace; // LUT bytes are sRGB: decoded on sampling, re-encoded on output
	tex.needsUpdate = true;
	// quad covering x in [-1, 1], y in [-1, 1]; value = 0 on the left edge, 1 on the right edge; disp moves y by +0.5
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
	g.setAttribute('value', new THREE.Float32BufferAttribute([0, 1, 1, 0, 1, 0], 1));
	g.setAttribute('disp', new THREE.Float32BufferAttribute(Array(18).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
	const vmin = uniform(0), vmax = uniform(1), dscale = uniform(0.5);
	const mat = new MeshBasicNodeMaterial();
	const t = clamp(attribute('value', 'float').sub(vmin).div(vmax.sub(vmin)), float(0), float(1));
	mat.colorNode = texture(tex, vec2(t.mul(255 / 256).add(0.5 / 256), 0.5));
	mat.positionNode = positionLocal.add(attribute('disp', 'vec3').mul(dscale));
	mat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.5)]; // keeps x <= 0.5
	mat.side = THREE.DoubleSide;
	step('material built');
	const variant = new URLSearchParams(location.search).get('clip') ?? 'material';
	if (variant === 'discard') {
		mat.clippingPlanes = [];
		const cn = uniform(new THREE.Vector3(1, 0, 0)), cd = uniform(0.5);
		const base = mat.colorNode;
		mat.colorNode = Fn(() => { If(dot(positionWorld, cn).greaterThan(cd), () => { Discard(); }); return base; })();
		void vec3;
	}
	if (variant === 'renderer') { mat.clippingPlanes = []; renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.5)]; }
	out.clipVariant = variant;
	const scene = new THREE.Scene();
	scene.add(new THREE.Mesh(g, mat));
	const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
	renderer.setClearColor(0x0000ff, 1);
	renderer.render(scene, cam);
	step('rendered');
	const gl = renderer.getContext() as WebGL2RenderingContext;
	const px = (x: number, y: number) => { const b = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return Array.from(b); };
	// canvas 256x256, NDC x -> px (x+1)*128; displaced quad spans y in [-0.5, 1.5] -> rows 64..256
	out.samples = {
		left_mid: px(16, 160),       // x = -0.875, inside: value ~0.06 -> mostly red
		right_mid: px(176, 160),     // x = 0.375, inside: value ~0.69 -> greener
		clipped: px(240, 160),       // x = 0.875 > 0.5 -> clipped -> clear blue
		below_disp: px(128, 32)      // y = -0.75 < -0.5 -> outside the displaced quad -> clear blue
	};
	const s = out.samples as Record<string, number[]>;
	out.checks = {
		lut_and_value_attribute: s.left_mid![0]! > 200 && s.left_mid![1]! < 40 && s.right_mid![1]! > 150,
		clipping_plane: s.clipped![2]! > 200 && s.clipped![0]! < 30,
		disp_attribute_and_uniform: s.below_disp![2]! > 200 && s.below_disp![0]! < 30
	};
	out.ok = Object.values(out.checks as Record<string, boolean>).every(Boolean);
	out.renderer = String(gl.getParameter(gl.RENDERER));
} catch (e) {
	out.error = (e as Error).stack ?? String(e);
}
(window as unknown as { __probe: unknown }).__probe = out;
document.getElementById('out')!.textContent = JSON.stringify(out, null, 1);
