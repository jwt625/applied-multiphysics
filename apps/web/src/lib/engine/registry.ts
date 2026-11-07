// SPDX-License-Identifier: GPL-3.0-or-later
// The registry used by the app: L2's core + provisional wave-1 types, superseded by @amp/physics registrations when
// L4 exports them (their `{replace: true}` entries).
import { wave1Registry } from '@amp/spec/provisional';
import type { Registry } from '@amp/spec';
import type { PhysicsExports } from './physics';

export function appRegistry(p: PhysicsExports | null): { reg: Registry; source: string } {
	if (p?.physicsRegistry) return { reg: p.physicsRegistry(), source: '@amp/physics registry (wave-1 seed superseded by L4)' };
	const reg = wave1Registry();
	const fn = p?.register ?? p?.registerAll;
	if (fn) {
		fn(reg);
		return { reg, source: '@amp/spec wave-1 + @amp/physics registrations' };
	}
	return { reg, source: '@amp/spec wave-1 (provisional)' };
}
