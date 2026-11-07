// SPDX-License-Identifier: GPL-3.0-or-later
// Deterministic elementary functions for everything that feeds geometry or meshes (DevLog-004 s.9).
//
// ECMAScript leaves Math.sin/cos/atan2/log/exp/pow implementation-approximated. Measured on 2026-11-06, Node v23.7.0
// and Chrome 156 disagree in the last ulp on 0.1-57 % of inputs (`10 ** -4` included), which made the same spec mesh
// differently in the browser and in Node. These versions use only IEEE-754 + - * / and sqrt, which are correctly
// rounded everywhere, with a fixed evaluation order, so every conforming engine returns the same bits. Accuracy is a
// few ulp (tested against Math.*); determinism, not correct rounding, is the goal.
// Constants: the Cody-Waite splits of pi/2 and ln 2 and the minimax kernel coefficients are those of fdlibm
// (e_rem_pio2.c, k_sin.c, k_cos.c, e_exp.c; Sun Microsystems, freely redistributable); atan, log and exp use series.

const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417e0; // first 33 bits of pi/2
const PIO2_2 = 6.07710050630396597660e-11; // next 33 bits
const PIO2_3 = 2.02226624871116645580e-21; // next 33 bits
const S1 = -1.66666666666666324348e-1, S2 = 8.33333333332248946124e-3, S3 = -1.98412698298579493134e-4,
  S4 = 2.75573137070700676789e-6, S5 = -2.50507602534068634195e-8, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2, C2 = -1.38888888888741095749e-3, C3 = 2.48015872894767294178e-5,
  C4 = -2.75573143513906633035e-7, C5 = 2.08757232129817482790e-9, C6 = -1.13596475577881948265e-11;
const LN2_HI = 6.93147180369123816490e-1, LN2_LO = 1.90821492927058770002e-10;
const LN2 = 0.6931471805599453;
const HALF_PI = 1.5707963267948966, PI = 3.141592653589793;

const kSin = (x: number) => {
  const z = x * x, v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
};
const kCos = (x: number) => {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z, w = 1 - hz;
  return w + (((1 - w) - hz) + z * r);
};

/** [sin x, cos x]; Cody-Waite reduction by pi/2 (accurate for |x| < about 1e6, deterministic for all finite x). */
export function sinCos(x: number): [number, number] {
  if (!Number.isFinite(x)) return [NaN, NaN];
  if (x === 0) return [x, 1];
  const k = Math.round(x * INV_PIO2);
  const y = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  const s = kSin(y), c = kCos(y);
  switch (((k % 4) + 4) % 4) {
    case 0: return [s, c];
    case 1: return [c, -s];
    case 2: return [-s, -c];
    default: return [-c, s];
  }
}
export const sin = (x: number) => sinCos(x)[0];
export const cos = (x: number) => sinCos(x)[1];

/** atan by three argument halvings (atan a = 2 atan(a / (1 + sqrt(1 + a^2)))) and a 12-term series on |a| < 0.1. */
export function atan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === 0) return x;
  if (x === Infinity) return HALF_PI;
  if (x === -Infinity) return -HALF_PI;
  const neg = x < 0;
  let a = neg ? -x : x;
  const inv = a > 1;
  if (inv) a = 1 / a;
  for (let i = 0; i < 3; i++) a = a / (1 + Math.sqrt(1 + a * a));
  const a2 = a * a;
  let s = 0;
  for (let n = 11; n >= 0; n--) s = (n % 2 ? -1 : 1) / (2 * n + 1) + a2 * s;
  let r = 8 * (a * s);
  if (inv) r = HALF_PI - r;
  return neg ? -r : r;
}

/** atan2 with the usual quadrant rules (signed zeros of y respected for x < 0). */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x > 0) return atan(y / x);
  if (x < 0) {
    const t = atan(y / x);
    return y > 0 || (y === 0 && 1 / y > 0) ? t + PI : t - PI;
  }
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 1 / x > 0 ? y : (1 / y > 0 ? PI : -PI);
}

/** m * 2^k exactly (k integer), through the binary exponent (two steps keep subnormal results exact). */
const F64 = new Float64Array(1), U32 = new Uint32Array(F64.buffer);
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
function pow2(k: number): number {
  U32[HI ^ 1] = 0;
  U32[HI] = (k + 1023) << 20;
  return F64[0]!;
}
export function ldexp(m: number, k: number): number {
  if (m === 0 || !Number.isFinite(m)) return m;
  while (k > 1023) { m *= pow2(1023); k -= 1023; }
  while (k < -1022) { m *= pow2(-1022); k += 1022; }
  return m * pow2(k);
}

/** x = m * 2^e with m in [1, 2) (exact). */
export function frexp(x: number): [number, number] {
  let m = x, e = 0;
  while (m >= 4294967296) { m *= 2.3283064365386963e-10; e += 32; }
  while (m >= 2) { m *= 0.5; e++; }
  while (m < 2.3283064365386963e-10) { m *= 4294967296; e -= 32; }
  while (m < 1) { m *= 2; e--; }
  return [m, e];
}

/** Natural log: exact binary scaling to m in (sqrt(1/2), sqrt(2)], then 2 atanh(u), u = (m - 1) / (m + 1), 13 terms. */
export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return x;
  let [m, e] = frexp(x);
  if (m > Math.SQRT2) { m *= 0.5; e++; }
  const u = (m - 1) / (m + 1), u2 = u * u;
  let s = 0;
  for (let n = 12; n >= 0; n--) s = 1 / (2 * n + 1) + u2 * s;
  return e * LN2_HI + (e * LN2_LO + 2 * u * s);
}

/** exp: x = k ln 2 + r (Cody-Waite), Taylor to degree 18 on |r| <= 0.35, exact scaling by 2^k. */
export function exp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  const k = Math.round(x / LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  let s = 0;
  for (let n = 18; n >= 1; n--) s = 1 + (r / n) * s;
  return ldexp(s, k);
}

/** round(log2 x) for x > 0, exactly: frexp exponent, +1 when the mantissa is at least sqrt(2). */
export function roundLog2(x: number): number {
  const [m, e] = frexp(x);
  return m * m >= 2 ? e + 1 : e;
}

/** sqrt(x^2 + y^2) (Math.hypot is implementation-approximated; no over/underflow risk at SI geometry scales). */
export const hyp2 = (x: number, y: number) => Math.sqrt(x * x + y * y);
export const hyp3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
