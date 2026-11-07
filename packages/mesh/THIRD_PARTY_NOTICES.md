# Third-party notices: @amp/mesh

`@amp/mesh` is GPL-3.0-or-later. Its only runtime dependency is `robust-predicates` (Unlicense).

The three WASM meshers below are **devDependencies of the 3D tet spike only** (DevLog-004 s.4.3). No build ships them today. Every row was checked on 2026-11-06 from the npm tarball (and `strings` on the `.wasm`) and from the upstream repository through the GitHub API. Before any lazy-loaded WASM pack ships, the obligations in the last section must be met.

| Component | Version / pin | Licence (source of the check) | In which artifact | Obligation when shipped |
|---|---|---|---|---|
| robust-predicates | 3.0.3 | Unlicense (npm `license`) | runtime dep of @amp/geom, @amp/mesh | none |
| manifold-3d | 3.5.4 | Apache-2.0 (tarball `LICENSE`; elalish/manifold `license.spdx_id`) | `manifold.js`, `manifold.wasm` | ship the Apache-2.0 text and any NOTICE. Bundle only `manifold.js` + `.wasm`; the package's 11 CLI deps (gltf-transform, commander, ...) are not used |
| Clipper2 (inside manifold.wasm) | `Clipper2Lib` symbols present (6 strings) | BSL-1.0 (AngusJohnson/Clipper2 `license.spdx_id`) | `manifold.wasm` | BSL-1.0 does not require the text for machine-code-only copies; it is listed here anyway |
| float-tetwild-wasm (fTetWild) | 0.2.0; fork loumalouomega/fTetWild @ `b6362a34f9eff68c25c47eccbde2ed3420b02e26` (master, checked 2026-11-06), upstream wildmeshing/fTetWild | MPL-2.0 (package.json; fork `LICENSE.MPL2`; source headers: plain MPL-2.0, no "Incompatible With Secondary Licenses" notice). **The tarball has no LICENSE or NOTICE file** | `floattetwild.serial.{mjs,wasm}` (+ threaded build, `libtbb.so*`) | MPL-2.0 s.3.2: state where the corresponding source is (fork URL + commit); ship the MPL-2.0 text |
| Geogram (in fTetWild) | v1.9.6 (`cmake/FloatTetwildDependencies.cmake`) | BSD-3-Clause, "Copyright (c) 2000-2022 Inria" (BrunoLevy/geogram `LICENSE` at tag v1.9.6) | fTetWild wasm | reproduce the BSD-3 notice and the Inria copyright in our docs |
| oneTBB (in fTetWild) | v2022.2.0 | Apache-2.0 (`LICENSE.txt` at tag) | threaded build, `libtbb.so*` | Apache-2.0 text. Strip the three identical `libtbb.so*` copies from a serial-only bundle |
| libigl (in fTetWild) | v2.6.0 | MPL-2.0 core (`LICENSE.MPL2`); the repo also carries `LICENSE.GPL` for its copyleft modules | fTetWild wasm | MPL-2.0 text; GPL parts, if linked, are compatible with GPL-3.0-or-later |
| fmt | 11.2.0 | MIT (`license.spdx_id`) | fTetWild wasm | MIT notice |
| spdlog | v1.15.3 | MIT (`LICENSE` at tag: "The MIT License (MIT) Copyright (c) 2016 Gabi Melman") | fTetWild wasm | MIT notice |
| CLI11 | v2.5.0 | BSD-3-Clause-style (`LICENSE` at tag: University of Cincinnati, "Redistribution and use in source and binary forms ...") | fTetWild build (CLI only) | BSD notice, if linked |
| nlohmann-style json (jdumas/json) | `0901d33b` | MIT (`license.spdx_id`) | fTetWild build | MIT notice |
| fast-envelope | `520ee04b` | MIT (`license.spdx_id`) | fTetWild wasm | MIT notice |
| @loumalouomega/mmg-wasm (MMG 5.8.0) | 0.1.0 | LGPL-3.0-or-later (tarball `LICENSE` = LGPL v3 text; package.json; MmgTools/mmg `LICENSE`: "either version 3 of the License, or (at your option) any later version", `COPYING`, `COPYING.LESSER`) | `mmg-core.wasm` + JS glue | LGPL-3.0: ship the text and a source offer for the exact MMG + wrapper sources (loumalouomega/MMG-WASM) used to build the wasm |

Excluded components that must stay excluded:
- **TetGen (AGPL-3.0 or commercial) must not be linked.** Geogram vendors TetGen, and the fTetWild fork declares `option(GEOGRAM_WITH_TETGEN ... OFF)` in `cmake/geogram.cmake`. That is an overridable default, not a forced setting. 0.2.0 has 0 `tetgenmesh` / `tetgenio` / `tetgenbehavior` strings in `floattetwild.serial.wasm`. **Before shipping**, our vendored build must pass `-DGEOGRAM_WITH_TETGEN=OFF` explicitly (CACHE FORCE) and re-run that strings check.
- **Triangle (Shewchuk; non-free terms)** is likewise vendored by Geogram. The fork defaults `GEOGRAM_WITH_TRIANGLE` to OFF, and the wasm has 0 `triangulateio` strings. Pin it OFF the same way.
- **GMP (LGPL)**: the fTetWild CMakeLists forces `FLOAT_TETWILD_USE_GMP OFF` under Emscripten.

Before any WASM pack ships:
1. Vendor and pin the fTetWild build (the fork's `.github/workflows/wasm.yml`, plus the commit above), with TetGen and Triangle forced OFF.
2. Publish the source offers: fTetWild (MPL-2.0 s.3.2), MMG (LGPL-3.0), and anything else under copyleft.
3. Ship this file, with the full licence texts, next to the lazy-loaded pack.
