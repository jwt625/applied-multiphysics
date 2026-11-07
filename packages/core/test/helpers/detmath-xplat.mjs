// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by test/detmath.test.mjs (Node) and test/fixtures/gen-detmath-xplat.mjs (Node + headless Chromium): fixed
// inputs and the bit patterns of detmath / expr / Math outputs on them. No imports, so the same file runs in a browser
// page; the detmath and expr modules are passed in. Inputs use only IEEE + - * / on an LCG, so they are identical in
// every engine.

const N = 4000;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** {sin: x[], atan2: [y, x][], log: x[], exp: x[], pow: [a, b][]} with special values first. */
export function inputs() {
  const r = lcg(20261106);
  const ang = [0, -0, 1e-300, 0.5, 1, Math.PI / 4, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI, 100, -100, 1e5];
  const sin = [...ang];
  while (sin.length < N) sin.push(200 * r() - 100);
  const atan2 = [[0, 1], [0, -1], [-0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1e-300, 1], [3, -4]];
  while (atan2.length < N) atan2.push([20 * r() - 10, 20 * r() - 10]);
  const log = [1, 2, 0.5, 10, 1e-300, 1e300, 0.1, 1e-4];
  while (log.length < N) { let x = 1 + r(); let k = Math.floor(400 * r()) - 200; while (k > 0) { x *= 2; k--; } while (k < 0) { x *= 0.5; k++; } log.push(x); }
  const exp = [0, 1, -1, 0.5, 700, -700, 1e-10, 2.302585092994046];
  while (exp.length < N) exp.push(1400 * r() - 700);
  const pow = [[10, -4], [2, 0.5], [9, 0.5], [1e-6, 2], [0.1, 3], [2.5, 1.7]];
  while (pow.length < N) pow.push([100 * r() + 1e-3, 20 * r() - 10]);
  return { sin, atan2, log, exp, pow };
}

const buf = new Float64Array(1), u32 = new Uint32Array(buf.buffer);
const hi = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const hex = (x) => { buf[0] = x; return u32[hi].toString(16).padStart(8, '0') + u32[hi ^ 1].toString(16).padStart(8, '0'); };

/** Concatenated hex bits per case: detmath, Math, and @amp/core/expr (array evaluation over a field variable). */
export function evaluate(D, compileExpression, DIMLESS) {
  const I = inputs();
  const out = {};
  const put = (k, xs) => { out[k] = xs.map(hex).join(''); };
  put('det.sin', I.sin.map(D.sin));
  put('det.cos', I.sin.map(D.cos));
  put('det.atan2', I.atan2.map(([y, x]) => D.atan2(y, x)));
  put('det.log', I.log.map(D.log));
  put('det.exp', I.exp.map(D.exp));
  put('math.sin', I.sin.map(Math.sin));
  put('math.cos', I.sin.map(Math.cos));
  put('math.atan2', I.atan2.map(([y, x]) => Math.atan2(y, x)));
  put('math.log', I.log.map(Math.log));
  put('math.exp', I.exp.map(Math.exp));
  put('math.pow', I.pow.map(([a, b]) => a ** b));
  const field = (vals) => ({ resolve: (n) => (n in vals ? { kind: 'field', key: n, dim: DIMLESS, complex: false, continuous: true } : null) });
  const run = (src, vals) => {
    const c = compileExpression(src, field(vals));
    const n = Object.values(vals)[0].length;
    const r = c.run({ n, get: (k) => ({ re: vals[k], im: null }) });
    return Array.from(r.re);
  };
  const F = (xs) => Float64Array.from(xs);
  put('expr.sin', run('sin(x)', { x: F(I.sin) }));
  put('expr.cos', run('cos(x)', { x: F(I.sin) }));
  put('expr.tan', run('tan(x)', { x: F(I.sin) }));
  put('expr.atan2', run('atan2(y, x)', { y: F(I.atan2.map((p) => p[0])), x: F(I.atan2.map((p) => p[1])) }));
  put('expr.log', run('log(x)', { x: F(I.log) }));
  put('expr.exp', run('exp(x)', { x: F(I.exp) }));
  put('expr.pow', run('a^b', { a: F(I.pow.map((p) => p[0])), b: F(I.pow.map((p) => p[1])) }));
  return out;
}
