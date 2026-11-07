// SPDX-License-Identifier: GPL-3.0-or-later
// Headless Chrome (playwright-core + the installed Google Chrome) against the demo page served by a
// short-lived in-process static server on an uncommon port. Takes one screenshot per kernel and, optionally,
// runs the in-browser bench and gates. Everything goes to logs/ with a timestamp; the server closes on exit.
// Usage: node scripts/shoot.ts [--bench] [--gates] [--port 47613] [--no-shots]
import { createServer, type Server } from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");
const demo = join(pkg, "demo");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
let port = portArg >= 0 ? Number(args[portArg + 1]) : 47613;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

function serve(p: number): Promise<Server> {
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    const file = join(demo, rel === "" ? "index.html" : rel);
    if (!file.startsWith(demo)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok, bad) => {
    srv.once("error", bad);
    srv.listen(p, "127.0.0.1", () => ok(srv));
  });
}

let server: Server | null = null;
for (let tries = 0; tries < 10 && !server; tries++) {
  try {
    server = await serve(port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    port++;
  }
}
if (!server) throw new Error("no free port");
const base = `http://127.0.0.1:${port}/`;
console.log(`serving ${demo} at ${base}`);
await mkdir(join(root, "logs"), { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--use-angle=metal"],
});
const out: Record<string, unknown> = { at: new Date().toISOString(), chrome: browser.version(), url: base };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const logs: string[] = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  const run = async (q: string, timeout = 120_000): Promise<Record<string, unknown>> => {
    await page.goto(base + "index.html?" + q);
    try {
      await page.waitForFunction(() => (window as unknown as { __rtReady?: boolean }).__rtReady === true, null, { timeout, polling: 200 });
    } catch (e) {
      console.error("timeout on " + q + "\n" + logs.join("\n"));
      throw e;
    }
    return page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { probe: w.__rtProbe, error: w.__rtError ?? null, bench: w.__rtBench ?? null, gates: w.__rtGates ?? null, err: document.getElementById("err")?.textContent ?? "" };
    });
  };
  const first = await run("k=gs&autoplay=1&frames=1");
  out.probe = first.probe;
  console.log("probe", JSON.stringify(first.probe));
  if (!args.includes("--no-shots") && (first.probe as { webgpu?: boolean } | undefined)?.webgpu) {
    // audit S3: desktop 1440x900 and phone 390x844 per kernel; layout metrics checked; one composite PNG per kernel
    const tmp = process.env.RT_SHOT_TMP ?? join(root, "logs", `.rt-shot-tmp-${stamp}`);
    await mkdir(tmp, { recursive: true });
    const shots: Array<[string, string]> = [
      ["lbm", "k=lbm&autoplay=1&p.nD=40&p.Re=100&p.uMax=0.1&p.spf=200&frames=250"],
      ["fdtd", "k=fdtd&scene=1&autoplay=1&p.spf=4&frames=300"],
      ["gs", "k=gs&autoplay=1&p.spf=100&frames=100"],
    ];
    const vps: Array<[string, number, number]> = [["desktop", 1440, 900], ["phone", 390, 844]];
    const files: Record<string, string> = {};
    const metrics: Array<Record<string, unknown>> = [];
    for (const [name, q] of shots) {
      const parts: string[] = [];
      for (const [vp, w, h] of vps) {
        await page.setViewportSize({ width: w, height: h });
        const r = await run(q, 180_000);
        const m = await page.evaluate(() => {
          const cv = document.getElementById("cv") as HTMLCanvasElement;
          const b = cv.getBoundingClientRect();
          const w = window as unknown as { __rtGrid?: { nx: number; ny: number } };
          return {
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            canvasCss: [Math.round(b.width), Math.round(b.height)],
            canvasLeft: Math.round(b.left),
            grid: w.__rtGrid ?? null,
          };
        });
        const g = m.grid as { nx: number; ny: number } | null;
        const aspectErr = g ? (m.canvasCss[0]! / m.canvasCss[1]!) / (g.nx / g.ny) - 1 : NaN;
        const ok = m.scrollWidth <= m.innerWidth && Math.abs(aspectErr) < 0.02 && (vp !== "phone" || m.canvasLeft >= 15);
        metrics.push({ kernel: name, viewport: vp, ...m, aspectErr, ok, err: r.err });
        const f = join(tmp, `${name}-${vp}.png`);
        if (vp === "phone") {
          // explicit viewport height = document height instead of fullPage stitching (stitching duplicated content)
          const H = await page.evaluate(() => document.documentElement.scrollHeight);
          await page.setViewportSize({ width: w, height: H });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
          await page.waitForTimeout(300);
        }
        await page.screenshot({ path: f });
        parts.push(f);
        console.log(name, vp, JSON.stringify({ ...m, aspectErr: +aspectErr.toFixed(4), ok }), r.err ? `err: ${r.err}` : "");
      }
      // composite: desktop left, phone (full page) right, on one canvas
      const imgs = await Promise.all(parts.map(async (f) => "data:image/png;base64," + (await readFile(f)).toString("base64")));
      await page.goto("about:blank"); // stop the demo's frame loop before compositing (its DOM would be replaced)
      await page.setViewportSize({ width: 1440 + 390 + 48, height: 900 });
      await page.setContent(
        `<html><body style="margin:0;background:#06070a;display:flex;gap:16px;padding:16px;align-items:flex-start">` +
          `<img src="${imgs[0]}" style="width:1440px;display:block"><img src="${imgs[1]}" style="width:390px;display:block"></body></html>`,
      );
      const outPng = join(root, "logs", `rt-demo-${name}-${stamp}.png`);
      await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
      const H = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: 1440 + 390 + 48, height: H });
      // let Chrome repaint at the new size (without this the area beyond the old viewport repeated the top)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
      await page.waitForTimeout(300);
      await page.screenshot({ path: outPng });
      files[name] = outPng;
      for (const f of parts) await rm(f);
    }
    await rm(tmp, { recursive: true, force: true });
    out.shots = files;
    out.layout = metrics;
    out.layoutOk = metrics.every((m) => m.ok === true);
  }
  if (args.includes("--bench")) {
    const r = await run("bench=1&sec=1.5", 300_000);
    out.bench = r.bench;
    console.table(r.bench);
  }
  if (args.includes("--gates")) {
    const r = await run("gates=1", 300_000);
    out.gates = r.gates;
    console.log(JSON.stringify(r.gates, null, 1).slice(0, 4000));
  }
  out.console = logs;
} finally {
  await browser.close();
  server.close();
}
const f = join(root, "logs", `rt-chrome-${stamp}.json`);
await writeFile(f, JSON.stringify(out, null, 1));
console.log("wrote " + f);
