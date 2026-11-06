// SPDX-License-Identifier: GPL-3.0-or-later
// Node + Dawn throughput table; writes logs/rt-bench-node-<timestamp>.json at the repo root.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeGpu } from "../src/node-gpu.ts";
import { benchAll } from "../src/bench.ts";

const g = await nodeGpu();
if (!g) throw new Error("no WebGPU adapter through Dawn");
const rows = await benchAll(g.device, Number(process.argv[2] ?? 1));
console.table(rows.map((r) => ({ ...r, seconds: +r.seconds.toFixed(2), stepsPerSec: +r.stepsPerSec.toFixed(0), MLUPS: +r.MLUPS.toFixed(0), gpuMiB: +r.gpuMiB.toFixed(1) })));
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
mkdirSync(join(root, "logs"), { recursive: true });
const file = join(root, "logs", `rt-bench-node-${stamp}.json`);
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), runtime: "node " + process.version + " + webgpu@0.6.2 (Dawn)", adapter: g.adapterInfo, rows }, null, 1));
console.log("wrote " + file);
