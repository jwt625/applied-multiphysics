// SPDX-License-Identifier: GPL-3.0-or-later
// wave2d multi-frequency studies with library materials (DevLog-042 O4, DevLog-050): every frequency step uses the
// material table re-evaluated at lambda = c0 / f (prepareRun materialsAt), so a two-wavelength study must equal the two
// single-wavelength runs bitwise, and differ from a run that evaluates the library once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareRun } from '../src/index.ts';
import { emw2dModule } from '../src/wave2d/index.ts';
import { parseYaml } from '@amp/spec';
import type { Solution } from '@amp/spec/types';

const base = () => {
  const spec = parseYaml(readFileSync(new URL('../../../sims/floquet-slab-oblique.yaml', import.meta.url), 'utf8')).data as Record<string, any>;
  // film of library thermal oxide (dispersive n) instead of the eps 4 override; coarser mesh for speed
  spec.materials[1] = { id: 'film_mat', ref: 'materials/sio2-thermal-oxide', select: ['dom:film'] };
  spec.mesh = { size: { hmax: { value: 0.1, unit: 'um' } } };
  delete spec.results;
  delete spec.provenance;
  return spec;
};
const wl = (v: number[]) => ({ wavelengths: v.map((x) => ({ value: x, unit: 'um' })) });
const fieldOf = (sol: Solution, step: number) => sol.fields.find((f) => f.name === 'Ez_re' && (f.step ?? 0) === step)!.data;

test('multi-wavelength study with a library film equals the single-wavelength runs bitwise', async () => {
  const two = base(); two.studies[0].settings = wl([1.3, 1.55]);
  const p2 = await prepareRun(two, {});
  const s2 = await emw2dModule.run(p2);
  for (const [i, lam] of [[0, 1.3], [1, 1.55]] as const) {
    const one = base(); one.studies[0].settings = wl([lam]);
    const s1 = await emw2dModule.run(await prepareRun(one, {}));
    const a = fieldOf(s2, i), b = fieldOf(s1, 0);
    assert.equal(a.length, b.length);
    let same = true;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { same = false; break; }
    assert.ok(same, `step ${i} (${lam} um) differs from the single-wavelength run`);
  }
  assert.ok((s2 as { notes?: string[] }).notes!.some((n) => /evaluated at lambda = c0 \/ f for each of the 2 frequencies/.test(n)));
  // without the per-wavelength table every step uses one evaluation: the 1.3 um step changes
  const p3 = await prepareRun(two, {});
  delete (p3 as { materialsAt?: unknown }).materialsAt;
  const s3 = await emw2dModule.run(p3);
  const diff = (i: number) => { const a = fieldOf(s2, i), c = fieldOf(s3, i); let d = 0; for (let k = 0; k < a.length; k++) d = Math.max(d, Math.abs(a[k]! - c[k]!)); return d; };
  const d0 = diff(0), d1 = diff(1);
  if (process.env.W2D_VERBOSE) console.log('[dispersion] max |Ez_re| difference vs one evaluation:', d0, d1, (s3 as { notes?: string[] }).notes);
  assert.ok(Math.max(d0, d1) > 1e-6, `expected a dispersion effect, max differences ${d0}, ${d1}`);
});
