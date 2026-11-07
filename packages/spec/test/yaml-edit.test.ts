// SPDX-License-Identifier: GPL-3.0-or-later
// Splice editing. The first block ports the EO app tests (eo-modulator-atlas app/src/lib/sim/sim.test.ts, "YAML round
// trip", at 0546007) to node:test on inline texts; the rest covers the L2 extensions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setIn, deleteIn, insertIn, getIn, splitPath, applyOverrides, parseStrict } from '../src/yaml-edit.mjs';

const comments = (t: string) => t.split('\n').map((l) => l.match(/#.*$/)?.[0]).filter(Boolean) as string[];
const changedLines = (a: string, b: string) => {
  const x = a.split('\n'), y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return { removed: x.length - i - j, added: y.length - i - j };
};

test('EO: sets values without losing comments or flow style', () => {
  const text = '# header comment\nschema: eo-atlas.sim/v1\noptics:\n  wavelength_nm: 1550 # keep me\ngeometry:\n  regions:\n    - {name: a, rect: {x_um: [-1, 1], y_um: [0, 1]}}\n';
  const out = setIn(text, splitPath('optics.wavelength_nm'), 1310);
  assert.ok(out.includes('# header comment'));
  assert.ok(out.includes('wavelength_nm: 1310 # keep me'));
  const out2 = setIn(out, splitPath('geometry.regions.0.rect.x_um.1'), 2);
  assert.ok(out2.includes('x_um: [-1, 2], y_um'));
  assert.deepEqual(getIn(out2, ['geometry', 'regions', 0, 'rect', 'x_um']), [-1, 2]);
  assert.equal(getIn(applyOverrides(text, [['optics.wavelength_nm', 1000]]), ['optics', 'wavelength_nm']), 1000);
});

test('EO: changes only the edited value and quotes strings safely', () => {
  const src = 'a: {value: 738, unit: nm}   # spaced comment\nlist:\n- [1, 2]\nexpr: "=gap_um/2"\n';
  const out = setIn(src, ['a', 'value'], 532);
  const changed = out.split('\n').filter((l, i) => l !== src.split('\n')[i]);
  assert.deepEqual(changed, ['a: {value: 532, unit: nm}   # spaced comment']);
  assert.equal(getIn(setIn(src, ['expr'], '=max(gap_um, 2)'), ['expr']), '=max(gap_um, 2)');
  assert.deepEqual(getIn(deleteIn(src, ['a', 'unit']), ['a']), { value: 738 });
});

const SPEC = readFileSync(new URL('../../../sims/kirsch-plate.yaml', import.meta.url), 'utf8');

test('round trip on a hero spec: one changed line, inserted key deleted restores the bytes, comments kept', () => {
  for (const [path, value] of [
    [['params', 'D', 'value'], 8],
    [['mesh', 'size', 'hmin'], '0.1 mm'],
    [['physics', 0, 'bcs', 0, 'label'], 'x = 0 plane'],
    [['physics', 0, 'settings', 'thickness'], '1 mm'],
    [['geometry', 'features', 0, 'label'], 'quarter plate'],
  ] as [Array<string | number>, unknown][]) {
    const had = getIn(SPEC, path) !== undefined;
    const out = setIn(SPEC, path, value);
    assert.deepEqual(getIn(out, path), value);
    const d = changedLines(SPEC, out);
    assert.equal(d.added, 1, `${path.join('.')}: ${JSON.stringify(d)}`);
    assert.ok(d.removed <= 1);
    assert.deepEqual(comments(out), comments(SPEC), `${path.join('.')}: comments`);
    if (!had) assert.equal(deleteIn(out, path), SPEC, `${path.join('.')}: delete restores`);
  }
});

test('key added to a block map that is a sequence item is indented under the item', () => {
  const t = 'items:\n  - id: a   # first\n    type: rect\n  - id: b\n';
  const out = setIn(t, ['items', 0, 'label'], 'L');
  assert.equal(out, 'items:\n  - id: a   # first\n    type: rect\n    label: L\n  - id: b\n');
  assert.equal(deleteIn(out, ['items', 0, 'label']), t);
});

test('sequence insert and delete splice block and flow sequences', () => {
  const t = '# top\nlist:\n  - a   # one\n  - b   # two\nflow: [1, 2, 3] # f\nempty: []\n';
  const ins0 = insertIn(t, ['list'], 0, 'z');
  assert.equal(ins0, '# top\nlist:\n  - z\n  - a   # one\n  - b   # two\nflow: [1, 2, 3] # f\nempty: []\n');
  const ins2 = insertIn(t, ['list'], 2, { id: 'c', v: [1, 2] });
  assert.equal(ins2, '# top\nlist:\n  - a   # one\n  - b   # two\n  - {id: c, v: [1, 2]}\nflow: [1, 2, 3] # f\nempty: []\n');
  assert.equal(insertIn(t, ['flow'], 1, 9), t.replace('[1, 2, 3]', '[1, 9, 2, 3]'));
  assert.equal(insertIn(t, ['flow'], 3, 9), t.replace('[1, 2, 3]', '[1, 2, 3, 9]'));
  assert.equal(insertIn(t, ['empty'], 0, 'x'), t.replace('empty: []', 'empty: [x]'));
  assert.equal(deleteIn(ins0, ['list', 0]), t);
  assert.equal(deleteIn(ins2, ['list', 2]), t);
  assert.equal(deleteIn(t, ['flow', 1]), t.replace('[1, 2, 3]', '[1, 3]'));
  assert.equal(deleteIn(t, ['flow', 2]), t.replace('[1, 2, 3]', '[1, 2]'));
  // emptying a block sequence without prune keeps [] (RFC 6902 semantics)
  const one = 'list:\n  - a # c\nnext: 1 # n\n';
  const gone = deleteIn(one, ['list', 0], { prune: false });
  assert.deepEqual(parseStrict(gone).toJS(), { list: [], next: 1 });
  assert.ok(gone.includes('next: 1 # n'));
});

test('a block collection replaced by a value is spliced in place; the rest of the file is untouched', () => {
  const t = '# head\nsettings:\n  a: 1 # inner\n  b: 2\nafter: x # keep\n';
  const out = setIn(t, ['settings'], { c: 3 });
  assert.deepEqual(parseStrict(out).toJS(), { settings: { c: 3 }, after: 'x' });
  assert.ok(out.startsWith('# head\nsettings:\n'));
  assert.ok(out.endsWith('after: x # keep\n'));
});

test('delete without prune keeps an emptied map; with prune (EO default) removes it', () => {
  const t = 'a:\n  b: 1\nc: 2 # c\n';
  assert.deepEqual(parseStrict(deleteIn(t, ['a', 'b'], { prune: false })).toJS(), { a: {}, c: 2 });
  assert.deepEqual(parseStrict(deleteIn(t, ['a', 'b'])).toJS(), { c: 2 });
});

test('strings that need quoting survive (colon, hash, quotes, newline, unicode, reserved words)', () => {
  const t = 'k: v\n';
  for (const s of ['a: b', 'x # y', 'say "hi"', 'line1\nline2', 'yes', 'null', '-x', 'dom:plate', 'mu (µ) Ω', ' lead', '']) {
    assert.equal(getIn(setIn(t, ['k'], s), ['k']), s, JSON.stringify(s));
  }
});

test('anchors, aliases and duplicate keys are rejected', () => {
  assert.throws(() => parseStrict('a: &x 1\nb: *x\n'), /anchors are not allowed/);
  assert.throws(() => parseStrict('a: !js/function x\n'), /tag !js\/function is not allowed/);
  for (const k of ['__proto__', 'constructor', 'prototype']) assert.throws(() => parseStrict(`p:\n  ${k}: 1\n`), /is not allowed/, k);
  assert.throws(() => parseStrict('a: 1\na: 2\n'), /YAML/);
});
