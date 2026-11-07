// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMemoryFile, formatMemoryFile, MemoryFormatError } from '../src/memory/frontmatter.ts';
import { MemoryStore, MemoryError } from '../src/memory/store.ts';
import { memoryBackend } from '../src/memory/backends.ts';
import { nodeDirBackend } from '../src/memory/node-backend.ts';
import { recall } from '../src/memory/recall.ts';

const entry = (name: string, description: string, appliesWhen: string[] = [], type = 'note') =>
  `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n${appliesWhen.length ? `applies_when: [${appliesWhen.join(', ')}]\n` : ''}updated: 2026-11-06\n---\nbody of ${name}\n`;

test('front matter: parse, format round trip, strict errors', () => {
  const e = parseMemoryFile(entry('units', 'Display units', ['heat']), 'units.md');
  assert.deepEqual(e.appliesWhen, ['heat']);
  assert.deepEqual(parseMemoryFile(formatMemoryFile(e), 'units.md'), e);
  assert.throws(() => parseMemoryFile('no front matter'), MemoryFormatError);
  assert.throws(() => parseMemoryFile(entry('units', 'x'), 'other.md'), /does not match/);
  assert.throws(() => parseMemoryFile(entry('units', 'x').replace('type: note', 'type: secret')), /type/);
  assert.throws(() => parseMemoryFile(entry('units', 'x').replace('updated:', 'extra: 1\nupdated:')), /unknown key/);
});

test('memory ops: write, revert, undo are exact and logged; key refused', async () => {
  const be = memoryBackend();
  const m = await MemoryStore.open(be, { forbidden: () => ['not-a-pattern-secret-123'] });
  await assert.rejects(m.write({ name: 'a', description: 'd', type: 'note', body: 'x' }, { actor: 'agent:s' }), /reason/);
  const w1 = await m.write({ name: 'a', description: 'first', type: 'note', body: 'one' }, { actor: 'agent:s', reason: 'r' });
  const t1 = m.text('a.md');
  const w2 = await m.write({ name: 'a', description: 'second', type: 'note', body: 'two' }, { actor: 'user' });
  await assert.rejects(m.revert(w1.seq, { actor: 'user' }), /changed after/);
  await m.revert(w2.seq, { actor: 'user' });
  assert.equal(m.text('a.md'), t1);
  await m.undo({ actor: 'user' }); // undoes the revert: back to "second"
  assert.match(m.text('a.md') ?? '', /second/);
  assert.equal(m.effectOf(w2.seq), 'applied');
  await assert.rejects(m.write({ name: 'k', description: 'd', type: 'note', body: 'sk-ant-api03-abcdefghijk' }, { actor: 'user' }), MemoryError);
  await assert.rejects(m.write({ name: 'k', description: 'd', type: 'note', body: 'x not-a-pattern-secret-123' }, { actor: 'user' }), MemoryError);
  assert.equal(m.text('k.md'), null);
  // log persisted and chained
  const log = be.files.get('memory-log.jsonl') ?? '';
  assert.equal(log.trim().split('\n').length, m.ops.length);
  const again = await MemoryStore.open(be);
  assert.equal(again.ops.length, m.ops.length);
  assert.deepEqual(again.problems, []);
});

test('a tampered memory log is left untouched and a new log is started', async () => {
  const be = memoryBackend();
  const m = await MemoryStore.open(be);
  await m.write({ name: 'a', description: 'd', type: 'note', body: 'x' }, { actor: 'user' });
  const orig = (be.files.get('memory-log.jsonl') as string).replace('"actor":"user"', '"actor":"agent:x"');
  be.files.set('memory-log.jsonl', orig);
  const m2 = await MemoryStore.open(be);
  assert.equal(m2.problems.length, 1);
  await m2.write({ name: 'b', description: 'd', type: 'note', body: 'y' }, { actor: 'user' });
  assert.equal(be.files.get('memory-log.jsonl'), orig);
  assert.ok([...be.files.keys()].some((f) => /^memory-log-\d+\.jsonl$/.test(f)));
});

test('Node directory backend: external edits recorded, export/import to a folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amp-mem-'));
  const out = await mkdtemp(join(tmpdir(), 'amp-mem-export-'));
  try {
    const m = await MemoryStore.open(await nodeDirBackend(dir));
    await m.write({ name: 'units', description: 'Display units', type: 'units', body: 'mm' }, { actor: 'user' });
    const edited = (await readFile(join(dir, 'units.md'), 'utf8')).replace('mm', 'um');
    await writeFile(join(dir, 'units.md'), edited);
    const ext = await m.refresh();
    assert.equal(ext.length, 1);
    assert.equal(ext[0]!.kind, 'external');
    assert.equal(m.text('units.md'), edited);
    await m.revert(ext[0]!.seq, { actor: 'user' });
    assert.match(await readFile(join(dir, 'units.md'), 'utf8'), /\nmm\n/);
    const target = await nodeDirBackend(out);
    const ex = await m.exportTo(target);
    assert.ok(ex.written.includes('units.md') && ex.written.includes('memory-log.jsonl'));
    const fresh = await MemoryStore.open(memoryBackend());
    const im = await fresh.importFrom(target);
    assert.deepEqual(im.imported, ['units.md']);
    assert.equal(fresh.ops[0]!.kind, 'import');
    assert.equal(fresh.text('units.md'), m.text('units.md'));
  } finally { await rm(dir, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('recall: by description and applies_when; inapplicable entries dropped', () => {
  const es = [
    { ...parseMemoryFile(entry('plate-mesh', 'Mesh defaults for elastic plates with holes', ['elastic'])), file: 'plate-mesh.md' },
    { ...parseMemoryFile(entry('fin-mesh', 'Mesh defaults for heat fins', ['heat'])), file: 'fin-mesh.md' },
    { ...parseMemoryFile(entry('copper', 'Preferred copper material reference for coils')), file: 'copper.md' },
  ];
  const r = recall(es, { query: 'set up the mesh for my plate with a hole', physicsTypes: ['elastic'] });
  assert.deepEqual(r.map((x) => x.entry.name), ['plate-mesh']);
  assert.ok(r[0]!.why.some((w) => w.startsWith('applies_when')));
  assert.deepEqual(recall(es, { query: 'which copper do I use for coils', physicsTypes: ['magnetostatics'] }).map((x) => x.entry.name), ['copper']);
  assert.deepEqual(recall(es, { query: 'unrelated words only' }), []);
});
