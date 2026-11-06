// SPDX-License-Identifier: GPL-3.0-or-later
// L3 3D tet spike (DevLog-004 s.1.3): manifold-3d CSG surface -> float-tetwild-wasm (serial build, as a browser without
// cross-origin isolation would load) -> mmg3d optimisation (@loumalouomega/mmg-wasm), in Node. One shape per process:
//   node --max-old-space-size=1536 packages/mesh/spike/tet-spike.ts <box-hole|sphere-box|torus> [--threads]
// Without an argument it runs the three shapes one after another as child processes and writes
// logs/l3-tet-spike-<stamp>.jsonl. Shape dimensions are placeholders (metres), not physics values.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tetQuality } from '../src/quality.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shape = process.argv[2];
const threads = process.argv.includes('--threads');
const mmgMem = Number((process.argv.find((a) => a.startsWith('--mmg-mem=')) ?? '').split('=')[1] ?? NaN); // MB cap (IPARAM_mem); default MMG's own

if (!shape) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const log = join(here, `../../../logs/l3-tet-spike-${stamp}.jsonl`);
  mkdirSync(dirname(log), { recursive: true });
  // bundle sizes (gzip -9 of the files a browser would fetch)
  const pkgDir = (p: string) => join(here, '../node_modules', p);
  const files: Record<string, string[]> = {
    'manifold-3d': ['manifold.js', 'manifold.wasm'],
    'float-tetwild-wasm (serial)': ['index.js', 'dist/floattetwild.serial.mjs', 'dist/floattetwild.serial.wasm'],
    '@loumalouomega/mmg-wasm': ['dist/mmg.mjs', 'dist/runtime.mjs', 'dist/mmg-core.mjs', 'dist/mmg-descriptor.mjs', 'dist/mmg-core.wasm'],
  };
  const pkgOf: Record<string, string> = { 'manifold-3d': 'manifold-3d', 'float-tetwild-wasm (serial)': 'float-tetwild-wasm', '@loumalouomega/mmg-wasm': '@loumalouomega/mmg-wasm' };
  for (const [name, fl] of Object.entries(files)) {
    let raw = 0, gz = 0;
    const per: Record<string, number[]> = {};
    for (const f of fl) {
      const b = readFileSync(join(pkgDir(pkgOf[name]!), f));
      const z = gzipSync(b, { level: 9 }).length;
      raw += b.length; gz += z; per[f] = [b.length, z];
    }
    const version = JSON.parse(readFileSync(join(pkgDir(pkgOf[name]!), 'package.json'), 'utf8')).version;
    appendFileSync(log, JSON.stringify({ kind: 'bundle', package: name, version, raw_bytes: raw, gz9_bytes: gz, files: per, ts: new Date().toISOString() }) + '\n');
    console.log(`bundle ${name}@${version}: raw ${(raw / 1e6).toFixed(3)} MB, gzip-9 ${(gz / 1e6).toFixed(3)} MB`);
  }
  for (const s of ['box-hole', 'sphere-box', 'torus']) {
    const r = spawnSync(process.execPath, ['--max-old-space-size=1536', '--no-warnings', fileURLToPath(import.meta.url), s], { encoding: 'utf8' });
    const line = r.stdout.trim().split('\n').pop() ?? '';
    if (r.status !== 0) { console.log(s, 'FAILED', r.stderr.slice(-2000)); appendFileSync(log, JSON.stringify({ kind: 'shape', shape: s, error: r.stderr.slice(-2000) }) + '\n'); continue; }
    appendFileSync(log, line + '\n');
    const o = JSON.parse(line);
    console.log(`${s}: ${JSON.stringify(o)}`);
  }
  console.log(`log: ${log}`);
  process.exit(0);
}

const T: Record<string, number> = {};
const RSS: Record<string, number> = {};
const tic = (k: string, t0: number) => { T[k] = performance.now() - t0; RSS[k.replace('_ms', '')] = Math.round(process.memoryUsage().rss / 2 ** 20); };
let t0 = performance.now();
const Module = (await import('manifold-3d')).default;
const wasm = await Module();
wasm.setup();
const { Manifold, CrossSection } = wasm;
tic('load_manifold_ms', t0);

// ---- CSG surfaces (placeholder dimensions, m) ----
t0 = performance.now();
const segs = 96;
let surfaces: Array<{ v: Float64Array; f: Int32Array }> = [];
let exactVol: Record<string, number> = {};
let classify: ((x: number, y: number, z: number) => number) | null = null;
const toSoup = (m: InstanceType<typeof Manifold>) => {
  const mesh = m.getMesh();
  const np = mesh.numProp, nv = mesh.vertProperties.length / np;
  const v = new Float64Array(3 * nv);
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) v[3 * i + c] = mesh.vertProperties[np * i + c]!;
  return { v, f: Int32Array.from(mesh.triVerts) };
};
if (shape === 'box-hole') {
  const box = Manifold.cube([0.1, 0.1, 0.05], true), cyl = Manifold.cylinder(0.1, 0.02, 0.02, segs, true);
  const m = box.subtract(cyl);
  surfaces = [toSoup(m)];
  exactVol = { solid: 0.1 * 0.1 * 0.05 - Math.PI * 0.02 * 0.02 * 0.05 };
  box.delete(); cyl.delete(); m.delete();
} else if (shape === 'sphere-box') {
  const box = Manifold.cube([0.1, 0.1, 0.1], true), sph = Manifold.sphere(0.025, segs);
  surfaces = [toSoup(box), toSoup(sph)];
  exactVol = { box: 1e-3 - (4 / 3) * Math.PI * 0.025 ** 3, sphere: (4 / 3) * Math.PI * 0.025 ** 3 };
  classify = (x, y, z) => (Math.hypot(x, y, z) < 0.025 ? 1 : 0);
  box.delete(); sph.delete();
} else if (shape === 'torus') {
  const cs = CrossSection.circle(0.01, 48).translate([0.04, 0]);
  const m = Manifold.revolve(cs, segs);
  surfaces = [toSoup(m)];
  exactVol = { solid: 2 * Math.PI * Math.PI * 0.04 * 0.01 * 0.01 };
  cs.delete(); m.delete();
} else throw new Error(`unknown shape ${shape}`);
// merge surfaces into one soup
let nv = 0, nf = 0;
for (const s of surfaces) { nv += s.v.length / 3; nf += s.f.length / 3; }
const V = new Float64Array(3 * nv), F = new Int32Array(3 * nf);
let ov = 0, of = 0;
for (const s of surfaces) {
  V.set(s.v, 3 * ov);
  for (let i = 0; i < s.f.length; i++) F[3 * of + i] = s.f[i]! + ov;
  ov += s.v.length / 3; of += s.f.length / 3;
}
tic('csg_ms', t0);

// ---- fTetWild ----
t0 = performance.now();
const { loadFloatTetwild } = await import('float-tetwild-wasm');
const ft = await loadFloatTetwild({ threads });
tic('load_ftetwild_ms', t0);
t0 = performance.now();
const res = ft.tetrahedralizeTyped(V, F, { epsRel: 1e-3, idealEdgeLengthRel: 0.05, stopEnergy: 10, maxIts: 80 });
tic('ftetwild_ms', t0);
if (res.status !== 0) throw new Error(`fTetWild status ${res.status}`);
const tv = res.vertices, tt = Int32Array.from(res.tets);
const q1 = tetQuality(tv, tt);
const nT = tt.length / 4;
const dom = new Int32Array(nT);
if (classify) for (let e = 0; e < nT; e++) {
  let x = 0, y = 0, z = 0;
  for (let a = 0; a < 4; a++) { const v = tt[4 * e + a]!; x += tv[3 * v]! / 4; y += tv[3 * v + 1]! / 4; z += tv[3 * v + 2]! / 4; }
  dom[e] = classify(x, y, z);
}
const volOf = (vv: Float64Array, tets: Int32Array, d: Int32Array) => {
  const out = [0, 0];
  for (let e = 0; e < d.length; e++) {
    const p = [0, 1, 2, 3].map((a) => tets[4 * e + a]!);
    const u = [0, 1, 2].map((c) => vv[3 * p[1]! + c]! - vv[3 * p[0]! + c]!), w = [0, 1, 2].map((c) => vv[3 * p[2]! + c]! - vv[3 * p[0]! + c]!), s = [0, 1, 2].map((c) => vv[3 * p[3]! + c]! - vv[3 * p[0]! + c]!);
    out[d[e]!]! += (u[0]! * (w[1]! * s[2]! - w[2]! * s[1]!) - u[1]! * (w[0]! * s[2]! - w[2]! * s[0]!) + u[2]! * (w[0]! * s[1]! - w[1]! * s[0]!)) / 6;
  }
  return out;
};
const vol1 = volOf(tv, tt, dom);

// ---- boundary / interface triangles for MMG (refs: 1 exterior, 2 interface) ----
const faceKey = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');
const fmap = new Map<string, { tri: number[]; tets: number[] }>();
for (let e = 0; e < nT; e++)
  for (const [i, j, k] of [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]] as const) {
    const a = tt[4 * e + i]!, b = tt[4 * e + j]!, c = tt[4 * e + k]!;
    const key = faceKey(a, b, c);
    const r = fmap.get(key);
    if (r) r.tets.push(e); else fmap.set(key, { tri: [a, b, c], tets: [e] });
  }
const tri: number[] = [], triRef: number[] = [];
for (const r of fmap.values()) {
  if (r.tets.length === 1) { tri.push(...r.tri.map((x) => x + 1)); triRef.push(1); }
  else if (dom[r.tets[0]!] !== dom[r.tets[1]!]) { tri.push(...r.tri.map((x) => x + 1)); triRef.push(2); }
}

// ---- MMG3D optimisation (keep the size, improve quality) ----
t0 = performance.now();
const mmgInit = (await import('@loumalouomega/mmg-wasm')).default;
const mmg = await mmgInit();
tic('load_mmg_ms', t0);
t0 = performance.now();
const m3 = mmg.mmg3d;
const h = m3.init();
const npt = tv.length / 3, ntri = triRef.length;
m3.setMeshSize(h.mesh, npt, nT, 0, ntri, 0, 0);
m3.setVertices(h.mesh, tv, null);
m3.setTetrahedra(h.mesh, Int32Array.from(tt, (x) => x + 1), Int32Array.from(dom, (d) => d + 1));
m3.setTriangles(h.mesh, Int32Array.from(tri), Int32Array.from(triRef));
m3.setIparameter(h.mesh, h.met, m3.IPARAM_verbose, -1);
m3.setIparameter(h.mesh, h.met, m3.IPARAM_optim, 1);
if (Number.isFinite(mmgMem)) m3.setIparameter(h.mesh, h.met, m3.IPARAM_mem, mmgMem);
const diag = Math.hypot(...[0, 1, 2].map((c) => { let lo = Infinity, hi = -Infinity; for (let i = c; i < tv.length; i += 3) { lo = Math.min(lo, tv[i]!); hi = Math.max(hi, tv[i]!); } return hi - lo; }));
m3.setDparameter(h.mesh, h.met, m3.DPARAM_hausd, 1e-3 * diag);
const ier = m3.mmg3dlib(h.mesh, h.met);
const size = m3.getMeshSize(h.mesh);
const out = m3.getVertices(h.mesh, size.np);
const ot = m3.getTetrahedra(h.mesh, size.ne) as { tetra: Int32Array; refs?: Int32Array };
m3.free(h);
tic('mmg3d_ms', t0);
const tet2 = Int32Array.from(ot.tetra, (x) => x - 1);
const dom2 = ot.refs ? Int32Array.from(ot.refs, (r) => r - 1) : new Int32Array(size.ne);
const q2 = tetQuality(out.vertices, tet2);
const vol2 = volOf(out.vertices, tet2, dom2);

const ru = process.resourceUsage();
console.log(JSON.stringify({
  kind: 'shape', shape, threads, mmgMemMB: Number.isFinite(mmgMem) ? mmgMem : null, ts: new Date().toISOString(), node: process.version, surface: { verts: nv, tris: nf },
  timings: T,
  ftetwild: { nodes: tv.length / 3, tets: nT, minDihedralDeg: q1.minDihedralDeg, minRadiusRatio: q1.minShape, meanRadiusRatio: q1.meanShape, inverted: q1.nInverted, volume: vol1 },
  mmg3d: { ier, nodes: size.np, tets: size.ne, minDihedralDeg: q2.minDihedralDeg, minRadiusRatio: q2.minShape, meanRadiusRatio: q2.meanShape, inverted: q2.nInverted, volume: vol2, domainsKept: !!ot.refs },
  exactVolume: exactVol, peakRssMB: ru.maxRSS / 1024, rssAfterStageMB: RSS,
}));
