// SPDX-License-Identifier: GPL-3.0-or-later
// Bloch band gates (DevLog-050 s.1.5): G-B1 empty lattice vs the folded light line (TM, TE), G-B5 eigen study at a
// fixed k = bands study at the same k. Two mesh levels each, error decreasing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellSpec, emptyLattice, runSpec, log, bref, SQUARE_PATH } from './bloch-common.ts';

const n = 1.5;   // eps 2.25 (test input)

for (const pol of ['TM', 'TE'] as const) {
  test(`G-B1 empty lattice ${pol}: 8 bands at Gamma, X, M and generic points vs |k + G| c0 / (2 pi n)`, async () => {
    const errs: number[] = [];
    for (const h of [0.125, 0.0625]) {
      const path = [...SQUARE_PATH.slice(0, 3), { label: 'P', k: [0.17, 0.31] }];
      const { sol, ms } = await runSpec(cellSpec({ ax: 1, ay: 1, h, pol, epsBg: n * n, study: { type: 'bands', settings: { kPath: path, interpolate: 1, nBands: 8 } } }));
      const B = sol.wave2d.bands;
      let e = 0;
      B.k.forEach((k, i) => {
        const ref = emptyLattice(k, 1, 1, n, 8);
        B.f[i]!.forEach((f, b) => { e = Math.max(e, Math.abs(f - ref[b]!) / ref[7]!); });
      });
      log(pol, 'h', h, 'max rel err', e.toExponential(2), 'k points', B.k.length, 'ms', ms.toFixed(0));
      errs.push(e);
    }
    // P2: eigenvalue error O(h^4); measured 3.0e-4 / 1.9e-5 (DevLog-050 s.4)
    assert.ok(errs[0]! / errs[1]! > 12, `order: ratio ${errs[0]! / errs[1]!}`);
    assert.ok(errs[1]! < 3e-5, `fine ${errs[1]}`);
  });
}

test('G-B5 eigen study at fixed k equals the bands study at the same k (TM, rod cell)', async () => {
  const base = { ax: 1, ay: 1, h: 0.1, pol: 'TM' as const, epsBg: 1, rod: { r: 0.2, eps: 12, h: 0.04 } };
  const kk = [0.3, 0.1];
  const b = await runSpec(cellSpec({ ...base, study: { type: 'bands', settings: { kPath: [{ label: 'P', k: kk }], interpolate: 0, nBands: 4 } } }));
  const e = await runSpec(cellSpec({ ...base, kx: kk[0], ky: kk[1], study: { type: 'eigen', settings: { nModes: 4 } } }));
  for (let i = 0; i < 4; i++) {
    const fb = b.sol.scalars[`f_${i}_0`]!.value, fe = e.sol.scalars[`f_${i}`]!.value;
    log('band', i, fb, fe);
    assert.ok(Math.abs(fb - fe) <= 1e-10 * fb, `band ${i}: ${fb} vs ${fe}`);
  }
});

interface BraggRef { bragg: { ax: number; ay: number; d1: number; eps1: number; eps2: number; points: Array<{ pol: 'TM' | 'TE'; kReduced: [number, number]; f: number[] }> } }

for (const pol of ['TM', 'TE'] as const) {
  test(`G-B2 Bragg stack ${pol} (eps 4 / 1, d1 0.4, ax 1, ay 0.5 m), generic (K, k_y) vs the transfer-matrix dispersion`, async () => {
    const R = bref<BraggRef>('bloch_reference.json').bragg;
    const pts = R.points.filter((p) => p.pol === pol);
    const errs: number[] = [];
    for (const h of [0.0625, 0.03125]) {
      const path = pts.map((p, i) => ({ label: `P${i}`, k: p.kReduced }));
      // separate segments: interpolate 0 visits exactly the listed points
      const { sol, ms } = await runSpec(cellSpec({ ax: R.ax, ay: R.ay, h, pol, epsBg: 1, layers: { d1: R.d1, eps1: R.eps1, eps2: R.eps2 }, study: { type: 'bands', settings: { kPath: path, interpolate: 0, nBands: 8 } } }));
      let e = 0;
      pts.forEach((p, i) => sol.wave2d.bands.f[i]!.forEach((f, b) => { e = Math.max(e, Math.abs(f - p.f[b]!) / p.f[b]!); }));
      log(pol, 'bragg h', h, 'max rel err', e.toExponential(2), 'ms', ms.toFixed(0));
      errs.push(e);
    }
    assert.ok(errs[0]! / errs[1]! > 12, `order: ratio ${errs[0]! / errs[1]!}`);
    assert.ok(errs[1]! < 3e-5, `fine ${errs[1]}`);
  });
}

interface RodsRef { rods_pwe: { kReduced: number[][]; f: number[][]; floor_abs_nmax20_vs_24: number } }
// eval/expected/WO-04.json: MPB 1.34.0 Richardson (gap_*) and the PWE limit estimates (precision.pwe_limit_est)
const WO04 = { gap_lower: 0.2806643916748245, gap_upper: 0.4171623956235006, pwe_lower: 0.28066224255525063, pwe_upper: 0.4171631976452128 };

test('G-B3 MPB tutorial rods (r 0.2 a, eps 12) TM: band-1 maximum and band-2 minimum vs MPB; whole band table vs PWE', async () => {
  const P = bref<RodsRef>('bloch_reference.json').rods_pwe;
  const errs: Array<{ lo: number; hi: number; pwe: number; loPwe: number; hiPwe: number }> = [];
  for (const [h, hr] of [[0.1, 0.025], [0.05, 0.0125]] as const) {
    const { sol, ms } = await runSpec(cellSpec({ ax: 1, ay: 1, h, pol: 'TM', epsBg: 1, rod: { r: 0.2, eps: 12, h: hr }, study: { type: 'bands', settings: { kPath: SQUARE_PATH, interpolate: 4, nBands: 8 } } }));
    const fn = (v: number) => v / 299792458;   // a = 1 m: f a / c0
    const lo = fn(sol.scalars.fmax_0!.value), hi = fn(sol.scalars.fmin_1!.value);
    let pwe = 0;
    sol.wave2d.bands.f.forEach((row, i) => row.forEach((f, b) => { pwe = Math.max(pwe, Math.abs(fn(f) - P.f[i]![b]!)); }));
    const e = { lo: Math.abs(lo / WO04.gap_lower - 1), hi: Math.abs(hi / WO04.gap_upper - 1), pwe, loPwe: lo / WO04.pwe_lower - 1, hiPwe: hi / WO04.pwe_upper - 1 };
    log('rods h', h, 'gap', lo, hi, 'rel err', e.lo.toExponential(2), e.hi.toExponential(2), 'vs PWE limit', e.loPwe.toExponential(2), e.hiPwe.toExponential(2), 'max abs vs PWE (c/a)', pwe.toExponential(2), 'PWE floor', P.floor_abs_nmax20_vs_24.toExponential(2), 'ms', ms.toFixed(0), 'dof', sol.stats?.dof);
    errs.push(e);
  }
  // both levels inside the case tolerance (rel 1e-4 vs MPB); the FE values settle (level change << tolerance) at about
  // 1e-6 from the PWE limit estimate (WO-04.json pwe_limit_est), i.e. below the MPB-vs-PWE spread (7.7e-6 rel), so
  // a 'decreasing vs MPB' test would test the reference, not the solver
  for (const e of errs) assert.ok(e.lo < 1e-4 && e.hi < 1e-4, `MPB case tolerance rel 1e-4: ${e.lo}, ${e.hi}`);
  assert.ok(Math.abs(errs[1]!.lo - errs[0]!.lo) < 1e-5 && Math.abs(errs[1]!.hi - errs[0]!.hi) < 1e-5, 'level change below 1e-5 rel');
  assert.ok(Math.abs(errs[1]!.loPwe) < 5e-6 && Math.abs(errs[1]!.hiPwe) < 5e-6, `vs PWE limit ${errs[1]!.loPwe}, ${errs[1]!.hiPwe}`);
  // every band at every path point within the PWE floor (nmax 20 vs 24) plus the FE error of the gap edges
  assert.ok(errs[1]!.pwe < 1e-4, `band table vs PWE ${errs[1]!.pwe}`);
});
