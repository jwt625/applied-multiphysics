// SPDX-License-Identifier: GPL-3.0-or-later
// 3D preview of layered (extrude) specs (DevLog-044 R-web-1, DevLog-052): the coarse preview adapter meshes through
// @amp/mesh meshFromSpec with scaled sizes, and the surface view keeps exterior faces only (one adjacent cell): no
// triangle on the internal interface between the two layers, total area = box surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecText } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { registerGeomFeatures } from '@amp/geom/spec';
import { meshFromSpec } from '@amp/mesh/spec';
import { exterior } from '../src/lib/post/solid3d.ts';
import { buildMesh } from '../src/lib/engine/spec-adapter.ts';

const YAML = `schema: amp-spec/0
id: two-layer
title: two layers
geometry:
  dim: 3
  features:
    - {id: cell, type: rect, settings: {center: {value: [0, 0], unit: m}, size: {value: [2, 1], unit: m}}}
    - id: stack
      type: extrude
      settings:
        layers:
          - {id: lo, thickness: {value: 0.5, unit: m}, sketch: [cell], nz: 2}
          - {id: hi, thickness: {value: 0.25, unit: m}, sketch: [cell], nz: 1}
mesh:
  size: {hmax: {value: 0.5, unit: m}}
`;

function areaAndInterface(m: ReturnType<typeof meshFromSpec>) {
	const s = exterior(m);
	const P = s.pos;
	let area = 0, onIface = 0;
	for (let t = 0; t < P.length / 9; t++) {
		const a = [P[9 * t]!, P[9 * t + 1]!, P[9 * t + 2]!], b = [P[9 * t + 3]!, P[9 * t + 4]!, P[9 * t + 5]!], c = [P[9 * t + 6]!, P[9 * t + 7]!, P[9 * t + 8]!];
		const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
		area += 0.5 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
		// interface plane z = 0.5 m; positions are relative to the box centre z = 0.375 m
		const zi = 0.5 - s.c0[2];
		if ([a, b, c].every((p) => Math.abs(p[2]! - zi) < 1e-6) && [a, b, c].some((p) => Math.abs(p[0]!) < 0.999 && Math.abs(p[1]!) < 0.499)) onIface++;
	}
	return { area, onIface, nTri: P.length / 9 };
}

test('exterior of a two-layer stack: no internal interface faces, area of the box surface', () => {
	const m = meshFromSpec(parseSpecText(YAML, registerGeomFeatures(wave1Registry())).data as Record<string, unknown>, { order: 1 });
	assert.equal(m.dim, 3);
	assert.ok(new Set(m.cells.domain).size >= 2, 'two layer domains');
	const r = areaAndInterface(m);
	assert.equal(r.onIface, 0);
	const box = 2 * (2 * 1 + 2 * 0.75 + 1 * 0.75);
	assert.ok(Math.abs(r.area - box) < 1e-5 * box, `${r.area} vs ${box}`);
});

test('coarse preview adapter meshes the extrude spec with scaled sizes (was: one box or cylinder only)', () => {
	const p = parseSpecText(YAML, registerGeomFeatures(wave1Registry()));
	assert.ok(p.ok && p.spec, 'spec validates');
	const fine = buildMesh(p.spec!, p.params, 1).mesh, coarse = buildMesh(p.spec!, p.params, 2).mesh;
	assert.equal(fine.dim, 3);
	assert.equal(fine.cells.domain.length, meshFromSpec(p.data as Record<string, unknown>, { order: 1 }).cells.domain.length, 'scale 1 = meshFromSpec');
	assert.ok(coarse.cells.domain.length < fine.cells.domain.length, `${coarse.cells.domain.length} < ${fine.cells.domain.length}`);
	assert.equal(areaAndInterface(coarse).onIface, 0);
});
