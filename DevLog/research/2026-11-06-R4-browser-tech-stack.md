---
title: R4 - Browser tech stack update (platform, meshing, solvers, GPU demos, visualization, hybrid) as of 2026-11-06
date: 2026-11-06
status: research report (read-only; nothing built, no benchmarks run)
parent: DevLog/DevLog-000-scoping.md
updates: advanced-packaging-atlas DevLog/research/2026-10-20-sim-browser-solver-stack.md (R2) and 2026-10-20-sim-ui-ux-visualization.md (R7)
authors: Claude (research lane R4, five parallel read-only research subagents, synthesized here)
---

# R4: browser tech stack, update and extension (2026-11-06)

This report gives deltas against the 2026-10-20 R2/R7 reports; it does not repeat them. Every source was accessed
2026-11-06 (URLs are in Sources, keyed [Pn], [Mn], [Sn], [Gn], [Vn], [Hn]).

Labels: **[fact]** primary source (spec, repo/LICENSE, npm/PyPI/GitHub API, release notes, bug tracker); **[meas]**
measured by a subagent (tarball sizes, `gzip -9` of streamed `.wasm`/`.js`); **[est]** estimate/inference with stated
assumption; **[unv]** not confirmed. Coordinator spot-checks (npm registry): `@loumalouomega/gmsh-wasm` 0.4.0
(2026-10-19, GPL-2.0-or-later), `float-tetwild-wasm` 0.2.0 (MPL-2.0), `three` 0.187.0 (2026-10-30); Safari 27.0 notes page (2026-09-17).

Acronyms: COI cross-origin isolation; COOP/COEP Cross-Origin-Opener/-Embedder-Policy; CORP Cross-Origin-Resource-Policy;
SAB SharedArrayBuffer; JSPI JavaScript Promise Integration; LNA Local Network Access; BCD MDN browser-compat-data; CRD W3C
Candidate Recommendation Draft; TSL three.js Shading Language; OIT order-independent transparency; LBM lattice Boltzmann;
MLUPS million lattice-site updates/s; MPM material point method; SPH smoothed-particle hydrodynamics; FDTD finite-difference
time-domain; TDSE time-dependent Schrodinger equation; BPM beam propagation method; OCCT Open CASCADE Technology; CDT
constrained Delaunay triangulation; df64 double-single (two-f32) emulated precision.

## 0. Executive summary

1. **Platform: the posture is unchanged and confirmed.**
   - The solver stays dependency-free JS in workers, with WebGPU as a gated accelerator.
   - WGSL still has no f64; gpuweb #2805 is open at "Milestone 4+", and Dawn says work "hasn't started" [fact].
   - Corrections to R2:
     - Firefox WebGPU on macOS is Apple Silicon only.
     - Safari is now 27.x.
     - The iOS WebKit 269777 memory figure predates a 2024 Gigacage fix, so current iOS limits are [unv] and must be measured.
     - Memory64 is on by default in WebKit trunk but not in shipping Safari.
   - Static hosting:
     - GitHub Pages still cannot set headers.
     - Cloudflare Pages / Netlify / Vercel can set them.
     - Safari still lacks COEP `credentialless`.
2. **Meshing: R2 was wrong on two counts; there are now real WASM meshers.**
   - Gmsh: `@loumalouomega/gmsh-wasm`, GPL-2.0+, 11.6 MB gz with OCC, threads-only (needs COI).
   - fTetWild: `float-tetwild-wasm`, MPL-2.0, 0.70 MB gz, serial build available.
   - MMG 2D/surface/3D: `@loumalouomega/mmg-wasm`, LGPL-3.0+, 0.40 MB gz.
   - All three are young, single-maintainer packages, 2026-07 to 2026-10.
   - Triangle (Shewchuk) is not GPL-compatible. TetGen still has no WASM build.
3. **Solvers: no browser-packaged PETSc, hypre, MUMPS, DOLFINx, MFEM or deal.II.**
   - PETSc compiles with emcc in upstream CI only. NGSolve has an official Pyodide build (~21 MB, single-thread).
   - SuiteSparse 7.12.2 static libraries landed in emscripten-forge on 2026-11-05.
   - MUMPS (CeCILL-C) is GPL-incompatible per the FSF.
   - No published, measured WebGPU sparse or FEM solver throughput exists. Our own G2 gate numbers would be the first.
4. **GPU demos: there is now a rich MIT-licensed reference set**, with throughput numbers quoted in S4:
   - LBM, two FDTD EM codes validated against openEMS, WebGPU acoustic FDTD, MLS-MPM, and WGSL split-step FFT.
5. **Visualization: stay on three.js r187 `WebGLRenderer`.**
   - New since R7: `WebGLNodesHandler` runs TSL node materials on `WebGLRenderer`. Write new field materials in TSL now, so the later move to `WebGPURenderer` is a renderer swap, not a rewrite.
6. **Hybrid: one code path is feasible.**
   - Node can run the same ES modules and WGSL via Dawn (`webgpu` npm), and Deno via its built-in wgpu.
   - Chrome LNA permits a localhost helper from an HTTPS page, with a permission prompt.
   - Tauri 2 and Electron both work as desktop shells.

## 1. Platform status 2026-11 (deltas vs R2 S2)

### 1.1 WebGPU per browser/OS [fact unless noted; P1, P2]

| Browser / OS | Status 2026-11-06 | Delta vs R2 |
|---|---|---|
| Chromium macOS / Windows x64 / ChromeOS | Shipped 113. Dawn now requires macOS 13+ | Dawn macOS floor is new |
| Chromium Android | 12+ for ARM/Qualcomm/Intel (121); Imagination on Android 16+ (139); Samsung Xclipse and others TBD | Imagination needs Android 16+ |
| Chromium Linux | Intel Gen12+ (144); NVIDIA 535.183.01+ on Wayland (147); others behind a flag | Unchanged |
| Chromium Windows ARM64 | Behind `--enable-unsafe-webgpu` | Unchanged |
| Firefox Windows | 141 | Unchanged |
| Firefox macOS | Apple Silicon only: macOS 26 since 145, older macOS since 147. Intel Macs unsupported (bug 2004105, NEW) | **Correction** (R2 said "147 all macOS") |
| Firefox Linux / Android | Linux Nightly only (meta bug 2006676 NEW); Android off (BCD `false`) | Unchanged; the "ships 2026" expectation is unconfirmed |
| Safari macOS / iOS / iPadOS / visionOS | Since 26. 27.0 (2026-09-17) adds WGSL `clip_distances`; 27.2 (2026-10-26) is WebGPU bug fixes only | Safari is at 27.x |
| WebGPU in dedicated workers | Chrome 113, Safari 26, Firefox 141 (BCD) | Confirmed: solver workers can own the device |
| Release cadence | Chrome stable 158 (M156 stable 2026-10-20, about 2-week cadence per chromiumdash); Firefox 159.0.1 (2026-11-03) | Version numbers move fast; feature-detect, never UA-sniff |

### 1.2 Compute-relevant WebGPU features [P1-P6]

| Feature | Status | Design consequence |
|---|---|---|
| f64 | **None.** The WGSL CRD dated 2026-11-06 has exactly six enable-extensions: f16, clip_distances, dual_source_blending, subgroups, primitive_index, subgroup_size_control. gpuweb #2805 is open; Kangz (2025-08-25) says work has not started and consumer f64 is often about 8x slower [fact] | Keep f32 inner solves with an f64 outer loop in JS (R2 S5). df64 options: luma.gl `fp64arithmetic` WGSL module (add/sub/mul/div/sqrt only; about 48-bit mantissa; integer-controlled path on Apple because WGSL allows reassociation) [fact]; jesedv/df64 (Rust + WGSL, MPFR-checked; license [unv]). Use df64 for reductions/residuals only, and validate on Metal, D3D12 and Vulkan [est] |
| subgroups | Chrome 134; subgroup_id 144, subgroup_uniformity 145, `@subgroup_size` 151-152. Safari: WebKit 295343 FIXED in trunk 2026-08-17, not in any 27.x release notes. Firefox: bug 1955417 NEW. About 69 % of surveyed adapters report it (Web3D Survey) [est] | Reductions (dot products in PCG) need a workgroup-shared fallback path; subgroups is an optional fast path |
| timestamp-query | Pass-boundary `timestampWrites` (Chrome 121). Chrome quantizes to 100 us unless the developer-features flag is set. COI does not lift the quantization (spec). Timestamps inside passes need the unsafe flag. Safari granularity [unv] | Use it for coarse per-pass profiling; benchmark gates use wall-clock over many iterations |
| shader-f16 | Safari about 99.98 %, Chrome about 93 %, Firefox about 92 % of adapters; iOS and Mac above 99.8 %; Linux about 78 % [est]. Chrome 155-156 enables f16 on Linux NVIDIA [fact] | Usable for visualization buffers and LBM populations (see S4); not for solver vectors |
| Buffer limits | Spec defaults: maxStorageBufferBindingSize 128 MiB, maxBufferSize 256 MiB. Typical: about 2 GiB on Windows (92 %); Mac about 65 %; iOS tops at 1 GiB (82 %, none higher); Android binding size 512 MiB (51 %) or 1 GiB (38 %) [est, Web3D Survey] | Tile anything above 1 GiB on Apple/Android. R2 budget of 256 MiB per buffer remains the safe default |
| Compatibility mode | `requestAdapter({featureLevel:"compatibility"})`; OpenGL ES 3.1 path from Chrome 146 (Android first); `maxStorageBuffersInVertexStage` = 0 in compat [fact] | Low-end Android is reachable only if vertex shaders read storage via textures/attributes; keep visualization on attributes |
| New Chrome items | Immediates (149-150), WGSL `buffer_view` and `swizzle_assignment` (153-154), experimental synchronous buffer mapping in workers (145, current status [unv]), bindless preview (155-156) [fact] | Chrome-only; do not depend on them |

### 1.3 WebAssembly per browser [fact; P7, P8]

| Feature | Chrome | Firefox | Safari | Note |
|---|---|---|---|---|
| Threads (SAB + Atomics) | 74 | 79 | 14.1 (webassembly.org) / 15.2 (BCD) | Needs COI |
| Fixed SIMD | 91 | 89 | 16.4 | Unchanged |
| Relaxed SIMD | 114 | 145 (webassembly.org) / 146 (BCD) | Behind a flag ("preview") | No Safari, so no FMA-guaranteed path; keep fixed SIMD |
| Memory64 | 133 | 134 | Flag; WebKit PR 70452 enabled it by default in trunk (2026-07-30); **not in 27.x** | Still not a v1 dependency (R2 G4 holds) |
| JSPI | 137 | **153 (new)** | **27.0 (new)** | Now universal. Lets synchronous C/C++ code await async JS (e.g. WebGPU readback) |
| exnref / WasmGC / tail calls | 137 / 119 / 112 | 131 / 120 / 121 | 18.4 / 18.2 / 18.2 | Universal |
| Multi-memory | 120 | 125 | Preview; trunk fix 2026-09-29 | Avoid |

Open WebKit bugs that matter here [fact]:
- **299731:** memory grows with Wasm threads on each reload until `new WebAssembly.Memory` fails (NEW).
- **288526:** `memory.grow` is slow (NEW).
- **255103:** iOS OOM with `shared=true` (NEW, stale).

Pre-size memory once rather than growing it; on Safari, prefer non-shared memory [est].

### 1.4 Cross-origin isolation on static hosts [fact; P9-P15]

| Host / mechanism | COOP/COEP possible? | Caveat |
|---|---|---|
| GitHub Pages | No. Community discussion #13309 is still open (last +1 on 2026-10-25) | Threads need a service-worker shim |
| Cloudflare Pages `_headers` (and Workers static assets) | Yes; arbitrary header names allowed | Max 100 rules; not applied to Pages Functions responses or Worker-generated responses |
| Netlify `_headers` / `netlify.toml` | Yes; COOP/COEP not on the blocked list | Not applied to proxied, Functions or Edge responses |
| Vercel `vercel.json` `headers` | Yes | n/a |
| coi-serviceworker | Works by injecting headers from a service worker | npm 0.1.7, last commit 2023-12-09 (unmaintained, not archived); reloads the page on first visit; defaults to `credentialless` |
| COEP `credentialless` | Chrome 96, Firefox 119 | **Not supported:** Safari / iOS, Firefox Android. On Safari every cross-origin subresource needs CORP or CORS (`require-corp`). WebKit's position is "support", but nothing has shipped |
| Document-Isolation-Policy | Chrome desktop 137, **Chrome Android 146 (new)**; Mozilla position "positive" (2026-08-10); WebKit "concerns" | Still a header, so not on GitHub Pages |
| Safari 27.0 | Stricter COI enforcement for workers, SAB cloning fixes. STP 255/256 add a `cross-origin-isolated` Permissions Policy and console logging when isolation fails | Safari COI is getting stricter: test it |

Hosting recommendation [est]:

| Phase | Host | COI | Threading |
|---|---|---|---|
| v1 | GitHub Pages | None | Workers + transferables, as in R2 |
| Threaded or gmsh-wasm builds | Cloudflare Pages (or Netlify) | `_headers` with COOP `same-origin` + COEP `require-corp` | SAB available |

With `require-corp`, self-host every asset (fonts, LUT textures, WASM); do not rely on `credentialless`, because Safari lacks it.

### 1.5 Practical memory limits

| Platform | Limit | Label |
|---|---|---|
| V8 64-bit | wasm32 max 4 GiB; Memory64 max 16 GiB (262,144 pages; also the JS API spec cap, so it binds SpiderMonkey too) | [fact] wasm-limits.h, JS API spec |
| V8 32-bit builds (some Android) | About 2 GiB for both | [fact] |
| Safari macOS | wasm32 only in 27.x, so the address-space cap is 4 GiB. WebKit 263969 (heaps above 4 GB) FIXED in trunk 2026-08-17 via Memory64 | [fact]; real allocatable size [unv] |
| iOS Safari | The R2 figure (about 1 GB first load, 300-500 MB after reload) predates the 2024-05-15 Gigacage enlargement and fast-memory fix (272232). No iOS 26/27 measurement found | [fact] history; current [unv] |
| WebGPU iOS | maxBufferSize at most 1 GiB; jetsam ceiling [unv] | [est] survey |
| Android Chrome, Firefox desktop | No primary per-tab figure beyond engine caps | [unv] |

Budgets:
- Keep the R2 budgets: desktop 1.5-2 GB per tab; mobile <= 300 MB; GPU <= 1 GB with buffers <= 256 MiB.
- Add a startup probe that allocates in 64 MB steps inside a throwaway worker. Record the result per device in a JSONL benchmark log, which replaces the stale iOS numbers [est].

## 2. Meshing in the browser (corrects R2 S3)

Sizes are [meas] from the npm tarballs; licenses are from the primary LICENSE files [fact; M1-M20].

GPL column: compatibility with this repo (GPL-3.0-or-later).
- GPL-2.0-or-later, LGPL-x and MPL-2.0 (via MPL section 3.3) are compatible.
- Apache-2.0 is compatible with GPLv3.
- AGPL-3.0 combines with GPLv3 under GPLv3 section 13, but the network clause stays on that part.
- Not legal advice.

| Tool | Browser build (version, date) | WASM raw / gz | Capability | License | GPL | Maturity |
|---|---|---|---|---|---|---|
| Gmsh | npm `@loumalouomega/gmsh-wasm` 0.4.0 (2026-10-19); alt OlegJakushkin/gmsh-wasm (2026-06, not on npm) | 41.5 / 11.6 MB with OCC 7.8.1; README says about 12 MB raw without OCC | Full C API (342 functions), geo + OCC kernels, booleans, STEP/IGES/BREP, 1D-3D, size fields, HXT, DOMHEX; MSH via MEMFS | GPL-2.0-or-later + exception | Yes; serving it is conveying, so publish the Gmsh and OCCT source | One maintainer, 3 stars; pthreads/OpenMP build only, README requires COI |
| fTetWild | npm `float-tetwild-wasm` 0.2.0 (2026-08-28) | 2.11 / 0.70 MB (serial); threaded 2.24 MB | Triangle soup to tets: envelope, edge length, energy, coarsen; typed-array API; 0.2.0 fixed tet winding. No per-region sizing, background mesh or CSG in the API | MPL-2.0 | Yes (file headers not checked for "Incompatible With Secondary Licenses" [unv]) | One maintainer; **serial build needs no COI** |
| MMG (mmg2d / mmgs / mmg3d) | npm `@loumalouomega/mmg-wasm` 0.1.0 (2026-07-05), MMG 5.8.0 | 1.16 / 0.40 MB | 2D generation + adaptation, surface remeshing, 3D tet remeshing; iso/aniso metrics; level-set discretization; Medit/MSH I/O | LGPL-3.0-or-later | Yes | One maintainer; threading [unv] |
| Netgen | Only inside NGSolve's Pyodide bundle (`ngsolve_pyodide_314.0.6`, 27.9 MB bz2 including Pyodide; 2026-10-28) | `libnglib` 8.9 MB + `netgen` 1.6 MB zips | OCC, CSG, geom2d, STL, meshing; no MPI or GUI | LGPL-2.1 | Yes | Official CI build, but needs Pyodide |
| CGAL | Demo zalo/cgal-ct3-wasm (Constrained_triangulation_3, no license); emscripten-forge `cgal-cpp` 6.2.1 (headers). No Mesh_3 / Mesh_2 / PMP WASM | 1.25 MB (demo) | CT3: boundary-conforming, no quality refinement | Mesh_3 / Mesh_2 / CT3 GPL-3.0-or-later OR commercial; kernel LGPL-3+ | Yes, but self-build | Build effort |
| TetGen | None (npm and GitHub searches) | n/a | n/a | AGPL-3.0+ or commercial | Combinable, but carries the AGPL clause | Absent |
| TetWild (original) | None | n/a | n/a | GPL-3.0 | n/a | Stale (2023) |
| Triangle (Shewchuk) | npm `triangle-wasm` 1.0.0 (2020) | 0.125 MB | Quality CDT | Upstream "may not be sold or included in commercial products" | **No** | Exclude; the npm "MIT" covers only the wrapper |
| OpenCASCADE | opencascade.js (latest 1.1.1 from 2020; beta 2023; **stale**); **occt-wasm 5.15.0** (2026-11-03, active); **replicad 1.2.1** (2026-11-06, active); `@bitbybit-dev/occt` 1.6.0; occt-import-js 0.0.23 (dormant; forks active) | opencascade.js 50.3 / 13.7; occt-wasm 21.2 / 6.76 (README claims about 4.5 MB brotli); replicad 22.9 / 7.19; occt-import-js 7.6 / 3.08 | B-rep, booleans, fillets, STEP/IGES, tessellation. Surface mesh only (open OCCT has no volume mesher) | LGPL-2.1 (+ OCCT exception); wrappers MIT / Apache | Yes | occt-wasm and replicad are the live options |
| manifold-3d | npm 3.5.4 (2026-09-25), 2.4k stars | 0.54 / 0.20 MB | Robust triangle-mesh booleans (guaranteed manifold), SDF level sets, hull | Apache-2.0 | Yes | Mature |
| Truck (Rust B-rep) | `truck-js` wrapper in the repo, not on npm | n/a | B-rep, booleans, STEP, tessellation | Apache-2.0 | Yes | Robustness vs OCCT [unv] |
| OpenSCAD | `@kreijstal/openscad-wasm` (11.1 MB), `@loumalouomega/openscad-wasm` 0.3.1 (24.1 MB) | 11-24 MB | CSG to mesh | GPL | Yes | Not needed |
| build123d in Pyodide | yeicor/OCP.wasm (MIT wrapper, no releases) | [unv] | Python code-CAD in the browser | MIT + OCCT LGPL | Yes | Experimental |
| 2D: Delaunator + Constrainautor | Delaunator 5.1.0 (2026-03); `@kninnug/constrainautor` 4.1.0 | 67 KB unpacked (Delaunator) | Unconstrained Delaunay + constrained edges; no refinement | ISC | Yes | Active |
| 2D: cdt2d, poly2tri, cdt-js, earcut | Various, mostly stale | Small | CDT without refinement (earcut is for rendering only) | MIT / BSD-3 / ISC | Yes | Stale except earcut |
| Mesh I/O | `@meshioplusplus/wasm` 18.3.0 (2026-11-04) | 18-36 MB | 80 read / 75 write formats incl. MED, CGNS, Exodus, STEP | MIT + LGPL-2.1 + LGPL-3+ | Yes | New |

No pure-JS Ruppert/quality-refinement mesher exists on npm [fact: searches]. The user's own 2D Delaunay mesher (EO lineage) is the only license-clean quality 2D option without WASM; mmg2d is the WASM alternative.

Pyodide 314.0.7 ships no gmsh, pygmsh, meshpy, triangle, meshio or mmg package. emscripten-forge has no gmsh, occt, tetgen, triangle, netgen or mmg recipe [fact].

Meshing recommendation [est]:

| Use case | Tool | Notes |
|---|---|---|
| Structured, extruded, prism | Own JS (R2 S3) | Default for packaging and the snappy path |
| General 3D tets from a closed surface | Lazy-loaded fTetWild serial (0.7 MB gz), then mmg3d (0.4 MB gz) | mmg3d does quality and size-field adaptation |
| CAD to surface | manifold-3d for CSG on meshes; occt-wasm or replicad (about 7 MB gz) only when STEP import or B-rep fillets are needed | n/a |
| Gmsh-wasm | "Expert/CAD mode" only, and only on a COI host | Do not ship it together with a separate OCCT build: it duplicates about 7 MB gz of OCCT. Pin the version and vendor the build scripts, because the bus factor is one |

## 3. Solvers in the browser (corrects and extends R2 S4)

### 3.1 Native libraries in WASM [fact; S1-S20]

| Library | WASM status 2026-11-06 | License | GPL-3+ | Verdict |
|---|---|---|---|---|
| PETSc | **Compiles with emcc in upstream CI** (`linux-emcc`: C-only, no MPI, f2cblaslapack, tests disabled; MR !5588, 2022). No npm, Pyodide or emscripten-forge package; petsc4py 3.26.1 has no wasm wheel | BSD-2-Clause | Yes | Proof that it builds; no browser use found |
| hypre | None found (native v3.2.1, 2026-11-03) | MIT / Apache-2.0 | Yes | Algorithm reference only |
| SuiteSparse | Pyodide `libsuitesparse` 5.11.0 (AMD, CAMD, COLAMD, CCOLAMD, METIS, CHOLMOD, SPQR; no UMFPACK/KLU/LDL; Python access via `sparseqr` only). **emscripten-forge `suitesparse` 7.12.2, static libraries, merged 2026-11-05 (PR #5804), not yet in repodata.** jchatkinson/sparse-wasm (KLU + CHOLMOD + SuperLU, TS bindings, 2026-09, **no license**) | Per module: BSD-3 (orderings), LGPL-2.1+ (KLU, LDL, CXSparse), CHOLMOD LGPL-2.1+ AND GPL-2.0+ AND Apache-2.0, UMFPACK / SPQR GPL-2.0+, ParU GPL-3.0+ | **Yes, all** under a GPL-3.0-or-later project | Correction: R2 rejected the CHOLMOD Supernodal module as GPL, but GPL-2+ is fine for this repo. Candidate oracle and benchmark for the own supernodal LDLT |
| MUMPS | Static build inside louisabraham/ipopt-wasm (MUMPS 5.8.1, MPI stubs) | CeCILL-C | **No**: FSF says it lacks the GPL-compatibility clause | Exclude |
| Eigen | Header-only; emscripten-forge `eigen` 3.4.1; eigen-js 0.2.2 stale (2023); `std::fma` slow in WASM (Eigen issue 2959) | MPL-2.0 | Yes | No gain over own code |
| AMGCL | One abandoned experiment (2023, no license); upstream 1.5.0 (2026-08-03) | MIT | Yes | Still the best AMG candidate if own GMG fails (R2 R1) |
| SuperLU | Inside SciPy in Pyodide / emscripten-forge (scipy 1.18.0) | BSD-style | Yes | Python-only access |
| OpenBLAS / LAPACK | Pyodide `libopenblas` 0.3.31 (`-msimd128`, no threads, 2.1 MB zip); emscripten-forge openblas 0.3.34, lapack 3.12.1, arpack 3.9.1 | BSD-3 | Yes | Available if a C port needs LAPACK |
| faer (Rust, to wasm32) | 0.24.4 (2026-06-24): sparse LLT, LDLT, LBLT, LU, QR; simplicial and supernodal; AMD/COLAMD; symbolic/numeric split. SIMD only on x86-64/AArch64, so scalar in wasm [secondary] | MIT | Yes | Best permissive sparse-direct oracle if a second direct solver is wanted |
| Ginkgo | None | BSD-3 | Yes | No |

### 3.2 Python-in-browser stacks [fact]

| Stack | Status | Size | Notes |
|---|---|---|---|
| Pyodide | Latest 314.0.7 (2026-09-14). Version scheme now tracks Python (314 = CPython 3.14); 314.0.0 on 2026-06-09 (Emscripten 5.0.3, ABI break). Includes numpy 2.4.6, scipy 1.18.0 (SuperLU, ARPACK `eigsh`, LOBPCG; the PROPACK `svds` path has a signature issue per the recipe), sympy, matplotlib, h5py | Raw: pyodide.asm.wasm 9.6 MB + stdlib 2.5 MB + numpy 3.0 MB + scipy 14.0 MB + openblas 2.1 MB, about 31 MB before HTTP compression | No pyamg, petsc4py, meshio, gmsh, numba or jax. OpenBLAS is single-threaded |
| scikit-fem 12.0.2 (2026-06-05) | Pure wheel via micropip; **CI-tested in Pyodide since 2026-10-28** (PR #1237) | Small on top of SciPy | Best in-browser cross-check engine (BSD-3) |
| NGSolve Pyodide | **Official CI build** (Pyodide 314.0.6, OCC 8.0.1, `-msimd128`, LAPACK on; UMFPACK, MUMPS, PARDISO, hypre and MPI off; no pthreads, so single-threaded [est]); demo at ngsolve.github.io/jupyterlite_ngsolve | About 21.0 MB of zips plus the Pyodide core | LGPL-2.1. Full FEM incl. H(curl) in the browser, slow but real |
| JupyterLite xeus + emscripten-forge-4x | scipy 1.18.0, openblas, arpack, eigen, vtk 9.7.2, cgal-cpp, boost. **Absent:** petsc, hypre, mumps, dolfinx/basix/ffcx, ngsolve, mfem, gmsh, slepc, trilinos, deal.II | n/a | No open issue or PR for any of these |
| FEniCSx / DOLFINx | Nothing (blocked by PETSc + MPI) | n/a | LGPL-3.0; desktop only |
| MFEM / PyMFEM | Upstream emscripten fix (2020); only npm `glvis` 0.6.3 (visualization). PyMFEM 4.10.0.1 is native wheels only | n/a | BSD-3 |
| deal.II, Palace | Nothing | n/a | n/a |
| libCEED | Issue 1040 (2022): ran under wasmer at small sizes; not packaged | n/a | BSD-2 |

### 3.3 WebGPU sparse LA and browser GPU FEM [fact; S21-S28]

- **No published, measured WebGPU SpMV, CG or multigrid FEM throughput.** The arXiv "WebGPU" corpus (37 papers) has none.
- Related numbers, as stated by the sources:

| Source | Problem | Stated result |
|---|---|---|
| arXiv 2611.04060 (2026-11-02) | WebGPU split-step Fourier Gross-Pitaevskii equation (GPE) | Up to 1024^2 grid points, with an f64 CPU fallback |
| arXiv 2507.11794 | Explicit mass-spring cloth, no linear solve | 60 fps at 640k nodes |

- Code to study:

| Code | Content | License | Caveat |
|---|---|---|---|
| RomanShushakov/fea_app | WebGPU CSR SpMV + 6x6 block-Jacobi PCG, Rust to WASM | **None** | Study only, not reusable |
| andeplane/fem-lab (2026-09) | Rust + WebGPU; recommends an f32 GPU inner solve with an f64 CPU outer loop | MIT | Its timing figures are its own estimates, not measurements |
| FEAScript 0.3.1 (2026-10-30) | JS FEM, 1D/2D, Gmsh import, CPU and WebGPU Jacobi | MIT | "Heavy development" |
| milhidaka/webgpu-blas | WebGPU GEMM | MIT | Dense only, no sparse kernels |
| manit2004/wgblas (2026-11-04) | f32 BLAS levels 1-3 | Apache-2.0 | Dense only, no sparse kernels |
| WgPy (arXiv 2503.00279) | NumPy-like WebGL/WebGPU arrays for Pyodide | n/a | n/a |

- Mixed-precision PCG theory, newer than Goeddeke 2007 (R2): arXiv 2510.11379 (error bounds), arXiv 2505.04155 (adaptive, dynamically scaled).
- Consequence: R2's G2 plan stands unchanged, and publishing our own G2 numbers would be novel [est].

## 4. Non-FEM GPU methods for snappy educational demos [fact; G1-G40]

License and last push are from the GitHub API. Repos with no license are all-rights-reserved: study them, do not reuse them.

| Method | Project | License | Tech | Stated performance / validation | Last push |
|---|---|---|---|---|---|
| LBM D3Q19 TRT | slowernet/cells | **None** | WebGPU, FP16/FP32 | **About 1400 MLUPS FP16 / 750 FP32 on Apple M5, 192x96x96**; sphere Re 300, St 0.135 vs 0.137 published | 2026-09-29 |
| LBM D2Q9 | LennartPaduch/WebLBM | MIT | WebGPU WGSL, needs `shader-f16`, up to 2048^2 | MLUPS shown in the UI, no published number | 2026-02-13 |
| LBM 2D/3D + FDTD | Helron1977/Hypercube-gpu | MIT | WebGPU | Self-reported 1042 MLUPS D3Q19, GPU not stated [unv] | 2026-04-02 |
| LBM 3D wind tunnel | Mrfaheem4/Ventus | MIT | WebGPU | None stated | 2026-10-31 |
| LBM 2D | tnlt-AG/FLOWNIAC | GPL-3.0 | WebGPU | None stated | 2026-10-04 |
| FDTD EM 3D + near-to-far-field (NTFF) | tomipiriyev/volna | MIT (STEP importer LGPL-2.1) | C++ to WASM worker + optional WebGPU time loop | **WebGPU matches CPU to about 1e-6 and is 3-6x faster on M1; validated against openEMS on identical grids**. openEMS discussion 464 says it is "built on openEMS" (GPL-3.0): check provenance before copying | 2026-11-03 |
| Thin-wire method of moments (MoM) + FDTD antennas | vkopitsa/webantenna | MIT | WebGPU + CPU fallback | Strip dipole 74.6 ohm / 2.17 dBi vs openEMS 74 / 2.14; inverted-F antenna (IFA) resonance about 3 % high | 2026-10-21 |
| FDTD + convolutional PML (CPML) | SpaceEngineerSS/PhotonLab | MIT | Rust to WASM + WebGL2 | Start-up benchmark picks the grid size | 2026-10-13 |
| Yee FDTD | RobinKa/maxwell-simulation | MIT | WebGL fragment kernels | None stated | 2026-02-13 |
| Acoustic FDTD (staggered p/v) | ylfeid/epidaurus | MIT | WebGPU | dx = 2 cm gives 2.1 kHz bandwidth; GPU validation page vs closed form | 2026-10-22 |
| 2D wave + auralization | yahelrosenblum/hollow | MIT | WebGPU + AudioWorklet, no-build ES modules | "Tens of thousands" of steps/s | 2026-11-03 |
| Ripple tank (scalar wave) | pfalstad/ripplegl (now ripplegl-ts) | GPL-2.0-or-later (source headers) | WebGL | Hosted at falstad.com/ripple | 2026-10-11 |
| MLS-MPM / SPH | matsuoka-601/WebGPU-Ocean; Splash | MIT | WebGPU | About 100k particles real-time on an integrated GPU, about 300k on "decent GPUs"; Splash `million` branch about 1.6M | 2025-06 / 2025-04 |
| Position-based MPM (PB-MPM) | electronicarts/pbmpm | BSD-3 | WebGPU (Firefox not working) | None stated | 2024-10 |
| SPH + PIC/FLIP | jeantimex/fluid | MIT | WebGPU | "Tens of thousands of particles at 60 FPS" | 2026-04 |
| MPM | dimforge/wgsparkl | Field-of-use custom | wgpu | n/a. **Not GPL-compatible** | 2025-05 |
| Stable fluids | PavelDoGreat/WebGL-Fluid-Simulation | MIT | WebGL ping-pong, runs on mobile | None stated | 2024-11 |
| GPGPU library | amandaghassaei/gpu-io | MIT | WebGL2; shares a context with three.js | n/a | 2024-01 |
| Split-step TDSE, WGSL Stockham FFT | ylfeid/wavefront | MIT | WebGPU | 512^2 real-time; Chrome, Safari 26+, Firefox | 2026-10-21 |
| FFT ocean | Noniv/web-ocean | MIT | Raw WebGPU | Reusable FFT kernels | 2026-10-17 |
| TDSE / Dirac | marl0ny/QM-Simulator-2D | BSD-2 | WebGL | None stated | 2025-07 |
| General PDE playground | Pecnut/visual-pde (VisualPDE) | MIT code; CC-BY-4.0 HTML/CSS | three.js + GLSL, 1D/2D | Bull. Math. Biol. 2023 | 2026-11-06 |
| Reaction-diffusion | robert-leitl/webgpu-reaction-diffusion; flatironinstitute/rd_webgpu | MIT / BSD-2 | WebGPU | None stated | 2024 |

Not found: a WebGPU VkFFT port, a browser split-step BPM, or a k-Wave web port.

[est] A paraxial BPM has the same operator split as wavefront's TDSE (z for t), so its FFT kernels transfer directly. This is a natural photonics demo for this project.

Throughput anchors for planning [est]:

| Method | Anchor | Basis |
|---|---|---|
| LBM D3Q19 | 0.5-1.5 GLUPS on Apple / mid-range GPUs | cells is the only measured number |
| FDTD | WebGPU 3-6x over a WASM CPU path on M1 | volna |
| Particle methods | 1e5-3e5 particles interactive; about 1.6M at the high end | WebGPU-Ocean, Splash |

These are consistent with R2's 1-3 Gcells/s FDTD estimate for an M4 Pro, which remains unmeasured.

Demo recommendation [est]: write our own compact WGSL kernels, a few hundred lines each, using the MIT projects above as references. Vendor MIT code only with its notice. The kernels share one "structured-grid field" contract with the renderer (S5), so every demo gets the same colormaps and probes.

| Order | Demo |
|---|---|
| 1 | 2D scalar wave / heat on a texture (WebGL2 fallback) |
| 2 | 2D TE/TM FDTD with CPML |
| 3 | D2Q9 LBM |
| 4 | Split-step BPM / TDSE (FFT) |
| 5 | 3D FDTD block (ties to R2 S8.5) |
| 6 | Acoustic FDTD |
| 7 | MPM / SPH (lowest priority for a multiphysics tool) |

## 5. Visualization (updates R7 S1, S4)

### 5.1 three.js r187 (0.187.0, 2026-10-30) [fact; V1-V8]

| Item | Status |
|---|---|
| `WebGPURenderer` | Manual still says "still in an experimental state"; "depending on your application ... a better performance with `WebGLRenderer`" |
| GLSL on `WebGPURenderer` | `ShaderMaterial`, `RawShaderMaterial` and `onBeforeCompile` are still unsupported; TSL node materials only |
| `WebGLRenderer` | Maintained; "the recommended choice for pure WebGL 2 applications"; "no plans to add larger new features" |
| **`WebGLNodesHandler` (new vs R7)** | `renderer.setNodesHandler(new WebGLNodesHandler())` renders TSL node materials on `WebGLRenderer`. Added 2026-03-14 (PR #32851); `compile()` 2026-08-13; four `webgl_tsl_*` examples. Coverage is partial [est] |
| Post-processing | `PostProcessing` renamed `RenderPipeline` (r183); `DirectRenderPipeline` (r186). Built-in multiple render targets (MRT) default to RGBA16F. TSL nodes: GTAO, SSAO, Bloom, TRAA, TAAU, SSR, SSGI, SSS, SMAA, FXAA, Outline, Sobel, DoF, Lut3D, Denoise, FSR1, **OITPassNode** (weighted-blended OIT, `WebGPURenderer` only) |
| Compute | `StorageBufferAttribute`, `StorageInstancedBufferAttribute`, `StorageTexture`, `Storage3DTexture`, `ComputeNode`; `compileComputeAsync()` (r186), `storageTexture3D` (r185) |
| Tone mapping | Linear, Reinhard, Cineon, ACESFilmic, AgX, Neutral, Custom, on both renderers |
| Volume | `webgl_texture3d*`, `webgl_volume_*`, `webgpu_volume_*`: all 3D-texture ray marching; no tetrahedral volume renderer |
| WebGPU vs WebGL speed | One user report, r183, 4,000 meshes / 8M triangles: CPU time in `render()` was WebGL 4.5 ms vs WebGPU 9.7 ms; cold first frame 32 ms vs 167 ms (issue #30560) [unv, single report] |
| Bundle (gzip -9 of jsDelivr builds) [meas] | `three.core.min.js` 105 KB + `three.module.min.js` 89 KB = **about 195 KB** for the WebGL path; `three.webgpu.min.js` 123 KB + `three.tsl.min.js` 93 KB, so the WebGPU path is about 230-320 KB before tree-shaking [est] |

### 5.2 Alternatives [fact; V9-V16; bundlephobia min+gz]

| Library | License | Version | WebGPU | Size | Verdict |
|---|---|---|---|---|---|
| Babylon.js | Apache-2.0 | 9.35.0 (2026-11-06); 9.0 2026-03-26 | Mature since 5.0; native WGSL core shaders; Frame Graph; node materials; compute | 1.84 MB | No: duplicates three.js, no FEM advantage |
| vtk.js | BSD-3 | 38.0.5 (2026-11-05) | "Preliminary", "lots of capabilities ... not implemented" | 673 KB | Algorithm reference only |
| VTK.wasm (`@kitware/vtk-wasm`) | Apache-2.0 wrapper; VTK BSD-3 | 3.0.6 (2026-10-13) | `rendering: "webgl" \| "webgpu"` | Runtime 13.4 MB compressed (wasm32) | Optional "expert filters" mode at most |
| trame / trame-vtklocal | Apache-2.0 | 4.0.0 / 1.8.1 | n/a | Needs a Python server | Fits only the local-helper path (S6) |
| deck.gl / luma.gl | MIT | 9.4.1 / 9.4.2 | "Experimental, not yet recommended for production" | 218 KB / 27 KB | No (geospatial) |
| regl | MIT | 2.1.1 (2024-11) | None | 38 KB | No (maintenance mode) |
| PlayCanvas | MIT | 2.23.3 | "WebGPU (Beta)" | 637 KB | No |
| Plotly.js / ECharts-GL | MIT / BSD-3 | 4.2.0 / 2.1.0 | n/a | n/a | Small line or convergence plots only, if the own LinePlot (R7) is insufficient |

### 5.3 Techniques: what exists to copy [fact unless noted]

| Need | Reference | License | Plan [est] |
|---|---|---|---|
| Isosurfaces on the GPU | Twinklebear/webgpu-marching-cubes: 256^3 in 31-37.5 ms on RTX 3080 (Vulkan 27.5-33.4 ms); M2 Max 40.8-54.4 ms | MIT | Keep the R7 CPU worker marching-tets kernel first; port the scan/compaction pattern to WGSL when fields live on the GPU (16 tet cases) |
| Volume rendering | three.js 3D-texture ray marching; no maintained browser tet ray-marcher (unray 2020, BSD-3, stale) | MIT | R7 skipped volume rendering; for RF/optics near fields and acoustics, resample to a `Data3DTexture` and ray-march. Do not do unstructured tet ray marching in v1 |
| LIC | mroehlig/webgl_line_integral_convolution (three.js, MIT), Domenicobrz LIC (MIT) | MIT | LIC on slice planes for E/H/heat-flux/velocity fields. Fragment pass: noise texture plus a vector-field texture |
| Animated flow particles | mapbox/webgl-wind (texture state, trail ping-pong) | ISC | Gives the "alive" look for fluids and Poynting flux; TSL compute later |
| Glyphs | `InstancedMesh` | MIT | Already in the R7 plan |
| Streamlines | No GPU library | n/a | Worker RK4 (R7), rendered with `Line2` fat lines or instanced tubes |
| OIT | `OITPassNode` (WebGPU only) | MIT | On WebGL, hand-roll weighted-blended OIT with 2 render targets for x-ray mode |

### 5.4 The "smooth and gorgeous" recipe [est unless noted]

- **Field color.**
  - Linear-space scalar, then a 256x1 (or 1024x1) LUT texture, sampled after scaling, with optional banding.
  - Colormap licenses [fact]:

| Colormap | Source | License |
|---|---|---|
| viridis / magma / inferno / plasma / cividis | BIDS mpl-colormaps | CC0 |
| cmocean (balance, thermal, curl for signed fields) | matplotlib/cmocean | MIT |
| Crameri 8.0.1 | Zenodo record 8409685 | MIT |
| colorcet | holoviz/colorcet | CC-BY-4.0 (attribution required; FSF lists it as GPL-compatible but not for software) |

  - Ship the LUTs as generated data files with a NOTICE.
- **Tone mapping.**
  - Use Neutral (or none) for the colormapped term, so LUT colors stay faithful. AgX desaturates highlights.
  - Apply lighting as a luminance modulation of the LUT color (Lambert + small specular), not a full PBR material.
- **Isolines.** `fract(v / step)` with an `fwidth`-based smoothstep gives anti-aliased contours at any zoom. This is the EO renderer technique.
- **Depth cues.**
  - GTAO (`webgl_postprocessing_gtao` via EffectComposer on WebGL), a PMREM room environment for subtle reflections, and OutlinePass or feature-edge lines.
  - MSAA (`antialias: true`) plus SMAA; add TAA when the camera is static.
- **Animation.**
  - Time-harmonic fields: `Re(A e^{i(wt + phi)})` computed in the vertex/fragment shader from two attributes (Re, Im), with a time uniform. Animation is then free: no per-frame upload.
  - Transient results: double-buffered attribute uploads at a fixed fps.
- **Render on demand.** Render on input or animation only (R7), to save battery and fan noise.

### 5.5 Stack recommendation

| Decision | Reason |
|---|---|
| three.js r187 `WebGLRenderer` + EffectComposer (GTAO, SMAA, OutputPass with Neutral tone mapping) | Universal: WebGL2 runs on Linux, low-end Android and Firefox Linux/Android where WebGPU is missing. Smallest bundle (about 195 KB gz). Mature post-processing |
| Write new field materials in TSL, run them through `WebGLNodesHandler` | Same node code later runs on `WebGPURenderer`. Gate: if a needed feature (clipping planes, instancing attributes, custom attributes) fails under the handler, fall back to one GLSL `ShaderMaterial` behind the same interface (R7 S1) [est] |
| Switch to `WebGPURenderer` per view, not globally, when compute sharing pays | Triggers: solver fields already resident on a WebGPU device (no readback), GPU marching tets, more than 1M advected particles, or OIT. Reassess when the manual drops "experimental" |
| Demos (S4) render into the same three.js scene | Field textures or storage buffers, the same LUT and isoline material: one look across FEM and demo modes |

## 6. Hybrid: optional local accelerator with one code path [fact; H1-H20]

| Path | Status 2026-11-06 | One-code-path mechanism |
|---|---|---|
| Same JS + WASM in Node / Deno / Bun | Node 26.13.0 / 24.22.2 (2026-10-28); Deno 2.9.8 (2026-10-21); Bun 1.4.4 (2026-10-22) | Deno and Bun have a Web `Worker` (Deno: module only). Node needs a roughly 20-line `worker_threads` shim [est]. SAB works without COI headers natively, so the threaded solver path that is gated in browsers is free in Node [est] |
| Same WGSL natively | Dawn through npm `webgpu` 0.6.2 (2026-10-02; npm says MIT, the repo says BSD-3: check before redistributing); Deno built-in `navigator.gpu` (wgpu; no flag in docs); wgpu v30.0.1 (2026-08-22); Bun has no native WebGPU | `navigator.gpu = create([...])` in Node, so the browser WebGPU backend runs unchanged in CI and on a headless GPU box |
| wasmtime | v50.0.1: simd and relaxed-simd Tier 1; threads Tier 2 (work in progress) | Only for headless WASI builds; not needed |
| Localhost helper (native PETSc, MFEM, Palace, MOOSE, gmsh) | **Chrome LNA:** permission prompt for public-to-loopback fetch since 142; split into `local-network` / `loopback-network` in 145; WebSockets gated from 147. The page must be HTTPS. `fetch(url, {targetAddressSpace: "loopback"})` exempts the request from mixed-content blocking. CORS is still required; the old private-network preflight header is deprecated. An app served from `http://localhost` itself does not trigger LNA | The helper binds 127.0.0.1 on an uncommon port, allowlists the app origin via CORS, and uses a pairing token (the browser permission covers the whole origin). Handshake `GET /v1/capabilities` returns solvers, versions, physics, dims, gpu, max_dofs. **Same typed model spec** (DevLog-000 S4) in, binary fields out. Silent fallback to in-browser on denial [est] |
| Remote GPU job | n/a [est] | HTTP job API (spec + mesh blob to a job id); a WebSocket streams progress, residuals and decimated fields; results by chunked binary GET. WebRTC only for server-side pixel streaming of huge fields |
| Tauri 2.12.5 (2026-10-21; v3 alpha.6 2026-11-06) | WebGPU works in WKWebView on macOS/iOS 26+ (maintainer comment, issue 6381); Windows WebView2 is Chromium (likely fine [unv]); Linux WebKitGTK WebGPU not confirmed; the CEF runtime on Linux shows only a SwiftShader adapter (issue 16203, open) | COOP/COEP via `app.security.headers`; native solvers as sidecars (`bundle.externalBin`). Small installer [unv size] |
| Electron 45.2.3 (2026-11-04) | Bundled Chromium gives uniform WebGPU on all OSes [est] | `protocol.handle` serves the app with COOP/COEP headers [unv mechanics]; native solvers via `child_process`. Larger bundle (Chromium) |

Recommendation [est]:
- **Default:** the browser app.
- **Same engine in CI and agents:** Node + `webgpu` npm.
- **Native backends:** the localhost helper (FastAPI, per user defaults, or Rust), via a capability handshake.
- **Desktop shell:**
  - Electron if a desktop app is wanted with guaranteed WebGPU on Linux.
  - Tauri if macOS/Windows are the targets and installer size matters.
  - Defer the choice; the helper protocol is identical either way.

## 7. Ranked recommendation: build vs adopt

Licenses are relative to GPL-3.0-or-later. Sizes: [meas] from npm tarballs or builds, otherwise [est].

### 7.1 Build ourselves (core; ships first)

| Rank | Component | Why own | Size |
|---|---|---|---|
| 1 | Solver core (existing supernodal LDLT, PCG+GMG, GMRES+p-MG, matrix-free kernels; WASM SIMD behind the R2 G1 gate) | Already exists. No browser-packaged PETSc, hypre or AMG alternative exists (S3) | JS source plus a few-KB SIMD module [est] |
| 2 | Structured / extruded / prism meshers + existing 2D Delaunay | Snappy, GPU-friendly, license-clean; no pure-JS quality mesher exists on npm | Source only |
| 3 | WebGPU backend in own WGSL (apply, z-line smoother, transfers, reductions; f32 inner, f64 outer) | No library exists. Use a subgroups fast path with a fallback; buffers <= 256 MiB, tiled above 1 GiB | Source only |
| 4 | Visualization kernels (boundary extraction, slice/iso marching tets, LIC, particles) + one TSL field material on three.js r187 | R7 plan holds; TSL for future-proofing | three.js about 195 KB gz [meas] |
| 5 | GPU demo engines (wave/heat, 2D FDTD + CPML, D2Q9 LBM, split-step BPM, 3D FDTD block, acoustic FDTD) | Small kernels; MIT references available (S4); shared field contract with the renderer | Source only |
| 6 | Platform probe (WebGPU features and limits, SIMD, COI, memory ramp) to a JSONL benchmark log | Replaces stale iOS and limit numbers with our own | Source only |

### 7.2 Adopt (lazy-loaded WASM ports, optional features)

| Rank | Package | Use | License / GPL | Size (gz) | Condition |
|---|---|---|---|---|---|
| 1 | manifold-3d 3.5.4 | Mesh booleans / CSG for user geometry | Apache-2.0 / yes | 0.20 MB [meas] | Adopt when CSG lands; mature |
| 2 | `@loumalouomega/mmg-wasm` 0.1.0 (MMG 5.8.0) | 2D quality meshing alternative, surface remeshing, 3D adaptation with metric fields (a posteriori adaptivity) | LGPL-3.0+ / yes | 0.40 MB [meas] | Pin; vendor the build script (single maintainer) |
| 3 | `float-tetwild-wasm` 0.2.0 | General tets from triangle soup (imported STL, CSG output), followed by mmg3d | MPL-2.0 / yes | 0.70 MB [meas], serial, no COI | Pin; check MPL file headers |
| 4 | occt-wasm 5.15.0 or replicad 1.2.1 | STEP import, B-rep modeling, fillets | LGPL-2.1 / yes | 6.8-7.2 MB [meas] | Only with a CAD import feature; must offer OCCT source |
| 5 | `@loumalouomega/gmsh-wasm` 0.4.0 | Full Gmsh (size fields, OCC, HXT) for parity with the desktop Gmsh path | GPL-2.0+ / yes | 11.6 MB [meas] | Needs a COI host (Cloudflare Pages `_headers`), and it duplicates OCCT. Expert mode only; publish the corresponding source |
| 6 | faer (Rust, to wasm) or emscripten-forge SuiteSparse 7.12.2 (CHOLMOD) | Second sparse-direct oracle / benchmark against the own LDLT | MIT / yes; LGPL+GPL-2+ / yes | [unv]; build needed | Benchmark gate only, not shipped |
| 7 | Pyodide 314.0.7 + scikit-fem 12.0.2; NGSolve Pyodide | In-browser cross-check notebooks, validation, teaching | MPL-2.0 (Pyodide [unv]) + BSD-3; LGPL-2.1 / yes | About 31 MB raw core + SciPy; NGSolve +21 MB [meas raw] | Optional tab, never the engine |
| 8 | VTK.wasm 3.0.6 | VTK filters / readers in expert mode | Apache-2.0 + BSD-3 / yes | About 13.4 MB | Low priority |

### 7.3 Exclude

| Item | Reason |
|---|---|
| Triangle | Non-free license terms |
| MUMPS | CeCILL-C is GPL-incompatible (FSF) |
| dimforge wgsparkl | Field-of-use license |
| TetGen | No WASM build; AGPL. Not needed given fTetWild + MMG |
| opencascade.js | Stale since 2023 |
| Unlicensed repos (cells, fea_app, sparse-wasm, kishimisu, heaviside, cgal-ct3-wasm, amgcl-wasm) | No license, so all rights reserved: study only |
| Babylon.js, deck.gl, regl, vtk.js as the main renderer | See S5.2 |

### 7.4 Bundle budget

All rows except three.js are lazy-loaded.

| Tier | Contents | Size gz |
|---|---|---|
| Core app | Svelte UI + own engine + three.js | three.js about 195 KB [meas]; total about 0.4-0.8 MB [est] |
| + meshing pack | manifold + mmg + fTetWild | About 1.3 MB [meas sum] |
| + CAD pack | occt-wasm | About 6.8 MB |
| + Gmsh expert pack | gmsh-wasm (instead of the CAD pack, not in addition) | About 11.6 MB |
| + Python cross-check | Pyodide + SciPy (+ NGSolve) | Tens of MB [est after compression] |

## 8. Open items for measurement (not decisions)

- iOS 26/27 and Android per-tab WASM and WebGPU memory ceilings (startup probe, JSONL log).
- `WebGLNodesHandler` coverage for clipping planes, instanced attributes and custom attributes, before committing to TSL.
- Safari first-ship versions for subgroups and Memory64 (both in WebKit trunk now).
- Firefox relaxed SIMD: 145 vs 146 (sources disagree). Safari threads: 14.1 vs 15.2 (sources disagree).
- MPL file headers in fTetWild; GPL source-offer mechanics for the Gmsh, MMG and OCCT WASM we serve.
- volna provenance vs openEMS (GPL-3.0) before borrowing any code.
- R2 G2: our own WebGPU matrix-free PCG/GMG throughput on Apple and one non-Apple GPU. That would be the first published numbers.

## Sources (all accessed 2026-11-06)

Platform:
- [P1] gpuweb implementation status (edited 2026-10-02): https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- [P2] MDN BCD api/GPU.json: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/GPU.json ; Firefox Intel Mac bug: https://bugzilla.mozilla.org/show_bug.cgi?id=2004105
- [P3] WGSL CRD: https://www.w3.org/TR/WGSL/ ; WebGPU CRD (2026-09-15): https://www.w3.org/TR/webgpu/ ; f64 issue: https://github.com/gpuweb/gpuweb/issues/2805
- [P4] luma.gl fp64: https://luma.gl/next/docs/api-reference/shadertools/shader-modules/fp64 ; df64: https://github.com/jesedv/df64
- [P5] Chrome "What's new in WebGPU": https://developer.chrome.com/blog/new-in-webgpu-120 ; -121 ; -146 ; -151-152 ; -153-154 ; -155-156 (same URL pattern)
- [P6] Web3D Survey: https://web3dsurvey.com/webgpu/features/subgroups ; /features/timestamp-query ; /features/shader-f16 ; /limits/maxBufferSize ; /limits/maxStorageBufferBindingSize
- [P7] webassembly.org features: https://raw.githubusercontent.com/WebAssembly/website/main/features.json ; V8 limits: https://chromium.googlesource.com/v8/v8/+/main/src/wasm/wasm-limits.h
- [P8] Safari 27.0: https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ ; 27.2: https://webkit.org/blog/18515/webkit-features-for-safari-27-2/ ; STP 256: https://webkit.org/blog/18602/release-notes-for-safari-technology-preview-256/ ; WebKit bugs: https://bugs.webkit.org/show_bug.cgi?id=269937 , ?id=295343 , ?id=299731 , ?id=288526 , ?id=255103 , ?id=263969 ; Firefox subgroups: https://bugzilla.mozilla.org/show_bug.cgi?id=1955417
- [P9] GitHub Pages headers discussion: https://github.com/orgs/community/discussions/13309
- [P10] Cloudflare Pages headers: https://developers.cloudflare.com/pages/configuration/headers/ ; Workers: https://developers.cloudflare.com/workers/static-assets/headers/
- [P11] Netlify headers: https://docs.netlify.com/manage/routing/headers/
- [P12] Vercel: https://vercel.com/docs/project-configuration/vercel-json
- [P13] coi-serviceworker: https://github.com/gzuidhof/coi-serviceworker
- [P14] COEP BCD: https://github.com/mdn/browser-compat-data (http/headers/Cross-Origin-Embedder-Policy.json); WebKit DIP position: https://github.com/WebKit/standards-positions/issues/399
- [P15] Chrome releases: https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows ; Firefox notes: https://www.firefox.com/en-US/firefox/notes/

Meshing:
- [M1] https://www.npmjs.com/package/@loumalouomega/gmsh-wasm ; https://github.com/loumalouomega/GMSH-JS ; https://github.com/OlegJakushkin/gmsh-wasm ; Gmsh license: https://gmsh.info/LICENSE.txt
- [M2] https://www.npmjs.com/package/float-tetwild-wasm ; https://github.com/wildmeshing/fTetWild
- [M3] https://www.npmjs.com/package/@loumalouomega/mmg-wasm ; https://github.com/MmgTools/mmg
- [M4] NGSolve Pyodide files: https://ngsolve.org/files/ ; https://docu.ngsolve.org/ngs24/myaddons/lite.html ; https://github.com/NGSolve/netgen
- [M5] https://github.com/zalo/cgal-ct3-wasm ; https://github.com/emscripten-forge/recipes ; CGAL license: https://www.cgal.org/license.html
- [M6] TetGen mirror: https://github.com/ufz/tetgen ; TetWild: https://github.com/Yixin-Hu/TetWild
- [M7] Triangle: https://www.cs.cmu.edu/~quake/triangle.html ; https://www.npmjs.com/package/triangle-wasm
- [M8] opencascade.js: https://github.com/donalffons/opencascade.js ; occt-wasm: https://www.npmjs.com/package/occt-wasm ; replicad: https://github.com/sgenoud/replicad ; https://www.npmjs.com/package/@bitbybit-dev/occt ; https://github.com/kovacsv/occt-import-js
- [M9] manifold: https://github.com/elalish/manifold ; https://www.npmjs.com/package/manifold-3d
- [M10] Truck: https://github.com/ricosjp/truck ; Fornjot: https://github.com/hannobraun/fornjot ; OpenSCAD wasm: https://github.com/openscad/openscad-wasm ; OCP.wasm: https://github.com/yeicor/OCP.wasm
- [M11] Delaunator: https://github.com/mapbox/delaunator ; https://www.npmjs.com/package/@kninnug/constrainautor ; https://www.npmjs.com/package/cdt2d ; https://www.npmjs.com/package/poly2tri ; https://www.npmjs.com/package/earcut ; https://www.npmjs.com/package/@meshioplusplus/wasm
- [M12] Pyodide lock: https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide-lock.json

Solvers:
- [S1] PETSc emcc MR: https://gitlab.com/petsc/petsc/-/merge_requests/5588 ; https://pypi.org/project/petsc4py/
- [S2] hypre: https://github.com/hypre-space/hypre
- [S3] SuiteSparse recipe: https://github.com/emscripten-forge/recipes (PR 5804) ; pyodide-recipes: https://github.com/pyodide/pyodide-recipes ; https://github.com/jchatkinson/sparse-wasm ; https://cprimozic.net/notes/posts/compiling-boundary-first-flattening-to-wasm/
- [S4] MUMPS wasm: https://github.com/louisabraham/ipopt-wasm ; FSF license list: https://www.gnu.org/licenses/license-list.html#CeCILL-C
- [S5] Eigen: https://gitlab.com/libeigen/eigen ; eigen-js: https://www.npmjs.com/package/eigen
- [S6] AMGCL: https://github.com/ddemidov/amgcl ; https://github.com/Toyoharu-Nishikawa/amgcl-wasm
- [S7] SuperLU: https://github.com/xiaoyeli/superlu ; Ginkgo: https://github.com/ginkgo-project/ginkgo
- [S8] faer: https://github.com/sarah-quinones/faer-rs ; arXiv 2606.19213
- [S9] Pyodide changelog: https://pyodide.org/en/stable/project/changelog.html ; releases: https://github.com/pyodide/pyodide/releases
- [S10] scikit-fem: https://pypi.org/project/scikit-fem/ ; https://github.com/kinnala/scikit-fem/pull/1237
- [S11] NGSolve Pyodide CI: https://github.com/NGSolve/ngsolve/tree/master/tests/gitlab-ci/pyodide ; demo: https://ngsolve.github.io/jupyterlite_ngsolve
- [S12] JupyterLite xeus environments: https://jupyterlite-xeus.readthedocs.io/en/latest/environment.html ; channel: https://prefix.dev/channels/emscripten-forge-4x
- [S13] DOLFINx: https://github.com/FEniCS/dolfinx ; MFEM: https://github.com/mfem/mfem (PR 1918) ; PyMFEM: https://pypi.org/project/mfem/ ; libCEED: https://github.com/CEED/libCEED/issues/1040
- [S21] arXiv 2611.04060 ; arXiv 2507.11794 ; arXiv 2503.00279 ; arXiv 2510.11379 ; arXiv 2505.04155 (https://arxiv.org/abs/<id>)
- [S22] https://github.com/RomanShushakov/fea_app ; https://github.com/andeplane/fem-lab ; https://github.com/milhidaka/webgpu-blas ; https://github.com/manit2004/wgblas ; FEAScript: https://www.npmjs.com/package/feascript ; mathjs: https://mathjs.org

GPU demos (all https://github.com/<repo>, license and push dates via the GitHub API):
- [G] slowernet/cells ; LennartPaduch/WebLBM ; Helron1977/Hypercube-gpu ; Mrfaheem4/Ventus ; tnlt-AG/FLOWNIAC ; tomipiriyev/volna ; vkopitsa/webantenna ; SpaceEngineerSS/PhotonLab ; RobinKa/maxwell-simulation ; ylfeid/epidaurus ; yahelrosenblum/hollow ; pfalstad/ripplegl ; matsuoka-601/WebGPU-Ocean ; matsuoka-601/Splash ; electronicarts/pbmpm ; jeantimex/fluid ; dimforge/wgsparkl ; PavelDoGreat/WebGL-Fluid-Simulation ; amandaghassaei/gpu-io ; ylfeid/wavefront ; Noniv/web-ocean ; marl0ny/QM-Simulator-2D ; Pecnut/visual-pde ; robert-leitl/webgpu-reaction-diffusion ; flatironinstitute/rd_webgpu ; openEMS discussion: https://github.com/thliebig/openEMS-Project/discussions/464

Visualization:
- [V1] three.js releases: https://github.com/mrdoob/three.js/releases ; npm: https://www.npmjs.com/package/three
- [V2] WebGPURenderer manual: https://threejs.org/manual/#en/webgpurenderer (source: https://raw.githubusercontent.com/mrdoob/three.js/dev/manual/pages/webgpurenderer.html)
- [V3] WebGLNodesHandler docs: https://threejs.org/docs/#WebGLNodesHandler (PR https://github.com/mrdoob/three.js/pull/32851)
- [V4] Post-processing manual: https://threejs.org/manual/#en/webgpu-postprocessing ; TSL display nodes: https://github.com/mrdoob/three.js/tree/r187/examples/jsm/tsl/display
- [V5] three.js examples list: https://github.com/mrdoob/three.js/blob/dev/examples/files.json ; constants: https://github.com/mrdoob/three.js/blob/r187/src/constants.js
- [V6] Renderer perf report (single user): https://discourse.threejs.org/ (thread 91904, 2026-05-29)
- [V7] Marching cubes: https://willusher.io/graphics/2024/04/22/webgpu-marching-cubes ; https://github.com/Twinklebear/webgpu-marching-cubes
- [V8] LIC: https://github.com/mroehlig/webgl_line_integral_convolution ; wind: https://github.com/mapbox/webgl-wind ; unray: https://github.com/martinal/unray
- [V9] Babylon.js WebGPU: https://doc.babylonjs.com/setup/support/webGPU ; 9.0: https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/
- [V10] vtk.js: https://github.com/Kitware/vtk-js ; VTK.wasm: https://kitware.github.io/vtk-wasm ; trame: https://github.com/Kitware/trame
- [V11] deck.gl: https://deck.gl/docs/whats-new ; PlayCanvas: https://developer.playcanvas.com/user-manual/graphics/ ; regl: https://github.com/regl-project/regl
- [V12] Bundle sizes: https://bundlephobia.com/api/size?package=<pkg>@<ver>
- [V13] Colormaps: https://github.com/BIDS/colormap ; https://github.com/matplotlib/cmocean ; https://zenodo.org/records/8409685 ; https://github.com/holoviz/colorcet ; https://www.gnu.org/licenses/license-list.html#ccby

Hybrid:
- [H1] Chrome LNA guide: https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access ; blog: https://developer.chrome.com/blog/local-network-access ; WebSockets intent to ship: https://groups.google.com/a/chromium.org/g/Blink-dev/c/O6GMKt44Ups
- [H2] Dawn node: https://github.com/dawn-gpu/node-webgpu ; https://www.npmjs.com/package/webgpu ; wgpu: https://github.com/gfx-rs/wgpu ; Deno GPU: https://docs.deno.com/api/web/~/GPU ; Bun issue: https://github.com/oven-sh/bun/issues/1084
- [H3] wasmtime proposals: https://github.com/bytecodealliance/wasmtime/blob/main/docs/stability-wasm-proposals.md
- [H4] Tauri: https://github.com/tauri-apps/tauri/issues/6381 ; https://github.com/tauri-apps/tauri/issues/16203 ; sidecar docs: https://v2.tauri.app/develop/sidecar/ ; Electron protocol: https://github.com/electron/electron/blob/main/docs/api/protocol.md ; WebKitGTK: https://webkitgtk.org/2026/02/06/webkitgtk2.51.91-released.html
