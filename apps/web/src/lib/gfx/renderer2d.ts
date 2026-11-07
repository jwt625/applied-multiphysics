// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from eo-modulator-atlas/app/src/lib/sim/renderer.ts at 0546007 (GPL-3.0-or-later). Changes: SI metres with a
// float32 origin per display mesh (refined display from post/field2d.ts, C2 tri3/tri6 meshes), perceptual colormaps
// only (gfx/colormaps.ts), arrows and the Canvas 2D fallback dropped for v0, mesh-keyed caches replaced by a cache per
// RefinedDisplay object, region colors and masks unchanged.
//
// WebGL2, one indexed draw call per layer. Layers: surface (color table fill), contour (iso-lines in the fragment
// shader at up to 64 levels, anti-aliased with fwidth), region (domain colors). Every layer is drawn on the refined
// lattice display (r^2 sub-triangles per element, Gouraud inside sub-triangles); the wireframe draws the parent
// elements from barycentrics.
import { colormapLut, type ColormapName } from './colormaps';
import type { RefinedDisplay } from '../post/field2d';

export type ScaleMode = 'linear' | 'log' | 'symlog';
export interface Range { min: number; max: number }

export interface View2D {
	/** world point (m) at the canvas centre */
	cx: number;
	cy: number;
	/** CSS px per metre */
	scale: number;
}

export interface Layer2D {
	kind: 'surface' | 'contour' | 'region';
	disp: RefinedDisplay;
	/** one value per lattice point, element-major */
	values?: Float32Array | null;
	scale?: ScaleMode;
	range?: Range;
	colormap?: ColormapName;
	reverse?: boolean;
	levels?: number[];
	uniform?: string | null;
	regionColors?: string[];
	regionMask?: Uint8Array | null;
	wire?: boolean;
	wireColor?: string;
	/** contour line opacity (0..1, default 1) */
	opacity?: number;
	/**
	 * mirrored copies (symmetry display, DevLog-015): each copy reflects x by sx and y by sy (+1 / -1) and multiplies
	 * the value by `sign` (the field's parity under that reflection). Default: the layer as computed only.
	 */
	mirror?: Array<{ sx: number; sy: number; sign: number }>;
}

export interface DrawState2D { view: View2D; background: string; layers: Layer2D[] }

const MAX_LEVELS = 64;

const VS = `#version 300 es
in vec2 aPos;
in vec2 aBary;
in float aVal;
in float aReg;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform float uValSign;
out float vVal;
out vec3 vBary;
flat out int vReg;
void main() {
	vBary = vec3(aBary, 1.0 - aBary.x - aBary.y);
	vVal = aVal * uValSign;
	vReg = int(aReg + 0.5);
	gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in float vVal;
in vec3 vBary;
flat in int vReg;
uniform int uMode; // 0 region, 1 surface, 2 contour
uniform int uLog;
uniform float uMin;
uniform float uMax;
uniform sampler2D uLut;
uniform sampler2D uRegions;
uniform sampler2D uMask;
uniform int uUseMask;
uniform float uWire;
uniform vec3 uWireColor;
uniform int uNLevels;
uniform float uLevels[${MAX_LEVELS}];
uniform int uUniform;
uniform vec3 uUniformColor;
uniform float uOpacity;
out vec4 outColor;
float mapT(float v) {
	if (uLog == 2) {
		float a = abs(v);
		if (a < uMin) return 0.5;
		float u = min(1.0, (log2(a) - log2(uMin)) / (log2(uMax) - log2(uMin)));
		return 0.5 + 0.5 * sign(v) * u;
	}
	if (uLog == 1) {
		float a = abs(v);
		if (a <= 0.0) return -1.0;
		return (log2(a) - log2(uMin)) / (log2(uMax) - log2(uMin));
	}
	return (v - uMin) / (uMax - uMin);
}
vec3 lut(float t) { return texture(uLut, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb; }
void main() {
	if (uUseMask == 1 && texelFetch(uMask, ivec2(vReg, 0), 0).r < 0.5) discard;
	vec3 col;
	float alpha = 1.0;
	if (uMode == 1) {
		col = lut(mapT(vVal));
	} else if (uMode == 2) {
		float t = mapT(vVal);
		float w = max(fwidth(t), 1e-7);
		float best = 0.0;
		float lev = 0.0;
		for (int i = 0; i < ${MAX_LEVELS}; i++) {
			if (i >= uNLevels) break;
			float d = abs(t - uLevels[i]) / w;
			float a = 1.0 - smoothstep(0.6, 1.4, d);
			if (a > best) { best = a; lev = uLevels[i]; }
		}
		if (best <= 0.01) discard;
		col = uUniform == 1 ? uUniformColor : lut(lev);
		alpha = best * uOpacity;
	} else {
		col = texelFetch(uRegions, ivec2(vReg, 0), 0).rgb;
	}
	if (uWire > 0.5) {
		float d = min(min(vBary.x, vBary.y), vBary.z);
		float fw = max(fwidth(d), 1e-6);
		float line = 1.0 - smoothstep(0.0, 1.2 * fw, d);
		float fade = clamp(((1.0 / 3.0) / fw - 1.5) / 3.0, 0.0, 1.0);
		col = mix(col, uWireColor, 0.8 * line * fade);
	}
	outColor = vec4(col, alpha);
}`;

export function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const rgb01 = (hex: string): [number, number, number] => hexToRgb(hex).map((v) => v / 255) as [number, number, number];

/** Colour coordinate t in [0, 1] of a value (same mapping as the shader). */
export function scaleT(v: number, mode: ScaleMode, r: Range): number {
	if (mode === 'log') return v > 0 ? (Math.log10(v) - Math.log10(r.min)) / (Math.log10(r.max) - Math.log10(r.min)) : -1;
	if (mode === 'symlog') {
		const a = Math.abs(v);
		if (a < r.min) return 0.5;
		return 0.5 + 0.5 * Math.sign(v) * Math.min(1, (Math.log10(a) - Math.log10(r.min)) / (Math.log10(r.max) - Math.log10(r.min)));
	}
	return (v - r.min) / (r.max - r.min);
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
	const prog = gl.createProgram()!;
	for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
		const sh = gl.createShader(type)!;
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
		gl.attachShader(prog, sh);
	}
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(prog)}`);
	return prog;
}

interface Entry { pos: WebGLBuffer; bary: WebGLBuffer; reg: WebGLBuffer; idx: WebGLBuffer; n: number; vals: Map<Float32Array, WebGLBuffer>; used: number }

export class Renderer2D {
	private gl: WebGL2RenderingContext;
	private prog: WebGLProgram;
	private vao: WebGLVertexArrayObject;
	private lutTex: WebGLTexture;
	private regTex: WebGLTexture;
	private maskTex: WebGLTexture;
	private lutKey = '';
	private regKey = '';
	private entries = new Map<RefinedDisplay, Entry>();
	private frame = 0;
	private u: Record<string, WebGLUniformLocation | null> = {};
	private loc: Record<string, number> = {};
	private cssW = 1;
	private cssH = 1;

	static create(canvas: HTMLCanvasElement): Renderer2D | null {
		const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false, alpha: false });
		if (!gl) return null;
		try {
			return new Renderer2D(gl);
		} catch {
			return null;
		}
	}

	private constructor(gl: WebGL2RenderingContext) {
		this.gl = gl;
		this.prog = compile(gl, VS, FS);
		for (const n of ['uScale', 'uOffset', 'uMode', 'uLog', 'uMin', 'uMax', 'uLut', 'uRegions', 'uMask', 'uUseMask', 'uWire', 'uWireColor', 'uNLevels', 'uLevels', 'uUniform', 'uUniformColor', 'uValSign', 'uOpacity'])
			this.u[n] = gl.getUniformLocation(this.prog, n);
		for (const n of ['aPos', 'aBary', 'aVal', 'aReg']) this.loc[n] = gl.getAttribLocation(this.prog, n);
		this.vao = gl.createVertexArray()!;
		const tex = () => {
			const t = gl.createTexture()!;
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			return t;
		};
		this.lutTex = tex();
		this.regTex = tex();
		this.maskTex = tex();
		gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		this.warm();
	}

	/**
	 * One degenerate triangle per shader mode at creation (DevLog-015, audit S2): drivers that compile or JIT the
	 * program at its first draw (SwiftShader) do it here, at load, not when the first or a refined result arrives.
	 */
	private warm() {
		const gl = this.gl;
		this.uploadLut('viridis', false);
		this.uploadRegions(['#000000']);
		this.uploadMask(new Uint8Array(1));
		const buf = gl.createBuffer()!;
		gl.useProgram(this.prog);
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(6), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(this.loc.aPos!);
		gl.vertexAttribPointer(this.loc.aPos!, 2, gl.FLOAT, false, 0, 0);
		for (const n of ['aBary', 'aVal', 'aReg']) gl.disableVertexAttribArray(this.loc[n]!);
		const u = this.u;
		gl.uniform2f(u.uScale!, 1, 1); gl.uniform2f(u.uOffset!, 0, 0); gl.uniform1f(u.uValSign!, 1); gl.uniform1f(u.uOpacity!, 1);
		gl.uniform1f(u.uMin!, 0); gl.uniform1f(u.uMax!, 1); gl.uniform1i(u.uNLevels!, 0);
		[[u.uLut, this.lutTex], [u.uRegions, this.regTex], [u.uMask, this.maskTex]].forEach(([loc, tex], k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, tex as WebGLTexture); gl.uniform1i(loc as WebGLUniformLocation, k); });
		for (const mode of [0, 1, 2]) { gl.uniform1i(u.uMode!, mode); gl.drawArrays(gl.TRIANGLES, 0, 3); }
		gl.bindVertexArray(null);
		gl.deleteBuffer(buf);
	}

	isLost(): boolean {
		return this.gl.isContextLost();
	}

	info(): string {
		const gl = this.gl;
		const ext = gl.getExtension('WEBGL_debug_renderer_info');
		return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
	}

	resize(cssW: number, cssH: number, dpr: number): void {
		this.cssW = Math.max(1, cssW);
		this.cssH = Math.max(1, cssH);
		const c = this.gl.canvas as HTMLCanvasElement;
		const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
		if (c.width !== w || c.height !== h) {
			c.width = w;
			c.height = h;
		}
	}

	private entry(d: RefinedDisplay): Entry {
		let e = this.entries.get(d);
		if (!e) {
			const gl = this.gl;
			const buf = (data: ArrayBufferView, target: number = gl.ARRAY_BUFFER) => {
				const b = gl.createBuffer()!;
				gl.bindBuffer(target, b);
				gl.bufferData(target, data, gl.STATIC_DRAW);
				return b;
			};
			gl.bindVertexArray(this.vao);
			e = { pos: buf(d.pos), bary: buf(d.bary), reg: buf(d.reg), idx: buf(d.sub, gl.ELEMENT_ARRAY_BUFFER), n: d.sub.length, vals: new Map(), used: 0 };
			this.entries.set(d, e);
		}
		e.used = this.frame;
		return e;
	}

	private valueBuf(e: Entry, values: Float32Array): WebGLBuffer {
		const hit = e.vals.get(values);
		if (hit) return hit;
		const gl = this.gl;
		const buf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
		if (e.vals.size >= 6) {
			const [k, old] = e.vals.entries().next().value!;
			gl.deleteBuffer(old);
			e.vals.delete(k);
		}
		e.vals.set(values, buf);
		return buf;
	}

	private release(e: Entry) {
		const gl = this.gl;
		for (const b of [e.pos, e.bary, e.reg, e.idx]) gl.deleteBuffer(b);
		for (const v of e.vals.values()) gl.deleteBuffer(v);
	}

	private evict(keep: Set<RefinedDisplay>) {
		if (this.entries.size <= 4) return;
		const old = [...this.entries.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used);
		while (this.entries.size > 4 && old.length) {
			const [k, e] = old.shift()!;
			this.release(e);
			this.entries.delete(k);
		}
	}

	private uploadLut(name: ColormapName, reverse: boolean) {
		const key = `${name}:${reverse}`;
		if (this.lutKey === key) return;
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colormapLut(name, reverse));
		this.lutKey = key;
	}

	private uploadRegions(colors: string[]) {
		const key = colors.join(',');
		if (key === this.regKey) return;
		const gl = this.gl;
		const n = Math.max(1, colors.length);
		const data = new Uint8Array(4 * n);
		colors.forEach((c, i) => {
			const [r, g, b] = hexToRgb(c);
			data.set([r, g, b, 255], 4 * i);
		});
		gl.bindTexture(gl.TEXTURE_2D, this.regTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		this.regKey = key;
	}

	private uploadMask(mask: Uint8Array) {
		const gl = this.gl;
		const n = Math.max(1, mask.length);
		const data = new Uint8Array(4 * n);
		for (let i = 0; i < mask.length; i++) data[4 * i] = mask[i] ? 255 : 0;
		gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
	}

	draw(s: DrawState2D): void {
		const gl = this.gl;
		this.frame++;
		const c = gl.canvas as HTMLCanvasElement;
		gl.viewport(0, 0, c.width, c.height);
		const [br, bg, bb] = rgb01(s.background);
		gl.clearColor(br, bg, bb, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		const sx = (2 * s.view.scale) / this.cssW, sy = (2 * s.view.scale) / this.cssH;
		const u = this.u;
		gl.useProgram(this.prog);
		gl.bindVertexArray(this.vao);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		const used = new Set<RefinedDisplay>();
		for (const L of s.layers) {
			const e = this.entry(L.disp);
			used.add(L.disp);
			const scalar = L.kind !== 'region';
			const vals = scalar && L.values && L.values.length === L.disp.nT * L.disp.np ? L.values : null;
			if (scalar && !vals) continue;
			const bind = (buf: WebGLBuffer, name: string, size: number) => {
				gl.bindBuffer(gl.ARRAY_BUFFER, buf);
				gl.enableVertexAttribArray(this.loc[name]!);
				gl.vertexAttribPointer(this.loc[name]!, size, gl.FLOAT, false, 0, 0);
			};
			bind(e.pos, 'aPos', 2);
			bind(e.bary, 'aBary', 2);
			bind(e.reg, 'aReg', 1);
			if (vals) bind(this.valueBuf(e, vals), 'aVal', 1);
			else {
				gl.disableVertexAttribArray(this.loc.aVal!);
				gl.vertexAttrib1f(this.loc.aVal!, 0);
			}
			const r = L.range ?? { min: 0, max: 1 };
			gl.uniform1i(u.uMode!, L.kind === 'surface' ? 1 : L.kind === 'contour' ? 2 : 0);
			gl.uniform1i(u.uLog!, L.scale === 'log' ? 1 : L.scale === 'symlog' ? 2 : 0);
			gl.uniform1f(u.uMin!, r.min);
			gl.uniform1f(u.uMax!, r.max === r.min ? r.min + 1 : r.max);
			this.uploadLut(L.colormap ?? 'viridis', !!L.reverse);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
			gl.uniform1i(u.uLut!, 0);
			if (L.regionColors) this.uploadRegions(L.regionColors);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.regTex);
			gl.uniform1i(u.uRegions!, 1);
			gl.uniform1i(u.uUseMask!, L.regionMask ? 1 : 0);
			if (L.regionMask) this.uploadMask(L.regionMask);
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
			gl.uniform1i(u.uMask!, 2);
			gl.uniform1f(u.uWire!, L.wire ? 1 : 0);
			gl.uniform3fv(u.uWireColor!, rgb01(L.wireColor ?? '#e8e8e8'));
			const lv = L.kind === 'contour' ? (L.levels ?? []).slice(0, MAX_LEVELS).map((l) => scaleT(l, L.scale ?? 'linear', r)) : [];
			gl.uniform1i(u.uNLevels!, lv.length);
			if (lv.length) gl.uniform1fv(u.uLevels!, Float32Array.from(lv));
			gl.uniform1i(u.uUniform!, L.uniform ? 1 : 0);
			gl.uniform3fv(u.uUniformColor!, rgb01(L.uniform ?? '#ffffff'));
			gl.uniform1f(u.uOpacity!, L.opacity ?? 1);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, e.idx);
			// one draw per mirrored copy: reflected transform (world x -> mx x) and the value times its parity
			for (const m of L.mirror ?? [{ sx: 1, sy: 1, sign: 1 }]) {
				gl.uniform2f(u.uScale!, sx * m.sx, sy * m.sy);
				gl.uniform2f(u.uOffset!, (m.sx * L.disp.c0[0] - s.view.cx) * sx, (m.sy * L.disp.c0[1] - s.view.cy) * sy);
				gl.uniform1f(u.uValSign!, m.sign);
				gl.drawElements(gl.TRIANGLES, e.n, gl.UNSIGNED_INT, 0);
			}
		}
		gl.disable(gl.BLEND);
		gl.bindVertexArray(null);
		this.evict(used);
	}

	dispose(): void {
		const gl = this.gl;
		for (const e of this.entries.values()) this.release(e);
		this.entries.clear();
		for (const t of [this.lutTex, this.regTex, this.maskTex]) gl.deleteTexture(t);
		gl.deleteProgram(this.prog);
		gl.getExtension('WEBGL_lose_context')?.loseContext();
	}
}
