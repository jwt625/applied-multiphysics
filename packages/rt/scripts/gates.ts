// SPDX-License-Identifier: GPL-3.0-or-later
// Runs every DevLog-005 gate (CPU references and the WGSL kernels through Dawn) and writes
// logs/rt-gates-<timestamp>.json at the repo root. Usage: node scripts/gates.ts [--quick]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeGpu } from "../src/node-gpu.ts";
import * as G from "../src/gates.ts";

const quick = process.argv.includes("--quick");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out: Record<string, unknown> = { startedAt: new Date().toISOString(), quick };
const t = (label: string): (() => void) => {
  const t0 = performance.now();
  process.stderr.write(`${new Date().toISOString()} ${label} ...\n`);
  return () => process.stderr.write(`${new Date().toISOString()} ${label} done in ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);
};

const gpu = await nodeGpu();
out.platform = gpu ? { runtime: "node", node: process.version, dawn: "webgpu@0.6.2", adapter: gpu.adapterInfo, limits: gpu.limits } : { runtime: "node", gpu: null };
const dev = gpu?.device ?? null;

let done = t("gate 1 Poiseuille (cpu)");
out.poiseuilleCpu = await G.poiseuille(null, quick ? [8, 16] : [8, 16, 32, 64]);
done();
if (dev) {
  done = t("gate 1 Poiseuille (gpu)");
  out.poiseuilleGpu = await G.poiseuille(dev, quick ? [8, 16] : [8, 16, 32, 64]);
  done();
  done = t("gate 1b channel inlet/outlet (gpu)");
  out.channelGpu = [await G.channelPoiseuille(dev), await G.channelPoiseuille(dev, 32, 257, 0.8, 0.02), await G.channelPoiseuille(dev, 64, 513)];
  done();
}
done = t("gate 1b channel inlet/outlet (cpu, H 16)");
out.channelCpu = await G.channelPoiseuille(null, 16, 8 * 16 + 1);
done();
if (dev) {
  done = t("gate 8 lbm gpu vs cpu");
  out.lbmGpuVsCpu = await G.lbmGpuVsCpu(dev);
  done();
  const st: unknown[] = [];
  for (const nD of quick ? [10, 20] : [10, 20, 30, 40, 60]) {
    done = t(`gate 2 Strouhal nD ${nD}`);
    st.push(await G.strouhal(dev, nD));
    done();
  }
  if (!quick) {
    done = t("gate 2 Strouhal nD 40, uMax 0.05");
    st.push(await G.strouhal(dev, 40, { uMax: 0.05 }));
    done();
    done = t("gate 2 Strouhal nD 40, BGK");
    st.push(await G.strouhal(dev, 40, { collision: 0 }));
    done();
  }
  out.strouhal = st;
}
done = t("gate 3 dispersion (cpu)");
out.dispersionCpu = await G.dispersion(null);
done();
if (dev) {
  done = t("gate 3 dispersion (gpu)");
  out.dispersionGpu = await G.dispersion(dev);
  done();
}
const cp: unknown[] = [];
done = t("gate 4 CPML (cpu, 10 cells)");
cp.push(await G.cpmlReflection(null, 10));
done();
if (dev) {
  for (const n of [5, 10, 20]) {
    done = t(`gate 4 CPML (gpu, ${n} cells)`);
    cp.push(await G.cpmlReflection(dev, n));
    done();
  }
}
out.cpml = cp;
done = t("gate 5 cavity (cpu)");
out.cavityCpu = await G.cavity(null, quick ? [16] : [16, 32]);
done();
if (dev) {
  done = t("gate 5 cavity (gpu)");
  out.cavityGpu = await G.cavity(dev, [16, 32, 64]);
  done();
  done = t("gate 8 fdtd gpu vs cpu");
  out.fdtdGpuVsCpu = await G.fdtdGpuVsCpu(dev);
  done();
  done = t("gate 6 gray-scott gpu vs cpu");
  out.gsGpuVsCpu = await G.gsGpuVsCpu(dev);
  done();
  done = t("gate 7 pattern (gpu)");
  out.gsPatternGpu = await G.gsPattern(dev);
  done();
}
done = t("gate 7 pattern (cpu f64)");
out.gsPatternCpu = await G.gsPattern(null, ["spots", "maze"], quick ? 3000 : 10000);
done();

out.finishedAt = new Date().toISOString();
mkdirSync(join(root, "logs"), { recursive: true });
const file = join(root, "logs", `rt-gates-${stamp}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
process.stderr.write(`wrote ${file}\n`);
