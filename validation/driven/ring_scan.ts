// SPDX-License-Identifier: GPL-3.0-or-later
// Resonance scan of the add-drop ring example (sims/ring-resonator-bus.yaml) on the engine, DevLog-047.
// For each isolated-ring resonance lambda_m of validation/driven/ring_reference.json (exact Bessel dispersion relation)
// in the window: (1) zoom scans of the drop power |S31|^2 (batches of wavelengths in one frequency study, so the
// symbolic analysis is shared) until the step is below FWHM / 100; (2) the half-maximum crossings of the computed
// spectrum by bisection (spectrum FWHM); (3) a Lorentzian fit D = D0 / (1 + ((lambda - lambda_c) / gamma)^2) through
// 1 / D = a lambda^2 + b lambda + c (linear least squares on 11 points within +-1 FWHM): lambda_c, FWHM = 2 gamma.
// Outputs per level: resonance wavelengths (peak and fit), FSR, loaded Q from both widths, peak drop / through power.
// Run (repo root): nice -n 10 node --max-old-space-size=1536 validation/driven/ring_scan.ts [--hf 1] [--out file.json]
//   [--seed coarser-level.json] (start windows and stopping tolerances from a coarser level's peaks and widths)
import { readFileSync, writeFileSync } from 'node:fs';
import { parseYaml } from '../../packages/spec/src/index.ts';
import { prepareRun, runStudy } from '../../packages/physics/src/index.ts';

const ROOT = new URL('../../', import.meta.url);
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const hf = Number(opt('--hf') ?? 1);
const ref = JSON.parse(readFileSync(new URL('validation/driven/ring_reference.json', ROOT), 'utf8')) as { resonances: Array<{ m: number; lambda_um: number }> };
const base = parseYaml(readFileSync(new URL('sims/ring-resonator-bus.yaml', ROOT), 'utf8')).data as Record<string, any>;
const WIN = [Number(opt('--lo') ?? 1.50), Number(opt('--hi') ?? 1.60)];

let solves = 0;
async function batch(lams: number[]): Promise<Array<{ lam: number; drop: number; thru: number; refl: number; add: number }>> {
  const spec = structuredClone(base);
  spec.studies.find((s: any) => s.id === 's').settings.wavelengths = lams.map((l) => ({ value: l, unit: 'um' }));
  const prep = await prepareRun(spec, { hFactor: hf, studyId: 's' });
  const sol = await runStudy(prep, { studyId: 's' });
  solves += lams.length;
  const sc = sol.scalars as Record<string, { value: number }>;
  const g = (n: string, i: number) => sc[lams.length > 1 ? `${n}_${i}` : n]!.value;
  return lams.map((lam, i) => ({ lam, drop: g('S31_abs', i) ** 2, thru: g('S21_abs', i) ** 2, refl: g('S11_abs', i) ** 2, add: g('S41_abs', i) ** 2 }));
}
const lin = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

async function resonance(lamRef: number, seed?: { peak_um: number; fwhm_spectrum_um: number }) {
  // zoom on the drop peak (around the isolated-ring value, or around a coarser level's peak with --seed)
  const c0s = seed?.peak_um ?? lamRef, hw = seed ? 3 * seed.fwhm_spectrum_um : 0.003;
  let lo = c0s - hw, hi = c0s + hw, best = { lam: lamRef, drop: 0 } as { lam: number; drop: number };
  for (let it = 0; it < 8; it++) {
    const r = await batch(lin(lo, hi, 13));
    const k = r.reduce((a, x, i) => (x.drop > r[a]!.drop ? i : a), 0);
    best = r[k]!;
    const step = (hi - lo) / 12;
    if (k === 0 || k === 12) { lo = best.lam - 6 * step; hi = best.lam + 6 * step; continue; }   // peak at the edge: shift
    lo = best.lam - 1.5 * step; hi = best.lam + 1.5 * step;
    if (step < (seed ? seed.fwhm_spectrum_um / 100 : 2e-6)) break;
  }
  const peak = (await batch([best.lam]))[0]!;
  // half-maximum crossings by bisection (each side), bracket from the peak outwards
  const half = peak.drop / 2;
  async function cross(dir: 1 | -1): Promise<number> {
    let a = peak.lam, d = 1e-5, b = a + dir * d;
    while ((await batch([b]))[0]!.drop > half) { a = b; d *= 2; b = a + dir * d; }
    for (let i = 0; i < 30 && Math.abs(b - a) > (seed ? 1e-4 * seed.fwhm_spectrum_um : 1e-9); i++) { const c = 0.5 * (a + b); if ((await batch([c]))[0]!.drop > half) a = c; else b = c; }
    return 0.5 * (a + b);
  }
  const l1 = await cross(-1), l2 = await cross(1);
  const fwhm = l2 - l1;
  // Lorentzian fit through 1 / D quadratic in lambda
  const pts = await batch(lin(peak.lam - fwhm, peak.lam + fwhm, 11));
  const y = pts.map((p) => 1 / p.drop);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bv = [0, 0, 0];
  // centre lambda for conditioning
  const c0 = peak.lam;
  const Xc = pts.map((p) => { const t = p.lam - c0; return [t * t, t, 1]; });
  for (let i = 0; i < pts.length; i++) for (let r = 0; r < 3; r++) { bv[r]! += Xc[i]![r]! * y[i]!; for (let c = 0; c < 3; c++) A[r]![c]! += Xc[i]![r]! * Xc[i]![c]!; }
  const sol3 = solve3(A, bv);
  const [qa, qb, qc] = sol3;
  const tc = -qb / (2 * qa), invD0 = qc - (qb * qb) / (4 * qa), D0 = 1 / invD0, gamma = Math.sqrt(invD0 / qa);
  const resid = Math.max(...pts.map((p, i) => Math.abs((qa * Xc[i]![0]! + qb * Xc[i]![1]! + qc) * p.drop - 1)));
  return { lamRef, peak_um: peak.lam, drop_peak: peak.drop, through_at_peak: peak.thru, refl_at_peak: peak.refl, add_at_peak: peak.add,
    fwhm_spectrum_um: fwhm, Q_spectrum: peak.lam / fwhm, fit_center_um: c0 + tc, fit_fwhm_um: 2 * gamma, Q_fit: (c0 + tc) / (2 * gamma), fit_D0: D0, fit_max_rel_residual: resid };
}
function solve3(A: number[][], b: number[]): [number, number, number] {
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let k = 0; k < 3; k++) {
    let p = k; for (let i = k + 1; i < 3; i++) if (Math.abs(M[i]![k]!) > Math.abs(M[p]![k]!)) p = i;
    [M[k], M[p]] = [M[p]!, M[k]!];
    for (let i = k + 1; i < 3; i++) { const f = M[i]![k]! / M[k]![k]!; for (let j = k; j < 4; j++) M[i]![j]! -= f * M[k]![j]!; }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) { let s = M[i]![3]!; for (let j = i + 1; j < 3; j++) s -= M[i]![j]! * x[j]!; x[i] = s / M[i]![i]!; }
  return x as [number, number, number];
}

const t0 = performance.now();
const res = [];
const seeds = opt('--seed') ? (JSON.parse(readFileSync(opt('--seed')!, 'utf8')) as { resonances: Array<{ m: number; peak_um: number; fwhm_spectrum_um: number }> }).resonances : null;
for (const r of ref.resonances.filter((x) => x.lambda_um > WIN[0]! && x.lambda_um < WIN[1]!)) {
  const o = { m: r.m, ...(await resonance(r.lambda_um, seeds?.find((x) => x.m === r.m))) };
  process.stderr.write(`${JSON.stringify(o)}\n`);
  res.push(o);
}
const out = { hFactor: hf, solves, wall_s: (performance.now() - t0) / 1000, rss_MB: Math.round(process.memoryUsage().rss / 1e6), resonances: res,
  fsr: res.slice(1).map((r, i) => ({ m_pair: [res[i]!.m, r.m], fsr_fit_um: r.fit_center_um - res[i]!.fit_center_um, fsr_peak_um: r.peak_um - res[i]!.peak_um, fsr_ref_um: r.lamRef - res[i]!.lamRef })) };
const txt = JSON.stringify(out, null, 1);
if (opt('--out')) writeFileSync(opt('--out')!, `${txt}\n`);
process.stdout.write(`${txt}\n`);
