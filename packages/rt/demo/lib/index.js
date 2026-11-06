// Generated from packages/rt/src/index.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/rt: real-time WebGPU kernels (CONTRACTS-v0 C9) with CPU references. DevLog-005.

                                
export { LbmD2Q9, RECORD_CAP } from "./kernels/lbm.js";
export { FdtdTMz, FDTD_RECORD_CAP } from "./kernels/fdtd.js";
export { GrayScott } from "./kernels/grayscott.js";
export { LBM_DEFAULTS, dfgGrid, lbmDerive, lbmParams } from "./kernels/lbm-common.js";
export { FDTD_DEFAULTS, C0, fdtdParams, yeeOmega } from "./kernels/fdtd-common.js";
export { GS_DEFAULTS, WELL_FK, gsDiffusionNumber, gsParams } from "./kernels/grayscott-common.js";
export { FieldRenderer,                   } from "./render.js";
export { probePlatform,                    } from "./probe.js";
export { colormapCSS, colormapRGBA,                   } from "./colormaps.js";
export * as analysis from "./analysis.js";
export * as gates from "./gates.js";
export { benchAll, benchOne, BENCH_CASES,               } from "./bench.js";
