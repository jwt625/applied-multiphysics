// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPatch, createOpLog, parseSpecText } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { diffPatch, jsonEq, encodeShare, decodeShare, setOp } from '../src/lib/state/diff.ts';

const text = readFileSync(new URL('../../../sims/kirsch-plate.yaml', import.meta.url), 'utf8');

test('diffPatch reproduces the target and round-trips through the op log and the share code', async () => {
  const reg = wave1Registry();
  const log0 = await createOpLog(text);
  const a = log0.data as any;
  const b = structuredClone(a);
  b.params.D.value = 7;
  b.mesh.refine[0].h = 'D/30';
  b.results.push({ id: 'syy', type: 'plot2d', data: 'std1', expr: 'solid.syy', unit: 'MPa' });
  delete b.description;
  const p = diffPatch(a, b);
  assert.equal(p.length, 4);
  const p2 = decodeShare(encodeShare(p));
  assert.deepEqual(p2, p);
  const log = await createOpLog(text, { registry: reg });
  await log.apply(p2, { actor: 'user' });
  assert.ok(jsonEq(log.data, b));
  assert.ok(parseSpecText(log.text, reg).ok);
  assert.ok(log.text.includes('# H1 Plate with a hole'), 'comments kept by the splice');
  await log.undo({ actor: 'user' });
  assert.equal(log.text, text);
  assert.deepEqual(setOp(a, '/params/D/value', 10), []);
  assert.equal(setOp(a, '/params/D/value', 4)[0]!.op, 'replace');
  void applyPatch;
});
