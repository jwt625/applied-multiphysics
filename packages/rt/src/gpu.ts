// SPDX-License-Identifier: GPL-3.0-or-later
// Small WebGPU helpers shared by the kernels (browser and Node/Dawn).

export const WG = 16; // 2D workgroup edge used by all grid kernels

export class BufferSet {
  readonly device: GPUDevice;
  readonly list: GPUBuffer[] = [];
  bytes = 0;
  constructor(device: GPUDevice) {
    this.device = device;
  }
  make(size: number, usage: number, label: string): GPUBuffer {
    const b = this.device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, label });
    this.list.push(b);
    this.bytes += b.size;
    return b;
  }
  storage(size: number, label: string): GPUBuffer {
    return this.make(
      size,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label,
    );
  }
  uniform(size: number, label: string): GPUBuffer {
    return this.make(size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label);
  }
  destroy(): void {
    for (const b of this.list) b.destroy();
    this.list.length = 0;
    this.bytes = 0;
  }
}

export function write(device: GPUDevice, buf: GPUBuffer, data: ArrayBufferView, offsetBytes = 0): void {
  device.queue.writeBuffer(buf, offsetBytes, data.buffer, data.byteOffset, data.byteLength);
}

/** Copies `bytes` from `src` at `offset` into a mappable buffer and returns a copy as Float32Array. */
export async function readF32(device: GPUDevice, src: GPUBuffer, offset: number, bytes: number): Promise<Float32Array> {
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
  device: GPUDevice,
  code: string,
  label: string,
  entryPoint = "main",
  layout: GPUPipelineLayout | "auto" = "auto",
): Promise<GPUComputePipeline> {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code, label });
  const p = device.createComputePipeline({ layout, compute: { module, entryPoint }, label });
  const err = await device.popErrorScope();
  if (err) throw new Error(`${label}: ${err.message}`);
  return p;
}

export function groups(n: number): number {
  return Math.ceil(n / WG);
}
