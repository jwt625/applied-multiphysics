// SPDX-License-Identifier: GPL-3.0-or-later
// Resonance search (DevLog-061): method error on synthetic line shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findResonance, lorentzFit, type ResonanceDef } from '../src/resonance.ts';

const DEF: ResonanceDef = { scan: 13, window: [1.525, 1.535], shape: 'peak', baseline: 1, tol: 1e-3, maxIter: 6 };
const lor = (x0: number, g: number, A = 1) => (x: number) => A / (1 + ((x - x0) / g) ** 2);
const batch = (f: (x: number) => number, calls?: number[]) => async (xs: number[]) => { calls?.push(xs.length); return xs.map(f); };

test('Lorentzian fit through 1 / p is exact for an exact Lorentzian (any spacing)', () => {
  const f = lor(1.5305649, 3.4e-4, 0.99994);
  const xs = [1.529, 1.5301, 1.5323];
  const r = lorentzFit(xs, xs.map(f), 1.53, 1e-3);
  assert.ok(!('error' in r));
  assert.ok(Math.abs(r.x0 - 1.5305649) < 1e-12 && Math.abs(r.g / 3.4e-4 - 1) < 1e-9 && Math.abs(r.A / 0.99994 - 1) < 1e-9, JSON.stringify(r));
});

test('peak: centre, FWHM, Q and peak value of an exact Lorentzian to round-off; both width estimates agree', async () => {
  const x0 = 1.5305649, g = 3.39e-4;
  const calls: number[] = [];
  const r = await findResonance(batch(lor(x0, g, 0.99994), calls), DEF);
  assert.ok(!('error' in r), JSON.stringify(r));
  assert.ok(Math.abs(r.center - x0) < 1e-10, `${r.center}`);
  assert.ok(Math.abs(r.fwhm / (2 * g) - 1) < 1e-8);
  assert.ok(Math.abs(r.q / (x0 / (2 * g)) - 1) < 1e-8);
  assert.ok(Math.abs(r.peak - 0.99994) < 1e-9);
  assert.ok(Math.abs(r.fwhm_halfmax / (2 * g) - 1) < 1e-6, `${r.fwhm_halfmax}`);
  assert.ok(Math.abs(r.center_halfmax - x0) < 1e-9);
  assert.equal(calls[0], 13);
  assert.ok(r.diag.solves < 45, `${r.diag.solves}`);
});

test('dip below a baseline: the dip of 1 - D is found as a peak of baseline - y', async () => {
  const D = lor(1.58, 4.7e-4, 0.9999);
  const r = await findResonance(batch((x) => 1 - D(x)), { ...DEF, window: [1.575, 1.585], shape: 'dip' });
  assert.ok(!('error' in r));
  assert.ok(Math.abs(r.center - 1.58) < 1e-10 && Math.abs(r.fwhm / 9.4e-4 - 1) < 1e-8);
  assert.ok(Math.abs(r.peak - (1 - 0.9999)) < 1e-9, `minimum transmission ${r.peak}`);
});

test('a Lorentzian in frequency read on the wavelength axis: width error of order 1 / Q', async () => {
  const c = 299792458, lam0 = 1.5306e-6, Q = 2258, f0 = c / lam0, gf = f0 / (2 * Q);
  const r = await findResonance(batch((lamUm) => lor(f0, gf)(c / (lamUm * 1e-6))), DEF);
  assert.ok(!('error' in r));
  const qRel = Math.abs(r.q / Q - 1), cRel = Math.abs(r.center * 1e-6 / lam0 - 1);
  assert.ok(qRel < 2 / Q && cRel < 1 / Q ** 2 * 10, `Q rel ${qRel}, centre rel ${cRel}`);
  // the two width estimates differ by the line-shape asymmetry, also O(1 / Q)
  assert.ok(Math.abs(r.q_halfmax / r.q - 1) < 2 / Q);
});

test('background and a neighbouring line show in the fit residual and the width difference', async () => {
  const f = (x: number) => lor(1.53, 3.4e-4)(x) + lor(1.5325, 3.4e-4, 0.5)(x) + 0.01;
  const r = await findResonance(batch(f), DEF);
  assert.ok(!('error' in r));
  // the background and the neighbour's slope pull the centre by a small fraction of the FWHM (here about 2e-3)
  assert.ok(Math.abs(r.center - 1.53) < 1e-2 * r.fwhm, `${r.center}`);
  assert.ok(r.diag.fit_residual > 1e-4, `residual ${r.diag.fit_residual}`);
  assert.ok(Math.abs(r.fwhm_halfmax / r.fwhm - 1) > 1e-4);
});

test('extreme at the window edge, flat data and non-finite values are errors, never a silent value', async () => {
  const edge = await findResonance(batch(lor(1.5249, 3e-4)), DEF);
  assert.ok('error' in edge && /window edge/.test(edge.error));
  const nan = await findResonance(batch((x) => (x > 1.53 ? NaN : lor(1.53, 3e-4)(x))), DEF);
  assert.ok('error' in nan && /non-finite/.test(nan.error));
  const flat = await findResonance(batch(() => 0.5), DEF);
  assert.ok('error' in flat);
});

// ---- end to end through the engine worker with a mock module (Lorentzian in the study wavelengths) ----
import { main } from '../src/cli.ts';
import { caseYaml, makeRoot, MOCK_PHYSICS } from './helpers.ts';

// drop power D(lambda) = 1 / (1 + ((lambda - x0(h)) / g)^2), x0(h) = 1.5306e-6 m (1 - 1e-4 h^2), g = 3.4e-10 m;
// one scalar per wavelength, step-suffixed when the study has several (as wave2d)
const MOCK_RES = MOCK_PHYSICS.replace(/async run\(ctx\) \{[\s\S]*?\n  \},\n\}\];/, `async run(ctx) {
    const h = ctx.mesh.h;
    const st = ctx.spec.studies.find((s) => s.type === 'frequency');
    const lams = st.settings.wavelengths.map((v) => (typeof v === 'number' ? v : v.value));
    const x0 = 1.5306e-6 * (1 - 1e-4 * h * h), g = 3.4e-10;
    const scalars = {};
    lams.forEach((l, i) => { scalars[lams.length > 1 ? 'D_' + i : 'D'] = { value: Math.sqrt(1 / (1 + ((l - x0) / g) ** 2)), unit: '1' }; });
    return {
      meshHash: 'm' + h, fields: [], scalars,
      stats: { dof: Math.round(1 / (h * h)), solver: 'mock' }, timing: { solve: 1 },
      run: { engine: '@amp/physics@mock', specHash: 's', meshHash: 'm' + h, startedAt: '2026-11-18T00:00:00-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' },
    };
  },
}];
export const RESULT_NAMES = { mock: { fields: [], scalars: ['D', 'D_<s>'] } };`);
const SPEC = '{schema: amp-spec/0, physics: [{id: p1, type: mock}], studies: [{id: s, type: frequency, settings: {wavelengths: [1.53e-6]}}]}';
const resTarget = (id: string, output: string, unit: string, value: number, extra = '') => `
  - id: ${id}
    quantity: ${id}
    metric_id: ${id}
    value: ${value}
    unit: "${unit}"
    tolerance: {rel: 1.0e-7, after: finest}
    basis: D
    form: closed_form
    provenance: {citation: synthetic, locator: test, accessed: 2026-11-18}
    extract: {kind: resonance, name: D, power: 2, shape: peak, axis: wavelength, window: [${extra || '1.525e-6, 1.535e-6'}], window_unit: m, output: ${output}}`;

test('resonance extract end to end: centre in the target unit, Q, shared search per level, diagnostics, edge error', async () => {
  const fx = makeRoot({ physicsSrc: MOCK_RES });
  try {
    const x0f = 1.5306e-6 * (1 - 1e-4 * 0.025 ** 2);
    const refs = resTarget('lam_c', 'center', 'mm', x0f * 1e3) + resTarget('Q', 'q', '1', x0f / 6.8e-10)
      + resTarget('Q_hm', 'q_halfmax', '1', x0f / 6.8e-10) + resTarget('edge', 'center', 'mm', 1, '1.5307e-6, 1.535e-6');
    const y = caseYaml({ spec: SPEC }).replace(/references:\n[\s\S]*?\nconvergence:/, `references:${refs}\nconvergence:`);
    fx.write('eval/cases/a/XX-01.yaml', y);
    let buf = '';
    await main(['--root', fx.root, '--no-log', '--json'], { out: (s) => { buf += s; }, err: () => {} });
    const out = JSON.parse(buf) as { results: Array<{ targets: Array<{ target: string; status: string; reason?: string; value: number; levels?: Array<{ diag?: Record<string, number> }> }> }> };
    const t = Object.fromEntries(out.results[0]!.targets.map((x) => [x.target, x]));
    assert.equal(t.lam_c!.status, 'pass', JSON.stringify(t.lam_c));
    assert.equal(t.Q!.status, 'pass', JSON.stringify(t.Q));
    // the half-maximum width of the same exact Lorentzian: the secant iteration converges well below its stopping step
    assert.equal(t.Q_hm!.status, 'pass', JSON.stringify(t.Q_hm));
    assert.equal(t.edge!.status, 'error');
    assert.match(t.edge!.reason!, /window edge/);
    const dg = t.lam_c!.levels!.at(-1)!.diag!;
    assert.ok(dg.solves! > 13 && dg.fit_residual! < 1e-9, JSON.stringify(dg));
  } finally { fx.cleanup(); }
});

// ---- wave2d result names (DevLog-047 R3): higher port modes and step-suffixed scalars are declared ----
import { nameDeclared } from '../src/registry.ts';
import { RESULT_NAMES_WAVE2D } from '../../physics/src/wave2d/spec.ts';

test('wave2d declares higher-mode S and step-suffixed scalars; undeclared names stay undeclared', () => {
  const emw = RESULT_NAMES_WAVE2D['emw-2d']!.scalars, ac = RESULT_NAMES_WAVE2D['acoustics-frequency']!.scalars;
  for (const n of ['S21_abs', 'S11_10_abs', 'S21_01_phase', 'S31_abs_3', 'S11_20_dB_12', 'sigma2d_back_0', 'freq_2', 'P_in_1', 'P_src_1_4', 'beta_1_0_2', 'neff_2_1_0', 'fmax_0', 'f_1_10'])
    assert.ok(nameDeclared(emw, n), n);
  for (const n of ['S21_abs_0', 'S11_10_re', 'p_x', 'freq_5']) assert.equal(nameDeclared(ac, n), n !== 'p_x', n);
  for (const n of ['S21_mag', 'sigma2d_side', 'S21_abs_0_1', 'neff_1_0_0_0']) assert.ok(!nameDeclared(emw, n), n);
});

// DevLog-066: points clamped to the window and to x > 0; dip gated on the fit residual (a wrong baseline is an error)
test('refinement and half-maximum points never leave the window; a wide line near the edge is an error, not a value outside', async () => {
  const seen: number[] = [];
  const f = lor(1.5305, 2e-3);   // FWHM 4e-3 in a 1e-2 window: x0 +- 1.1 g fits, the start g of the coarse fit may not
  const w: [number, number] = [1.525, 1.535];
  const r = await findResonance(async (xs) => { seen.push(...xs); return xs.map(f); }, { ...DEF, window: w });
  assert.ok(seen.every((x) => x >= w[0] && x <= w[1] && x > 0), `outside: ${seen.filter((x) => x < w[0] || x > w[1])}`);
  assert.ok(!('error' in r) && Math.abs(r.center - 1.5305) < 1e-9, JSON.stringify(r));
  // a line wider than the window: an error naming the window
  const seen2: number[] = [];
  const r2 = await findResonance(async (xs) => { seen2.push(...xs); return xs.map(lor(1.5305, 6e-3)); }, { ...DEF, window: w });
  assert.ok('error' in r2 && /window/.test(r2.error), JSON.stringify(r2));
  assert.ok(seen2.every((x) => x >= w[0] && x <= w[1]));
  // a window that reaches x <= 0 (frequency axis from 0): no sample at x <= 0
  const seen3: number[] = [];
  await findResonance(async (xs) => { seen3.push(...xs); return xs.map(lor(0.3, 0.2)); }, { ...DEF, window: [0, 1] });
  assert.ok(seen3.every((x) => x > 0), `${Math.min(...seen3)}`);
});

test('dip: a baseline that is not the off-resonance level is an error (fit residual gate); the right baseline passes', async () => {
  const D = lor(1.58, 4.7e-4, 0.5);
  const ok = await findResonance(batch((x) => 0.95 - D(x)), { ...DEF, window: [1.575, 1.585], shape: 'dip', baseline: 0.95 });
  assert.ok(!('error' in ok) && ok.diag.fit_residual < 1e-9, JSON.stringify(ok));
  for (const off of [0.02, 0.05]) {
    const bad = await findResonance(batch((x) => 0.95 - D(x)), { ...DEF, window: [1.575, 1.585], shape: 'dip', baseline: 0.95 + off });
    assert.ok('error' in bad && /fit residual/.test(bad.error), `offset ${off}: ${JSON.stringify(bad)}`);
  }
});

test('dip residual gate: residual and width error per baseline offset (numbers for DevLog-066 s.4)', async () => {
  const D = lor(1.58, 4.7e-4, 0.5);
  const rows: string[] = [];
  for (const off of [0.005, 0.01, 0.02, 0.05]) {
    // gate off (peak shape on baseline - y) to read the residual and the width error the offset causes
    const r = await findResonance(batch((x) => 0.95 + off - (0.95 - D(x))), { ...DEF, window: [1.575, 1.585], shape: 'peak' });
    if (!('error' in r)) rows.push(`offset/depth ${off / 0.5}: residual ${r.diag.fit_residual.toExponential(2)}, fwhm error ${(r.fwhm / 9.4e-4 - 1).toExponential(2)}`);
  }
  assert.equal(rows.length, 4);
  if (process.env.AMP_PRINT_DIP) console.log(rows.join('\n'));
});
