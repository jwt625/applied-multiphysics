// SPDX-License-Identifier: GPL-3.0-or-later
// blockPattern / blockElementSlots (la/sparse.mjs, lane S4 DevLog-045): every element entry's slot equals the binary
// search result in the block pattern; caching per elem / bs; a pattern with another layout is rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildElementPattern, blockPattern, blockElementSlots, entryIndex } from '../src/la/sparse.mjs';

/** Random-ish element connectivity: ne elements of k distinct nodes out of n. */
function elems(n, ne, k, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  const out = new Int32Array(ne * k);
  for (let e = 0; e < ne; e++) {
    const set = new Set();
    while (set.size < k) set.add(rnd() % n);
    out.set([...set], e * k);
  }
  return out;
}

for (const [k, bs] of [[3, 2], [6, 2], [4, 3], [10, 3], [10, 4]]) {
  test(`blockElementSlots = per-entry search: k ${k}, bs ${bs}`, () => {
    const n = 300, elem = elems(n, 400, k);
    const node = buildElementPattern(n, elem, k);
    const blk = blockPattern(node, bs);
    assert.equal(blk.n, n * bs);
    assert.equal(blk.nnz, node.nnz * bs * bs);
    for (let i = 0; i < blk.n; i++) for (let q = blk.rowptr[i] + 1; q < blk.rowptr[i + 1]; q++) assert.ok(blk.colidx[q] > blk.colidx[q - 1], 'rows sorted, unique');
    const slots = blockElementSlots(node, blk, elem, k, bs);
    const nd = k * bs;
    assert.equal(slots.length, nd * nd * (elem.length / k));
    for (let e = 0; e < elem.length / k; e++)
      for (let a = 0; a < nd; a++)
        for (let b = 0; b < nd; b++) {
          const row = bs * elem[k * e + Math.floor(a / bs)] + (a % bs), col = bs * elem[k * e + Math.floor(b / bs)] + (b % bs);
          const z = entryIndex(blk, row, col);
          assert.ok(z >= 0);
          if (slots[nd * nd * e + nd * a + b] !== z) assert.fail(`e ${e} a ${a} b ${b}: ${slots[nd * nd * e + nd * a + b]} vs ${z}`);
        }
    assert.equal(blockElementSlots(node, blk, elem, k, bs), slots, 'cached');
  });
}

test('blockElementSlots rejects a pattern without the blockPattern layout', () => {
  const n = 50, elem = elems(n, 40, 4);
  const node = buildElementPattern(n, elem, 4);
  const other = buildElementPattern(n * 2, elems(n * 2, 200, 4, 3), 4);
  assert.throws(() => blockElementSlots(node, other, elem, 4, 2), /not blockPattern/);
  // same size, permuted columns: rows interleaved by component instead of by node
  const blk = blockPattern(node, 2);
  const bad = { ...blk, colidx: blk.colidx.map((c) => (c % 2 ? c - 1 : c + 1)) };
  assert.throws(() => blockElementSlots(node, bad, elem, 4, 2), /not blockPattern/);
});
