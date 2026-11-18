// SPDX-License-Identifier: GPL-3.0-or-later
// Floquet driven gate G-B4 (DevLog-050 s.1.5): dielectric slab (eps 4, t 0.3 lambda) in vacuum, plane wave at 30 and 60
// deg from the normal, TM (E_z) and TE (H_z), one period of a strip (width 0.5 lambda) with periodic sides and PML
// top / bottom; the Bloch phase comes from the incident wave. Complex r (front face) and tau (front to back face) from
// the field vs the Airy film formula (validation/bloch/bloch_refs.py, two routes). Also: the scattering condition next
// to a non-background cell is rejected (audit minor, s.1.7), and periodic + port is rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRun } from '../src/index.ts';
import { emw2dModule } from '../src/wave2d/index.ts';
import { probe } from '../src/wave2d/probe.ts';
import { bref, log, rect } from './bloch-common.ts';
import type { Solution } from '@amp/spec/types';

const q = (v: number | number[], unit: string) => ({ value: v, unit });
interface SlabRef { slab: { eps_s: number; t: number; cases: Array<{ pol: 'TM' | 'TE'; theta_deg: number; r: [number, number]; tau: [number, number] }> } }

const W = 0.5, T = 0.3, UP = 1.0, DN = 1.0, D = 1.0;   // strip width, slab, air above / below, PML thickness (m, lambda = 1 m)

export function slabSpec(o: { pol: 'TM' | 'TE'; theta: number; h: number; eps: number; R0?: number }): Record<string, unknown> {
  const parts = [rect('pt', 0, W, UP, UP + D), rect('at', 0, W, 0, UP), rect('sl', 0, W, -T, 0), rect('ab', 0, W, -T - DN, -T), rect('pb', 0, W, -T - DN - D, -T - DN)];
  const ids = ['pt', 'at', 'sl', 'ab', 'pb'];
  return {
    schema: 'amp-spec/0', id: 'floquet-slab', title: 'Floquet slab',
    geometry: { dim: 2, features: parts },
    materials: [{ id: 'vac', override: { eps_r: 1, mu_r: 1 }, select: ['dom:pt', 'dom:at', 'dom:ab', 'dom:pb'] }, { id: 'film', override: { eps_r: o.eps, mu_r: 1 }, select: ['dom:sl'] }],
    physics: [{ id: 'w', type: 'emw-2d', select: ids.map((i) => `dom:${i}`), settings: { polarization: o.pol },
      bcs: [{ id: 'absorb', type: 'pml', select: ['dom:pt', 'dom:pb'], settings: { R0: o.R0 ?? 1e-10, order: 2 } },
        { id: 'inc', type: 'plane-wave', select: ['dom:at', 'dom:ab'], settings: { direction: q(o.theta - 90, 'deg'), amplitude: q(1, o.pol === 'TM' ? 'V/m' : 'A/m') } },
        { id: 'cell', type: 'periodic', select: [...ids.map((i) => `bnd:${i}.left`), ...ids.map((i) => `bnd:${i}.right`)] }] }],
    mesh: { size: { hmax: q(o.h, 'm') }, refine: [{ select: ['dom:sl'], h: q(o.h / 2, 'm') }] },
    studies: [{ id: 's', type: 'frequency', physics: ['w'], settings: { wavelengths: [q(1, 'm')] } }],
  };
}

function rt(sol: Solution, mesh: Parameters<typeof probe>[0], pol: 'TM' | 'TE', theta: number): { r: [number, number]; tau: [number, number]; spread: number } {
  const U = pol === 'TM' ? 'Ez' : 'Hz';
  const get = (n: string) => sol.fields.find((f) => f.name === n)!.data;
  const k0 = 2 * Math.PI, th = (theta * Math.PI) / 180, kx = k0 * Math.sin(th), kc = k0 * Math.cos(th);
  const div = (a: [number, number], ph: number): [number, number] => { const c = Math.cos(ph), s = Math.sin(ph); return [a[0] * c + a[1] * s, a[1] * c - a[0] * s]; };   // a / exp(j ph)
  const rs: Array<[number, number]> = [], ts: Array<[number, number]> = [];
  for (const x of [0.07, 0.21, 0.33, 0.46]) {
    for (const y of [0.3, 0.6]) {
      const v = probe(mesh, [get(`${U}_sc_re`), get(`${U}_sc_im`)], x, y)!;
      rs.push(div([v[0]!, v[1]!], -(kx * x + kc * y)));   // u_s = r exp(-j (kx x + kc y))
    }
    for (const y of [-T - 0.3, -T - 0.6]) {
      const v = probe(mesh, [get(`${U}_re`), get(`${U}_im`)], x, y)!;
      ts.push(div([v[0]!, v[1]!], -kx * x + kc * (y + T)));   // u = tau exp(-j kx x) exp(+j kc (y + t))
    }
  }
  const mean = (a: Array<[number, number]>): [number, number] => [a.reduce((s, v) => s + v[0], 0) / a.length, a.reduce((s, v) => s + v[1], 0) / a.length];
  const r = mean(rs), tau = mean(ts);
  const spread = Math.max(...rs.map((v) => Math.hypot(v[0] - r[0], v[1] - r[1])), ...ts.map((v) => Math.hypot(v[0] - tau[0], v[1] - tau[1])));
  return { r, tau, spread };
}

for (const pol of ['TM', 'TE'] as const) for (const theta of [30, 60]) {
  test(`G-B4 Floquet slab ${pol} at ${theta} deg: complex r, tau vs Airy (two levels)`, async () => {
    const R = bref<SlabRef>('bloch_reference.json').slab;
    const ref = R.cases.find((c) => c.pol === pol && c.theta_deg === theta)!;
    const errs: number[] = [];
    for (const h of [0.05, 0.025]) {
      const p = await prepareRun(slabSpec({ pol, theta, h, eps: R.eps_s }), {});
      const t0 = performance.now();
      const sol = await emw2dModule.run(p);
      const v = rt(sol, p.mesh, pol, theta);
      const e = Math.max(Math.hypot(v.r[0] - ref.r[0], v.r[1] - ref.r[1]), Math.hypot(v.tau[0] - ref.tau[0], v.tau[1] - ref.tau[1]));
      log(pol, theta, 'h', h, 'r', v.r, 'tau', v.tau, 'err', e.toExponential(2), 'probe spread', v.spread.toExponential(2), 'nodes', p.mesh.nodes.length / 2, 'ms', (performance.now() - t0).toFixed(0));
      errs.push(e);
    }
    assert.ok(errs[1]! < errs[0]!, `decreasing ${errs}`);
    assert.ok(errs[0]! < 1e-3 && errs[1]! < 1e-4, `r, tau errors ${errs}`);
  });
}

test('scattering condition next to a non-background cell under a plane wave is rejected', async () => {
  // the slab cell with its side faces given a first-order absorbing condition instead of the periodic one
  const spec = slabSpec({ pol: 'TM', theta: 30, h: 0.1, eps: 4 }) as { physics: Array<{ bcs: Array<Record<string, unknown>> }> };
  spec.physics[0]!.bcs[2] = { id: 'abc', type: 'scattering', select: ['bnd:sl.left', 'bnd:sl.right', 'bnd:at.left', 'bnd:at.right', 'bnd:ab.left', 'bnd:ab.right', 'bnd:pt.left', 'bnd:pt.right', 'bnd:pb.left', 'bnd:pb.right'] };
  const p = await prepareRun(spec, {});
  await assert.rejects(() => emw2dModule.run(p), /scattering condition on .*'bnd:sl\.left' \(next to 'dom:sl'\) touch(es)? a medium other than the background/);
});

test('ports in a periodic cell are rejected by readiness', async () => {
  const spec = slabSpec({ pol: 'TM', theta: 30, h: 0.1, eps: 4 }) as { physics: Array<{ bcs: Array<Record<string, unknown>> }> };
  spec.physics[0]!.bcs.splice(1, 1, { id: 'p1', type: 'port', select: ['bnd:at.top'] });
  const r = emw2dModule.readiness(spec as never, 'w');
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => /ports in a periodic \(Floquet\) cell are not supported/.test(x)), r.reasons.join('; '));
});
