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
import { grabCanvas } from './capture';

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
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
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
		if (pos.length) g.computeBoundingSphere();
		return g;
	}

	/** Replace the data of a persistent geometry (same object, same attribute names). */
	private fill(g: THREE.BufferGeometry, pos: Float32Array, val: Float32Array, disp: Float32Array | null) {
		const put = (name: string, arr: Float32Array, size: number) => {
			const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
			if (a && a.array.length === arr.length) { (a.array as Float32Array).set(arr); a.needsUpdate = true; }
			else g.setAttribute(name, new THREE.BufferAttribute(arr, size));
		};
		put('position', pos, 3);
		put('value', val, 1);
		put('disp', disp ?? new Float32Array(pos.length), 3);
		g.setDrawRange(0, pos.length / 3);
	}

	// materials are built once and reused: a TSL material compiles to GLSL on first use, which costs 100+ ms (audit S6)
	private matField: THREE.Material | null = null;
	private matRegion: THREE.Material | null = null;
	private matCut: THREE.Material | null = null;
	private matLine: THREE.Material | null = null;
	private materials() {
		this.regionLut ??= lutTexture(new Uint8Array(1024), true);
		this.matField ??= fieldMaterial(this.lut, this.u, { shade: true });
		this.matRegion ??= fieldMaterial(this.regionLut, this.ur, { shade: true });
		this.matCut ??= fieldMaterial(this.lut, this.u, { shade: true, clip: false });
		this.matLine ??= lineMaterial(this.u, 0xe8e8e8, 0.28);
	}
	/** region view: domain index i maps to texel i of a 256-entry categorical LUT (own uniforms, range 0..255) */
	readonly ur: FieldUniforms = makeUniforms();

	/**
	 * Exterior surface with per-vertex values; `regionColors` switches to the categorical domain LUT. The Mesh and
	 * LineSegments objects persist and only their geometry is swapped: under WebGLNodesHandler a new render object
	 * rebuilds its node program (about 130 ms per object, measured as long tasks during drags; audit S6).
	 */
	setSurface(d: Drawable, regionColors: string[] | null, edges: Float32Array | null, edgeDisp: Float32Array | null) {
		this.materials();
		if (regionColors) {
			const bytes = this.regionLut!.image.data as Uint8Array;
			bytes.fill(90);
			regionColors.slice(0, 256).forEach((c, i) => bytes.set([...hexToRgb(c), 255], 4 * i));
			for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255;
			this.regionLut!.needsUpdate = true;
			// clip and deformation follow the field uniforms
			this.ur.vmin.value = 0; this.ur.vmax.value = 255;
			this.ur.clipOn.value = this.u.clipOn.value; this.ur.clipN.value.copy(this.u.clipN.value); this.ur.clipD.value = this.u.clipD.value;
			this.ur.dscale.value = this.u.dscale.value;
		}
		const mat = regionColors ? this.matRegion! : this.matField!;
		if (!this.surf) { this.surf = new THREE.Mesh(new THREE.BufferGeometry(), mat); this.surf.frustumCulled = false; this.group.add(this.surf); }
		this.surf.material = mat;
		this.fill(this.surf.geometry, d.pos, d.val, d.disp);
		this.surf.visible = this.surfOn && d.pos.length > 0;
		const E = edges ?? new Float32Array(0);
		if (!this.wire) { this.wire = new THREE.LineSegments(new THREE.BufferGeometry(), this.matLine!); this.wire.frustumCulled = false; this.group.add(this.wire); }
		this.fill(this.wire.geometry, E, new Float32Array(E.length / 3), edgeDisp);
		this.wire.visible = this.wireOn && E.length > 0;
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
		// pooled cut meshes (same reason as setSurface)
		this.materials();
		const L = list.filter((d) => d.pos.length);
		while (this.cuts.length < L.length) { const m = new THREE.Mesh(new THREE.BufferGeometry(), this.matCut!); m.frustumCulled = false; this.cuts.push(m); this.group.add(m); }
		this.cuts.forEach((c, i) => {
			c.geometry.dispose();
			c.geometry = i < L.length ? this.geom(L[i]!.pos, L[i]!.val, L[i]!.disp) : new THREE.BufferGeometry();
			c.visible = i < L.length;
		});
		this.request();
	}

	private surfOn = true;
	private wireOn = true;
	showSurface(on: boolean) { this.surfOn = on; if (this.surf) this.surf.visible = on && this.surf.geometry.getAttribute('position').count > 0; this.request(); }
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
		this.ur.clipOn.value = on ? 1 : 0;
		this.ur.clipN.value.set(n[0], n[1], n[2]);
		this.ur.clipD.value = d;
		this.request();
	}

	setDeform(scale: number) { this.u.dscale.value = scale; this.ur.dscale.value = scale; this.request(); }

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
		// phones use a horizontal colorbar at the bottom (no right offset)
		return this.w > 240 && window.innerWidth > 760 ? 80 : 0;
	}

	/** Render now and read the canvas back (screenshot tool). */
	grab(): { base64: string; width: number; height: number } | null {
		return grabCanvas(this.renderer.domElement, () => this.renderer.render(this.scene, this.camera));
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
		for (const o of [this.surf, this.wire]) if (o) { this.group.remove(o); o.geometry.dispose(); }
		this.surf = null;
		this.wire = null;
	}

	dispose() {
		cancelAnimationFrame(this.raf);
		this.clearSurface();
		this.setCuts([]);
		this.controls.dispose();
		for (const m of [this.matField, this.matRegion, this.matCut, this.matLine]) m?.dispose();
		this.lut.dispose();
		this.regionLut?.dispose();
		this.renderer.dispose();
		this.renderer.forceContextLoss();
	}
}
