// SPDX-License-Identifier: GPL-3.0-or-later
// UI parity tools (DevLog-053): cancel_run, select_sweep_point, probe, quick_view, set_camera preset / look_at and the
// run_study default study, through AgentSession.execute with the recording navigation host, and through the agent
// loop with the scripted mock provider. Expected values written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specHash } from '@amp/spec';
import { Agent } from '../src/loop.ts';
import { ScriptedProvider, say, turn, use, lastToolResult } from '../src/provider/mock.ts';
import { RecordingNavHost, type QuickViewInfo, type SweepInfo } from '../src/nav.ts';
import { AgentSession } from '../src/session.ts';
import { fixture, headJson, blockJson, simText } from '../eval/fixtures.ts';

const txt = (o: { content: Array<{ type: string; text?: string }> }) => (o.content[0] as { text: string }).text;

const sweep = (): SweepInfo => ({
  study: 'par', inner: 'std1', done: 2, total: 3, shown: 0,
  points: [
    { index: 0, label: 'D = 8 mm', values: { D: { value: 8, unit: 'mm' } }, status: 'solved', shown: true, selectable: true },
    { index: 1, label: 'D = 10 mm', values: { D: { value: 10, unit: 'mm' } }, status: 'solved', shown: false, selectable: true },
    { index: 2, label: 'D = 12 mm', values: { D: { value: 12, unit: 'mm' } }, status: 'pending', shown: false, selectable: false },
  ],
});
const view = (): QuickViewInfo => ({
  field: 'T', fields: ['T', 'q'], component: null, components: [], colormap: 'auto', colormaps: ['viridis', 'balance', 'inferno'],
  range: 'full', log: false, logAvailable: true, contours: false, wire: false, plotGroup: null,
});

test('parity tools: unavailable without host methods, no_sweep / no_field when the view has nothing', async () => {
  const fx = await fixture('kirsch-plate');
  // a host with only the core navigation methods (as a view that implements none of the new ones)
  const bare = {
    focusNode: () => ({ ok: true }), openSettings: () => ({ ok: true }), highlightSelection: () => ({ ok: true }),
    setCamera: () => ({ ok: true }), setViewMode: () => ({ ok: true }), screenshot: () => null,
  };
  const s = new AgentSession({ log: fx.log, registry: fx.registry, memory: fx.memory, nav: bare, sessionId: 'bare' });
  for (const [tool, input, code] of [
    ['cancel_run', {}, 'cancel_run_unavailable'], ['select_sweep_point', {}, 'select_sweep_point_unavailable'],
    ['probe', { action: 'list' }, 'probe_unavailable'], ['quick_view', {}, 'quick_view_unavailable'],
  ] as const) assert.equal(headJson(txt(await s.execute(tool, input)))?.error, code, tool);
  assert.equal(headJson(txt(await fx.session.execute('select_sweep_point', {})))?.error, 'no_sweep');
  assert.equal(headJson(txt(await fx.session.execute('quick_view', {})))?.error, 'no_field_drawn');
  assert.equal(headJson(txt(await fx.session.execute('probe', { action: 'add', at: [0, 0] })))?.error, 'ui_refused');
});

test('cancel_run calls the host once, changes no spec, and is in the navigation trail', async () => {
  const fx = await fixture('kirsch-plate');
  const h0 = await specHash(fx.log.data);
  const r = await fx.session.execute('cancel_run', {});
  assert.equal(r.isError, false);
  assert.equal(headJson(txt(r))?.note, 'nothing was running');
  assert.equal(fx.nav.state.cancelled, 1);
  assert.equal(await specHash(fx.log.data), h0);
  assert.deepEqual(fx.session.trail.entries.map((e) => `${e.tool}:${e.ok}`), ['cancel_run:true']);
});

test('select_sweep_point lists points, selects one, rejects unknown and unsolved points', async () => {
  const fx = await fixture('kirsch-plate');
  fx.nav.sweepState = sweep();
  const list = await fx.session.execute('select_sweep_point', {});
  assert.deepEqual(headJson(txt(list)), { ok: true, total: 3, done: 2, shown: 0 });
  assert.equal((blockJson(txt(list)) as SweepInfo).points[1]!.label, 'D = 10 mm');
  const sel = await fx.session.execute('select_sweep_point', { index: 1 });
  assert.deepEqual(headJson(txt(sel)), { ok: true, total: 3, done: 2, shown: 1, selected: 1 });
  assert.equal(fx.nav.sweepState.shown, 1);
  assert.equal(headJson(txt(await fx.session.execute('select_sweep_point', { index: 7 })))?.error, 'no_sweep_point');
  const pend = await fx.session.execute('select_sweep_point', { index: 2 });
  assert.equal(headJson(txt(pend))?.error, 'ui_refused');
  assert.match(txt(pend), /point 2 is pending/);
  assert.equal(headJson(txt(await fx.session.execute('select_sweep_point', { index: -1 })))?.error, 'invalid_input');
});

test('probe: add (2D and 3D points), list, remove, clear; a point needs coordinates', async () => {
  const fx = await fixture('kirsch-plate');
  fx.nav.view = view();
  fx.nav.probeValue = (p) => (p[0] > 1 ? null : 300 + 1000 * p[0]);
  const a = await fx.session.execute('probe', { action: 'add', at: [0.01, 0.002] });
  assert.deepEqual(headJson(txt(a)), { ok: true, n: 1, inside: true });
  assert.deepEqual(blockJson(txt(a)), { n: 1, at_m: [0.01, 0.002, 0], field: 'T', value: 310, unit: 'K', dataset: '' });
  const b = await fx.session.execute('probe', { action: 'add', at: [2, 0, 0.5] });
  assert.deepEqual(headJson(txt(b)), { ok: true, n: 2, inside: false });
  assert.equal(headJson(txt(await fx.session.execute('probe', { action: 'add' })))?.error, 'missing_point');
  assert.equal(headJson(txt(await fx.session.execute('probe', { action: 'add', at: [1] })))?.error, 'invalid_input');
  assert.equal(headJson(txt(await fx.session.execute('probe', { action: 'list' })))?.count, 2);
  assert.equal(headJson(txt(await fx.session.execute('probe', { action: 'remove' })))?.error, 'missing_probe_number');
  assert.equal(headJson(txt(await fx.session.execute('probe', { action: 'remove', n: 9 })))?.error, 'ui_refused');
  const rm = await fx.session.execute('probe', { action: 'remove', n: 1 });
  assert.equal(headJson(txt(rm))?.count, 1);
  assert.equal((blockJson(txt(rm)) as { probes: Array<{ n: number }> }).probes[0]!.n, 2);
  assert.equal(headJson(txt(await fx.session.execute('probe', { action: 'clear' })))?.count, 0);
  assert.deepEqual(fx.nav.calls.filter((c) => c.method === 'probeAdd').map((c) => c.args[0]), [[0.01, 0.002, 0], [2, 0, 0.5]]);
});

test('quick_view reads the settings, applies a patch, refuses unknown fields and colormaps', async () => {
  const fx = await fixture('kirsch-plate');
  fx.nav.view = view();
  const r0 = await fx.session.execute('quick_view', {});
  assert.deepEqual(headJson(txt(r0)), { ok: true, changed: [] });
  assert.deepEqual((blockJson(txt(r0)) as QuickViewInfo).fields, ['T', 'q']);
  const r1 = await fx.session.execute('quick_view', { field: 'q', colormap: 'inferno', range: 'p1-99', log: true });
  assert.deepEqual(headJson(txt(r1)), { ok: true, changed: ['field', 'colormap', 'range', 'log'] });
  assert.deepEqual({ f: fx.nav.view.field, c: fx.nav.view.colormap, r: fx.nav.view.range, l: fx.nav.view.log }, { f: 'q', c: 'inferno', r: 'p1-99', l: true });
  const bad = await fx.session.execute('quick_view', { field: 'nope' });
  assert.equal(headJson(txt(bad))?.error, 'ui_refused');
  assert.match(txt(bad), /no field nope/);
  assert.equal(headJson(txt(await fx.session.execute('quick_view', { colormap: 'rainbow' })))?.error, 'ui_refused');
  assert.equal(headJson(txt(await fx.session.execute('quick_view', { range: 'manual' })))?.error, 'invalid_input');
  assert.equal(fx.nav.view.field, 'q');
});

test('set_camera passes preset, look_at with a direction, and a host note', async () => {
  const fx = await fixture('kirsch-plate');
  assert.equal((await fx.session.execute('set_camera', { kind: 'preset', preset: 'top' })).isError, false);
  assert.deepEqual(fx.nav.state.camera, { kind: 'preset', preset: 'top' });
  await fx.session.execute('set_camera', { kind: 'look_at', target: [0, 0, 0.001], preset: 'front' });
  assert.deepEqual(fx.nav.state.camera, { kind: 'look_at', target: [0, 0, 0.001], preset: 'front' });
  assert.equal(headJson(txt(await fx.session.execute('set_camera', { kind: 'look_at' })))?.error, 'missing_camera_argument');
  const noted = new RecordingNavHost();
  noted.setCamera = () => ({ ok: true, message: 'distance is not applied' });
  const s = new AgentSession({ log: fx.log, registry: fx.registry, memory: fx.memory, nav: noted, sessionId: 'n' });
  assert.equal(headJson(txt(await s.execute('set_camera', { kind: 'look_at', target: [0, 0, 0], distance: 1 })))?.note, 'distance is not applied');
});

test('run_study: the study defaults to the host choice, else the first study; unknown names fail', async () => {
  const two = simText('kirsch-plate').replace('  - {id: std1, type: stationary, physics: [solid]}', '  - {id: std1, type: stationary, physics: [solid]}\n  - {id: std2, type: stationary, physics: [solid]}');
  const fx = await fixture('kirsch-plate', { text: two });
  const first = await fx.session.execute('run_study', { reason: 'default' });
  assert.equal(headJson(txt(first))?.study_default, true);
  assert.equal(fx.runner.calls.at(-1)!.studyId, 'std1');
  fx.runner.defaultStudy = () => 'std2';
  const chosen = await fx.session.execute('run_study', { reason: 'default, chosen' });
  assert.equal(headJson(txt(chosen))?.runOk, true);
  assert.equal(fx.runner.calls.at(-1)!.studyId, 'std2');
  assert.equal(fx.session.sideEffects.at(-1)!.study, 'std2');
  // a choice that is not a study of the spec falls back to the first study
  fx.runner.defaultStudy = () => 'gone';
  await fx.session.execute('run_study', { reason: 'stale choice' });
  assert.equal(fx.runner.calls.at(-1)!.studyId, 'std1');
  // an explicit study wins over the choice
  fx.runner.defaultStudy = () => 'std2';
  const named = await fx.session.execute('run_study', { study: 'std1', reason: 'named' });
  assert.equal(headJson(txt(named))?.study_default, undefined);
  assert.equal(fx.runner.calls.at(-1)!.studyId, 'std1');
  assert.equal(headJson(txt(await fx.session.execute('run_study', { study: 'nope', reason: 'x' })))?.error, 'unknown_study');
});

test('scripted mock model drives every parity tool through the agent loop', async () => {
  const fx = await fixture('kirsch-plate');
  fx.nav.sweepState = sweep();
  fx.nav.view = view();
  fx.nav.probeValue = () => 301.5;
  const p = new ScriptedProvider([
    turn(use('cancel_run', {}), use('select_sweep_point', {})),
    turn(use('select_sweep_point', { index: 1 }), use('quick_view', { field: 'q', colormap: 'balance' }), use('set_camera', { kind: 'preset', preset: 'iso' })),
    turn(use('probe', { action: 'add', at: [0.004, 0.001] })),
    (req) => {
      const v = (blockJson(lastToolResult(req, 'probe')) as { value: number; unit: string }).value;
      return turn(say(`T = ${v} K at the probe`));
    },
  ]);
  const r = await new Agent({ session: fx.session, provider: p }).runTurn('cancel, show point 2 with q in balance, probe at (4, 1) mm');
  assert.equal(r.stop, 'end_turn');
  assert.deepEqual(r.toolCalls.map((c) => `${c.name}:${c.isError}`), ['cancel_run:false', 'select_sweep_point:false', 'select_sweep_point:false', 'quick_view:false', 'set_camera:false', 'probe:false']);
  assert.equal(r.text, 'T = 301.5 K at the probe');
  assert.deepEqual(p.wireViolations, []);
  // every request carried the parity tools
  for (const q of p.requests) for (const t of ['cancel_run', 'select_sweep_point', 'probe', 'quick_view']) assert.ok(q.tools.some((d) => d.name === t), t);
  assert.equal(fx.nav.sweepState.shown, 1);
  assert.equal(fx.nav.view.colormap, 'balance');
  assert.equal(fx.nav.probes.length, 1);
  assert.equal(fx.session.trail.entries.length, 6);
  assert.equal(fx.log.ops.length, 0);
});
