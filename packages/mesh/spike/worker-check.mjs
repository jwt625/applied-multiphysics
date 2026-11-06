// SPDX-License-Identifier: GPL-3.0-or-later
// L3 spike: load each WASM mesher inside a Node worker_threads Worker and run a tiny operation.
// Run: node packages/mesh/spike/worker-check.mjs
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
if (isMainThread) {
  for (const which of ['manifold', 'ftetwild-serial', 'mmg']) {
    const r = await new Promise((res) => {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: which });
      w.once('message', res);
      w.once('error', (e) => res({ which, ok: false, error: String(e) }));
    });
    console.log(JSON.stringify(r));
  }
} else {
  const which = workerData, t0 = performance.now();
  try {
    let info;
    if (which === 'manifold') {
      const w = await (await import('manifold-3d')).default(); w.setup();
      const c = w.Manifold.cube([1, 1, 1], true); info = { volume: c.volume() }; c.delete();
    } else if (which === 'ftetwild-serial') {
      const { loadFloatTetwild } = await import('float-tetwild-wasm');
      const ft = await loadFloatTetwild({ threads: false });
      const V = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), F = new Int32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
      const r = ft.tetrahedralizeTyped(V, F, { idealEdgeLengthRel: 0.5 }); info = { status: r.status, tets: r.tets.length / 4, threaded: ft.threaded };
    } else {
      const mmg = await (await import('@loumalouomega/mmg-wasm')).default();
      const h = mmg.mmg3d.init(); mmg.mmg3d.free(h); info = { init: true };
    }
    parentPort.postMessage({ which, ok: true, ms: performance.now() - t0, info });
  } catch (e) { parentPort.postMessage({ which, ok: false, error: String(e) }); }
}
