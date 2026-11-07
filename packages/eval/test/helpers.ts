// SPDX-License-Identifier: GPL-3.0-or-later
// Test fixtures: a minimal valid case and a throw-away repo root with cases and a mock @amp/physics.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function caseYaml(over: { metricId?: string; id?: string; cls?: string; ref?: number; tol?: string; spec?: string; extra?: string; refExtra?: string } = {}): string {
  const id = over.id ?? 'XX-01';
  return `schema: amp-eval/0
id: ${id}
class: ${over.cls ?? 'a'}
title: Synthetic test case
status: unvalidated
physics: [heat-cond]
dimension: 2D
units: SI
spec: ${over.spec ?? '{schema: amp-spec/0, physics: [{id: p1, type: mock}]}'}
references:
  - quantity: q
    metric_id: ${over.metricId ?? 'q'}
    value: ${over.ref ?? 1.0}
    unit: "1"
    tolerance: ${over.tol ?? '{rel: 1.0e-3, after: richardson}'}
    basis: D
    form: closed_form
    provenance: {citation: synthetic, locator: test, accessed: 2026-11-06}${over.refExtra ?? ''}
convergence: {levels_min: 3, ratio_min: 1.5, method: richardson_gci, h_factors: [1, 0.5, 0.25]}
rights: {source_license: synthetic, allowed: [cite_values], forbidden: []}
${over.extra ?? ''}`;
}

// Mock physics: q(h) = 1 + 0.1 h^2 with h = hFactor / 10, DOF = 1 / h^2 (2D), so Richardson recovers 1 exactly.
export const MOCK_PHYSICS = `
export const modules = [{
  type: 'mock', dims: ['2d'],
  readiness: () => ({ ready: true, reasons: [] }),
  async run(ctx) {
    const h = ctx.mesh.h;
    return {
      meshHash: 'm' + h, fields: [], scalars: { q: { value: 1 + 0.1 * h * h, unit: '1' } },
      stats: { dof: Math.round(1 / (h * h)), solver: 'mock' }, timing: { assemble: 1, solve: 2 },
      run: { engine: '@amp/physics@mock', specHash: 's', meshHash: 'm' + h, startedAt: '2026-11-06T00:00:00-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' },
    };
  },
}];
export async function prepareRun({ spec, hFactor, signal }) {
  return { spec, mesh: { h: hFactor / 10 }, materials: {}, study: {}, progress() {}, signal };
}
`;

// Mock @amp/spec: accepts any object spec; units: identity for equal strings, degC <-> K affine.
const MOCK_SPEC = `
export function validateSpec(data) { return { ok: true, spec: data, issues: [] }; }
export function parseSpecText() { return { ok: false, spec: null, issues: [{ dotted: '', message: 'mock' }] }; }
export function formatIssues(i) { return i.map((x) => x.message).join('\\n'); }
export const units = {
  parseUnit(u) { if (u === 'degC') return { dim: [0, 0, 0, 0, 1], factor: 1, offset: 273.15 }; if (u === 'K') return { dim: [0, 0, 0, 0, 1], factor: 1, offset: 0 };
    if (u === 'mm') return { dim: [1, 0, 0, 0, 0], factor: 1e-3, offset: 0 }; if (u === 'm') return { dim: [1, 0, 0, 0, 0], factor: 1, offset: 0 };
    if (u === '1') return { dim: [0, 0, 0, 0, 0], factor: 1, offset: 0 }; throw new Error('unknown unit ' + u); },
  dimEq(a, b) { return a.every((x, i) => x === b[i]); },
};
`;
const MOCK_SPEC_PROV = `export function wave1Registry() { return { get() {}, list() { return []; }, register() {} }; }`;

export interface Fixture { root: string; out: string; write(rel: string, text: string): void; cleanup(): void }

export function makeRoot(opts: { physics?: boolean; physicsSrc?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'amp-eval-test-'));
  const out = join(root, 'out');
  mkdirSync(out, { recursive: true });
  for (const c of ['a', 'b', 'c']) mkdirSync(join(root, 'eval', 'cases', c), { recursive: true });
  mkdirSync(join(root, 'eval', 'expected'), { recursive: true });
  const write = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  write('packages/spec/package.json', JSON.stringify({ name: '@amp/spec', version: '0.0.0-mock', type: 'module', exports: { '.': './src/index.mjs', './provisional': './src/prov.mjs' } }));
  write('packages/spec/src/index.mjs', MOCK_SPEC);
  write('packages/spec/src/prov.mjs', MOCK_SPEC_PROV);
  if (opts.physics !== false) {
    write('packages/physics/package.json', JSON.stringify({ name: '@amp/physics', version: '0.0.0-mock', type: 'module', exports: { '.': './src/index.mjs' } }));
    write('packages/physics/src/index.mjs', opts.physicsSrc ?? MOCK_PHYSICS);
  }
  return { root, out, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
