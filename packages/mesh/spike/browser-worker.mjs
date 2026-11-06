// SPDX-License-Identifier: GPL-3.0-or-later
// L3 spike: module Worker that loads the three WASM meshers in a browser (served from packages/mesh/).
const out = [];
self.onunhandledrejection = (e) => postMessage({ progress: 'unhandled ' + String(e.reason) });
const run = async (which, f) => {
  postMessage({ progress: 'start ' + which }); const t0 = performance.now(); try { const info = await f(); out.push({ which, ok: true, ms: Math.round(performance.now() - t0), info }); } catch (e) { out.push({ which, ok: false, error: String(e) }); } };
await run('manifold', async () => { const w = await (await import('../node_modules/manifold-3d/manifold.js')).default(); w.setup(); const c = w.Manifold.cube([1, 1, 1], true); const v = c.volume(); c.delete(); return { volume: v }; });
await run('ftetwild', async () => {
  const { loadFloatTetwild } = await import('../node_modules/float-tetwild-wasm/index.js');
  const ft = await loadFloatTetwild();
  const V = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), F = new Int32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const r = ft.tetrahedralizeTyped(V, F, { idealEdgeLengthRel: 0.5 });
  return { status: r.status, tets: r.tets.length / 4, threaded: ft.threaded };
});
await run('mmg', async () => { const m = await (await import('../node_modules/@loumalouomega/mmg-wasm/dist/mmg.mjs')).default(); const h = m.mmg3d.init(); m.mmg3d.free(h); return { init: true }; });
postMessage({ crossOriginIsolated: self.crossOriginIsolated, ua: navigator.userAgent, results: out });
