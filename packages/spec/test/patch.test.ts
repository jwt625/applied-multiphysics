// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, invertPatch, parsePointer, formatPointer, type JsonPatchOp } from '../src/patch.ts';
import { canonicalJson, sha256Hex, specHash, jsonEqual } from '../src/canonical.ts';

const doc = { a: 1, b: { c: [1, 2, 3] }, 'x/y': { '~t': true } };

test('RFC 6901 pointers', () => {
  assert.deepEqual(parsePointer(''), []);
  assert.deepEqual(parsePointer('/x~1y/~0t'), ['x/y', '~t']);
  assert.equal(formatPointer(['x/y', '~t', 0]), '/x~1y/~0t/0');
  assert.throws(() => parsePointer('a'), /must start/);
  assert.throws(() => parsePointer('/~2'), /invalid escape/);
});

test('RFC 6902 operations and errors (atomic)', () => {
  const ap = (p: JsonPatchOp[]) => applyPatch(doc, p).doc;
  assert.deepEqual(ap([{ op: 'add', path: '/b/c/1', value: 9 }]), { ...doc, b: { c: [1, 9, 2, 3] } });
  assert.deepEqual(ap([{ op: 'add', path: '/b/c/-', value: 9 }]), { ...doc, b: { c: [1, 2, 3, 9] } });
  assert.deepEqual(ap([{ op: 'remove', path: '/a' }]), { b: doc.b, 'x/y': doc['x/y'] });
  assert.deepEqual(ap([{ op: 'move', from: '/b/c/0', path: '/b/c/2' }]), { ...doc, b: { c: [2, 3, 1] } });
  assert.deepEqual(ap([{ op: 'copy', from: '/a', path: '/b/d' }]), { ...doc, b: { c: [1, 2, 3], d: 1 } });
  assert.equal((ap([{ op: 'test', path: '/x~1y/~0t', value: true }, { op: 'replace', path: '/a', value: 2 }]) as { a: number }).a, 2);
  assert.throws(() => ap([{ op: 'replace', path: '/a', value: 5 }, { op: 'test', path: '/a', value: 1 }]), /test \/a failed/);
  assert.equal(doc.a, 1, 'input never mutated');
  assert.throws(() => ap([{ op: 'add', path: '/b/c/9', value: 0 }]), /out of range/);
  assert.throws(() => ap([{ op: 'add', path: '/b/c/01', value: 0 }]), /index/);
  assert.throws(() => ap([{ op: 'remove', path: '/zz' }]), /no member/);
  assert.throws(() => ap([{ op: 'move', from: '/b', path: '/b/c/0' }]), /inside/);
  assert.throws(() => ap([{ op: 'add', path: '/__proto__', value: {} }]), /not allowed/);
});

test('inverse restores the document for every op kind, including overwrites and same-array moves', () => {
  const cases: JsonPatchOp[][] = [
    [{ op: 'add', path: '/b/c/-', value: { z: 1 } }],
    [{ op: 'add', path: '/a', value: 'overwrite' }],
    [{ op: 'remove', path: '/b/c/1' }],
    [{ op: 'replace', path: '', value: [1] }],
    [{ op: 'move', from: '/b/c/0', path: '/b/c/2' }],
    [{ op: 'move', from: '/a', path: '/x~1y/~0t' }],
    [{ op: 'copy', from: '/b', path: '/b2' }],
    [{ op: 'copy', from: '/a', path: '/b/c/0' }],
    [{ op: 'add', path: '/n', value: 1 }, { op: 'move', from: '/n', path: '/b/c/1' }, { op: 'remove', path: '/a' }, { op: 'test', path: '/b/c/1', value: 1 }],
  ];
  for (const p of cases) {
    const next = applyPatch(doc, p).doc;
    const inv = invertPatch(doc, p);
    assert.ok(jsonEqual(applyPatch(next, inv).doc, doc), JSON.stringify(p));
  }
  // the guard makes a stale inverse fail instead of clobbering
  const inv = invertPatch(doc, [{ op: 'replace', path: '/a', value: 2 }]);
  assert.throws(() => applyPatch({ ...doc, a: 3 }, inv), /test/);
});

test('canonical JSON and sha-256 (WebCrypto)', async () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x', 1e21, 0.1], c: undefined }), '{"a":[true,null,"x",1e+21,0.1],"b":1}');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); // FIPS 180-2 test vector
  assert.equal(await specHash({ a: 1, b: 2 }), await specHash({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
});

test('inverse of a move into an earlier array slot is RFC-legal (gate regression, seed 20261106 seq 215)', () => {
  const d = { f: [{ s: [1, 2] }, { s: [3] }] };
  const p: JsonPatchOp[] = [{ op: 'move', from: '/f/0/s', path: '/f/0' }];
  const next = applyPatch(d, p).doc;
  assert.deepEqual(next, { f: [[1, 2], {}, { s: [3] }] });
  assert.deepEqual(applyPatch(next, invertPatch(d, p)).doc, d);
});
