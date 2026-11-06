// SPDX-License-Identifier: GPL-3.0-or-later
// Platform probe (browser or Node): WebGPU adapter info, selected limits and features, cross-origin isolation.
// Shape matches the C5 RunRecord.platform fields where they overlap.

export interface PlatformProbe {
  runtime: "browser" | "node";
  ua?: string;
  cores?: number;
  crossOriginIsolated?: boolean;
  webgpu: boolean;
  gpu?: string;
  adapter?: { vendor: string; architecture: string; device: string; description: string };
  limits?: Record<string, number>;
  features?: string[];
  error?: string;
  at: string;
}

export const PROBE_LIMITS = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
  "maxComputeWorkgroupSizeX",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupsPerDimension",
  "maxTextureDimension2D",
  "minUniformBufferOffsetAlignment",
] as const;

export async function probePlatform(gpu: GPU | undefined): Promise<{ probe: PlatformProbe; adapter: GPUAdapter | null }> {
  const g = globalThis as { window?: unknown; navigator?: Navigator; crossOriginIsolated?: boolean };
  const probe: PlatformProbe = {
    runtime: g.window !== undefined ? "browser" : "node",
    ua: g.navigator?.userAgent,
    cores: g.navigator?.hardwareConcurrency,
    crossOriginIsolated: g.crossOriginIsolated,
    webgpu: false,
    at: new Date().toISOString(),
  };
  if (!gpu) {
    probe.error = "navigator.gpu is undefined (WebGPU not available in this browser or context)";
    return { probe, adapter: null };
  }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      probe.error = "requestAdapter() returned null";
      return { probe, adapter: null };
    }
    const i = adapter.info;
    probe.webgpu = true;
    probe.adapter = { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description };
    probe.gpu = [i.vendor, i.architecture, i.device].filter((s) => s).join(" ");
    const lim: Record<string, number> = {};
    for (const k of PROBE_LIMITS) lim[k] = adapter.limits[k];
    probe.limits = lim;
    probe.features = [...adapter.features].map(String).sort();
    return { probe, adapter };
  } catch (e) {
    probe.error = (e as Error).message;
    return { probe, adapter: null };
  }
}
