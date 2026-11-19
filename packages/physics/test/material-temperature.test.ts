// SPDX-License-Identifier: GPL-3.0-or-later
// Material temperature (DevLog-058): a material node `T` makes prepareRun evaluate the library tables / fits of that
// material at T (falling back to the run temperature CaseCtx.T), with a provenance note; without any temperature the
// earlier "depends on T" note stays. Expected values are read from the library at the same T, none is typed in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, validateSpec } from '@amp/spec';
import { defaultLibrary } from '@amp/materials/node';
import { prepareRun } from '../src/index.ts';
import { physicsRegistry } from '../src/registrations.ts';

const lib = defaultLibrary();
const q = (value: number | number[], unit: string) => ({ value, unit });
const libAt = (id: string, p: string, T: number) => lib.getProperty(id, p, { T }).value as number;

/** 2D stationary heat on two rectangles: Si (library) and Cu (library, optional extra fields). */
function spec(si: Record<string, unknown>, cu: Record<string, unknown> = {}, params?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 'amp-spec/0', id: 'mat-t', title: 'material temperature',
    ...(params ? { params } : {}),
    geometry: { dim: 2, features: [
      { id: 'a', type: 'rect', settings: { size: q([1, 1], 'mm'), center: q([0.5, 0.5], 'mm') } },
      { id: 'b', type: 'rect', settings: { size: q([1, 1], 'mm'), center: q([1.5, 0.5], 'mm') } },
    ] },
    materials: [
      { id: 'si', ref: 'materials/silicon', ...si, select: ['dom:a'] },
      { id: 'cu', ref: 'materials/copper', ...cu, select: ['dom:b'] },
    ],
    physics: [{ id: 'ht', type: 'heat', select: ['dom:a', 'dom:b'], bcs: [{ id: 'T', type: 'temperature', select: ['bnd:a.left'], settings: { T: q(300, 'K') } }] }],
    mesh: { size: { hmax: q(0.5, 'mm') } },
    studies: [{ id: 's', type: 'stationary', physics: ['ht'] }],
  };
}

test('material T: library T tables of that material resolve at the node T (Si k, cp at 350 K), with a provenance note', async () => {
  const p = await prepareRun(spec({ T: q(350, 'K') }), { library: lib });
  assert.equal(p.materials.si!.k, libAt('silicon', 'k', 350));
  assert.equal(p.materials.si!.cp, libAt('silicon', 'cp', 350));
  assert.ok(p.notes.includes('materials.si (materials/silicon): library values at T = 350 K (material temperature)'), p.notes.join('\n'));
  // the other material has no T and the run has none: its T leaves still fail with the earlier note
  assert.equal(p.materials.cu!.k, undefined);
  assert.ok(p.notes.some((n) => n.startsWith('materials.cu (materials/copper).k:') && n.includes('depends on T')), p.notes.join('\n'));
});

test('material T: without node T and without a run T the "depends on T" note stays; run T alone is used for every material', async () => {
  const none = await prepareRun(spec({}), { library: lib });
  assert.equal(none.materials.si!.k, undefined);
  assert.ok(none.notes.some((n) => n.startsWith('materials.si (materials/silicon).k:') && n.includes('depends on T')), none.notes.join('\n'));
  const run = await prepareRun(spec({}), { library: lib, T: 320 });
  assert.equal(run.materials.si!.k, libAt('silicon', 'k', 320));
  assert.equal(run.materials.cu!.k, libAt('copper', 'k', 320));
  assert.ok(!run.notes.some((n) => n.includes('(material temperature)')), run.notes.join('\n'));
});

test('material T takes precedence over the run T (noted); the other material uses the run T', async () => {
  const p = await prepareRun(spec({ T: q(25, 'degC') }), { library: lib, T: 400 });
  assert.equal(p.materials.si!.k, libAt('silicon', 'k', 298.15));
  assert.equal(p.materials.cu!.k, libAt('copper', 'k', 400));
  assert.ok(p.notes.includes('materials.si (materials/silicon): library values at T = 298.15 K (material temperature), not at the run temperature 400 K'), p.notes.join('\n'));
});

test('material T: an override wins at any T; a parameter T resolves; N/A T falls back to the run T with a note', async () => {
  const ov = await prepareRun(spec({ T: q(350, 'K'), override: { k: q(100, 'W/(m*K)') } }), { library: lib });
  assert.equal(ov.materials.si!.k, 100);
  assert.equal(ov.materials.si!.cp, libAt('silicon', 'cp', 350));
  assert.ok(ov.notes.some((n) => n.endsWith('(material temperature); override values as given')), ov.notes.join('\n'));
  const par = await prepareRun(spec({ T: 'T_si' }, {}, { T_si: q(330, 'K') }), { library: lib });
  assert.equal(par.materials.si!.k, libAt('silicon', 'k', 330));
  const naSpec = { ...spec({ T: { value: 'N/A', unit: 'K' } }), missing: [{ path: 'materials.si.T.value', what: 'material temperature not known' }] };
  const na = await prepareRun(naSpec, { library: lib, T: 310 });
  assert.equal(na.materials.si!.k, libAt('silicon', 'k', 310));
  assert.ok(na.notes.includes('materials.si.T: N/A; run temperature 310 K used'), na.notes.join('\n'));
});

test('material T: materialsAt keeps the node T (copy semantics, notes not repeated per wavelength)', async () => {
  const p = await prepareRun(spec({ T: q(350, 'K') }), { library: lib });
  const nn: string[] = [];
  const a = p.materialsAt(1.55e-6, nn);
  assert.equal(a.si!.k, libAt('silicon', 'k', 350));
  assert.ok(!nn.some((n) => n.includes('(material temperature)')), nn.join('\n'));
  a.si!.k = -1;
  assert.equal(p.materialsAt(1.55e-6).si!.k, libAt('silicon', 'k', 350));
});

test('material T schema: a temperature quantity (K or degC) is accepted, another dimension or a non-positive T is rejected', () => {
  const issues = (t: unknown) => validateSpec(spec({ T: t }), physicsRegistry()).issues.filter((i) => i.severity !== 'notice');
  assert.deepEqual(issues(q(300, 'K')), []);
  assert.deepEqual(issues(q(25, 'degC')), []);
  assert.ok(issues(q(300, 'm')).some((i) => i.dotted === 'materials.0.T'), JSON.stringify(issues(q(300, 'm'))));
  assert.ok(issues(q(0, 'K')).some((i) => i.dotted === 'materials.0.T'), JSON.stringify(issues(q(0, 'K'))));
});

test('packaging sims: the material T resolves the library values the earlier overrides held (bitwise)', async () => {
  // earlier overrides (library values at 298.15 K) were: Cu alpha, k; Si alpha, k (TSV sims, warpage, interposer); Si eps_r (CPW)
  const sim = (n: string) => parseYaml(readFileSync(new URL(`../../../sims/${n}.yaml`, import.meta.url), 'utf8')).data as Record<string, unknown>;
  const ax = await prepareRun(sim('tsv-stress-axisym'), { library: lib });
  for (const [m, id] of [['cu', 'copper'], ['silicon', 'silicon']] as const) {
    assert.equal(ax.materials[m]!.alpha, libAt(id, 'alpha', 298.15));
    assert.equal(ax.materials[m]!.k, libAt(id, 'k', 298.15));
  }
  const cpw = await prepareRun(sim('cpw-si-interposer'), { library: lib });
  assert.equal(cpw.materials.silicon!.eps_r, libAt('silicon', 'eps_r', 298.15));
});
