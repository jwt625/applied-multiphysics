// SPDX-License-Identifier: GPL-3.0-or-later
// Chunk 2 engine audit fixes in wave2d and the module wrapper (DevLog-050 s.9): library n vs library eps_r only with a
// bound wavelength; size guard of the Floquet envelope LU; complex-orthogonal vectors from degenerate clusters of the
// real embedding; eigen `solver` settings outside the 3D electromagnetic module refused. Material values here are the
// library's (borofloat33, sio2-thermal-oxide) or test inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareRun, acousticsModule, emwModule } from '../src/index.ts';
import { emw2dModule, solveWave2D } from '../src/wave2d/index.ts';
import { clusterVectors } from '../src/wave2d/bands.ts';
import { EnvelopeLU, ENVELOPE_LU_MAX_BYTES } from '../src/wave2d/lu.ts';
import { parseYaml } from '@amp/spec';
import type { Solution } from '@amp/spec/types';

const sim = (name: string) => parseYaml(readFileSync(new URL(`../../../sims/${name}.yaml`, import.meta.url), 'utf8')).data as Record<string, any>;
const notesOf = (s: Solution) => (s as { notes?: string[] }).notes ?? [];
const fieldOf = (sol: Solution, name: string, step = 0) => sol.fields.find((f) => f.name === name && (f.step ?? 0) === step)!.data;
const sameBits = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));

const rodsAtX = (rod: Record<string, unknown>) => {
  const spec = sim('phc-square-rods-bands');
  spec.materials[1] = { id: 'rod_mat', ...rod, select: ['dom:disk'] };
  spec.studies[0].settings.kPath = [{ label: 'X', k: [0.5, 0] }];
  spec.studies[0].settings.nBands = 2;
  delete spec.results;
  return spec;
};

test('bands study (no wavelength): a library material with eps_r and n uses the library eps_r, not n', async () => {
  // borofloat33: library eps_r 4.6 (low frequency) and n 1.471 (stated at 587.6 nm only); tan_delta 0 for a lossless pencil
  const ref = await emw2dModule.run(await prepareRun(rodsAtX({ ref: 'materials/borofloat33', override: { mu_r: 1, tan_delta: 0 } }), {}));
  const ovr = await emw2dModule.run(await prepareRun(rodsAtX({ override: { eps_r: 4.6, mu_r: 1 } }), {}));
  assert.equal(ref.scalars.f_0_0!.value, ovr.scalars.f_0_0!.value);
  assert.equal(ref.scalars.f_1_0!.value, ovr.scalars.f_1_0!.value);
  assert.ok(notesOf(ref).some((n) => n.includes("'rod_mat'") && n.includes('library eps_r (4.6') && n.includes('no wavelength')), notesOf(ref).join('\n'));
  // the library tan_delta is applied as before: a band study refuses the lossy medium
  await assert.rejects(emw2dModule.run(await prepareRun(rodsAtX({ ref: 'materials/borofloat33', override: { mu_r: 1 } }), {})), /lossy/);
});

test('driven run at 1.55 um: a library SiO2 film uses the library n at that wavelength (n wins over the library eps_r)', async () => {
  const film = (m: Record<string, unknown>) => {
    const spec = sim('floquet-slab-oblique');
    spec.materials[1] = { id: 'film_mat', ...m, select: ['dom:film'] };
    spec.mesh = { size: { hmax: { value: 0.1, unit: 'um' } } };
    spec.studies[0].settings = { wavelengths: [{ value: 1.55, unit: 'um' }] };
    delete spec.results; delete spec.provenance;
    return spec;
  };
  const p = await prepareRun(film({ ref: 'materials/sio2-thermal-oxide' }), {});
  const nLib = p.materials.film_mat!.n!;
  assert.ok(nLib > 1.4 && nLib < 1.5, `library n ${nLib}`);
  const lib = await emw2dModule.run(p);
  assert.ok(notesOf(lib).some((n) => n.includes("'film_mat'") && n.includes('refractive index n')), notesOf(lib).join('\n'));
  const ovr = await emw2dModule.run(await prepareRun(film({ override: { n: nLib, mu_r: 1 } }), {}));
  assert.ok(sameBits(fieldOf(lib, 'Ez_re'), fieldOf(ovr, 'Ez_re')), 'library run differs from the override n run');
});

test('Floquet envelope LU: refused above the factor-storage budget, with unknowns, estimate and limit in the message', async () => {
  assert.equal(ENVELOPE_LU_MAX_BYTES, 2 ** 30);
  const spec = sim('floquet-slab-oblique');
  spec.mesh = { size: { hmax: { value: 0.1, unit: 'um' } } };
  delete spec.results; delete spec.provenance;
  const p = await prepareRun(spec, {});
  await assert.rejects(solveWave2D(p, 'emw', { envelopeMaxBytes: 2 ** 20 }), (e: Error) => {
    assert.match(e.message, /envelope LU/);
    assert.match(e.message, /\d+ unknowns/);
    assert.match(e.message, /estimated factor storage [\d.]+ MiB/);
    assert.match(e.message, /limit 1\.0 MiB/);
    return true;
  });
  const ok = await solveWave2D(p, 'emw');
  assert.ok(ok.fields.length > 0);
  // the constructor alone refuses before allocating
  assert.throws(() => new EnvelopeLU({ n: 3, rowptr: Int32Array.from([0, 3, 6, 9]), colidx: Int32Array.from([0, 1, 2, 0, 1, 2, 0, 1, 2]), nnz: 9 }, { maxBytes: 8 }), /limit/);
});

test('degenerate cluster of the real embedding: complex-orthogonal eigenvectors, first one unchanged', () => {
  // Hermitian M = diag(1, 2, 1, 3) (complex values on a diagonal pattern); two complex vectors v1, v3 of one eigenvalue.
  // The embedding returns w = (Re v, Im v) and J w = (-Im v, Re v) for each; order [w1, w3, J w1, J w3] made the old
  // choice (cluster entries 0 and 2) return v1 and j v1, the same complex mode
  const n = 4;
  const pat = { n, rowptr: Int32Array.from([0, 1, 2, 3, 4]), colidx: Int32Array.from([0, 1, 2, 3]), nnz: n };
  const M = { re: Float64Array.from([1, 2, 1, 3]), im: new Float64Array(n) };
  const v1 = { re: [1, 0.3, 0, 0.2], im: [0.5, 0, -0.4, 0] }, v3 = { re: [0, 0.1, 1, -0.3], im: [0, 0.2, 0, 0.7] };
  const w = (v: { re: number[]; im: number[] }) => Float64Array.from([...v.re, ...v.im]);
  const J = (v: { re: number[]; im: number[] }) => Float64Array.from([...v.im.map((x) => -x), ...v.re]);
  const out = clusterVectors([w(v1), w(v3), J(v1), J(v3)], n, pat, M, 2);
  assert.equal(out.length, 2);
  assert.ok(sameBits(out[0]!.re, v1.re) && sameBits(out[0]!.im, v1.im));
  const ip = (a: { re: ArrayLike<number>; im: ArrayLike<number> }, b: { re: ArrayLike<number>; im: ArrayLike<number> }) => {
    let r = 0, i = 0;
    for (let k = 0; k < n; k++) { const m = M.re[k]!; r += m * (a.re[k]! * b.re[k]! + a.im[k]! * b.im[k]!); i += m * (a.re[k]! * b.im[k]! - a.im[k]! * b.re[k]!); }
    return Math.hypot(r, i);
  };
  const c = ip(out[0]!, out[1]!) / Math.sqrt(ip(out[0]!, out[0]!) * ip(out[1]!, out[1]!));
  assert.ok(c < 1e-12, `|<v1, M v2>| / norms = ${c}`);
  // a cluster of one complex mode (multiplicity 2) returns its first vector unchanged
  const one = clusterVectors([J(v1), w(v1)], n, pat, M, 1);
  assert.ok(one.length === 1 && sameBits(one[0]!.re, v1.im.map((x) => -x)) && sameBits(one[0]!.im, v1.re));
});

test('eigen study: solver ams / auto refused outside the 3D electromagnetic module; direct accepted', () => {
  const spec = sim('box-acoustics');
  spec.studies[0].settings.solver = 'ams';
  const r = acousticsModule.readiness(spec as never, 'ac');
  assert.ok(!r.ready && r.reasons.some((x) => /solver 'ams'/.test(x) && /3D electromagnetic/.test(x)), r.reasons.join('; '));
  spec.studies[0].settings.solver = 'auto';
  assert.ok(!acousticsModule.readiness(spec as never, 'ac').ready);
  spec.studies[0].settings.solver = 'direct';
  assert.ok(acousticsModule.readiness(spec as never, 'ac').ready);
  const cav = sim('cylinder-cavity');
  for (const s of cav.studies) if (s.type === 'eigen') s.settings = { ...(s.settings ?? {}), solver: 'ams' };
  assert.ok(emwModule.readiness(cav as never, cav.physics[0].id).ready);
});
