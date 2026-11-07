// SPDX-License-Identifier: GPL-3.0-or-later
// Runs every DevLog-005 gate (CPU references and the WGSL kernels through Dawn), prints a flat summary table
// and writes logs/rt-gates-<timestamp>.json at the repo root.
// Usage: node scripts/gates.ts [--quick] [--cpu-only]
// Exit codes (as L8's CLI): 0 all gates pass, 1 error (including no GPU without --cpu-only), 2 a gate missed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeGpu, nodeGpuError } from "../src/node-gpu.ts";
import { deviceErrors } from "../src/gpu.ts";
import * as G from "../src/gates.ts";

const quick = process.argv.includes("--quick");
const cpuOnly = process.argv.includes("--cpu-only");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out: Record<string, unknown> = { startedAt: new Date().toISOString(), quick, cpuOnly, thresholds: G.THRESHOLDS };
const log = (s: string): boolean => process.stderr.write(`${new Date().toISOString()} ${s}\n`);

interface SummaryRow {
  gate: string;
  item: string;
  value: string;
  threshold: string;
  pass: boolean | null; // null = report-only
}
const summary: SummaryRow[] = [];
const fmt = (v: number): string => (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e4 ? v.toPrecision(4) : v.toExponential(2));
const add = (gate: string, item: string, value: number | string, threshold: string, pass: boolean | number | undefined | null): void => {
  summary.push({
    gate, item, value: typeof value === "number" ? fmt(value) : value, threshold,
    pass: pass === undefined || pass === null ? null : Boolean(pass),
  });
};

function fl04Ref(): G.Fl04Ref | undefined {
  const f = join(root, "eval", "expected", "FL-04.json");
  if (!existsSync(f)) return undefined;
  const d = JSON.parse(readFileSync(f, "utf8")) as { targets?: Array<{ metric_id: string; value: number }>; generated_at?: string };
  const t = (id: string): number | undefined => d.targets?.find((x) => x.metric_id === id)?.value;
  const cD = t("c_D_max");
  const cL = t("c_L_max");
  const St = t("St");
  if (cD === undefined || cL === undefined || St === undefined) return undefined;
  return { c_D_max: cD, c_L_max: cL, St, source: `eval/expected/FL-04.json (generated_at ${d.generated_at ?? "?"})` };
}

async function main(): Promise<number> {
  const T = G.THRESHOLDS;
  const gpu = cpuOnly ? null : await nodeGpu();
  if (!gpu && !cpuOnly) {
    log(`no WebGPU device through Dawn: ${nodeGpuError() ?? "unknown"}; rerun with --cpu-only to skip the GPU gates on purpose`);
    return 1;
  }
  out.platform = gpu ? { runtime: "node", node: process.version, dawn: "webgpu@0.6.2", adapter: gpu.adapterInfo, limits: gpu.limits } : { runtime: "node", gpu: null };
  const dev = gpu?.device ?? null;
  const ref = fl04Ref();
  out.fl04Ref = ref ?? null;

  log("gate 1 Poiseuille");
  const pois = [...(await G.poiseuille(null, quick ? [8, 16] : [8, 16, 32, 64])), ...(dev ? await G.poiseuille(dev, quick ? [8, 16] : [8, 16, 32, 64]) : [])];
  out.poiseuille = pois;
  for (const r of pois) {
    if (r.collision === "TRT") add("1 Poiseuille", `${r.backend} TRT H ${r.H} L2`, r.L2, `< ${r.backend === "cpu" ? T.poiseuilleTrtF64 : T.poiseuilleTrtF32}`, r.pass);
    else add("1 Poiseuille", `${r.backend} BGK H ${r.H} ${r.order === undefined ? "L2" : "order"}`, r.order ?? r.L2, r.order === undefined ? "report" : `2 +- ${r.backend === "cpu" ? T.poiseuilleBgkOrder.tolF64 : T.poiseuilleBgkOrder.tolF32}`, r.pass);
  }
  log("gate 1b channel");
  const ch = [await G.channelPoiseuille(null, 16, 8 * 16 + 1)];
  if (dev) ch.push(await G.channelPoiseuille(dev), await G.channelPoiseuille(dev, 32, 257, 0.8, 0.02), ...(quick ? [] : [await G.channelPoiseuille(dev, 64, 513)]));
  out.channel = ch;
  for (const r of ch) {
    add("1b channel", `${r.backend} H ${r.H} u ${r.uMax} L2shape`, r.L2shape, `< ${T.channelShape}`, r.pass);
    add("1b channel", `${r.backend} H ${r.H} u ${r.uMax} L2 raw / |dRho|`, `${fmt(r.L2)} / ${fmt(Math.abs(r.dRho))}`, "report", null);
  }
  if (dev) {
    log("gate 8 LBM GPU vs CPU");
    const lg = await G.lbmGpuVsCpu(dev);
    out.lbmGpuVsCpu = lg;
    add("8 LBM gpu vs cpu", "max rel (ux, uy, rho, force)", Math.max(lg.ux_rel!, lg.uy_rel!, lg.rho_rel!, lg.force_rel!), `< ${T.lbmGpuVsCpuRel}`, lg.pass);
    const series: Array<[number, number, number, number]> = quick
      ? [[20, 0.1, 1, 1], [20, 0.05, 1, 1]]
      : [[10, 0.05, 1, 1], [20, 0.05, 1, 1], [40, 0.05, 1, 1], [60, 0.05, 1, 1], [80, 0.05, 1, 1],
        [40, 0.1, 1, 1], [40, 0.025, 1, 1], [40, 0.0125, 1, 1], [40, 0.05, 1, 0], [40, 0.05, 0, 1]];
    const st: G.StrouhalResult[] = [];
    for (const [nD, u, coll, bz] of series) {
      log(`gate 2 DFG 2D-2 D ${nD} u_max ${u} ${coll ? "TRT" : "BGK"} bouzidi ${bz}`);
      let r: G.StrouhalResult;
      try {
        r = await G.strouhal(dev, nD, { uMax: u, collision: coll, bouzidi: bz, ...(ref ? { ref } : {}) });
      } catch (e) {
        if (!/diverged/.test((e as Error).message)) throw e;
        const inScope = nD >= T.stMinD && coll === 1 && u >= T.stMinUMax;
        add("2 DFG St", `D ${nD} u ${u} ${coll ? "TRT" : "BGK"}`, (e as Error).message, inScope ? "no divergence" : "report (outside gate scope)", inScope ? false : null);
        continue;
      }
      st.push(r);
      const tag = `D ${nD} u ${u} ${r.collision}${bz ? " Bz" : " halfway"}`;
      add("2 DFG St", tag, r.St, r.pass !== undefined ? `${T.stBand[0]}-${T.stBand[1]}` : "report (outside gate scope)", r.pass);
      if (ref) add("2 DFG forces (realtime, report)", `${tag} err c_D, c_L, St`, `${fmt(r.errCD!)}, ${fmt(r.errCL!)}, ${fmt(r.errSt!)}`, "report", null);
    }
    out.strouhal = st;
  }
  log("gate 3 dispersion");
  const disp = [...(await G.dispersion(null)), ...(dev ? await G.dispersion(dev) : [])];
  out.dispersion = disp;
  for (const b of ["cpu", "gpu"] as const) {
    const rows = disp.filter((r) => r.backend === b);
    if (rows.length) add("3 dispersion", `${b} max |w - w_Yee| / w_Yee (${rows.length} modes)`, Math.max(...rows.map((r) => Math.abs(r.relErrVsYee))), `< ${b === "cpu" ? T.dispersionF64 : T.dispersionF32}`, rows.every((r) => r.pass));
  }
  log("gate 4 CPML");
  const cp = [await G.cpmlReflection(null, 10), ...(dev ? [await G.cpmlReflection(dev, 5), await G.cpmlReflection(dev, 10), await G.cpmlReflection(dev, 20)] : [])];
  out.cpml = cp;
  for (const r of cp) add("4 CPML", `${r.backend} ${r.pml} cells [dB]`, r.dB, `< ${T.cpmlDb}`, r.pass);
  log("gate 5 cavity");
  const cav = [...(await G.cavity(null, quick ? [16] : [16, 32])), ...(dev ? await G.cavity(dev, [16, 32, 64]) : [])];
  out.cavity = cav;
  for (const r of cav) {
    add("5 cavity", `${r.backend} N ${r.N} rel err`, r.relErrVsAnalytic, r.N === 32 ? `< ${T.cavityRelAtN32}` : "report", r.N === 32 ? Math.abs(r.relErrVsAnalytic) < T.cavityRelAtN32 : null);
    if (r.order !== undefined) add("5 cavity", `${r.backend} N ${r.N} order`, r.order, `2 +- ${T.cavityOrder.tol}`, Math.abs(r.order - 2) <= T.cavityOrder.tol);
  }
  if (dev) {
    log("gate 8 FDTD GPU vs CPU");
    const fg = await G.fdtdGpuVsCpu(dev);
    out.fdtdGpuVsCpu = fg;
    add("8 FDTD gpu vs cpu", "Ez rel", fg.ez_rel!, `< ${T.fdtdGpuVsCpuRel}`, fg.pass);
    log("gate 6 Gray-Scott GPU vs CPU");
    const gs = await G.gsGpuVsCpu(dev);
    out.gsGpuVsCpu = gs;
    for (const r of gs)
      add("6 GS gpu vs f32 cpu", `${r.steps} steps max(u, v)`, Math.max(r.u_vs_f32!, r.v_vs_f32!), r.steps === 1000 ? `< ${T.gsVsF32At1000}` : "report", r.pass ?? null);
  }
  log("gate 7 pattern");
  const pat = [...(dev ? await G.gsPattern(dev) : []), ...(await G.gsPattern(null, ["spots", "maze"], quick ? 3000 : 10000))];
  out.pattern = pat;
  for (const r of pat) add("7 GS pattern", `${r.backend} ${r.set} (${r.components} comp, Q ${r.medianQ.toFixed(2)})`, r.cls, r.expected, r.pass);

  if (dev) {
    const errs = deviceErrors(dev);
    add("S2 GPU errors", "uncaptured WebGPU errors during the run", errs.length, "= 0", errs.length === 0);
    out.gpuErrors = errs;
  }
  out.summary = summary;
  const failed = summary.filter((r) => r.pass === false);
  out.allPass = failed.length === 0;
  out.finishedAt = new Date().toISOString();
  mkdirSync(join(root, "logs"), { recursive: true });
  const file = join(root, "logs", `rt-gates-${stamp}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.table(summary.map((r) => ({ ...r, pass: r.pass === null ? "report" : r.pass ? "PASS" : "FAIL" })));
  console.log(`${summary.filter((r) => r.pass === true).length} pass, ${failed.length} fail, ${summary.filter((r) => r.pass === null).length} report-only; wrote ${file}`);
  return failed.length === 0 ? 0 : 2;
}

try {
  process.exitCode = await main();
} catch (e) {
  log(`error: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
}
