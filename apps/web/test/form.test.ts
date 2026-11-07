// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpLog, specJsonSchema } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { SchemaWalker } from '../src/lib/schema/form.ts';

test('schema walker: discriminated nodes, quantity, vector, selection and enum widgets', async () => {
  const reg = wave1Registry();
  const w = new SchemaWalker(specJsonSchema(reg) as Record<string, unknown>);
  const data = (await createOpLog(readFileSync(new URL('../../../sims/kirsch-plate.yaml', import.meta.url), 'utf8'))).data as any;
  const f = w.fields(data, '/physics/0', data.physics[0], new Set(['bcs']));
  const by = Object.fromEntries(f.map((x) => [x.key, x.widget.kind]));
  assert.deepEqual(by, { id: 'string', type: 'string', label: 'string', select: 'selection', settings: 'object' });
  const s = w.fields(data, '/physics/0/settings', data.physics[0].settings);
  assert.deepEqual(s.map((x) => [x.key, x.widget.kind]), [['model', 'enum'], ['thickness', 'quantity']]);
  const bc = w.fields(data, '/physics/0/bcs/2/settings', data.physics[0].bcs[2].settings);
  assert.equal(bc[0]!.widget.kind, 'vector');
  const geo = w.fields(data, '/geometry/features/1/settings', data.geometry.features[1].settings);
  assert.deepEqual(geo.map((x) => [x.key, x.widget.kind]), [['center', 'vector'], ['radius', 'quantity']]);
  const mesh = w.fields(data, '/mesh/size', data.mesh.size);
  assert.equal(mesh[0]!.widget.kind, 'quantity');
});
