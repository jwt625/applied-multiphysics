// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/rt: real-time WebGPU kernels (CONTRACTS-v0 C9) with CPU references. DevLog-005.

export type * from "./types.ts";
export { LbmD2Q9, RECORD_CAP } from "./kernels/lbm.ts";
export { FdtdTMz, FDTD_RECORD_CAP } from "./kernels/fdtd.ts";
export { GrayScott } from "./kernels/grayscott.ts";
export { LBM_DEFAULTS, dfgGrid, lbmDerive, lbmParams } from "./kernels/lbm-common.ts";
export { FDTD_DEFAULTS, C0, fdtdParams, yeeOmega } from "./kernels/fdtd-common.ts";
export { GS_DEFAULTS, WELL_FK, gsDiffusionNumber, gsParams } from "./kernels/grayscott-common.ts";
export { FieldRenderer, type OverlayStyle } from "./render.ts";
export { probePlatform, type PlatformProbe } from "./probe.ts";
export { colormapCSS, colormapRGBA, type ColormapName } from "./colormaps.ts";
export * as analysis from "./analysis.ts";
export * as gates from "./gates.ts";
export { benchAll, benchOne, BENCH_CASES, type BenchRow } from "./bench.ts";
