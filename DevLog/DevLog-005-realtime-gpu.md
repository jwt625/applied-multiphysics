# DevLog-005: Real-time GPU tier (`@amp/rt`, lane L6)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Status | Done for wave 1: three kernels, CPU references, gates passing, demo page verified in headless Chrome; open items in section 9 |
| Lane | L6 (wave 1) |
| Owns | `packages/rt/**`, this file |
| Plan refs | DevLog-001 A9 (two-tier engine), heroes H9 / H12 / H13, performance targets, section 6 guidelines; CONTRACTS-v0 C1, C5, C9; R4 s.1, 4, 5, 6; R5 s.2; R3 FL-04, TR-03 |
| Author | Claude (Opus 5.5), lane L6 |

## 1. Scope

Three explicit WebGPU (WGSL) kernels behind the C9 `RealtimeKernel` interface. Each has a CPU reference implementation that runs in Node on small grids. The lane also delivers a no-bundler demo page, eval gates with numbers, and a performance table.

| Kernel | Hero | Method | Gates |
|---|---|---|---|
| `lbm-d2q9` | H9 (real-time tier) | D2Q9, TRT collision, pull streaming, halfway bounce-back, Zou-He velocity inlet, non-equilibrium-extrapolation outlet at rho = 1, Guo forcing, momentum-exchange force | Poiseuille L2 + convergence; St at Re 100 in DFG 2D-2 vs 0.295-0.305; GPU vs CPU |
| `fdtd-tmz` | H13 | 2D Yee TMz (Ez, Hx, Hy); CPML (Roden-Gedney); PEC mask; eps_r map; point and line soft sources; PEC, CPML or periodic per axis | Yee dispersion relation; CPML normal-incidence reflection < -40 dB; PEC square cavity TM11 vs analytic; GPU vs CPU |
| `gray-scott` | H12 | Explicit Euler, 5-point Laplacian, periodic | GPU vs CPU after N steps to f32 tolerance; pattern class for 2 (f, k) sets of The Well |

## 2. Design decisions

| # | Decision | Reason |
|---|---|---|
| L6-1 | **TRT, not BGK**, with magic parameter Lambda = 3/16. BGK is kept as an option (`collision: 0`) for comparison | With halfway bounce-back, TRT at Lambda = 3/16 places the wall exactly midway for Poiseuille flow, independent of viscosity (Ginzburg and d'Humieres). The BGK wall location drifts with tau. Measured: TRT is exact to 1e-13 in f64, while BGK shows a second-order error (gate 1). TRT is also more robust near tau = 0.5, which a Re slider reaches (tau 0.52 at D = 10 runs stably). Cost: one extra relaxation term per population |
| L6-2 | Populations stored as deviations `g_i = f_i - w_i` (rho0 = 1), in f32 | Reduces f32 round-off in the density sum (standard practice for single-precision LBM). WGSL has no f64 (R4 s.1.2) |
| L6-3 | Fused pull-stream-collide, two ping-pong storage buffers, WGSL generated with the 9 directions unrolled | One dispatch per step; no atomics; no dynamic indexing of constant arrays in the hot loop |
| L6-3b | **Outlet: non-equilibrium extrapolation at rho = 1** (unknowns 3, 6, 7 = equilibrium(1, u_s) + non-equilibrium part of the source cell). Replaces the two outlets tried first | Measured 2026-11-06. (a) Zero-gradient outlet: mean density drifted +6.9 % over 36k steps (mass gain), and c_D was inflated. (b) Zou-He pressure outlet: diverged at D = 10 and raised c_D. (c) This outlet: outlet rho = 1.0000, mean rho stable within 0.2 %, all D stable |
| L6-4 | FDTD in normalized units: H' = eta0 H, Courant number S = c0 dt / dx (default 0.5) as a parameter; SI in the UI (dx in m, f in Hz, t in s) | Identical update coefficients on CPU and GPU; SI via dx and c0 (an SI-defined constant) |
| L6-5 | CPML with full-size psi arrays and 1D b/c/kappa arrays per axis; polynomial grading m = 3; sigma_max = 0.8 (m + 1) / (eta0 dx); kappa_max and alpha_max are parameters (defaults 1 and 0) | Branch-free GPU indexing; formulas from Roden and Gedney 2000 / Taflove-Hagness ch. 7 |
| L6-6 | Gray-Scott in The Well form and units (dt 1, Du 2e-5, Dv 1e-5, dx = 2 / 128); explicit Euler, 5-point Laplacian | Diffusion number Du dt / dx^2 = 0.0819 < 0.25, so dt 1 is stable. The Well's generator is spectral ETDRK4, so a pointwise match to its stored fields is not expected; the gate is pattern class |
| L6-7 | Sources are TS with erasable syntax; WGSL lives in string constants inside the TS modules. The demo imports a JS copy in `packages/rt/demo/lib/`, produced by Node's built-in `module.stripTypeScriptTypes`, with `.ts` imports rewritten to `.js`. There is no bundler and no dependency. `test/emit.test.ts` fails when the copy is stale | Browsers cannot import `.ts`; C1 requires TS for new code. Generated files carry a "do not edit" header |
| L6-8 | Node GPU path: Dawn `webgpu@0.6.2`, an exact pin and a devDependency of `packages/rt` only. Pipelines are created with `createComputePipeline` (synchronous) and errors come from error scopes | Dawn node 0.6.2 crashes in `createComputePipelineAsync()` and in `getCompilationInfo()` when a module has errors. If the GPU instance or adapter is garbage-collected, the process aborts ("mutex lock failed" / SIGSEGV). `node-gpu.ts` keeps them reachable. All three were found and worked around 2026-11-06 |
| L6-9 | C9 additions (optional members, allowed by the contracts preamble): `grid`, `views()`, `setView()`, `setParams()`, `paint()`, `overlay()`, `info()`; FDTD `setField()` | Interaction and gates need them; the C9 core is unchanged |
| L6-10 | Probe and force histories: `copyBufferToBuffer` of one cell (or the 2-float force) into a 65536-entry ring after each step, only when `probeX >= 0` | Per-step time series with no per-step readback; zero cost when off |
| L6-11 | Renderer: one full-screen triangle; the fragment shader reads the f32 view buffer with bilinear interpolation, a 256-entry LUT (viridis CC0, cmocean balance MIT), and a material overlay per cell | Smooth by default (toggle), perceptual maps, a colorbar in display units |

## 3. Gate definitions (fixed before running; never tuned to a target)

1. **LBM Poiseuille.**
   - Setup: body-force-driven periodic channel, halfway bounce-back walls, H = 8, 16, 32, 64 fluid cells, tau 0.8.
   - Metric: L2 relative error of u_x(y) vs the analytic parabola, with the wall midway between the last fluid node and the first solid node. Reported for BGK and TRT.
   - Second check (1b): a velocity-inlet / outlet channel (the BCs of the cylinder case); the profile at mid-length vs the parabola.
2. **LBM Strouhal.**
   - Geometry, DFG 2D-2 from the FEATFLOW page: [0, 2.2] x [0, 0.41], cylinder centre (0.2, 0.2), r = 0.05, parabolic inflow Um = 1.5, U_mean = 1, nu = 1e-3, Re = U_mean D / nu = 100, St = f D / U_mean.
   - Lattice: D = nD cells, H = 4.1 nD, L = 22 nD, u_max = 0.1 (Mach 0.173), t_end = 12 s.
   - Metric: St from the upward zero crossings of c_L over the last 10 periods (the FL-04 definition: "f from the lift signal"). c_D,max and c_L,max are taken over the same window.
   - Gate: St in [0.295, 0.305] (R3 FL-04).
3. **FDTD dispersion.**
   - Setup: fully periodic 80 x 80 domain, standing-wave eigen-initialisation Ez = cos(kx x + ky y), H = 0, 2000 steps.
   - Measurement: the temporal frequency from the exact recurrence x[n+1] + x[n-1] = 2 cos(w dt) x[n], fitted by least squares.
   - Compared with the analytic Yee relation sin^2(w dt / 2) = S^2 [sin^2(kx dx / 2) + sin^2(ky dx / 2)].
   - Coverage: angles 0, 26.6 and 45 deg; 5 to 57 points per wavelength.
   - Gate: |w_num - w_Yee| / w_Yee < 1e-4 (f32).
4. **FDTD CPML reflection.**
   - Setup: plane wave at normal incidence (periodic y, line source across y), Ricker wavelet peaking at 10 GHz (30 cells per wavelength at dx = 1 mm), S = 0.5, 3000 steps. The probe sits 10 cells in front of the x+ CPML.
   - Metric: R = max over t of |Ez_test - Ez_ref| / max over t of |Ez_ref|. The reference run is the same domain extended by 2000 cells, so no reflection returns within the window.
   - Gate: < -40 dB.
5. **FDTD cavity.**
   - Setup: PEC square cavity, side a = 0.1 m, N = 16, 32, 64 cells per side, Ricker excitation at an off-symmetry point, 150 TM11 periods of ringdown.
   - Measurement: peak of the Hann-windowed DFT, refined by golden-section search.
   - Compared with the analytic TM11 frequency f = c0 / (sqrt(2) a) and with the discrete Yee cavity frequency.
   - Gate: relative error < 1 % at N = 32 and decreasing as about N^-2.
6. **Gray-Scott GPU vs CPU.**
   - Setup: 64^2 grid, the same initial condition, N = 100 and 1000 steps.
   - Metric: max |diff| of u and v against the f64 CPU reference and against an f32 CPU reference that rounds every operation (Math.fround) in the WGSL operation order.
   - Gate: < 1e-4 vs f32 at N = 1000.
7. **Gray-Scott pattern class.**
   - The Well's six sets (README, verified 2026-11-06): Gliders (0.014, 0.054), Bubbles (0.098, 0.057), Maze (0.029, 0.057), Worms (0.058, 0.065), Spirals (0.018, 0.051), Spots (0.03, 0.062). Gated: Spots and Maze.
   - Setup: 128^2, dt 1, t = 10000. Initial condition: 30 random periodic Gaussian clusters (sigma 0.04, seed 1); this is mine, not the dataset's.
   - Classifier, fixed in advance:
     - foreground = v > (v_min + v_max) / 2; periodic 4-connected components;
     - per component, Q = 4 pi A / P^2, with P counted in exposed cell edges;
     - "spots" if there are at least 10 components and median Q >= 0.5;
     - "stripes/maze" if the largest component holds at least 50 % of the foreground, or median Q < 0.3;
     - otherwise "mixed".
   - Gate: Spots gives "spots" and Maze gives "stripes/maze".
8. **GPU vs CPU, LBM and FDTD** (supporting).
   - LBM: DFG nD = 10, 200 steps.
   - FDTD: 96 x 64 with CPML, a PEC block, a dielectric disc and a CW source, 300 steps.
   - Metric: max abs difference / max |field|.

## 4. TODO

- [x] Package skeleton (`package.json`, `tsconfig.json`, exact pins), Dawn `webgpu@0.6.2`, `playwright-core@1.65.0`
- [x] Common: C9 types shim, GPU helpers, colormap LUTs (viridis CC0, cmocean balance MIT; `NOTICE`)
- [x] LBM: CPU reference, WGSL kernel, gates 1, 1b, 2, 8
- [x] FDTD: CPU reference, WGSL kernel, gates 3, 4, 5, 8
- [x] Gray-Scott: CPU reference, WGSL kernel, gates 6, 7
- [x] Platform probe (`src/probe.ts`, shown in the demo)
- [x] Demo page (`demo/index.html`, `demo/app.js`, emitted `demo/lib/`)
- [x] Headless Chrome screenshots, one per kernel in `logs/`
- [x] Performance table (Node Dawn and headless Chrome)
- [x] `node --test` suite: 13 tests (CPU gates always; GPU tests skip without an adapter)
- [x] `tsc --noEmit` clean
- [ ] Open items: section 9

## 5. Progress log

- 2026-11-06 15:13 PST: Read CLAUDE.md, DevLog-001, CONTRACTS-v0, R4 s.1/4/5/6, R5 s.2, R3 FL-04/TR-03. Verified The Well gray_scott (f, k) sets and the DFG 2D-2 geometry on their primary pages (section 8). Plan written.
- 15:17: Package skeleton. Dawn adapter in Node: apple-m4-pro, metal-3. Colormap LUTs generated from BIDS/colormap (CC0) and cmocean (MIT); `NOTICE` added.
- 15:20: LBM CPU reference. Poiseuille: BGK L2 0.0111 / 0.00278 / 0.000695 at H 8 / 16 / 32 (order 2.00); TRT 2e-15 to 2e-13.
- 15:22-15:28: Dawn crashes isolated (L6-8): async pipeline creation, `getCompilationInfo` on errors, and GC of the GPU instance. Worked around.
- 15:29: LBM GPU vs CPU, DFG nD 10, 200 steps: max |diff| 8e-7 (u_x), relative 5.7e-6.
- 15:30-15:33: DFG 2D-2. St was in the band already, but c_D,max was 3.75 at D = 20.
  - Cause: the zero-gradient outlet lets mean rho drift +6.9 % in 36k steps.
  - A Zou-He pressure outlet diverged at D = 10.
  - The rho = 1 non-equilibrium-extrapolation outlet (L6-3b) fixed the drift (outlet rho 1.0000).
- 15:34: FDTD CPU reference: dispersion matches Yee to 1e-14. FDTD WGSL kernel: GPU vs CPU 2.0e-7 relative.
- 15:35: Gray-Scott kernel and CPU references; quick gate run passed (`logs/rt-gates-20261106T233514Z.json`).
- 15:36: Channel check 1b: the raw error equals the density change along the channel (weak compressibility, see 6.1). Added a shape metric.
- 15:37: Node bench (`logs/rt-bench-node-20261106T233730Z.json`).
- 15:38: Coordinator note handled:
  - tsconfig now adds `lib: ["ES2023", "DOM"]` and `types: ["node", "webgpu"]`;
  - my package-local install artifacts were removed (`packages/rt/pnpm-lock.yaml`, `packages/rt/node_modules/.pnpm`); the root install links the deps;
  - the webgpu install script was reviewed (section 7).
- 15:40-15:45: Renderer, probe, emit script, demo page, playwright harness.
  - Headless Chrome 156 exposes WebGPU (apple metal-3), and the page is cross-origin isolated under the harness's COOP/COEP headers.
  - First shots failed because `smooth` is a reserved WGSL word; renamed it. Fixed the colorbar labels, the probe panel layout, the PEC/CPML overlay colours, and switched auto-range to the 99th percentile of |value|.
- 15:47: Full gate run (`logs/rt-gates-20261106T234652Z.json`): all gates pass.
- 15:48: Chrome run with bench and in-browser gates (`logs/rt-chrome-20261106T234808Z.json`): all gates pass, with no console errors.
- 15:49: Final screenshots (`logs/rt-demo-{lbm,fdtd,gs}-20261106T234858Z.png`); superseded screenshots deleted. `tsc` clean; `pnpm test` 13/13 pass.

## 6. Results

Platform:
- Apple M4 Pro, macOS 15.5. Node 23.7.0 + `webgpu@0.6.2` (Dawn, Metal). Headless Chrome 156.0.8078.80 (WebGPU, Metal).
- Seven other lanes shared the machine during these runs, so the throughput numbers are lower bounds for an idle machine.
- Sources: `logs/rt-gates-20261106T234652Z.json` (Node) and `logs/rt-chrome-20261106T234808Z.json` (Chrome).

### 6.1 LBM

Gate 1, Poiseuille (periodic, body force, tau 0.8, L2 relative):

| H | BGK f64 | order | TRT f64 | BGK GPU f32 | TRT GPU f32 |
|---|---|---|---|---|---|
| 8 | 1.11e-2 | | 1.7e-15 | 1.11e-2 | 4.6e-7 |
| 16 | 2.78e-3 | 2.00 | 4.9e-15 | 2.81e-3 | 2.6e-5 |
| 32 | 6.95e-4 | 2.00 | 1.8e-13 | 7.32e-4 | 2.4e-5 |
| 64 | 1.74e-4 | 2.00 | 9.6e-14 | 1.76e-4 | 4.3e-5 |

- TRT (Lambda 3/16) is exact up to round-off. On the GPU its error is the f32 floor, about 3e-5, and does not converge with H. The body force shrinks as 1/H^2 (u_max fixed at 0.01), so per-step increments approach f32 resolution.
- BGK converges at second order with a tau-dependent constant.

Gate 1b, velocity inlet + rho = 1 outlet, profile at mid-length (TRT, tau 0.8, GPU unless noted):

| H | L / H | u_max | L2 raw | L2 shape | rho(mid) - rho(inlet) |
|---|---|---|---|---|---|
| 32 | 8 | 0.05 | 1.52e-2 | 3.1e-4 | -1.56e-2 |
| 32 | 8 | 0.02 | 6.03e-3 | 5.3e-5 | -6.08e-3 |
| 64 | 8 | 0.05 | 7.51e-3 | 3.0e-4 | -7.65e-3 |
| 16 (CPU f64) | 8 | 0.05 | 3.10e-2 | 3.2e-4 | -3.21e-2 |

- The raw error equals |delta rho| to within 4 % in every row (0.8-3.5 %). This is the weakly compressible LBM: mass flux rho u is conserved, so u rises as the pressure (density) falls along the channel.
- delta rho scales with the pressure drop, i.e. with u_max L / H^2.
- The profile shape matches the parabola to 3e-4. The inlet/outlet BCs are therefore not the error source.

Gate 2, DFG 2D-2, Re 100 (GPU, t_end 12 s):

| D [cells] | grid | u_max | Mach | tau | collision | St | St (previous 10 periods) | c_D,max | c_L,max | steps | wall [s] | pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 221 x 43 | 0.1 | 0.173 | 0.52 | TRT | 0.2991 | 0.2992 | 3.53 | 0.920 | 18000 | 0.44 | yes |
| 20 | 441 x 84 | 0.1 | 0.173 | 0.54 | TRT | 0.2988 | 0.2989 | 3.58 | 1.22 | 36000 | 1.65 | yes |
| 30 | 661 x 125 | 0.1 | 0.173 | 0.56 | TRT | 0.3018 | 0.3018 | 3.46 | 1.14 | 54000 | 2.00 | yes |
| 40 | 881 x 166 | 0.1 | 0.173 | 0.58 | TRT | 0.3022 | 0.3022 | 3.43 | 1.12 | 72000 | 3.70 | yes |
| 60 | 1321 x 248 | 0.1 | 0.173 | 0.62 | TRT | 0.3026 | 0.3025 | 3.41 | 1.11 | 108000 | 11.95 | yes |
| 40 | 881 x 166 | 0.05 | 0.087 | 0.54 | TRT | 0.3004 | 0.3001 | 3.37 | 1.06 | 144000 | 7.37 | yes |
| 40 | 881 x 166 | 0.1 | 0.173 | 0.58 | BGK | 0.3019 | 0.3019 | 3.44 | 1.12 | 72000 | 3.63 | yes |

References (FEATFLOW level 6): St 0.30188, c_D,max 3.2200, c_L,max 0.9859. FL-04 bounds: St 0.295-0.305, c_D,max 3.22-3.24, c_L,max 0.99-1.01.

- **St gate: passes at every resolution tested, from D = 10 cells (0.2991) upward.** The coarsest tested resolution already reaches the band. St is converged at the window level (the previous 10 periods agree to 3e-4).
- **The forces are not converged:**
  - c_D,max is 3.41 at D = 60 (+5.9 % vs 3.22); c_L,max is 1.11 (+12 % vs 0.9859).
  - Both drop as D rises and as Mach falls: at D = 40, c_D,max is 3.43 at u_max 0.1 and 3.37 at u_max 0.05.
  - [est] The likely causes are the staircase (node-masked) cylinder with simple bounce-back, plus the compressibility error at Mach 0.17. The fix is interpolated bounce-back (Bouzidi) and a lower Mach (open item O1).
  - The real-time tier would therefore **fail the FL-04 c_D,max and c_L,max bounds** today. Only St is gated.

Gate 8, LBM GPU vs CPU (DFG nD 10, 200 steps; 9503 cells): max |diff| / max |field| = 5.8e-6 (u_x), 1.5e-5 (u_y), 2.9e-6 (rho). Chrome gives identical numbers.

### 6.2 FDTD

Gate 3, dispersion (80 x 80 periodic, S 0.5, 2000 steps):
- CPU f64: |w - w_Yee| / w_Yee at most 2.7e-13 over all 11 modes.
- GPU f32: at most 3.4e-8 (Node and Chrome).
- The Yee dispersion itself, (w_Yee - c k) / (c k):

| angle | 40 ppw | 20 ppw | 10 ppw | 5 ppw |
|---|---|---|---|---|
| 0 deg | -7.7e-4 | -3.09e-3 | -1.24e-2 | -5.05e-2 |
| 45 deg | (56.6 ppw) -1.3e-4 | (18.9) -1.16e-3 | (9.4) -4.67e-3 | (5.1) -1.61e-2 |
| 26.6 deg | (35.8) -5.5e-4 | (17.9) -2.21e-3 | (8.9) -8.91e-3 | |

Gate 4, CPML normal-incidence reflection (Ricker at 10 GHz, 30 cells per wavelength at the peak):

| CPML cells | GPU | CPU |
|---|---|---|
| 5 | -64.8 dB | |
| 10 | -91.4 dB | -91.4 dB |
| 20 | -109.2 dB | |

Gate passes (< -40 dB) at every thickness. Chrome: -91.4 dB at 10 cells.

Gate 5, PEC square cavity TM11 (a = 0.1 m, analytic 2.11985 GHz):

| N | f_num [GHz] | error vs analytic | order | error vs discrete Yee |
|---|---|---|---|---|
| 16 | 2.118147 | -8.04e-4 | | 9.4e-8 |
| 32 | 2.119427 | -2.01e-4 | 2.00 | 8.2e-8 |
| 64 | 2.119747 | -5.01e-5 | 2.00 | 8.8e-8 |

GPU and CPU agree (N = 16, 32). Gate passes: 0.020 % at N = 32, second order.

Gate 8, FDTD GPU vs CPU (CPML, PEC block, eps_r 4 disc, CW source, 300 steps): max |diff| / max |Ez| = 2.0e-7.

### 6.3 Gray-Scott

Gate 6 (64^2, max |diff|):

| steps | u vs f64 | v vs f64 | u vs f32-rounded | v vs f32-rounded |
|---|---|---|---|---|
| 100 | 1.7e-6 | 1.3e-6 | 1.8e-6 | 1.4e-6 |
| 1000 | 2.0e-5 | 1.4e-5 | 1.0e-5 | 7.5e-6 |

- Gate passes (< 1e-4).
- The GPU is not bit-identical to the f32-rounded CPU reference. [est] The likely cause is fused multiply-add contraction in the Metal compiler.
- The difference grows about 10x over 10x more steps.

Gate 7, The Well grid (128^2, dt 1, t = 10000):

| set | f | k | backend | components | largest / foreground | median Q | class | pass |
|---|---|---|---|---|---|---|---|---|
| Spots | 0.03 | 0.062 | GPU | 228 | 0.006 | 0.737 | spots | yes |
| Maze | 0.029 | 0.057 | GPU | 2 | 0.985 | 0.207 | stripes/maze | yes |
| Spots | 0.03 | 0.062 | CPU f64 | 228 | 0.006 | 0.737 | spots | yes |
| Maze | 0.029 | 0.057 | CPU f64 | 2 | 0.985 | 0.207 | stripes/maze | yes |

Chrome: same classes.

### 6.4 Performance

`benchOne`: 64-step batches, wall clock fenced by `onSubmittedWorkDone`, at least 1.5 s per case. MLUPS = cells x steps/s / 1e6. Memory = bytes of the GPU buffers the kernel allocates (computed from buffer sizes, not measured RSS).

| kernel | grid | Node Dawn steps/s | Node MLUPS | Chrome steps/s | Chrome MLUPS | GPU MiB |
|---|---|---|---|---|---|---|
| LBM D2Q9 | 512 x 256 | 36873 | 4833 | 35613 | 4668 | 12.8 |
| LBM D2Q9 | 1024 x 512 | 5086 | 2666 | 5534 | 2901 | 48.8 |
| LBM D2Q9 | 2048 x 1024 | 1144 | 2400 | 1158 | 2429 | 192.8 |
| FDTD TMz | 512^2 | 20631 | 5408 | 20911 | 5482 | 12.3 |
| FDTD TMz | 1024^2 | 2992 | 3138 | 3104 | 3255 | 48.4 |
| FDTD TMz | 2048^2 | 697 | 2922 | 713 | 2993 | 192.4 |
| Gray-Scott | 256^2 | 227322 | 14898 | 231337 | 15161 | 1.5 |
| Gray-Scott | 1024^2 | 26315 | 27593 | 27032 | 28346 | 24.0 |
| Gray-Scott | 2048^2 | 3172 | 13303 | 3385 | 14196 | 96.0 |

Notes:
- [est] The small-grid figures (for example LBM 4.8 GLUPS at 512 x 256, 12.8 MiB) imply about 400 GB/s at 84 bytes/cell/step. That exceeds DRAM bandwidth, so the working set is presumably served from the on-chip cache. The large-grid figures (about 2.4 GLUPS, about 200 GB/s) are the bandwidth-bound numbers to plan with.
- Interactive demo, headless Chrome at 1600 x 900, 60 fps:
  - LBM 881 x 166: 200 steps/frame = 11.9k steps/s, 1.74 GLUPS.
  - FDTD 640 x 400: 4 steps/frame by default (the user sets it).
  - Gray-Scott 512^2: 100 steps/frame = 6000 steps/s.
- Against DevLog-001: drag-to-repaint is one frame (16.7 ms at 60 fps), well under the 100 ms target.

### 6.5 Demo page

- `packages/rt/demo/index.html` + `app.js`: plain ES modules, no framework, dark, sharp corners.
- Kernel tabs. Every parameter has a slider plus an exact field. Views (LBM speed / vorticity / u_x / u_y in SI; FDTD Ez, eta0 |H|, Ez^2; Gray-Scott v / u).
- Smooth toggle, range fields, auto-range at the 99th percentile.
- Draw tools:
  - LBM: obstacle, erase.
  - FDTD: point source, line source, PEC, dielectric with eps_r, erase.
  - Gray-Scott: seed, erase.
- Presets: DFG 2D-2, Re 20, Re 250, coarse D 20; FDTD point source, double slit, dielectric lens, parallel plate; the six The Well sets.
- Hover readout with physical coordinates and units; a colorbar with absolute limits and unit.
- Platform probe: adapter, driver, COI, cores, key limits, features, UA.
- Status line: fps, steps/s, MLUPS, grid, GPU MiB, the `fidelity: realtime` badge.
- Share link: URL holds the kernel and parameters. Painted geometry is not encoded.
- Calm start: paused until Run, Space or a draw action.
- URL flags for automation: `autoplay`, `frames`, `scene`, `bench=1`, `gates=1`.
- Screenshots (kept): `logs/rt-demo-lbm-20261106T234858Z.png` (vortex street, D 40), `logs/rt-demo-fdtd-20261106T234858Z.png` (double slit, 10 GHz), `logs/rt-demo-gs-20261106T234858Z.png` (Spots, t 9300).
- Harness: `scripts/shoot.ts`:
  - serves `demo/` from an in-process server on 127.0.0.1:47613 (checked free with `lsof` before each run; the server closes on exit; the port was confirmed free afterwards);
  - sends COOP/COEP headers;
  - drives the installed Google Chrome via playwright-core with `--enable-unsafe-webgpu`.

## 7. Contract requests

1. **C9 optional members** (L6-9): `grid`, `views(): ViewSpec[]`, `setView(id)`, `setParams(p)`, `paint(op: PaintOp)`, `overlay(): GPUBuffer` (u32 class per cell), `info(): {gpuBytes, cellsPerStep, steps}`. Please list them in C9 so L5 (Play views) can rely on them. Shapes are in `packages/rt/src/types.ts`.
2. **C9 grid units:** `dx` is metres for LBM and FDTD, and model units for Gray-Scott (The Well domain). Proposal: add an optional `lengthUnit` to the grid, so non-SI model kernels are explicit.
3. **C9 readback names** in use (for the L8 harness):
   - LBM: `g`, `rho`, `ux`, `uy`, `view`, `mask`, `probe`, `force`.
   - FDTD: `ez`, `hx`, `hy`, `view`, `probe`, `cls`.
   - Gray-Scott: `u`, `v`, `view`.
   - Probe and force histories are 65536-entry rings indexed by step % 65536.
4. **Eval harness hook:** `@amp/rt` exports `gates` (`src/gates.ts`) with device-agnostic functions that take a `GPUDevice` or `null` (CPU). L8 can wrap them as `amp-eval/0` runs. FL-04 (L7b) defines St "from the lift signal", the same as gate 2. TR-03 (L7c) can use `gsPattern` for the class gate.
5. **Dawn install script (coordinator note 2):**
   - `webgpu@0.6.2` `postinstall` runs `node build/postinstall.js`. On macOS it removes the `com.apple.quarantine` xattr from `dist/darwin-universal/dawn.node` if present; on other platforms it does nothing. It downloads nothing.
   - The root-installed `dawn.node` carries only `com.apple.provenance`, no quarantine, and Dawn works without the script (verified 2026-11-06). **No `approve-builds` needed;** none was run.
6. **Root devDependencies:** `pnpm check` for `@amp/rt` relies on the root `typescript@5.9.3` and `@types/node@24.19.2` (present); WebGPU types come from `webgpu` (which imports `@webgpu/types@0.1.74`).
7. **Known Dawn-node defects** (L6-8) matter to any lane using WebGPU in Node; L8 especially should use `src/node-gpu.ts` rather than calling `create()` directly.

## 8. References and credits

- The Well, gray_scott_reaction_diffusion README: https://github.com/PolymathicAI/the_well/blob/master/datasets/gray_scott_reaction_diffusion/README.md (accessed 2026-11-06).
- FEATFLOW DFG benchmark 2D-2 (Re 100) page: https://wwwold.mathematik.tu-dortmund.de/~featflow/en/benchmarks/cfdbenchmarking/flow/dfg_benchmark2_re100.html (accessed 2026-11-06). Level 6, k = 1/200: max c_D 3.2200, max c_L 0.9859, St 0.30188.
- Colormaps:
  - viridis from BIDS/colormap `option_d.py` (Smith and van der Walt, CC0);
  - balance from matplotlib/cmocean `balance-rgb.txt` (Thyng, MIT; licence text in `packages/rt/NOTICE`);
  - both downloaded 2026-11-06 and rounded to 8 bits.
- MIT references, consulted for algorithm structure only (R4 s.4); no code copied: LennartPaduch/WebLBM (D2Q9 on WebGPU), tomipiriyev/volna and vkopitsa/webantenna (WebGPU FDTD), ylfeid/wavefront (no-build WebGPU ES modules), robert-leitl/webgpu-reaction-diffusion. Unlicensed repos were not used.
- Algorithms:
  - Yee 1966; Roden and Gedney 2000 (CPML); Taflove and Hagness, Computational Electrodynamics, 3rd ed., ch. 4 (dispersion) and ch. 7 (CPML).
  - Ginzburg and d'Humieres (TRT, Lambda = 3/16); Zou and He 1997 (velocity BC); Guo, Zheng and Shi 2002 (forcing; non-equilibrium extrapolation); Ladd 1994 (momentum exchange).
  - Pearson 1993 (Gray-Scott patterns).
  - The references are cited from knowledge of the standard literature; their pages were not re-fetched in this lane.

## 9. Hand-off

State: all 8 gate groups pass in Node (Dawn) and in headless Chrome. `pnpm --filter @amp/rt check` is clean, and `pnpm --filter @amp/rt test` passes 13/13 in about 1.5 s.

How to run (from `packages/rt`):

```
pnpm test            # CPU gates + GPU gates (skip without adapter) + emit freshness
pnpm run gates       # full gate suite -> logs/rt-gates-<ts>.json (about 60 s)
pnpm run bench       # Node Dawn throughput -> logs/rt-bench-node-<ts>.json
pnpm run emit        # after editing src/: regenerate demo/lib
pnpm run shoot       # headless Chrome: screenshots + bench + gates -> logs/rt-chrome-<ts>.json, logs/rt-demo-*.png
```

Open items:

| # | Item | Why |
|---|---|---|
| O1 | Interpolated bounce-back (Bouzidi) for curved obstacles, plus a lower-Mach default for the DFG gate run | c_D,max is +5.9 % and c_L,max +12 % vs FEATFLOW at D = 60; FL-04 force bounds would fail |
| O2 | The CPML gate covers normal incidence only. Add an oblique / point-source reflection map and kappa/alpha tuning for evanescent waves | Antenna near fields |
| O3 | TR-03 VRMSE vs stored The Well frames | Needs the dataset frames from L7c's cache; the explicit Euler + 5-point scheme differs from ETDRK4 spectral, so expect drift (R3) |
| O4 | The share URL does not encode painted geometry | Needs a spec-level obstacle list (C3 / L2) |
| O5 | f16 storage for LBM populations (`shader-f16` is available on this adapter) | About 2x bandwidth; needs an accuracy gate first |
| O6 | Split-step BPM kernel (A9 lists it; R4 s.4) | Not in this lane's task |
| O7 | Browser support beyond Chrome on macOS (Safari 26+, Firefox 141+) not tested | Only headless Chrome 156 was available for automation |
| O8 | Fresh-context audit of this lane (DevLog-001 s.6 process) | Coordinator |
