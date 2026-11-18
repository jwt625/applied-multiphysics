// SPDX-License-Identifier: GPL-3.0-or-later
// Thin spec -> geometry -> mesh adapter for the workbench preview (DevLog-011 s.1.6). It maps the registered amp-spec/0
// feature types onto @amp/geom / @amp/mesh inputs, with every value resolved through @amp/spec (params in scope, SI).
// It is replaced by @amp/physics `prepareRun` once L4 exports it (the runner prefers that path). No physical values.
import { resolveQuantity, type ParamInfo, type ScopeValue, type Spec } from '@amp/spec';
import { buildGeometry2D, type Feature, type Geometry2D, type Mesh } from '@amp/geom';
import * as M from '@amp/mesh';
import { meshFromSpec } from '@amp/mesh/spec';

export type Vec = number[];

export function scopeOf(params: Map<string, ParamInfo>): Map<string, ScopeValue> {
	const s = new Map<string, ScopeValue>();
	for (const [k, p] of params) s.set(k, { si: p.si, dim: p.dim });
	return s;
}

export function q(v: unknown, scope: ReadonlyMap<string, ScopeValue>, what: string): number {
	const r = resolveQuantity(v, scope);
	if (r.na) throw new Error(`${what} is N/A`);
	return r.si;
}

export function vec(v: unknown, scope: ReadonlyMap<string, ScopeValue>, what: string): Vec {
	if (Array.isArray(v)) return v.map((e, i) => q(e, scope, `${what}[${i}]`));
	if (v && typeof v === 'object' && Array.isArray((v as { value?: unknown }).value)) {
		const o = v as { value: number[]; unit: string };
		return o.value.map((x, i) => q({ value: x, unit: o.unit }, scope, `${what}[${i}]`));
	}
	throw new Error(`${what}: not a vector`);
}

type FeatureNode = { id: string; type: string; settings?: Record<string, unknown> };

export function features2d(spec: Spec, scope: ReadonlyMap<string, ScopeValue>): Feature[] {
	const out: Feature[] = [];
	for (const f of spec.geometry.features as FeatureNode[]) {
		const s = f.settings ?? {};
		const w = (k: string) => `geometry.${f.id}.settings.${k}`;
		switch (f.type) {
			case 'rect': {
				const [sx, sy] = vec(s.size, scope, w('size'));
				const [cx, cy] = vec(s.center, scope, w('center'));
				out.push({ id: f.id, type: 'rect', x: [cx! - sx! / 2, cx! + sx! / 2], y: [cy! - sy! / 2, cy! + sy! / 2] });
				break;
			}
			case 'circle': {
				const [cx, cy] = vec(s.center, scope, w('center'));
				out.push({ id: f.id, type: 'circle', c: [cx!, cy!], r: q(s.radius, scope, w('radius')) });
				break;
			}
			case 'polygon': {
				const pts = (s.points as unknown[]).map((p, i) => vec(p, scope, w(`points.${i}`)) as [number, number]);
				out.push({ id: f.id, type: 'polygon', points: pts });
				break;
			}
			case 'union':
				out.push({ id: f.id, type: 'union', inputs: s.inputs as string[] });
				break;
			case 'difference':
				out.push({ id: f.id, type: 'difference', target: s.base as string, tools: s.tools as string[], ...(s.keepTools ? { keepTools: true } : {}) });
				break;
			default:
				throw new Error(`feature type '${f.type}' (${f.id}) has no 2D geometry adapter`);
		}
	}
	return out;
}

export interface MeshSettings { hmax: number; hmin?: number; grade?: number; refine: Array<{ select: string[]; h: number }> }

export function meshSettings(spec: Spec, scope: ReadonlyMap<string, ScopeValue>, scale = 1): MeshSettings {
	const m = spec.mesh;
	if (!m) throw new Error('mesh: block missing (no hidden defaults)');
	const size = m.size as Record<string, unknown>;
	const out: MeshSettings = { hmax: scale * q(size.hmax, scope, 'mesh.size.hmax'), refine: [] };
	if (size.hmin !== undefined) out.hmin = q(size.hmin, scope, 'mesh.size.hmin');
	if (size.grading !== undefined) out.grade = q(size.grading, scope, 'mesh.size.grading');
	for (const [i, r] of (m.refine ?? []).entries()) out.refine.push({ select: r.select as string[], h: scale * q(r.h, scope, `mesh.refine.${i}.h`) });
	return out;
}

export interface Built { mesh: Mesh; geometry: Geometry2D | null; ms: { geometry: number; mesh: number } }

/** Geometry and mesh of a validated spec. `scale` multiplies the mesh sizes (coarse preview during drags). */
export function buildMesh(spec: Spec, params: Map<string, ParamInfo>, scale = 1): Built {
	const scope = scopeOf(params);
	const ms = meshSettings(spec, scope, scale);
	const t0 = performance.now();
	if (spec.geometry.dim === 2) {
		const g = buildGeometry2D({ dim: 2, axisym: !!spec.geometry.axisym, features: features2d(spec, scope) });
		const t1 = performance.now();
		const mesh = M.mesh2d(g, { hmax: ms.hmax, ...(ms.hmin ? { hmin: ms.hmin } : {}), ...(ms.grade ? { grade: ms.grade } : {}), refine: ms.refine, order: 1 });
		return { mesh, geometry: g, ms: { geometry: t1 - t0, mesh: performance.now() - t1 } };
	}
	// 3D (DevLog-044 R-web-1): every spec the solver path meshes (boxes, one cylinder, extrude stacks, mixed boxes and
	// z cylinders) through @amp/mesh meshFromSpec, with the size settings scaled; layer nz / dz stay as written
	const t1 = performance.now();
	const mesh = meshFromSpec(scaledSizes(spec as unknown as Record<string, unknown>, ms), { order: 1 });
	return { mesh, geometry: null, ms: { geometry: 0, mesh: performance.now() - t1 } };
}

/** A copy of the spec whose mesh.size.hmax and mesh.refine h are the resolved, scaled SI values of `ms`. */
export function scaledSizes(spec: Record<string, unknown>, ms: MeshSettings): Record<string, unknown> {
	const m = (spec.mesh ?? {}) as { size?: Record<string, unknown>; refine?: Array<Record<string, unknown>> };
	const L = (v: number) => ({ value: v, unit: 'm' });
	return {
		...spec,
		mesh: {
			...m,
			size: { ...(m.size ?? {}), hmax: L(ms.hmax) },
			...(m.refine ? { refine: m.refine.map((r, i) => ({ ...r, h: L(ms.refine[i]!.h) })) } : {})
		}
	};
}
