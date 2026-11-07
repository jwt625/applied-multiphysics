// SPDX-License-Identifier: GPL-3.0-or-later
// 3D viewer (DevLog-011 s.1.5): three.js r187 WebGLRenderer with WebGLNodesHandler, TSL field material
// (field-material.ts), damped orbit controls, render on demand. Drawables: the exterior surface (de-indexed triangle
// soup from the post worker), its wireframe, and cut layers (slices, isosurfaces). Values are per vertex in display
// units; region mode colours domains through a nearest-filtered categorical LUT.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WebGLNodesHandler } from 'three/addons/tsl/WebGLNodesHandler.js';
import { fieldMaterial, lineMaterial, lutTexture, makeUniforms, type FieldUniforms } from './field-material';
import { colormapLut, type ColormapName } from './colormaps';
import { hexToRgb } from './renderer2d';

export interface Drawable { pos: Float32Array; val: Float32Array; disp: Float32Array | null }

export class Viewer3D {
	readonly renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private controls: OrbitControls;
	readonly u: FieldUniforms = makeUniforms();
	private lut: THREE.DataTexture;
	private regionLut: THREE.DataTexture | null = null;
	private surf: THREE.Mesh | null = null;
	private wire: THREE.LineSegments | null = null;
	private cuts: THREE.Mesh[] = [];
	private group = new THREE.Group();
	private raf = 0;
	private w = 1;
	private h = 1;
	onframe: ((ms: number) => void) | null = null;
	private userMoved = false;
	private lastHalf: [number, number, number] | null = null;
	diag = 1;

	constructor(canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
		(this.renderer as unknown as { setNodesHandler(h: unknown): void }).setNodesHandler(new WebGLNodesHandler());
		this.renderer.setClearColor(0x0d0d0d, 1);
		this.camera = new THREE.PerspectiveCamera(35, 1, 1e-6, 1e6);
		this.camera.up.set(0, 0, 1);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.15;
		this.controls.addEventListener('change', () => this.request());
		this.controls.addEventListener('start', () => (this.userMoved = true));
		this.scene.add(this.group);
		this.lut = lutTexture(new Uint8Array(colormapLut('viridis')));
	}

	setColormap(name: ColormapName, reverse = false) {
		(this.lut.image.data as Uint8Array).set(colormapLut(name, reverse));
		this.lut.needsUpdate = true;
		this.request();
	}

	private geom(pos: Float32Array, val: Float32Array, disp: Float32Array | null): THREE.BufferGeometry {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		g.setAttribute('value', new THREE.BufferAttribute(val, 1));
		g.setAttribute('disp', new THREE.BufferAttribute(disp ?? new Float32Array(pos.length), 3));
		g.computeBoundingSphere();
		return g;
	}

	/** Exterior surface with per-vertex values; `regionColors` switches to the categorical domain LUT. */
	setSurface(d: Drawable, regionColors: string[] | null, edges: Float32Array | null, edgeDisp: Float32Array | null) {
		this.clearSurface();
		let tex = this.lut;
		if (regionColors) {
			const n = Math.max(1, regionColors.length);
			const bytes = new Uint8Array(4 * n);
			regionColors.forEach((c, i) => bytes.set([...hexToRgb(c), 255], 4 * i));
			this.regionLut?.dispose();
			this.regionLut = lutTexture(bytes, true);
			tex = this.regionLut;
		}
		this.surf = new THREE.Mesh(this.geom(d.pos, d.val, d.disp), fieldMaterial(tex, this.u, { shade: true }));
		this.surf.visible = this.surfOn;
		this.group.add(this.surf);
		if (edges) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(edges, 3));
			g.setAttribute('value', new THREE.BufferAttribute(new Float32Array(edges.length / 3), 1));
			g.setAttribute('disp', new THREE.BufferAttribute(edgeDisp ?? new Float32Array(edges.length), 3));
			this.wire = new THREE.LineSegments(g, lineMaterial(this.u, 0xe8e8e8, 0.28));
			this.wire.visible = this.wireOn;
			this.group.add(this.wire);
		}
		this.request();
	}

	/** Update surface values (and displacement) without rebuilding the geometry. */
	updateSurface(val: Float32Array, disp: Float32Array | null) {
		if (!this.surf) return;
		const g = this.surf.geometry;
		g.setAttribute('value', new THREE.BufferAttribute(val, 1));
		if (disp) g.setAttribute('disp', new THREE.BufferAttribute(disp, 3));
		this.request();
	}

	setCuts(list: Drawable[]) {
		for (const c of this.cuts) { this.group.remove(c); c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
		this.cuts = list.filter((d) => d.pos.length).map((d) => new THREE.Mesh(this.geom(d.pos, d.val, d.disp), fieldMaterial(this.lut, this.u, { shade: true, clip: false })));
		for (const c of this.cuts) this.group.add(c);
		this.request();
	}

	private surfOn = true;
	private wireOn = true;
	showSurface(on: boolean) { this.surfOn = on; if (this.surf) this.surf.visible = on; this.request(); }
	showWire(on: boolean) { this.wireOn = on; if (this.wire) this.wire.visible = on; this.request(); }

	setRange(min: number, max: number, logScale: boolean) {
		this.u.vmin.value = min;
		this.u.vmax.value = max === min ? min + 1 : max;
		this.u.log.value = logScale ? 1 : 0;
		this.request();
	}

	/** Section: discard the half space n . x > d (world = model coordinates relative to the mesh centre). */
	setClip(on: boolean, n: [number, number, number] = [1, 0, 0], d = 0) {
		this.u.clipOn.value = on ? 1 : 0;
		this.u.clipN.value.set(n[0], n[1], n[2]);
		this.u.clipD.value = d;
		this.request();
	}

	setDeform(scale: number) { this.u.dscale.value = scale; this.request(); }

	setPhase(phase: number, animValue: boolean) {
		this.u.amp.value = Math.cos(phase);
		this.u.animValue.value = animValue ? 1 : 0;
		this.request();
	}

	resetPhase() { this.u.amp.value = 1; this.u.animValue.value = 0; this.request(); }

	/** Fit the camera to a bounding box (relative to the mesh centre), isometric-like view. */
	fit(half: [number, number, number]) {
		this.lastHalf = half;
		this.userMoved = false;
		const r = Math.hypot(...half) || 1;
		this.diag = 2 * r;
		// the narrower of the vertical and horizontal fields of view decides (phones are portrait)
		const vf = (this.camera.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * (Math.max(1, this.w - this.padRight()) / this.h));
		const dist = (1.08 * r) / Math.sin(Math.min(vf, hf) / 2);
		this.camera.near = dist / 1000;
		this.camera.far = dist * 100;
		this.camera.position.set(dist * 0.62, -dist * 0.55, dist * 0.56);
		this.controls.target.set(0, 0, 0);
		this.camera.updateProjectionMatrix();
		this.controls.update();
		this.request();
	}

	resize(w: number, h: number, dpr: number) {
		this.w = Math.max(1, w);
		this.h = Math.max(1, h);
		this.renderer.setPixelRatio(dpr);
		this.renderer.setSize(this.w, this.h, false);
		this.camera.aspect = this.w / this.h;
		// centre the model in the area left of the colorbar (80 px): shift the view by half of it
		const pr = this.padRight();
		if (pr > 0) this.camera.setViewOffset(this.w, this.h, pr / 2, 0, this.w, this.h);
		else this.camera.clearViewOffset();
		this.camera.updateProjectionMatrix();
		// the first fit may run before the canvas has its size: refit until the user moves the camera
		if (this.lastHalf && !this.userMoved) this.fit(this.lastHalf);
		this.request();
	}

	private padRight(): number {
		return this.w > 240 ? 80 : 0;
	}

	request() {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			const t0 = performance.now();
			const moving = this.controls.update();
			this.renderer.render(this.scene, this.camera);
			this.onframe?.(performance.now() - t0);
			if (moving) this.request();
		});
	}

	private clearSurface() {
		for (const o of [this.surf, this.wire]) if (o) { this.group.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
		this.surf = null;
		this.wire = null;
	}

	dispose() {
		cancelAnimationFrame(this.raf);
		this.clearSurface();
		this.setCuts([]);
		this.controls.dispose();
		this.lut.dispose();
		this.regionLut?.dispose();
		this.renderer.dispose();
		this.renderer.forceContextLoss();
	}
}
