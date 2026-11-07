// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specHash } from '@amp/spec';
import { toolDefinitions, toolDefinitionSize } from '../src/tools/defs.ts';
import { TOOL_INPUTS } from '../src/tools/schemas.ts';
import { fixture, headJson, blockJson } from '../eval/fixtures.ts';

const txt = (o: { content: Array<{ type: string; text?: string }> }) => (o.content[0] as { text: string }).text;

test('tool definitions are generated, sorted, object schemas, and small', () => {
  const defs = toolDefinitions();
  assert.equal(defs.length, Object.keys(TOOL_INPUTS).length);
  assert.deepEqual(defs.map((d) => d.name), [...defs.map((d) => d.name)].sort());
  for (const d of defs) {
    assert.equal(d.input_schema.type, 'object', d.name);
    assert.equal(d.input_schema.$schema, undefined);
    assert.ok(d.description.length > 10);
  }
  const s = toolDefinitionSize();
  assert.ok(s.bytes < 16_000, `tool definitions ${s.bytes} B`);
  assert.equal(s.tokensEstimate, Math.round(s.bytes / 4));
  // apply_ops ops schema comes from @amp/spec JsonPatchSchema: all seven ops including the amp extension `absent`
  const ops = JSON.stringify(defs.find((d) => d.name === 'apply_ops')!.input_schema);
  for (const op of ['add', 'remove', 'replace', 'move', 'copy', 'test', 'absent']) assert.ok(ops.includes(`"const":"${op}"`), op);
  // keywords that tool-schema dialects may reject (L2 audit S6): none left after collapsing z.json()
  const all = JSON.stringify(defs);
  for (const k of ['$ref', '$defs', 'propertyNames', 'prefixItems', '$schema']) assert.equal(all.includes(`"${k}"`), false, k);
});

test('apply_ops: agent actor, reason required, validation issues returned, invalidations', async () => {
  const fx = await fixture('kirsch-plate', { sessionId: 's1' });
  const s = fx.session;
  const noReason = await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }] });
  assert.equal(noReason.isError, true);
  assert.equal(headJson(txt(noReason))?.error, 'invalid_input');
  assert.equal(fx.log.ops.length, 0);
  const r = await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }], reason: 'test' });
  assert.equal(r.isError, false);
  const h = headJson(txt(r))!;
  assert.equal(h.valid, true);
  assert.deepEqual(h.invalidates, ['geometry', 'mesh', 'solution', 'plots']);
  assert.equal(fx.log.ops[0]!.actor, 'agent:s1');
  assert.equal(fx.log.ops[0]!.reason, 'test');
  const bad = await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/mesh/size/hmax', value: 4 }], reason: 'unitless' });
  assert.equal(headJson(txt(bad))?.valid, false);
  assert.ok(((blockJson(txt(bad)) as { issues: Array<{ pointer: string }> }).issues).some((i) => i.pointer === '/mesh/size/hmax'));
  const missing = await s.execute('apply_ops', { ops: [{ op: 'remove', path: '/nope' }], reason: 'x' });
  assert.equal(headJson(txt(missing))?.error, 'patch_failed');
});

test('undo, redo and revert_op through the tools; exact text after undo', async () => {
  const fx = await fixture('kirsch-plate');
  const s = fx.session;
  await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }], reason: 'a' });
  await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/W/value', value: 300 }], reason: 'b' });
  assert.equal(headJson(txt(await s.execute('undo', { reason: 'u' })))?.target, 2);
  assert.equal(headJson(txt(await s.execute('redo', { reason: 'r' })))?.target, 2);
  const rv = await s.execute('revert_op', { seq: 1, reason: 'revert first' });
  assert.equal(rv.isError, false);
  assert.equal((fx.log.data as { params: { D: { value: number } } }).params.D.value, 10);
  assert.equal(headJson(txt(await s.execute('revert_op', { seq: 1, reason: 'again' })))?.error, 'revert_failed');
  // undo everything: back to the original bytes
  while (fx.log.canUndo) await fx.log.undo({ actor: 'user' });
  assert.equal(fx.log.text, fx.text);
  assert.equal(await specHash(fx.log.data), fx.log.genesis.specHash);
});

test('schema_at resolves registered types, including a new element by type', async () => {
  const fx = await fixture('kirsch-plate');
  const r = await fx.session.execute('schema_at', { pointer: '/physics/@solid/bcs/-', type: 'boundary-load' });
  const j = JSON.stringify(blockJson(txt(r)));
  assert.ok(j.includes('traction'), j.slice(0, 200));
  const q = await fx.session.execute('schema_at', { pointer: '/params/D' });
  assert.equal(q.isError, false);
  assert.equal(headJson(txt(await fx.session.execute('schema_at', { pointer: '/nope/x' })))?.ok, false);
});

test('navigation tools change UI state only and go to the trail', async () => {
  const fx = await fixture('kirsch-plate');
  const h0 = await specHash(fx.log.data);
  const s = fx.session;
  assert.equal((await s.execute('focus_node', { pointer: '/params/D' })).isError, false);
  assert.equal((await s.execute('focus_node', { pointer: '/params/NOPE' })).isError, true);
  assert.equal((await s.execute('highlight_selection', { ids: ['bnd:hole.edge'] })).isError, false);
  assert.equal(headJson(txt(await s.execute('highlight_selection', { ids: ['bnd:ghost.edge'] })))?.error, 'unknown_entities');
  assert.equal((await s.execute('set_camera', { kind: 'preset', preset: 'iso' })).isError, false);
  assert.equal((await s.execute('set_camera', { kind: 'preset' })).isError, true);
  assert.equal((await s.execute('set_view_mode', { mode: 'mesh' })).isError, false);
  const shot = await s.execute('screenshot', {});
  assert.equal(shot.content[1]?.type, 'image');
  assert.equal(fx.log.ops.length, 0);
  assert.equal(await specHash(fx.log.data), h0);
  assert.deepEqual(s.trail.entries.map((e) => `${e.tool}:${e.ok}`), ['focus_node:true', 'focus_node:false', 'highlight_selection:true', 'highlight_selection:false', 'set_camera:true', 'set_camera:false', 'set_view_mode:true', 'screenshot:true']);
  assert.equal(s.trail.entries.length, 8);
  assert.equal(fx.nav.state.mode, 'mesh');
});

test('run_study records a side effect and results; stale after an edit', async () => {
  const fx = await fixture('kirsch-plate');
  const s = fx.session;
  const r = await s.execute('run_study', { study: 'std1', reason: 'r' });
  assert.equal(headJson(txt(r))?.runOk, true);
  assert.equal(headJson(txt(r))?.gatesPassed, 0); // the FE runner pairs no eval case (eval/fixtures.ts header)
  assert.ok(((blockJson(txt(r)) as { scalars: { mises_max: { value: number } } }).scalars.mises_max.value) > 0);
  assert.equal(s.sideEffects.length, 1);
  assert.equal(headJson(txt(await s.execute('get_run_record', {})))?.stale, false);
  await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/sigma_inf/value', value: 2 }], reason: 'x' });
  assert.equal(headJson(txt(await s.execute('get_results_summary', { study: 'std1' })))?.stale, true);
  assert.equal(headJson(txt(await s.execute('run_study', { study: 'nope', reason: 'r' })))?.error, 'unknown_study');
  // the run record carries the op log head at run start (C5 oplogHead)
  const rec = s.results.get('std1')!;
  assert.ok(rec.outcome.ok && rec.outcome.solution.run.oplogHead === fx.log.genesis.hash);
});

test('timeline merges spec ops, memory ops, navigation and runs; revertTurn', async () => {
  const fx = await fixture('kirsch-plate');
  const s = fx.session;
  s.turn = 1;
  await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }], reason: 'a' });
  await s.execute('memory_write', { name: 'units', type: 'units', description: 'units pref', body: 'mm', reason: 'b' });
  await s.execute('focus_node', { pointer: '/params/D' });
  await s.execute('run_study', { study: 'std1', reason: 'c' });
  assert.deepEqual(new Set(s.timeline().map((r) => r.source)), new Set(['spec', 'memory', 'nav', 'run']));
  const r = await s.revertTurn(1);
  assert.equal(r.reverted, 2);
  assert.equal(fx.log.text, fx.text);
  assert.equal(fx.memory.text('units.md'), null);
});

test('unknown tool and invalid inputs are errors, never throws', async () => {
  const fx = await fixture('kirsch-plate');
  assert.equal(headJson(txt(await fx.session.execute('rm_rf', {})))?.error, 'unknown_tool');
  assert.equal(headJson(txt(await fx.session.execute('apply_ops', { ops: 'x', reason: 'y' })))?.error, 'invalid_input');
  assert.equal(headJson(txt(await fx.session.execute('apply_ops', { ops: [{ op: 'replace', path: '/__proto__/x', value: 1 }], reason: 'y' })))?.ok, false);
});
