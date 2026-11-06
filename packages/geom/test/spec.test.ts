// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, parseSpecText, resolveParams } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { registerGeomFeatures, makeResolver, geometryFromSpec, GEOM_FEATURES } from '../src/spec.ts';

test('registrations supersede the provisional seed and every sims/*.yaml validates', () => {
  const reg = registerGeomFeatures(wave1Registry());
  for (const r of GEOM_FEATURES) {
    const got = reg.get('feature', r.type)!;
    assert.equal(got.owner, '@amp/geom');
    assert.ok(!got.provisional);
  }
  for (const f of ['kirsch-plate', 'heat-plate-fin', 'helmholtz-coil', 'si-rib-waveguide', 'cylinder-cavity', 'box-acoustics']) {
    const text = readFileSync(new URL(`../../../sims/${f}.yaml`, import.meta.url), 'utf8');
    assert.deepEqual(parseSpecText(text, reg).issues.map((i) => i.message), [], f);
  }
});

test('geometryFromSpec: kirsch-plate gives the ids the spec selects', () => {
  const text = readFileSync(new URL('../../../sims/kirsch-plate.yaml', import.meta.url), 'utf8');
  const data = parseYaml(text).data as { params: unknown; geometry: { dim: number; features: Array<{ id: string; type: string }> } };
  const G = geometryFromSpec(data.geometry, makeResolver(resolveParams(data.params).scope));
  assert.equal(G.dim, 2);
  if (G.dim !== 2) return;
  assert.deepEqual(G.geometry.entities.domains.map((d) => d.id), ['dom:plate']);
  assert.deepEqual(G.geometry.entities.boundaries.map((d) => d.id).sort(), ['bnd:hole.edge', 'bnd:quarter.bottom', 'bnd:quarter.left', 'bnd:quarter.right', 'bnd:quarter.top']);
  assert.deepEqual(G.geometry.bbox.map((v) => Math.round(v * 1e9) / 1e9), [0, 0, 0.1, 0.1]);
});

test('3D primitives: box and cylinder resolve to SI', () => {
  const R = makeResolver(new Map());
  const G = geometryFromSpec({ dim: 3, features: [{ id: 'room', type: 'box', settings: { size: ['1 m', '0.8 m', '0.6 m'], center: ['0.5 m', '0.4 m', '0.3 m'] } }] }, R);
  assert.deepEqual(G, { dim: 3, solids: [{ type: 'box', id: 'room', x: [0, 1], y: [0, 0.8], z: [0, 0.6] }] });
});
