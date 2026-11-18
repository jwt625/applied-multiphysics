// SPDX-License-Identifier: GPL-3.0-or-later
// edit_tree and define_sweep (DevLog-053): the session applies the host's built patch as one agent op with the
// reason; refusals, missing arguments, the add-type list, the chosen-study hook and revertTurn. The editor here is a
// small fake (the real builders live in apps/web state/edit-ops.ts and state/sweep.ts and are covered there, also
// through the agent, in apps/web/test/e7-edits.test.ts). Expected values written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '../src/session.ts';
import { Agent } from '../src/loop.ts';
import { ScriptedProvider, say, turn, use } from '../src/provider/mock.ts';
import type { ModelEditor, SweepDef, TreeOp } from '../src/edits.ts';
import { fixture, headJson, blockJson } from '../eval/fixtures.ts';

const txt = (o: { content: Array<{ type: string; text?: string }> }) => (o.content[0] as { text: string }).text;

function fakeEditor() {
  const calls: Array<TreeOp | SweepDef | string> = [];
  const chosen: string[] = [];
  const ed: ModelEditor = {
    treeOp: (data, op) => {
      calls.push(op);
      const mats = (data as { materials: Array<{ id: string }> }).materials;
      if (op.op === 'add') return op.type === 'material' ? { ok: true, patch: [{ op: 'add', path: '/materials/-', value: { id: op.id ?? 'mat1', select: [] } }], id: op.id ?? 'mat1', pointer: `/materials/${mats.length}` } : { ok: false, reason: `no type '${op.type}' under ${op.parent}` };
      // rename of material 0 with its provenance keys (as the real builder updates dotted paths)
      if (op.op === 'rename') return { ok: true, patch: [{ op: 'replace', path: '/materials/0/id', value: op.id }, ...['E', 'nu'].map((k) => ({ op: 'move' as const, from: `/provenance/values/materials.steel.override.${k}`, path: `/provenance/values/materials.${op.id}.override.${k}` }))], id: op.id, pointer: '/materials/0', note: 'no references' };
      if (op.op === 'duplicate') return { ok: true, patch: [{ op: 'add', path: '/materials/-', value: { id: op.id ?? 'steel2', override: { E: { value: 200, unit: 'GPa' }, nu: 0.3 }, select: ['dom:plate'] } }], id: op.id ?? 'steel2', pointer: `/materials/${mats.length}` };
      return { ok: false, reason: `'${op.op}' refused: steel is referenced` };
    },
    addChoices: () => [{ type: 'material' }],
    sweepSet: (data, def) => {
      calls.push(def);
      const n = (data as { studies: unknown[] }).studies.length;
      return { ok: true, patch: [{ op: 'add', path: '/studies/-', value: { id: def.id, type: 'parametric', physics: ['solid'], settings: { study: def.study, sweep: def.axes.map((a) => ({ param: a.param, values: a.values.map((v) => `${v} ${a.unit}`) })) } } }], id: def.id, pointer: `/studies/${n}` };
    },
    sweepRemove: (_d, id) => (calls.push(`remove ${id}`), { ok: false, reason: `results datasets read '${id}'` }),
    sweepGet: (data, id) => {
      const st = (data as { studies: Array<{ id: string; settings?: { study: string; sweep: Array<{ param: string; values: string[] }> } }> }).studies.find((s) => s.id === id);
      return st?.settings ? { id, study: st.settings.study, axes: st.settings.sweep.map((a) => ({ param: a.param, mode: 'values', values: a.values, start: '', stop: '', n: 0, unit: '' })) } : null;
    },
    chooseStudy: (id) => void chosen.push(id),
  };
  return { ed, calls, chosen };
}

async function setup() {
  const fx = await fixture('kirsch-plate', { sessionId: 'e1' });
  const f = fakeEditor();
  const s = new AgentSession({ log: fx.log, registry: fx.registry, memory: fx.memory, nav: fx.nav, editor: f.ed, sessionId: 'e1' });
  return { fx, s, ...f };
}

test('edit tools are unavailable without an editor', async () => {
  const fx = await fixture('kirsch-plate');
  assert.equal(headJson(txt(await fx.session.execute('edit_tree', { op: 'delete', pointer: '/materials/@steel', reason: 'x' })))?.error, 'edit_tree_unavailable');
  assert.equal(headJson(txt(await fx.session.execute('define_sweep', { id: 'sw', remove: true, reason: 'x' })))?.error, 'define_sweep_unavailable');
});

test('edit_tree: one agent op with the reason; refusals carry the reason and the add types; arguments checked', async () => {
  const { fx, s, calls } = await setup();
  const add = await s.execute('edit_tree', { op: 'add', parent: '/materials', type: 'material', id: 'cu', reason: 'add copper' });
  // an empty material node carries its validation issues until it is filled
  assert.deepEqual(headJson(txt(add)), { ok: true, seq: 1, valid: false, issueCount: 2, invalidates: ['solution', 'plots'] });
  assert.deepEqual({ ...(blockJson(txt(add)) as object), issues: undefined }, { id: 'cu', pointer: '/materials/1', issues: undefined });
  assert.equal(fx.log.ops[0]!.actor, 'agent:e1');
  assert.equal(fx.log.ops[0]!.reason, 'add copper');
  const rn = await s.execute('edit_tree', { op: 'rename', pointer: '/materials/@steel', id: 'st37', reason: 'rename' });
  assert.equal((blockJson(txt(rn)) as { note: string }).note, 'no references');
  assert.equal((fx.log.data as { materials: Array<{ id: string }> }).materials[0]!.id, 'st37');
  const bad = await s.execute('edit_tree', { op: 'add', parent: '/materials', type: 'gold', reason: 'x' });
  assert.equal(headJson(txt(bad))?.error, 'refused');
  assert.deepEqual(blockJson(txt(bad)), { reason: "no type 'gold' under /materials", types: [{ type: 'material' }] });
  const del = await s.execute('edit_tree', { op: 'delete', pointer: '/materials/@st37', reason: 'x' });
  assert.match(txt(del), /refused: steel is referenced/);
  assert.equal(headJson(txt(await s.execute('edit_tree', { op: 'add', parent: '/materials', reason: 'x' })))?.error, 'missing_argument');
  assert.equal(headJson(txt(await s.execute('edit_tree', { op: 'rename', pointer: '/materials/0', reason: 'x' })))?.error, 'missing_argument');
  assert.equal(headJson(txt(await s.execute('edit_tree', { op: 'delete', reason: 'x' })))?.error, 'missing_argument');
  assert.equal(headJson(txt(await s.execute('edit_tree', { op: 'delete', pointer: '/x' })))?.error, 'invalid_input');
  assert.equal(fx.log.ops.length, 2);
  assert.deepEqual(calls.map((c) => (c as TreeOp).op), ['add', 'rename', 'add', 'delete']);
});

test('define_sweep: built from values or a range, applied, chosen, read back; remove refusal; argument errors', async () => {
  const { fx, s, calls, chosen } = await setup();
  const r = await s.execute('define_sweep', { id: 'sweepD', study: 'std1', axes: [{ param: 'D', values: ['6', '8'], unit: 'mm' }], reason: 'sweep D' });
  assert.equal(headJson(txt(r))?.seq, 1);
  assert.deepEqual(calls[0], { id: 'sweepD', study: 'std1', axes: [{ param: 'D', mode: 'values', values: ['6', '8'], start: '', stop: '', n: 0, unit: 'mm' }] });
  assert.deepEqual(chosen, ['sweepD']);
  assert.equal(r.content.length, 2);
  assert.deepEqual((blockJson((r.content[1] as { text: string }).text) as { sweep: SweepDef }).sweep.axes[0]!.values, ['6 mm', '8 mm']);
  await s.execute('define_sweep', { id: 'sweepW', study: 'std1', axes: [{ param: 'W', start: '100', stop: '300', n: 3, unit: 'mm' }], reason: 'range' });
  assert.deepEqual((calls[1] as SweepDef).axes[0], { param: 'W', mode: 'range', values: [], start: '100', stop: '300', n: 3, unit: 'mm' });
  assert.equal(headJson(txt(await s.execute('define_sweep', { id: 'x', study: 'std1', axes: [{ param: 'D', values: ['1'], n: 3 }], reason: 'x' })))?.error, 'values_or_range');
  assert.equal(headJson(txt(await s.execute('define_sweep', { id: 'x', axes: [{ param: 'D', values: ['1'] }], reason: 'x' })))?.error, 'missing_argument');
  const rm = await s.execute('define_sweep', { id: 'sweepD', remove: true, reason: 'drop' });
  assert.equal(headJson(txt(rm))?.error, 'refused');
  assert.match(txt(rm), /results datasets read 'sweepD'/);
  assert.equal(fx.log.ops.length, 2);
  assert.deepEqual(chosen, ['sweepD', 'sweepW']);
});

test('mock model: edit_tree rename and define_sweep in one turn, then revert turn restores the text', async () => {
  const { fx, s } = await setup();
  const p = new ScriptedProvider([
    turn(use('edit_tree', { op: 'rename', pointer: '/materials/@steel', id: 'st37', reason: 'user asked to rename steel' }), use('define_sweep', { id: 'sweepD', study: 'std1', axes: [{ param: 'D', values: ['6', '8'], unit: 'mm' }], reason: 'user asked to sweep D' })),
    turn(say('renamed steel to st37 and added sweep sweepD')),
  ]);
  const r = await new Agent({ session: s, provider: p }).runTurn('rename steel to st37 and sweep D over 6 and 8 mm');
  assert.equal(r.stop, 'end_turn', JSON.stringify({ m: r.message, p: r.problems, calls: r.toolCalls }));
  assert.deepEqual(r.toolCalls.map((c) => `${c.name}:${c.isError}`), ['edit_tree:false', 'define_sweep:false']);
  assert.deepEqual(r.specOps, [1, 2]);
  assert.deepEqual(p.wireViolations, []);
  assert.ok(p.requests[0]!.tools.some((t) => t.name === 'edit_tree') && p.requests[0]!.tools.some((t) => t.name === 'define_sweep'));
  const rv = await s.revertTurn(s.turn);
  assert.equal(rv.reverted, 2);
  assert.equal(fx.log.text, fx.text);
});
