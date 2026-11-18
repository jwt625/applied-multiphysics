// SPDX-License-Identifier: GPL-3.0-or-later
// Lane E3 (DevLog-049): isotropic Si E / nu from the cubic C (Voigt-Reuss-Hill), recomputed here from the stored C leaf
// so the derived values stay consistent with it; underfill modulus above Tg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../src/node.ts';

const lib = loadLibrary();
const close = (a: number, b: number, rel: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg ?? ''} ${a} vs ${b} (rel ${rel})`);

test('silicon: isotropic E, nu (Hill, Voigt, Reuss, <100>) agree with the stored cubic C to the printed digits', () => {
  const c = lib.getProperty('silicon', 'C').value as Record<string, number>;
  const C11 = c.C11!, C12 = c.C12!, C44 = c.C44!;
  const K = (C11 + 2 * C12) / 3;
  const GV = (C11 - C12 + 3 * C44) / 5, GR = 5 / (4 / (C11 - C12) + 3 / C44), GH = (GV + GR) / 2;
  const E = (G: number) => (9 * K * G) / (3 * K + G), nu = (G: number) => (3 * K - 2 * G) / (2 * (3 * K + G));
  // stored with 5 (E) and 4 (nu) significant digits
  close(lib.getProperty('silicon', 'E').value as number, E(GH), 5e-5, 'E Hill');
  close(lib.getProperty('silicon', 'nu').value as number, nu(GH), 3e-4, 'nu Hill');
  close(lib.getProperty('silicon', 'E', { alternative: 'voigt' }).value as number, E(GV), 5e-5, 'E Voigt');
  close(lib.getProperty('silicon', 'E', { alternative: 'reuss' }).value as number, E(GR), 5e-5, 'E Reuss');
  close(lib.getProperty('silicon', 'nu', { alternative: 'voigt' }).value as number, nu(GV), 3e-4, 'nu Voigt');
  close(lib.getProperty('silicon', 'nu', { alternative: 'reuss' }).value as number, nu(GR), 3e-4, 'nu Reuss');
  close(lib.getProperty('silicon', 'E', { alternative: 'dir100' }).value as number, ((C11 - C12) * (C11 + 2 * C12)) / (C11 + C12), 5e-5, 'E<100>');
  close(lib.getProperty('silicon', 'nu', { alternative: 'dir100' }).value as number, C12 / (C11 + C12), 3e-4, 'nu<100>');
  // T-independent leaves resolve without T (isotropic elastic models can bind them from the library)
  assert.equal(typeof lib.getProperty('silicon', 'E').value, 'number');
});

test('underfill UF 8830S: DMA modulus at 250 C as an alternative; k stays N/A', () => {
  close(lib.getProperty('underfill-uf8830s', 'E', { alternative: 'dma_250c' }).value as number, 352e6, 1e-12);
  assert.throws(() => lib.getProperty('underfill-uf8830s', 'k'));
  assert.throws(() => lib.getProperty('tin-film', 'k'));
});
