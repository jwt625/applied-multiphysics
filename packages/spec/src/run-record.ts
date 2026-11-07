// SPDX-License-Identifier: GPL-3.0-or-later
// Run record helpers (C5, DevLog-001 A5): engine stamp, spec hash, ISO timestamps with offset, platform probe and
// per-stage timing. Works in browsers, Web Workers and Node without Node-only imports.

import { specHash } from './canonical.ts';
import type { RunRecord, Platform } from './types/solution.ts';

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');

/** ISO 8601 local time with milliseconds and UTC offset, e.g. 2026-11-06T15:20:01.123-08:00. */
export function isoNow(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

/** Engine stamp '@amp/physics@<version>+<git short sha or "dirty">'. */
export function engineString(pkg: string, version: string, sha?: string | null): string {
  if (sha != null && !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`engine sha must be a hex git sha, got ${JSON.stringify(sha)}`);
  return `${pkg}@${version}+${sha ?? 'dirty'}`;
}

interface NavLike { userAgent?: string; hardwareConcurrency?: number; gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; device?: string; description?: string } } | null> } }

/** Synchronous platform probe (no GPU adapter query). */
export function probePlatform(): Platform {
  const g = globalThis as { process?: { versions?: { node?: string } }; navigator?: NavLike; crossOriginIsolated?: boolean };
  const node = g.process?.versions?.node;
  const nav = g.navigator;
  const p: Platform = { runtime: node ? 'node' : 'browser' };
  const ua = nav?.userAgent ?? (node ? `Node.js/${node}` : undefined);
  if (ua) p.ua = ua;
  if (typeof nav?.hardwareConcurrency === 'number') p.cores = nav.hardwareConcurrency;
  if (typeof g.crossOriginIsolated === 'boolean') p.crossOriginIsolated = g.crossOriginIsolated;
  return p;
}

/** Platform probe including the WebGPU adapter description when available. */
export async function probePlatformAsync(): Promise<Platform> {
  const p = probePlatform();
  try {
    const nav = (globalThis as { navigator?: NavLike }).navigator;
    const a = await nav?.gpu?.requestAdapter();
    const info = a?.info;
    if (info) {
      const s = [info.vendor, info.architecture, info.device, info.description].filter((x) => x).join(' ');
      if (s) p.gpu = s;
    }
  } catch { /* no GPU: field stays absent */ }
  return p;
}

export interface RunRecordInput {
  engine: string;
  spec?: unknown;
  specHash?: string;
  meshHash: string;
  fidelity: RunRecord['fidelity'];
  startedAt?: string;
  platform?: Platform;
  /** OpLog.head at run start, so a stored log can be checked against the run (replayJSONL expectHead). */
  oplogHead?: string;
}

/** Build a C5 run record; the spec hash is computed from `spec` when not given. */
export async function makeRunRecord(input: RunRecordInput): Promise<RunRecord> {
  const h = input.specHash ?? (input.spec !== undefined ? await specHash(input.spec) : null);
  if (!h) throw new Error('makeRunRecord: spec or specHash required');
  if (!/^[0-9a-f]{64}$/.test(input.meshHash)) throw new Error('makeRunRecord: meshHash must be a sha-256 hex string');
  if (input.oplogHead !== undefined && !/^[0-9a-f]{64}$/.test(input.oplogHead)) throw new Error('makeRunRecord: oplogHead must be a sha-256 hex string');
  return {
    engine: input.engine,
    specHash: h,
    meshHash: input.meshHash,
    startedAt: input.startedAt ?? isoNow(),
    platform: input.platform ?? probePlatform(),
    fidelity: input.fidelity,
    ...(input.oplogHead !== undefined ? { oplogHead: input.oplogHead } : {}),
  };
}

/** Wall-clock timing per stage in ms (C5 `timing`). */
export function stageTimer(now: () => number = () => performance.now()) {
  const timing: Record<string, number> = {};
  const open = new Map<string, number>();
  return {
    timing,
    start(stage: string) { open.set(stage, now()); },
    stop(stage: string) {
      const t0 = open.get(stage);
      if (t0 === undefined) throw new Error(`stage '${stage}' was not started`);
      open.delete(stage);
      timing[stage] = (timing[stage] ?? 0) + (now() - t0);
      return timing[stage] as number;
    },
    async time<T>(stage: string, fn: () => T | Promise<T>): Promise<T> {
      this.start(stage);
      try { return await fn(); } finally { this.stop(stage); }
    },
  };
}
