// SPDX-License-Identifier: GPL-3.0-or-later
// Type registry of amp-spec/0 (DevLog-003 s.1.2). Geometry features, physics interfaces, boundary/domain conditions,
// couplings, studies and material properties are registered by name, so packages such as @amp/physics and @amp/geom
// add their settings schemas without editing the core spec files. buildSpecSchema() composes the registered types
// into discriminated unions; the registry version invalidates the cached schema.

import type * as z from 'zod';
import type { EntityKind } from './ids.ts';
import type { ScopeValue } from './units.ts';

export type RegKind = 'feature' | 'physics' | 'bc' | 'coupling' | 'study' | 'property';
export const REG_KINDS: readonly RegKind[] = ['feature', 'physics', 'bc', 'coupling', 'study', 'property'];
export type SpaceDim = '1d' | '2d' | '2d-axisym' | '3d';
export type PathKey = string | number;

export interface CheckIssue { path: PathKey[]; message: string; code?: string }

export interface CheckContext {
  /** The structurally valid spec (plain data). */
  spec: Record<string, unknown>;
  /** Resolved params (SI value, dimension). */
  params: ReadonlyMap<string, ScopeValue>;
  space: SpaceDim | null;
  featureIds: ReadonlySet<string>;
  physics: ReadonlyMap<string, { type: string }>;
  studies: ReadonlyMap<string, { type: string }>;
  /** Resolve a quantity against the params; null for N/A; throws QuantityError on errors. */
  resolve(q: unknown): { si: number; dim: number[] } | null;
}

export interface Registration {
  kind: RegKind;
  /** Name used as `type:` in the spec (property: the key inside `override`). */
  type: string;
  /** Strict zod object for `settings`. Absent: the node takes no settings. Optional in the spec when `{}` passes. */
  settings?: z.ZodType;
  /** Entity kinds a `select` may contain. physics default ['dom']; bc required; coupling/study/feature: none. */
  select?: readonly EntityKind[];
  /** bc: physics types it applies to ('*' for any). coupling: [from type, to type]. */
  for?: readonly string[];
  /** physics / feature: space dimensions it supports. */
  dims?: readonly SpaceDim[];
  /** property: false when only tensor forms are allowed (default true). */
  scalar?: boolean;
  /** property: allowed tensor forms, symmetry -> independent component names (e.g. {cubic: ['C11', 'C12', 'C44']}). */
  tensor?: Readonly<Record<string, readonly string[]>>;
  /** property: a complete zod schema for the override value, replacing the scalar/tensor forms built from the fields above. */
  value?: z.ZodType;
  /** property: reference SI unit of the property (dimension check). */
  unit?: string;
  /** property: physical bounds on the SI value (e.g. {gt: 0}). */
  bounds?: { gt?: number; ge?: number; lt?: number; le?: number };
  /** feature: settings keys holding ids (string or string[]) of earlier features. */
  refs?: readonly string[];
  /** Extra semantic checks; issue paths are relative to the node. */
  check?(node: Record<string, unknown>, ctx: CheckContext): CheckIssue[];
  description?: string;
  /** Set on seed registrations that another lane is expected to supersede. */
  provisional?: boolean;
  owner?: string;
}

export interface Registry {
  /**
   * Register a type. BC types are scoped by physics (contracts v1): a bc registration covers the physics types in
   * `for` ('*' = any), and two registrations may share a BC name for different physics (e.g. `pressure` for acoustics
   * and for elastic). {replace: true} supersedes only the physics it names.
   */
  register(r: Registration, opts?: { replace?: boolean }): void;
  unregister(kind: RegKind, type: string): boolean;
  /** For kind 'bc', the registration only when exactly one exists under that name; use getBc. */
  get(kind: RegKind, type: string): Registration | undefined;
  /** The BC registration of `type` for a physics type (a physics-specific one before a '*' one). */
  getBc(physicsType: string, type: string): Registration | undefined;
  /** BC registrations that apply to a physics type (physics-specific ones shadow '*' ones of the same name). */
  bcsFor(physicsType: string): Registration[];
  list(kind: RegKind): Registration[];
  /** Increments on every change; schema caches key on it. */
  readonly version: number;
}

const TYPE_NAME = /^[a-z][a-z0-9-]{0,63}$|^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export function createRegistry(seed: Registration[] = []): Registry {
  const maps = new Map<RegKind, Map<string, Registration>>(REG_KINDS.map((k) => [k, new Map()]));
  /** bc registrations keyed `<physics type or *>|<bc type>`; one registration object may sit under several keys. */
  const bcs = new Map<string, Registration>();
  let version = 0;
  const byType = (a: Registration, b: Registration) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
  const bcList = () => [...new Set(bcs.values())].sort(byType);
  const reg: Registry = {
    register(r, opts = {}) {
      const m = maps.get(r.kind);
      if (!m) throw new Error(`unknown registry kind '${r.kind}'`);
      if (!TYPE_NAME.test(r.type)) throw new Error(`invalid ${r.kind} type name '${r.type}'`);
      if (r.kind === 'bc') {
        if (!r.select?.length) throw new Error(`bc type '${r.type}' needs select kinds`);
        const scopes = r.for?.length ? r.for : ['*'];
        const keys = scopes.map((p) => `${p}|${r.type}`);
        const taken = keys.filter((k) => bcs.has(k));
        if (taken.length && !opts.replace) throw new Error(`bc type '${r.type}' is already registered for physics ${taken.map((k) => `'${k.split('|')[0]}'`).join(', ')} (pass {replace: true} to supersede)`);
        const frozen = Object.freeze({ ...r, for: scopes });
        for (const k of keys) bcs.set(k, frozen);
        version++;
        return;
      }
      if (m.has(r.type) && !opts.replace) throw new Error(`${r.kind} type '${r.type}' is already registered (pass {replace: true} to supersede)`);
      if (r.kind === 'property' && !r.unit) throw new Error(`property '${r.type}' needs a reference unit`);
      if (r.kind === 'property' && r.scalar === false && !r.tensor && !r.value) throw new Error(`property '${r.type}': no value form (scalar false and no tensor)`);
      if (r.kind === 'coupling' && r.for && r.for.length !== 2) throw new Error(`coupling '${r.type}': for = [from type, to type]`);
      m.set(r.type, Object.freeze({ ...r }));
      version++;
    },
    unregister(kind, type) {
      let ok = false;
      if (kind === 'bc') { for (const k of [...bcs.keys()]) if (k.endsWith(`|${type}`)) { bcs.delete(k); ok = true; } }
      else ok = maps.get(kind)?.delete(type) ?? false;
      if (ok) version++;
      return ok;
    },
    get: (kind, type) => {
      if (kind !== 'bc') return maps.get(kind)?.get(type);
      const hits = bcList().filter((b) => b.type === type);
      return hits.length === 1 ? hits[0] : undefined;
    },
    getBc: (physicsType, type) => bcs.get(`${physicsType}|${type}`) ?? bcs.get(`*|${type}`),
    bcsFor: (physicsType) => {
      const out = new Map<string, Registration>();
      for (const [k, b] of bcs) { const [p, t] = k.split('|') as [string, string]; if (p === '*' && !out.has(t)) out.set(t, b); }
      for (const [k, b] of bcs) { const [p, t] = k.split('|') as [string, string]; if (p === physicsType) out.set(t, b); }
      return [...out.values()].sort(byType);
    },
    list: (kind) => (kind === 'bc' ? bcList() : [...(maps.get(kind)?.values() ?? [])].sort(byType)),
    get version() { return version; },
  };
  for (const r of seed) reg.register(r);
  return reg;
}
