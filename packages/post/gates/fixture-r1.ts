// SPDX-License-Identifier: GPL-3.0-or-later
// Gate 7 preparation (DevLog-023 s.4 R1 item 7; DevLog-026): a deterministic fixture that runs the R1 kernels on a
// structured P2 meshes (straight and curved tri6, planar and axisymmetric; tet10 box) with polynomial fields (no solve, no Math.sin / hypot: IEEE + - * / and sqrt only, expression
// functions through @amp/core detmath) and hashes every result value (SHA-256 over the little-endian Float64 bytes, via
// WebCrypto: the same code runs in Node and in a browser worker). The R2 lane runs `gate7Fixture()` in the post worker
// and compares the hash with `fixture-r1.expected.json` (the Node value).

import { boxMesh, makeMesh, rectTriMesh } from '@amp/physics/common/mesh';
import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import { attachMesh, cutLine, edgeDataset, evalIntegral, evalMax, evalMin, evalMeasure, evalPoint, cutPoints } from '../src/index.ts';

function field(m: Mesh, name: string, unit: string, nc: 1 | 2, f: (x: number, y: number) => number[]): FieldData {
  const nn = m.nodes.length / 2, data = new Float64Array(nn * nc);
  for (let i = 0; i < nn; i++) { const v = f(m.nodes[2 * i]!, m.nodes[2 * i + 1]!); for (let j = 0; j < nc; j++) data[nc * i + j] = v[j]!; }
  return { name, unit, space: 'H1P2', components: nc, data };
}

/** Structured tri6 rectangle; `curved`: interior x-edge mid nodes shifted along y and the top mid nodes raised, so
 *  cells are curved (exercises the Newton inverse map and the curved-edge crossings). */
function fixtureMesh(axisym: boolean, curved: boolean): Mesh {
  const nx = 12, ny = 7, m = rectTriMesh({ x: axisym ? [1e-3, 3e-3] : [0, 2e-3], y: [0, 1e-3], nx, ny, order: 2, ...(axisym ? { axisym: true } : {}) });
  if (!curved) return m;
  const nodes = m.nodes.slice(), NX = 2 * nx, NY = 2 * ny, dy = 1e-3 / ny;
  for (let j = 0; j <= NY; j += 2) for (let i = 1; i < NX; i += 2) {
    const k = 2 * (j * (NX + 1) + i) + 1;
    if (j === NY) nodes[k] = nodes[k]! + 0.1 * dy;
    else if (j > 0) nodes[k] = nodes[k]! + 0.15 * dy * (((i + j) % 3) - 1);
  }
  const { hash: _h, ...rest } = m; void _h;
  return makeMesh({ ...rest, nodes });
}

export function fixtureSolution(axisym = false, curved = false): Solution {
  const m = fixtureMesh(axisym, curved);
  const sol = {
    meshHash: m.hash, scalars: { Q: { value: 2.5, unit: 'W' } }, stats: { dof: m.nodes.length / 2, solver: 'fixture' }, timing: {},
    fields: [
      field(m, 'T', 'K', 1, (x, y) => [300 + 1e3 * x - 2e3 * y + 4e5 * x * y + 7e5 * x * x]),
      field(m, 'u', 'm', 2, (x, y) => [1e-6 * x * y * 1e3, 1e-6 * (x - y)]),
    ],
    run: { engine: 'fixture', specHash: '0'.repeat(64), meshHash: m.hash, startedAt: '2026-11-06T00:00:00.000-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' },
  } as Solution;
  return attachMesh(sol, m);
}

/** All fixture results in a fixed order. */
export function fixtureValues(): number[] {
  const out: number[] = [];
  for (const [axisym, curved] of [[false, false], [true, false], [false, true]] as const) {
    const sol = fixtureSolution(axisym, curved), m = (sol as Solution & { mesh: Mesh }).mesh;
    const x0 = axisym ? 1e-3 : 0;
    const o = { physicsId: 'ht', params: { T0: { si: 300, unit: 'K' } }, defs: { th: 'atan2(y - 0.4e-3[m], x - 0.9e-3[m])' } };
    const exprs = axisym ? ['ht.T - T0', 'd(T, r) + d(T, z)', 'u.r*u.z/(1[m^2])'] : ['ht.T - T0', 'd(T, x)*cos(th) + d(T, y)*sin(th)', 'sqrt(u.x^2 + u.y^2)', '-d(T, r)'];
    const Lc = cutLine(m, [x0 + 0.13e-3, 0.07e-3], [x0 + 1.91e-3, 0.83e-3], { mode: 'crossing' });
    const Lu = cutLine(m, [x0 + 0.13e-3, 0.07e-3], [x0 + 1.91e-3, 0.83e-3], { n: 37 });
    const E = edgeDataset(m, ['bnd:rect.bottom', 'bnd:rect.right']);
    const P = cutPoints(m, [[x0 + 0.5e-3, 0.5e-3], [x0 + 1.7e-3, 0.2e-3]]);
    for (const e of exprs) {
      out.push(...evalPoint(sol, e, Lc.points, o).values, ...evalPoint(sol, e, Lu.points, o).values, ...evalPoint(sol, e, P, o).values);
      for (const r of [Lc, E, { kind: 'domain' as const }, { kind: 'boundary' as const, ids: ['bnd:rect.top'] }]) out.push(evalIntegral(sol, e, r, o).value);
      out.push(evalMax(sol, e, { kind: 'domain' }, o).value, evalMin(sol, e, E, o).value, evalMax(sol, e, { kind: 'domain' }, { ...o, method: 'lattice', resolution: 3 }).value);
    }
    out.push(evalMeasure(m, { kind: 'domain' }).value, evalMeasure(m, E).value, Lc.covered, ...Lc.s, ...E.s);
    if (curved) { const T = cutLine(m, [0.05e-3, 1.005e-3], [1.95e-3, 1.005e-3]); out.push(T.covered, ...T.pieces, evalIntegral(sol, 'T', T, o).value); }
  }
  // 3D: tet10 box, 3D cut line (crossing), domain and face integrals, nodal max
  const b = boxMesh({ x: [0, 1e-3], y: [0, 1e-3], z: [0, 2e-3], nx: 3, ny: 3, nz: 4, cell: 'tet10' });
  const nn = b.nodes.length / 3, data = new Float64Array(nn);
  for (let i = 0; i < nn; i++) { const x = b.nodes[3 * i]!, y = b.nodes[3 * i + 1]!, z = b.nodes[3 * i + 2]!; data[i] = 1 + 1e3 * x + 2e6 * y * z - 3e5 * z * z; }
  const s3 = attachMesh({ ...fixtureSolution(), meshHash: b.hash, fields: [{ name: 'f', unit: '1', space: 'H1P2', components: 1, data }], run: { ...fixtureSolution().run, meshHash: b.hash } } as Solution, b);
  const L3 = cutLine(b, [0.1e-3, 0.05e-3, 0.02e-3], [0.93e-3, 0.88e-3, 1.97e-3], { mode: 'crossing' });
  out.push(L3.covered, ...L3.pieces, ...evalPoint(s3, 'f + d(f, z)*(1[m])', L3.points).values, evalIntegral(s3, 'f', L3).value,
    evalIntegral(s3, 'f', { kind: 'domain' }).value, evalIntegral(s3, 'f', { kind: 'boundary', ids: ['bnd:box.zmax'] }).value, evalMax(s3, 'f', { kind: 'domain' }).value);
  return out;
}

export async function sha256Hex(values: readonly number[]): Promise<string> {
  const f = Float64Array.from(values), dv = new DataView(new ArrayBuffer(8 * f.length));
  for (let i = 0; i < f.length; i++) dv.setFloat64(8 * i, f[i]!, true);
  const h = await globalThis.crypto.subtle.digest('SHA-256', dv.buffer);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function gate7Fixture(): Promise<{ sha256: string; count: number }> {
  const v = fixtureValues();
  return { sha256: await sha256Hex(v), count: v.length };
}
