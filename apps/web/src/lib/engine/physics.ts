// SPDX-License-Identifier: GPL-3.0-or-later
// Late binding to @amp/physics (L4): the glob is empty until packages/physics/src/index.ts exists, so the app builds and
// runs before L4 exports anything; once it does, its modules and registrations are used without an app change.
import type { PhysicsModule, RunContext } from '@amp/spec/types';
import type { Registry, Spec } from '@amp/spec';

export interface PhysicsExports {
	modules?: PhysicsModule[] | Record<string, PhysicsModule>;
	registerPhysics?: (r: Registry) => Registry;
	physicsRegistry?: () => Registry;
	register?: (r: Registry) => void;
	registerAll?: (r: Registry) => void;
	/** L4: prepareRun(specData, {hFactor, signal, T}) -> RunContext (+ notes) */
	prepareRun?: (a: { spec: Record<string, unknown>; physicsId?: string; hFactor?: number; signal?: AbortSignal; T?: number; case?: Record<string, unknown> }) => Promise<RunContext & { notes?: string[] }>;
	RESULT_NAMES?: Record<string, { fields: string[]; scalars: string[] }>;
}

const found = import.meta.glob<PhysicsExports>('../../../../../packages/physics/src/index.ts');

let cached: Promise<PhysicsExports | null> | null = null;

export function loadPhysics(): Promise<PhysicsExports | null> {
	const load = Object.values(found)[0];
	if (!load) return Promise.resolve(null);
	return (cached ??= load().catch((e) => {
		cached = null;
		console.warn('@amp/physics failed to load', e);
		return null;
	}));
}

export function moduleList(p: PhysicsExports | null): PhysicsModule[] {
	if (!p?.modules) return [];
	return Array.isArray(p.modules) ? p.modules : Object.values(p.modules);
}

export function findModule(p: PhysicsExports | null, type: string): PhysicsModule | null {
	return moduleList(p).find((m) => m.type === type) ?? null;
}

export type { RunContext, Spec };
