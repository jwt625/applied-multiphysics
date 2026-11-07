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
  /** Destroys one buffer allocated by this set (used when a table grows). */
  free(b: GPUBuffer): void {
    const k = this.list.indexOf(b);
    if (k >= 0) {
      this.list.splice(k, 1);
      this.bytes -= b.size;
    }
    b.destroy();
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

// ---------------------------------------------------------------- error surfacing (audit S2)

interface Guard {
  errors: string[];
  lost: string | null;
}
const guards = new WeakMap<GPUDevice, Guard>();

/** Attaches (once per device) listeners that record uncaptured errors and device loss. */
export function guardDevice(device: GPUDevice): Guard {
  let g = guards.get(device);
  if (g) return g;
  const guard: Guard = { errors: [], lost: null };
  device.addEventListener("uncapturederror", (e) => {
    guard.errors.push((e as GPUUncapturedErrorEvent).error.message);
  });
  void device.lost.then((info) => {
    guard.lost = `${info.reason}: ${info.message}`;
  });
  guards.set(device, guard);
  return guard;
}

/** Throws if the device was lost or produced any uncaptured error since it was guarded. */
export function checkDevice(device: GPUDevice, where: string): void {
  const g = guardDevice(device);
  if (g.lost) throw new Error(`${where}: GPU device lost (${g.lost})`);
  if (g.errors.length > 0) throw new Error(`${where}: WebGPU error: ${g.errors.join(" | ")}`);
}

/** Uncaptured errors recorded on a device so far (for gate reports). */
export function deviceErrors(device: GPUDevice): string[] {
  return [...guardDevice(device).errors];
}

/** Runs fn inside validation, out-of-memory and internal error scopes and throws on the first error. */
export async function scoped<T>(device: GPUDevice, label: string, fn: () => T | Promise<T>): Promise<T> {
  guardDevice(device);
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("internal");
  let out: T | undefined;
  let thrown: unknown = null;
  try {
    out = await fn();
  } catch (e) {
    thrown = e;
  }
  const internal = await device.popErrorScope();
  const oom = await device.popErrorScope();
  const validation = await device.popErrorScope();
  if (thrown) throw thrown;
  const err = validation ?? oom ?? internal;
  if (err) throw new Error(`${label}: ${err.message}`);
  return out as T;
}

/**
 * Compiles WGSL and creates a compute pipeline (layout "auto" unless given), inside error scopes.
 * Uses synchronous createComputePipeline and no getCompilationInfo(): Dawn node 0.6.2 crashes in
 * getCompilationInfo() when the module has errors, and in createComputePipelineAsync() (DevLog-005, 2026-11-06).
 */
export async function pipeline(
  device: GPUDevice,
  code: string,
  label: string,
  entryPoint = "main",
  layout: GPUPipelineLayout | "auto" = "auto",
): Promise<GPUComputePipeline> {
  return scoped(device, label, () => {
    const module = device.createShaderModule({ code, label });
    return device.createComputePipeline({ layout, compute: { module, entryPoint }, label });
  });
}

export function groups(n: number): number {
  return Math.ceil(n / WG);
}
