// SPDX-License-Identifier: GPL-3.0-or-later
// The agent's edit_tree and define_sweep tools over the workbench's real builders (lib/agent/editor.ts ->
// state/edit-ops.ts, state/sweep.ts; DevLog-053), on sims/kirsch-plate.yaml: each edit is one agent op in the op log,
// references follow a rename, refusals come back with the reason, the sweep reads back and becomes the chosen study,
// and a scripted mock-provider turn is reverted to the original bytes. Expected values written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpLog } from '@amp/spec';
import { physicsRegistry } from '@amp/physics';
import { Agent, AgentSession, MemoryStore, RecordingNavHost, ScriptedProvider, memoryBackend, say, turn, use } from '@amp/agent';
import { modelEditor } from '../src/lib/agent/editor.ts';

const text = readFileSync(new URL('../../../sims/kirsch-plate.yaml', import.meta.url), 'utf8');
const reg = physicsRegistry();
const head = (o: { content: Array<{ type: string; text?: string }> }, i = 0) => JSON.parse((o.content[i] as { text: string }).text.split('\n')[0]!) as Record<string, unknown>;
const body = (o: { content: Array<{ type: string; text?: string }> }, i = 0) => (o.content[i] as { text: string }).text;

async function setup() {
	const log = await createOpLog(text, { registry: reg });
	const chosen: string[] = [];
	const memory = await MemoryStore.open(memoryBackend({}));
	const s = new AgentSession({ log, registry: reg, memory, nav: new RecordingNavHost(), editor: modelEditor(reg, (id) => chosen.push(id)), sessionId: 'w1' });
	return { log, s, chosen };
}

test('edit_tree over the workbench builders: rename follows references, delete refused while referenced, add lists types', async () => {
	const { log, s } = await setup();
	const rn = await s.execute('edit_tree', { op: 'rename', pointer: '/materials/@steel', id: 'st37', reason: 'rename steel' });
	assert.equal(head(rn).ok, true, body(rn));
	assert.equal(head(rn).valid, true);
	assert.equal(log.ops.length, 1);
	assert.equal(log.ops[0]!.actor, 'agent:w1');
	assert.equal(log.ops[0]!.reason, 'rename steel');
	assert.ok(!log.text.includes('materials.steel.'), 'provenance keys follow the rename');
	assert.ok(log.text.includes('materials.st37.override.E'));
	const del = await s.execute('edit_tree', { op: 'delete', pointer: '/physics/@solid', reason: 'x' });
	assert.equal(head(del).error, 'refused');
	assert.match(body(del), /still referenced at \/studies\/0\/physics\/0/);
	const bad = await s.execute('edit_tree', { op: 'add', parent: '/geometry', type: 'nope', reason: 'x' });
	assert.equal(head(bad).error, 'refused');
	assert.match(body(bad), /unknown feature type 'nope'/);
	assert.match(body(bad), /"types":\[\{"type":"/);
	const add = await s.execute('edit_tree', { op: 'add', parent: '/materials', type: 'material', reason: 'new material' });
	assert.equal(head(add).ok, true, body(add));
	assert.equal(log.ops.length, 2);
	assert.equal((log.data as { materials: unknown[] }).materials.length, 2);
});

test('define_sweep over the workbench builder: stored, read back, chosen; remove; refusals', async () => {
	const { log, s, chosen } = await setup();
	const r = await s.execute('define_sweep', { id: 'sweepD', study: 'std1', axes: [{ param: 'D', values: ['6', '8'], unit: 'mm' }], reason: 'sweep D' });
	assert.equal(head(r).ok, true, body(r));
	assert.equal(head(r).valid, true, body(r));
	assert.deepEqual(chosen, ['sweepD']);
	const st = (log.data as { studies: Array<{ id: string; type: string; settings?: { study: string; sweep: Array<{ param: string; values: unknown[] }> } }> }).studies.find((x) => x.id === 'sweepD')!;
	assert.equal(st.type, 'parametric');
	assert.deepEqual(st.settings, { study: 'std1', sweep: [{ param: 'D', values: ['6 mm', '8 mm'] }] });
	assert.match(body(r, 1), /"values":\["6","8"\]/);
	assert.equal(head(await s.execute('define_sweep', { id: 'sw2', study: 'nope', axes: [{ param: 'D', values: ['1'] }], reason: 'x' })).error, 'refused');
	assert.equal(head(await s.execute('define_sweep', { id: 'sw2', study: 'std1', axes: [{ param: 'ghost', values: ['1'] }], reason: 'x' })).error, 'refused');
	const rm = await s.execute('define_sweep', { id: 'sweepD', remove: true, reason: 'drop the sweep' });
	assert.equal(head(rm).ok, true, body(rm));
	assert.equal((log.data as { studies: Array<{ id: string }> }).studies.some((x) => x.id === 'sweepD'), false);
	assert.equal(log.ops.length, 2);
});

test('scripted mock model: rename and sweep in one turn, revert turn restores the original text', async () => {
	const { log, s } = await setup();
	const p = new ScriptedProvider([
		turn(use('edit_tree', { op: 'rename', pointer: '/materials/@steel', id: 'st37', reason: 'user asked' }), use('define_sweep', { id: 'sweepD', study: 'std1', axes: [{ param: 'D', start: '4', stop: '8', n: 3, unit: 'mm' }], reason: 'user asked' })),
		turn(say('done'))
	]);
	const r = await new Agent({ session: s, provider: p }).runTurn('rename steel to st37 and sweep D from 4 to 8 mm in 3 points');
	assert.equal(r.stop, 'end_turn', JSON.stringify({ m: r.message, p: r.problems }));
	assert.deepEqual(r.toolCalls.map((c) => `${c.name}:${c.isError}`), ['edit_tree:false', 'define_sweep:false']);
	assert.deepEqual(p.wireViolations, []);
	assert.equal((await s.revertTurn(s.turn)).reverted, 2);
	assert.equal(log.text, text);
});
