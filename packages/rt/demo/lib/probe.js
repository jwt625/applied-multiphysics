// Generated from packages/rt/src/probe.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// Platform probe (browser or Node): WebGPU adapter info, selected limits and features, cross-origin isolation.
// Shape matches the C5 RunRecord.platform fields where they overlap.

                                
                              
              
                 
                                
                  
               
                                                                                          
                                  
                      
                 
             
 

export const PROBE_LIMITS = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
  "maxComputeWorkgroupSizeX",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupsPerDimension",
  "maxTextureDimension2D",
  "minUniformBufferOffsetAlignment",
]         ;

export async function probePlatform(gpu                 )                                                                {
  const g = globalThis                                                                              ;
  const probe                = {
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
    const lim                         = {};
    for (const k of PROBE_LIMITS) lim[k] = adapter.limits[k];
    probe.limits = lim;
    probe.features = [...adapter.features].map(String).sort();
    return { probe, adapter };
  } catch (e) {
    probe.error = (e         ).message;
    return { probe, adapter: null };
  }
}
