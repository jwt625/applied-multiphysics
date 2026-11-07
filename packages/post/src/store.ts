// SPDX-License-Identifier: GPL-3.0-or-later
// Solution store: solutions by run id with their meshes; field lookup by name and step. Meshes are also kept by hash
// (bounded) so that `sample(solution, field, points)` works without passing the mesh. Physics modules attach the mesh
// to an in-process Solution as a non-enumerable `mesh` property (not transferred by structured clone).

import type { FieldData, Mesh, Solution } from '@amp/spec/types';

const MAX_MESHES = 16;
const meshes = new Map<string, Mesh>();

export function rememberMesh(mesh: Mesh): void {
  meshes.delete(mesh.hash);
  meshes.set(mesh.hash, mesh);
  while (meshes.size > MAX_MESHES) meshes.delete(meshes.keys().next().value!);
}

export function attachMesh(sol: Solution, mesh: Mesh): Solution {
  Object.defineProperty(sol, 'mesh', { value: mesh, enumerable: false, configurable: true, writable: true });
  rememberMesh(mesh);
  return sol;
}

export function meshOf(sol: Solution, mesh?: Mesh): Mesh {
  const m = mesh ?? (sol as Solution & { mesh?: Mesh }).mesh ?? meshes.get(sol.meshHash);
  if (!m) throw new Error(`no mesh for solution (meshHash ${sol.meshHash.slice(0, 12)}): pass it or attach it`);
  if (m.hash !== sol.meshHash) throw new Error('mesh hash does not match the solution');
  return m;
}

/**
 * Field by name (and step index for transient / eigen solutions; default: the last step present). `physics` selects the
 * fields of one physics of a merged multiphysics solution (C11: `FieldData.physics`; untagged fields belong to the
 * study's single physics). Without it, a name carried by fields of several physics is an error.
 */
export function fieldOf(sol: Solution, name: string, step?: number, physics?: string): FieldData {
  let all = sol.fields.filter((f) => f.name === name && (physics === undefined || f.physics === undefined || f.physics === physics));
  if (!all.length) throw new Error(`field '${name}' not in solution${physics !== undefined ? ` for physics '${physics}'` : ''} (have: ${[...new Set(sol.fields.map((f) => (f.physics ? `${f.physics}.${f.name}` : f.name)))].join(', ')})`);
  const tags = [...new Set(all.map((f) => f.physics).filter((x) => x !== undefined))];
  if (physics === undefined && tags.length > 1) throw new Error(`field '${name}' is solved by several physics (${tags.join(', ')}): write <physics id>.${name}`);
  if (physics !== undefined && all.some((f) => f.physics === physics)) all = all.filter((f) => f.physics === physics);
  if (step === undefined) return all.reduce((a, b) => ((b.step ?? -1) > (a.step ?? -1) ? b : a));
  const f = all.find((x) => (x.step ?? 0) === step)
    // merged multiphysics solution (C11): a stationary physics' field (no steps) holds for every step of the other one
    ?? (all.length === 1 && all[0]!.step === undefined && all[0]!.physics !== undefined && sol.fields.some((x) => x.physics !== all[0]!.physics && x.step !== undefined) ? all[0] : undefined);
  if (!f) throw new Error(`field '${name}' has no step ${step}`);
  return f;
}

export class SolutionStore {
  private runs = new Map<string, { solution: Solution; mesh: Mesh; label?: string }>();
  put(id: string, solution: Solution, mesh: Mesh, label?: string): void {
    if (mesh.hash !== solution.meshHash) throw new Error('store: mesh hash does not match the solution');
    this.runs.set(id, { solution, mesh, ...(label ? { label } : {}) });
    rememberMesh(mesh);
  }
  get(id: string) { const r = this.runs.get(id); if (!r) throw new Error(`store: no run '${id}'`); return r; }
  ids(): string[] { return [...this.runs.keys()]; }
  delete(id: string): boolean { return this.runs.delete(id); }
  field(id: string, name: string, step?: number): FieldData { return fieldOf(this.get(id).solution, name, step); }
}
