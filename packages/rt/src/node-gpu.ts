// SPDX-License-Identifier: GPL-3.0-or-later
// Node-only: WebGPU device through Dawn (`webgpu` npm, devDependency). Never imported by the browser demo.

export interface NodeGpu {
  device: GPUDevice;
  adapterInfo: { vendor: string; architecture: string; device: string; description: string };
  limits: Record<string, number>;
  features: string[];
}

import { guardDevice } from "./gpu.ts";

let cached: Promise<NodeGpu | null> | null = null;
// Keep the GPU instance and adapter reachable: if they are garbage-collected, dawn.node aborts the process
// ("mutex lock failed" / SIGSEGV), observed with webgpu 0.6.2 on macOS 2026-11-06.
const keepAlive: unknown[] = [];
let lastError: string | null = null;

/** Why nodeGpu() returned null (null when it succeeded or was not called). */
export function nodeGpuError(): string | null {
  return lastError;
}

/** Returns null when Dawn or an adapter is unavailable; nodeGpuError() gives the reason. Tests and gates then fail
 * unless skipping is explicitly allowed (AMP_RT_ALLOW_NO_GPU=1, or gates --cpu-only). */
export function nodeGpu(): Promise<NodeGpu | null> {
  cached ??= (async () => {
    try {
      const mod = (await import("webgpu")) as unknown as {
        create: (o: string[]) => GPU;
        globals: Record<string, unknown>;
      };
      Object.assign(globalThis, mod.globals);
      const gpu = mod.create([]);
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        lastError = "requestAdapter() returned null";
        return null;
      }
      keepAlive.push(gpu, adapter);
      const want = ["maxStorageBufferBindingSize", "maxBufferSize", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage"] as const;
      const requiredLimits: Record<string, number> = {};
      for (const k of want) requiredLimits[k] = adapter.limits[k];
      const device = await adapter.requestDevice({ requiredLimits });
      keepAlive.push(device);
      guardDevice(device); // uncaptured errors and device loss become thrown errors in the kernels (audit S2)
      const i = adapter.info;
      const limits: Record<string, number> = {};
      for (const k of want) limits[k] = adapter.limits[k];
      return {
        device,
        adapterInfo: { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description },
        limits,
        features: [...adapter.features].map(String).sort(),
      };
    } catch (e) {
      lastError = (e as Error).message;
      return null;
    }
  })();
  return cached;
}
