// SPDX-License-Identifier: GPL-3.0-or-later
// Node module resolve hook: while an atlas test suite runs (read only, in its own repo), every import of an atlas
// numerics file that @amp/core ports is resolved to the @amp/core file instead, so the unchanged atlas tests exercise
// the core modules. Map: atlas path (relative to <atlas>/engine/src) -> core path (relative to packages/core/src).
// Data: {eo, apa, core, log} from register.mjs. Each redirected URL is reported once on stderr ("redirect a -> b").
import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';

const EO = {
  'sparse.mjs': 'la/sparse.mjs', 'ldlt.mjs': 'la/ldlt.mjs', 'complex.mjs': 'la/complex.mjs', 'vector-dense.mjs': 'la/vector-dense.mjs',
  'fem.mjs': 'fem/tri.mjs', 'params.mjs': 'params.mjs', 'postproc/units.mjs': 'units.mjs', 'postproc/expr.mjs': 'expr.mjs',
  'semi/linear.mjs': 'la/gmres-real.mjs',
};
const APA = {
  'la/sparse.mjs': 'la/sparse.mjs', 'la/ldlt.mjs': 'la/ldlt.mjs', 'la/complex.mjs': 'la/complex.mjs', 'la/stencil.mjs': 'la/stencil.mjs',
  'la/mg.mjs': 'la/mg.mjs', 'la/block.mjs': 'la/block.mjs', 'la/halfmg.mjs': 'la/halfmg.mjs', 'la/pcg.mjs': 'la/pcg.mjs',
  'la/wasm/encoder.mjs': 'la/wasm/encoder.mjs', 'la/wasm/kernels.mjs': 'la/wasm/kernels.mjs', 'la/wasm/accel.mjs': 'la/wasm/accel.mjs',
  'params/params.mjs': 'params.mjs', 'params/units.mjs': 'units.mjs',
  'em2d/dense.mjs': 'la/dense.mjs', 'em2d/ldlt-blocked.mjs': 'la/ldlt-blocked.mjs', 'em2d/ldlt-wasm.mjs': 'la/ldlt-wasm.mjs',
  'em2d/ldlt-select.mjs': 'la/ldlt-select.mjs', 'em2d/fe.mjs': 'fem/tri-fe.mjs',
  'em3d/krylov.mjs': 'la/krylov.mjs', 'em3d/amg.mjs': 'la/amg.mjs', 'em3d/ams.mjs': 'la/ams.mjs', 'em3d/pmg.mjs': 'la/pmg.mjs',
  'em3d/order.mjs': 'la/order3d.mjs', 'em3d/hcurl.mjs': 'fem/hcurl.mjs', 'em3d/elements.mjs': 'fem/nedelec1.mjs', 'em3d/space.mjs': 'fem/space.mjs',
  'thermal/assemble.mjs': 'fem/q1-grid.mjs',
};
let table = new Map();
const seen = new Set();
let logFd = 2;

export async function initialize({ eo, apa, core, log }) {
  const add = (root, map) => { if (root) for (const [a, c] of Object.entries(map)) table.set(pathToFileURL(`${root}/src/${a}`).href, pathToFileURL(`${core}/${c}`).href); };
  add(eo, EO);
  add(apa, APA);
  if (log) logFd = log;
}

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  const to = table.get(r.url);
  if (!to) return r;
  if (!seen.has(r.url)) { seen.add(r.url); writeSync(logFd, `redirect ${r.url} -> ${to}\n`); }
  return { ...r, url: to, shortCircuit: true };
}
