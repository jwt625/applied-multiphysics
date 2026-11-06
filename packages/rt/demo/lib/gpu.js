// Generated from packages/rt/src/gpu.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// Small WebGPU helpers shared by the kernels (browser and Node/Dawn).

export const WG = 16; // 2D workgroup edge used by all grid kernels

export class BufferSet {
           device           ;
           list              = [];
  bytes = 0;
  constructor(device           ) {
    this.device = device;
  }
  make(size        , usage        , label        )            {
    const b = this.device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, label });
    this.list.push(b);
    this.bytes += b.size;
    return b;
  }
  storage(size        , label        )            {
    return this.make(
      size,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label,
    );
  }
  uniform(size        , label        )            {
    return this.make(size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label);
  }
  destroy()       {
    for (const b of this.list) b.destroy();
    this.list.length = 0;
    this.bytes = 0;
  }
}

export function write(device           , buf           , data                 , offsetBytes = 0)       {
  device.queue.writeBuffer(buf, offsetBytes, data.buffer, data.byteOffset, data.byteLength);
}

/** Copies `bytes` from `src` at `offset` into a mappable buffer and returns a copy as Float32Array. */
export async function readF32(device           , src           , offset        , bytes        )                        {
  const dst = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, offset, dst, 0, bytes);
  device.queue.submit([enc.finish()]);
  await dst.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(dst.getMappedRange().slice(0));
  dst.unmap();
  dst.destroy();
  return out;
}

/**
 * Compiles WGSL and creates a compute pipeline (layout "auto" unless given).
 * Uses an error scope, not getCompilationInfo(): Dawn node 0.6.2 crashes in getCompilationInfo() when the
 * module has errors, and in createComputePipelineAsync() (DevLog-005, 2026-11-06).
 */
export async function pipeline(
  device           ,
  code        ,
  label        ,
  entryPoint = "main",
  layout                             = "auto",
)                              {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code, label });
  const p = device.createComputePipeline({ layout, compute: { module, entryPoint }, label });
  const err = await device.popErrorScope();
  if (err) throw new Error(`${label}: ${err.message}`);
  return p;
}

export function groups(n        )         {
  return Math.ceil(n / WG);
}
