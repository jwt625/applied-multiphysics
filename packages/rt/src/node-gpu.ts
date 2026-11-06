// SPDX-License-Identifier: GPL-3.0-or-later
// Node-only: WebGPU device through Dawn (`webgpu` npm, devDependency). Never imported by the browser demo.

export interface NodeGpu {
  device: GPUDevice;
  adapterInfo: { vendor: string; architecture: string; device: string; description: string };
  limits: Record<string, number>;
  features: string[];
}

let cached: Promise<NodeGpu | null> | null = null;
// Keep the GPU instance and adapter reachable: if they are garbage-collected, dawn.node aborts the process
// ("mutex lock failed" / SIGSEGV), observed with webgpu 0.6.2 on macOS 2026-11-06.
const keepAlive: unknown[] = [];

/** Returns null when Dawn or an adapter is unavailable (tests then skip the GPU gates). */
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
      if (!adapter) return null;
      keepAlive.push(gpu, adapter);
      const want = ["maxStorageBufferBindingSize", "maxBufferSize", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage"] as const;
      const requiredLimits: Record<string, number> = {};
      for (const k of want) requiredLimits[k] = adapter.limits[k];
      const device = await adapter.requestDevice({ requiredLimits });
      keepAlive.push(device);
      device.addEventListener("uncapturederror", (e) => {
        console.error("WebGPU uncaptured error:", (e as GPUUncapturedErrorEvent).error.message);
      });
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
      console.error("nodeGpu unavailable:", (e as Error).message);
      return null;
    }
  })();
  return cached;
}
