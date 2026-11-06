// Generated from packages/rt/src/bench.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// Throughput benchmark shared by Node (Dawn) and the browser demo. Wall clock over many steps,
// with queue.onSubmittedWorkDone() as the fence (R4 s.1.2: timestamp queries are quantized in Chrome).

                                                    
import { LbmD2Q9 } from "./kernels/lbm.js";
import { FdtdTMz } from "./kernels/fdtd.js";
import { GrayScott } from "./kernels/grayscott.js";

                           
                 
             
             
                
                
                  
                      
                                                  
                
                 
 

export const BENCH_CASES                                                                   = [
  { kernel: "lbm", nx: 512, ny: 256 },
  { kernel: "lbm", nx: 1024, ny: 512 },
  { kernel: "lbm", nx: 2048, ny: 1024 },
  { kernel: "fdtd", nx: 512, ny: 512 },
  { kernel: "fdtd", nx: 1024, ny: 1024 },
  { kernel: "fdtd", nx: 2048, ny: 2048 },
  { kernel: "gs", nx: 256, ny: 256 },
  { kernel: "gs", nx: 1024, ny: 1024 },
  { kernel: "gs", nx: 2048, ny: 2048 },
];

function make(kind                       , nx        , ny        )                                                                  {
  if (kind === "lbm") {
    const D = Math.round(ny / 8);
    return { k: new LbmD2Q9(), p: { L: D, cylX: ny / 2, cylY: ny / 2 + 0.5, cylR: D / 2 }, dx: 1 };
  }
  if (kind === "fdtd") return { k: new FdtdTMz(), p: { srcX: nx / 2, srcY: ny / 2 }, dx: 1e-3 };
  return { k: new GrayScott(), p: {}, dx: 2 / nx };
}

export async function benchOne(device           , kind                       , nx        , ny        , minSeconds = 1)                    {
  const { k, p, dx } = make(kind, nx, ny);
  await k.init(device, p, { nx, ny, dx });
  const batch = 64;
  k.step(batch);
  await device.queue.onSubmittedWorkDone();
  let steps = 0;
  const t0 = performance.now();
  let t = 0;
  while (t < minSeconds * 1000) {
    for (let r = 0; r < 4; r++) k.step(batch);
    steps += 4 * batch;
    await device.queue.onSubmittedWorkDone();
    t = performance.now() - t0;
  }
  const s = t / 1000;
  const info = k.info();
  k.dispose();
  return {
    kernel: k.id, nx, ny, cells: nx * ny, steps, seconds: s, stepsPerSec: steps / s,
    MLUPS: (nx * ny * steps) / s / 1e6, gpuMiB: info.gpuBytes / 2 ** 20,
  };
}

export async function benchAll(device           , minSeconds = 1)                      {
  const rows             = [];
  for (const c of BENCH_CASES) rows.push(await benchOne(device, c.kernel, c.nx, c.ny, minSeconds));
  return rows;
}
