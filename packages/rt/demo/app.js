// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/rt demo page: plain ES modules, no bundler. Imports the type-stripped copy of src/ in ./lib
// (regenerate with `node scripts/emit-browser.ts`). URL flags: k=lbm|fdtd|gs, autoplay=1, frames=N,
// bench=1 (throughput table), gates=1 (gates in the browser), scene=N (FDTD preset), plus p.<param>=<value>.

import {
  LbmD2Q9, FdtdTMz, GrayScott, FieldRenderer, probePlatform, colormapCSS, dfgGrid, WELL_FK, C0,
  benchAll, gates,
} from "./lib/index.js";

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
function esc(t) {
  return String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
const fmt = (v) => {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return Number(v.toPrecision(3)).toString();
};

// ------------------------------------------------------------------ kernel definitions

const FDTD_GRID = { nx: 640, ny: 400, dx: 1e-3 };
const GS_N = 512;
const GS_DX = 1 / 64; // The Well spacing (2 / 128); domain 8 x 8 model units

const DEFS = {
  lbm: {
    title: "LBM D2Q9",
    style: "lbm",
    view: "vorticity",
    autoRange: false,
    params: [
      { id: "nD", label: "D", unit: "cells", min: 10, max: 80, step: 10, value: 40, reinit: true, tip: "Cylinder diameter in cells. Channel 22 D x 4.1 D (DFG 2D-2: 2.2 m x 0.41 m, D = 0.1 m)" },
      { id: "Re", label: "Re", unit: "", min: 10, max: 1000, step: 1, value: 100, tip: "Reynolds number U_mean D / nu. Sets the lattice viscosity; tau -> 0.5 at high Re is unstable" },
      { id: "uMax", label: "u_max", unit: "lat", min: 0.02, max: 0.15, step: 0.005, value: 0.1, tip: "Peak inlet velocity in lattice units; Mach = u_max sqrt(3). Lower is more accurate and slower" },
      { id: "spf", label: "steps/frame", unit: "", min: 1, max: 200, step: 1, value: 40, tip: "Time steps per displayed frame" },
    ],
    tools: [["obstacle", "obstacle", "Draw a solid obstacle (bounce-back)"], ["erase", "erase", "Remove obstacles"]],
    value: null,
    presets: [
      ["DFG 2D-2", { nD: 40, Re: 100, uMax: 0.1 }, "Schafer-Turek benchmark 2D-2, Re 100 (St 0.295-0.305)"],
      ["Re 20 steady", { nD: 40, Re: 20, uMax: 0.1 }, "DFG 2D-1 Reynolds number: steady wake"],
      ["Re 250", { nD: 40, Re: 250, uMax: 0.08 }, "Stronger shedding"],
      ["coarse D 20", { nD: 20, Re: 100, uMax: 0.1 }, "D = 20 cells"],
    ],
    async make(device, P) {
      const { grid, params } = dfgGrid(P.nD);
      const k = new LbmD2Q9();
      await k.init(device, { ...params, Re: P.Re, uMax: P.uMax, probeX: -1, probeY: -1 }, grid);
      return k;
    },
    live(k, P) { k.setParams({ Re: P.Re, uMax: P.uMax }); },
    phys(k, i, j) { return [i * k.grid.dx, (j - 0.5) * k.grid.dx, "m"]; },
    dt(k) { return k.d.dt; },
    info(k) {
      const d = k.d;
      const nu = (1.0 * 0.1) / k.p.Re;
      const warn = d.tau < 0.51 ? "  tau near 0.5: may diverge" : "";
      return `tau ${d.tau.toFixed(4)}  Ma ${d.mach.toFixed(3)}  nu ${fmt(nu)} m^2/s  dx ${fmt(k.grid.dx)} m  dt ${fmt(d.dt)} s  U_mean 1 m/s${warn}`;
    },
  },
  fdtd: {
    title: "FDTD TMz",
    style: "fdtd",
    view: "ez",
    autoRange: true,
    params: [
      { id: "freq", label: "f", unit: "GHz", min: 1, max: 40, step: 0.1, value: 10, tip: "Source frequency (CW) or Ricker peak frequency. lambda0 = c0 / f" },
      { id: "srcType", label: "waveform", unit: "", type: "select", options: [["CW", 0], ["Ricker", 1]], value: 0, tip: "CW with a 3-period raised-cosine ramp, or a Ricker wavelet" },
      { id: "pml", label: "CPML", unit: "cells", min: 0, max: 30, step: 1, value: 12, reinit: true, tip: "CPML thickness (PEC-backed). 0 = PEC box" },
      { id: "spf", label: "steps/frame", unit: "", min: 1, max: 40, step: 1, value: 4, tip: "Time steps per displayed frame (S = c0 dt / dx = 0.5)" },
    ],
    tools: [["source", "point src", "Click: soft point source"], ["line", "line src", "Drag: line source"], ["pec", "PEC", "Perfect electric conductor"], ["dielectric", "dielectric", "Lossless dielectric, eps_r = value"], ["erase", "erase", "Back to vacuum"]],
    value: { label: "eps_r", min: 1, max: 12, step: 0.1, value: 4, tip: "Relative permittivity for the dielectric tool" },
    presets: [
      ["point source", { scene: 0 }, "Point source in free space"],
      ["double slit", { scene: 1 }, "Plane wave through two 36 mm slits, 90 mm apart, in a PEC screen (1.2 and 3 lambda0 at 10 GHz)"],
      ["dielectric lens", { scene: 2 }, "Point source behind a dielectric disc (eps_r 4)"],
      ["parallel plate", { scene: 3 }, "Line source between two PEC plates"],
    ],
    async make(device, P, scene = 0) {
      const k = new FdtdTMz();
      const base = { freq: P.freq * 1e9, srcType: P.srcType, pml: P.pml };
      const { nx, ny } = FDTD_GRID;
      if (scene === 1) {
        await k.init(device, { ...base, srcX: 60, srcLine: 1 }, FDTD_GRID);
        // two 36-cell openings (1.2 lambda0 at 10 GHz, dx 1 mm), centres 90 cells (3 lambda0) apart (audit M1)
        const x = 220;
        const w = 6;
        const c = ny / 2;
        k.paint({ tool: "pec", shape: "rect", x0: x, y0: 0, x1: x + w, y1: c - 64 });
        k.paint({ tool: "pec", shape: "rect", x0: x, y0: c - 26, x1: x + w, y1: c + 26 });
        k.paint({ tool: "pec", shape: "rect", x0: x, y0: c + 64, x1: x + w, y1: ny });
      } else if (scene === 2) {
        await k.init(device, { ...base, srcX: 140, srcY: ny / 2 }, FDTD_GRID);
        k.paint({ tool: "dielectric", shape: "disc", x0: 230, y0: ny / 2, r: 55, value: 4 });
      } else if (scene === 3) {
        await k.init(device, base, FDTD_GRID);
        k.paint({ tool: "pec", shape: "rect", x0: 60, y0: ny / 2 - 45, x1: nx - 120, y1: ny / 2 - 41 });
        k.paint({ tool: "pec", shape: "rect", x0: 60, y0: ny / 2 + 41, x1: nx - 120, y1: ny / 2 + 45 });
        k.paint({ tool: "source", shape: "line", x0: 80, y0: ny / 2 - 40, x1: 80, y1: ny / 2 + 40, r: 0, value: 1 });
      } else {
        await k.init(device, { ...base, srcX: 200, srcY: ny / 2 }, FDTD_GRID);
      }
      return k;
    },
    live(k, P) { k.setParams({ freq: P.freq * 1e9, srcType: P.srcType }); },
    phys(k, i, j) { return [i * k.grid.dx * 1e3, j * k.grid.dx * 1e3, "mm"]; },
    dt(k) { return k.dt; },
    info(k) {
      const lam = C0 / k.p.freq;
      return `lambda0 ${fmt(lam * 1e3)} mm = ${fmt(lam / k.grid.dx)} cells  dx ${fmt(k.grid.dx * 1e3)} mm  dt ${fmt(k.dt)} s  S ${k.p.S}  t ${fmt(k.steps * k.dt * 1e9)} ns`;
    },
  },
  gs: {
    title: "Gray-Scott",
    style: "none",
    view: "v",
    autoRange: false,
    params: [
      { id: "f", label: "f", unit: "", min: 0.005, max: 0.1, step: 0.0005, value: 0.03, tip: "Feed rate" },
      { id: "k", label: "k", unit: "", min: 0.03, max: 0.075, step: 0.0005, value: 0.062, tip: "Kill rate" },
      { id: "spf", label: "steps/frame", unit: "", min: 1, max: 200, step: 1, value: 40, tip: "Time steps (dt = 1) per displayed frame" },
    ],
    tools: [["seed", "seed", "u = 0.5, v = 0.25"], ["erase", "erase", "u = 1, v = 0"]],
    value: null,
    presets: Object.entries(WELL_FK).map(([name, [f, k]]) => [name, { f, k }, `The Well set: f ${f}, k ${k}`]),
    async make(device, P) {
      const k = new GrayScott();
      await k.init(device, { f: P.f, k: P.k, ic: 0, blobs: 480, sigma: 0.04, seed: 7 }, { nx: GS_N, ny: GS_N, dx: GS_DX });
      return k;
    },
    live(k, P) { k.setParams({ f: P.f, k: P.k }); },
    phys(k, i, j) { return [i * k.grid.dx, j * k.grid.dx, k.grid.lengthUnit === "model" ? "model units" : "m"]; },
    dt(k) { return k.p.dt; },
    info(k) {
      const dn = (Math.max(k.p.Du, k.p.Dv) * k.p.dt) / (k.grid.dx * k.grid.dx);
      return `Du ${k.p.Du}  Dv ${k.p.Dv}  dt ${k.p.dt}  dx ${fmt(k.grid.dx)}  D dt/dx^2 ${fmt(dn)}  t ${k.steps}`;
    },
  },
};

// ------------------------------------------------------------------ state

const S = {
  kind: DEFS[qs.get("k")] ? qs.get("k") : "lbm",
  P: {},
  k: null,
  device: null,
  renderer: null,
  running: false,
  tool: null,
  dirty: true,
  frame: 0,
  stepsWin: 0,
  framesWin: 0,
  tWin: performance.now(),
  stats: { fps: 0, sps: 0 },
  busy: false,
  scene: 0,
};

function paramsFor(kind, fromUrl) {
  const P = {};
  for (const d of DEFS[kind].params) {
    const q = fromUrl ? qs.get("p." + d.id) : null;
    P[d.id] = q !== null && Number.isFinite(Number(q)) ? Number(q) : d.value;
  }
  return P;
}

// ------------------------------------------------------------------ UI builders

function buildParams() {
  const host = $("params");
  host.innerHTML = "";
  for (const d of DEFS[S.kind].params) {
    const row = document.createElement("div");
    row.className = "row";
    const lab = document.createElement("label");
    lab.textContent = d.label + (d.unit ? ` [${d.unit}]` : "");
    lab.title = d.tip;
    row.appendChild(lab);
    if (d.type === "select") {
      const sel = document.createElement("select");
      sel.title = d.tip;
      sel.style.gridColumn = "2 / 4";
      for (const [t, v] of d.options) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = t;
        sel.appendChild(o);
      }
      sel.value = String(S.P[d.id]);
      sel.onchange = () => setParam(d, Number(sel.value));
      row.appendChild(sel);
    } else {
      const r = document.createElement("input");
      r.type = "range";
      Object.assign(r, { min: d.min, max: d.max, step: d.step, value: S.P[d.id], title: d.tip });
      const n = document.createElement("input");
      n.type = "number";
      Object.assign(n, { min: d.min, max: d.max, step: d.step, value: S.P[d.id], title: d.tip });
      r.oninput = () => { n.value = r.value; setParam(d, Number(r.value), true); };
      r.onchange = () => setParam(d, Number(r.value));
      n.onchange = () => { r.value = n.value; setParam(d, Number(n.value)); };
      row.appendChild(r);
      row.appendChild(n);
    }
    host.appendChild(row);
  }
}

function buildTools() {
  const def = DEFS[S.kind];
  const host = $("tools");
  host.innerHTML = "";
  S.tool = def.tools[0][0];
  for (const [id, label, tip] of def.tools) {
    const b = document.createElement("button");
    b.className = "btn tool" + (id === S.tool ? " on" : "");
    b.textContent = label;
    b.title = tip;
    b.onclick = () => {
      S.tool = id;
      for (const x of host.children) x.classList.toggle("on", x === b);
    };
    host.appendChild(b);
  }
  const v = def.value;
  $("valrow").style.display = v ? "" : "none";
  if (v) {
    $("vallab").textContent = v.label;
    $("vallab").title = v.tip;
    for (const el of [$("val"), $("valn")]) Object.assign(el, { min: v.min, max: v.max, step: v.step, value: v.value });
  }
  const host2 = $("presets");
  host2.innerHTML = "";
  for (const [name, pp, tip] of def.presets) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = name;
    b.title = tip;
    b.onclick = async () => {
      if ("scene" in pp) S.scene = pp.scene;
      else Object.assign(S.P, pp);
      buildParams();
      await rebuild();
    };
    host2.appendChild(b);
  }
}

function buildViews() {
  const sel = $("view");
  sel.innerHTML = "";
  for (const v of S.k.views()) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = `${v.label} [${v.unit}]`;
    sel.appendChild(o);
  }
  sel.value = DEFS[S.kind].view;
  applyView(true);
}

function applyView(resetRange) {
  const id = $("view").value;
  S.k.setView(id);
  const spec = S.k.views().find((v) => v.id === id);
  S.renderer.setColormap(spec.map);
  S.map = spec.map;
  if (resetRange) {
    const v = S.k.view();
    setRange(v.range[0], v.range[1]);
  }
  drawColorbar();
  S.dirty = true;
}

function setRange(lo, hi) {
  S.renderer.lo = lo;
  S.renderer.hi = hi;
  $("lo").value = fmt(lo);
  $("hi").value = fmt(hi);
  drawColorbar();
  S.dirty = true;
}

const isPhone = () => window.matchMedia("(max-width: 699px)").matches;

function drawColorbar() {
  const c = $("cbc");
  const horiz = isPhone();
  if (c.width !== (horiz ? 256 : 1)) {
    c.width = horiz ? 256 : 1;
    c.height = horiz ? 1 : 256;
  }
  const ctx = c.getContext("2d");
  for (let k = 0; k < 256; k++) {
    ctx.fillStyle = colormapCSS(S.map ?? "viridis", horiz ? k / 255 : 1 - k / 255);
    if (horiz) ctx.fillRect(k, 0, 1, 1);
    else ctx.fillRect(0, k, 1, 1);
  }
  const lo = S.renderer.lo;
  const hi = S.renderer.hi;
  const pct = (f) => (f > 0 ? `<span class="clip" title="fraction of cells beyond this limit (drawn clipped)">${f >= 0.001 ? (100 * f).toFixed(1) : "<0.1"}% clip</span>` : "");
  $("cbhi").innerHTML = esc(fmt(hi)) + pct(S.clipHi ?? 0);
  $("cbmid").textContent = fmt(0.5 * (lo + hi));
  $("cblo").innerHTML = esc(fmt(lo)) + pct(S.clipLo ?? 0);
  const spec = S.k.views().find((v) => v.id === $("view").value);
  $("cbu").textContent = spec ? `[${spec.unit}]` : "";
}

function layout() {
  const main = $("main");
  const cv = $("cv");
  const { nx, ny } = S.k.grid;
  // one scale for both axes: the canvas keeps the physical nx:ny aspect exactly (audit S3)
  let s;
  if (isPhone()) {
    s = (document.documentElement.clientWidth - 32) / nx;
  } else {
    s = Math.min((main.clientWidth - 144) / nx, (main.clientHeight - 44) / ny);
  }
  s = Math.max(s, 1e-3);
  const cw = Math.max(1, Math.round(nx * s));
  const ch = Math.max(1, Math.round(ny * s));
  cv.style.width = cw + "px";
  cv.style.height = ch + "px";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  $("cbar").style.height = isPhone() ? "" : ch + "px";
  $("cbar").style.width = isPhone() ? cw + "px" : "";
  drawColorbar();
  S.dirty = true;
}

function updateUrl() {
  const u = new URLSearchParams();
  u.set("k", S.kind);
  for (const [k, v] of Object.entries(S.P)) u.set("p." + k, String(v));
  if (S.scene) u.set("scene", String(S.scene));
  history.replaceState(null, "", "?" + u.toString());
}

// ------------------------------------------------------------------ kernel lifecycle

async function rebuild() {
  const def = DEFS[S.kind];
  S.k?.dispose();
  S.k = null;
  S.k = await def.make(S.device, S.P, S.scene);
  S.viewBuf = S.k.view().buffer;
  window.__rtGrid = { nx: S.k.grid.nx, ny: S.k.grid.ny };
  S.renderer.bind(S.viewBuf, S.k.overlay(), S.k.grid.nx, S.k.grid.ny, def.style);
  $("auto").checked = def.autoRange;
  buildViews();
  layout();
  $("err").textContent = "";
  updateUrl();
}

async function setKind(kind) {
  S.kind = kind;
  S.scene = 0;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.k === kind);
  S.P = paramsFor(kind, false);
  buildParams();
  buildTools();
  await rebuild();
}

let reinitTimer = 0;
function setParam(d, v, dragging = false) {
  S.P[d.id] = v;
  if (d.id === "spf") return updateUrl();
  if (d.reinit) {
    if (dragging) return;
    clearTimeout(reinitTimer);
    reinitTimer = setTimeout(() => rebuild(), 50);
    return;
  }
  try {
    DEFS[S.kind].live(S.k, S.P);
    $("err").textContent = "";
  } catch (e) {
    $("err").textContent = e.message;
  }
  updateUrl();
  S.dirty = true;
}

// ------------------------------------------------------------------ canvas interaction

function cellAt(ev) {
  const r = $("cv").getBoundingClientRect();
  const { nx, ny } = S.k.grid;
  const i = ((ev.clientX - r.left) / r.width) * nx - 0.5;
  const j = (1 - (ev.clientY - r.top) / r.height) * ny - 0.5;
  return [i, j];
}

let drag = null;
function paintAt(i0, j0, i1, j1) {
  const r = Number($("brushn").value);
  const value = Number($("valn").value);
  const tool = S.tool;
  if (S.kind === "fdtd" && (tool === "source" || tool === "line")) return;
  const t = S.kind === "lbm" ? (tool === "erase" ? "erase" : "obstacle") : tool;
  S.k.paint({ tool: t, shape: "line", x0: i0, y0: j0, x1: i1, y1: j1, r, value });
  S.dirty = true;
}

function hideHint() {
  $("hint").style.display = "none";
}

function bindCanvas() {
  const cv = $("cv");
  cv.addEventListener("pointerdown", (ev) => {
    cv.setPointerCapture(ev.pointerId);
    const [i, j] = cellAt(ev);
    drag = { i, j, i0: i, j0: j };
    if (S.kind === "fdtd" && S.tool === "source") {
      S.k.paint({ tool: "source", shape: "disc", x0: Math.round(i), y0: Math.round(j), r: 0, value: 1 });
      S.dirty = true;
    } else paintAt(i, j, i, j);
    hideHint();
  });
  cv.addEventListener("pointermove", (ev) => {
    hover(ev);
    if (!drag) return;
    const [i, j] = cellAt(ev);
    paintAt(drag.i, drag.j, i, j);
    drag.i = i;
    drag.j = j;
  });
  const end = (ev) => {
    if (drag && S.kind === "fdtd" && S.tool === "line") {
      const [i, j] = cellAt(ev);
      S.k.paint({ tool: "source", shape: "line", x0: drag.i0, y0: drag.j0, x1: i, y1: j, r: 0, value: 1 });
      S.dirty = true;
    }
    drag = null;
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", () => ($("tip").style.display = "none"));
}

// hover readout: one cell copied from the view buffer, throttled
let hoverBusy = false;
let hoverBuf = null;
let lastHover = 0;
function hover(ev) {
  const tip = $("tip");
  const now = performance.now();
  if (hoverBusy || now - lastHover < 80) return;
  lastHover = now;
  const [fi, fj] = cellAt(ev);
  const i = Math.round(fi);
  const j = Math.round(fj);
  const { nx, ny } = S.k.grid;
  if (i < 0 || j < 0 || i >= nx || j >= ny) return;
  hoverBusy = true;
  hoverBuf ??= S.device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = S.device.createCommandEncoder();
  enc.copyBufferToBuffer(S.viewBuf, (j * nx + i) * 4, hoverBuf, 0, 4);
  S.device.queue.submit([enc.finish()]);
  const [x, y, u] = DEFS[S.kind].phys(S.k, i, j);
  hoverBuf.mapAsync(GPUMapMode.READ).then(() => {
    const v = new Float32Array(hoverBuf.getMappedRange())[0];
    hoverBuf.unmap();
    const spec = S.k.views().find((s) => s.id === $("view").value);
    tip.textContent = `${spec.label} ${fmt(v)} ${spec.unit}\nx ${fmt(x)} y ${fmt(y)} ${u}\ncell ${i}, ${j}`;
    tip.style.left = ev.clientX + 14 + "px";
    tip.style.top = ev.clientY + 12 + "px";
    tip.style.display = "block";
    hoverBusy = false;
  }, () => { hoverBusy = false; });
}

// ------------------------------------------------------------------ main loop

async function healthAndRange() {
  if (S.busy) return;
  S.busy = true;
  try {
    const k = S.k;
    const v = await k.readback("view");
    if (k !== S.k) return;
    let bad = false;
    const stride = Math.max(1, Math.floor(v.length / 20000));
    const sample = [];
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) { bad = true; break; }
      if (i % stride === 0) sample.push(Math.abs(v[i]));
    }
    sample.sort((a, b) => a - b);
    let over = 0;
    let under = 0;
    const lo0 = S.renderer.lo;
    const hi0 = S.renderer.hi;
    if (!bad) for (let i = 0; i < v.length; i++) { if (v[i] > hi0) over++; else if (v[i] < lo0) under++; }
    S.clipHi = over / v.length;
    S.clipLo = under / v.length;
    const m = sample.length ? sample[Math.floor(0.99 * (sample.length - 1))] : 0;
    if (bad) {
      S.running = false;
      $("run").textContent = "Run";
      $("err").textContent = "diverged (non-finite values). Lower Re or u_max, or raise D; then Reset.";
      return;
    }
    if ($("auto").checked && m > 0) {
      if (S.map === "balance") setRange(-m, m);
      else setRange(0, m);
    } else drawColorbar();
  } catch (e) {
    $("err").textContent = String(e && e.message ? e.message : e);
    S.running = false;
    $("run").textContent = "Run";
  } finally {
    S.busy = false;
  }
}

let readyAt = Number(qs.get("frames") ?? 0);
function frame() {
  const now = performance.now();
  if (S.k) {
    if (S.running && (S.inflight ?? 0) < 2) {
      // GPU back-pressure (audit M10): at most two step batches in flight (keeps the GPU fed, bounds the queue);
      // steps/s counts completed steps
      const n = Math.max(1, Math.round(S.P.spf ?? 1));
      const k = S.k;
      try {
        k.step(n);
      } catch (e) {
        S.running = false;
        $("run").textContent = "Run";
        $("err").textContent = String(e && e.message ? e.message : e);
      }
      S.inflight = (S.inflight ?? 0) + 1;
      S.device.queue.onSubmittedWorkDone().then(() => {
        S.inflight -= 1;
        if (k === S.k) S.stepsWin += n;
      });
      S.dirty = true;
      if (S.frame % 15 === 0) healthAndRange();
    }
    if (S.dirty) {
      S.k.view();
      S.renderer.draw();
      S.dirty = false;
      S.framesWin++;
    }
    S.frame++;
    if (readyAt > 0 && S.k.info().steps >= readyAt * Math.max(1, Math.round(S.P.spf ?? 1))) {
      readyAt = 0;
      S.running = false;
      $("run").textContent = "Run";
      healthAndRange().then(() => S.device.queue.onSubmittedWorkDone()).then(() => {
        S.k.view();
        S.renderer.draw();
        return S.device.queue.onSubmittedWorkDone();
      }).then(() => { window.__rtReady = true; });
    }
  }
  if (now - S.tWin > 500) {
    const dt = (now - S.tWin) / 1000;
    S.stats.fps = S.framesWin / dt;
    S.stats.sps = S.stepsWin / dt;
    S.tWin = now;
    S.framesWin = 0;
    S.stepsWin = 0;
    status();
  }
  requestAnimationFrame(frame);
}

function status() {
  if (!S.k) return;
  const inf = S.k.info();
  const mlups = (S.stats.sps * inf.cellsPerStep) / 1e6;
  $("status").innerHTML =
    `<span class="badge" title="Real-time tier (DevLog-001 A9): explicit f32 GPU kernel; see DevLog-005 for its eval gates">fidelity: realtime</span>` +
    `<span title="frames per second (render on demand)">fps <b>${S.stats.fps.toFixed(0)}</b></span>` +
    `<span title="time steps per second (encoded)">steps/s <b>${fmt(S.stats.sps)}</b></span>` +
    `<span title="million cell updates per second">MLUPS <b>${fmt(mlups)}</b></span>` +
    `<span title="grid">${S.k.grid.nx} x ${S.k.grid.ny}</span>` +
    `<span title="GPU buffers allocated by this kernel">GPU <b>${(inf.gpuBytes / 2 ** 20).toFixed(1)}</b> MiB</span>` +
    `<span title="steps taken">n <b>${inf.steps}</b></span>`;
  $("info").textContent = DEFS[S.kind].info(S.k);
}

// ------------------------------------------------------------------ platform probe

const LIMIT_LABEL = {
  maxBufferSize: "maxBuffer", maxStorageBufferBindingSize: "maxStorageBind", maxStorageBuffersPerShaderStage: "storageBuf/stage",
  maxComputeWorkgroupSizeX: "wgSizeX", maxComputeInvocationsPerWorkgroup: "invoc/wg", maxComputeWorkgroupsPerDimension: "wg/dim",
  maxTextureDimension2D: "tex2D", minUniformBufferOffsetAlignment: "uniformAlign",
};
const bytes = (v) => (v >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(2)} GiB` : v >= 2 ** 20 ? `${(v / 2 ** 20).toFixed(0)} MiB` : String(v));

function showProbe(p) {
  const rows = [
    ["webgpu", p.webgpu ? "yes" : "no", "navigator.gpu adapter available"],
    ["adapter", p.adapter ? [p.adapter.vendor, p.adapter.architecture, p.adapter.device].filter((x) => x).join(" ") || "(not exposed)" : "-", "GPUAdapterInfo vendor / architecture / device"],
    ["driver", p.adapter?.description || "(not exposed)", "GPUAdapterInfo.description"],
    ["COI", String(p.crossOriginIsolated), "crossOriginIsolated (COOP/COEP): SharedArrayBuffer and threads"],
    ["cores", String(p.cores ?? "-"), "navigator.hardwareConcurrency"],
  ];
  for (const [k, v] of Object.entries(p.limits ?? {})) rows.push([LIMIT_LABEL[k] ?? k, /Size$/.test(k) && v > 65536 ? bytes(v) : String(v), k]);
  rows.push(["features", String((p.features ?? []).length), (p.features ?? []).join(", ")]);
  rows.push(["UA", p.ua ?? "-", "navigator.userAgent"]);
  if (p.error) rows.push(["error", p.error, ""]);
  $("probe").innerHTML = rows.map(([a, b, t]) => `<span class="k" title="${esc(t)}">${esc(a)}</span><span class="v" title="${esc(t)}">${esc(b)}</span>`).join("");
}

// ------------------------------------------------------------------ boot

async function main() {
  const { probe, adapter } = await probePlatform(navigator.gpu);
  window.__rtProbe = probe;
  showProbe(probe);
  if (!adapter) {
    $("hint").textContent = "WebGPU is not available here: " + (probe.error ?? "unknown");
    window.__rtReady = true;
    return;
  }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  device.lost.then((i) => { $("err").textContent = "GPU device lost: " + i.message; });
  device.addEventListener("uncapturederror", (e) => { $("err").textContent = "WebGPU: " + e.error.message; });
  S.device = device;
  S.renderer = new FieldRenderer(device, $("cv"));

  if (qs.get("bench") === "1") {
    $("hint").textContent = "benchmark running...";
    const rows = await benchAll(device, Number(qs.get("sec") ?? 1));
    window.__rtBench = rows;
    $("hint").textContent = "benchmark done";
    window.__rtReady = true;
    return;
  }
  if (qs.get("gates") === "1") {
    $("hint").textContent = "gates running...";
    const out = {};
    out.lbmGpuVsCpu = await gates.lbmGpuVsCpu(device);
    out.fdtdGpuVsCpu = await gates.fdtdGpuVsCpu(device);
    out.gsGpuVsCpu = await gates.gsGpuVsCpu(device);
    out.dispersion = await gates.dispersion(device);
    out.cpml10 = await gates.cpmlReflection(device, 10);
    out.cavity = await gates.cavity(device, [16, 32]);
    out.strouhal20 = await gates.strouhal(device, 20);
    out.pattern = await gates.gsPattern(device);
    window.__rtGates = out;
    $("hint").textContent = "gates done";
    window.__rtReady = true;
    return;
  }

  for (const b of document.querySelectorAll(".tab")) b.onclick = () => setKind(b.dataset.k);
  $("run").onclick = () => {
    S.running = !S.running;
    $("run").textContent = S.running ? "Pause" : "Run";
    hideHint();
  };
  $("stepb").onclick = () => {
    S.k.step(Math.max(1, Math.round(S.P.spf ?? 1)));
    S.dirty = true;
  };
  $("reset").onclick = () => rebuild();
  $("share").onclick = async () => {
    updateUrl();
    try { await navigator.clipboard.writeText(location.href); $("err").textContent = ""; $("info").textContent = "link copied"; } catch { $("info").textContent = location.href; }
  };
  $("view").onchange = () => applyView(true);
  $("smooth").onchange = () => { S.renderer.smooth = $("smooth").checked; S.dirty = true; };
  $("lo").onchange = () => setRange(Number($("lo").value), S.renderer.hi);
  $("hi").onchange = () => setRange(S.renderer.lo, Number($("hi").value));
  const sync = (a, b) => { a.oninput = () => (b.value = a.value); };
  sync($("brush"), $("brushn"));
  sync($("brushn"), $("brush"));
  sync($("val"), $("valn"));
  sync($("valn"), $("val"));
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); $("run").click(); }
  });
  window.addEventListener("resize", () => { if (S.k) layout(); });
  bindCanvas();

  S.P = paramsFor(S.kind, true);
  S.scene = Number(qs.get("scene") ?? 0) || 0;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.k === S.kind);
  buildParams();
  buildTools();
  await rebuild();
  if (qs.get("autoplay") === "1") {
    S.running = true;
    $("run").textContent = "Pause";
    hideHint();
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  $("err").textContent = String(e && e.message ? e.message : e);
  window.__rtError = String(e && e.message ? e.message : e);
  window.__rtReady = true;
});
