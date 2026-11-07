// SPDX-License-Identifier: GPL-3.0-or-later
// Real-time kernels of @amp/rt (L6, DevLog-005) as Play panels. Parameter spans, presets and grids follow the L6 demo
// (packages/rt/demo/app.js); they are UI choices or benchmark settings documented there, not new physical values.
import type { RealtimeKernelExt } from '@amp/rt';

export const RT_KERNELS = ['lbm-d2q9', 'fdtd-tmz', 'gray-scott'] as const;
export type RtKernelId = (typeof RT_KERNELS)[number];

export interface RtParam { id: string; label: string; unit: string; min: number; max: number; step: number; value: number; tip: string; reinit?: boolean }
export interface RtDef {
	title: string;
	style: 'lbm' | 'fdtd' | 'none';
	view: string;
	autoRange: boolean;
	params: RtParam[];
	tools: Array<[string, string, string]>;
	presets: Array<[string, Record<string, number>, string]>;
	caveat: string;
	make(device: GPUDevice, P: Record<string, number>, rt: typeof import('@amp/rt')): Promise<RealtimeKernelExt>;
	live(k: RealtimeKernelExt, P: Record<string, number>): void;
	paintTool(tool: string): string;
	phys(k: RealtimeKernelExt, i: number, j: number): [number, number, string];
}

export const RT_DEFS: Record<RtKernelId, RtDef> = {
	'lbm-d2q9': {
		title: 'LBM D2Q9: flow past a cylinder',
		style: 'lbm',
		view: 'vorticity',
		autoRange: false,
		params: [
			{ id: 'nD', label: 'D', unit: 'cells', min: 10, max: 80, step: 10, value: 40, reinit: true, tip: 'Cylinder diameter in cells. Channel 22 D x 4.1 D (DFG 2D-2: 2.2 m x 0.41 m, D = 0.1 m)' },
			{ id: 'Re', label: 'Re', unit: '1', min: 10, max: 1000, step: 1, value: 100, tip: 'Reynolds number U_mean D / nu (sets the lattice viscosity; tau -> 0.5 at high Re is unstable)' },
			{ id: 'uMax', label: 'u_max', unit: 'lattice', min: 0.02, max: 0.15, step: 0.005, value: 0.1, tip: 'Peak inlet velocity in lattice units; Mach = u_max sqrt(3)' },
			{ id: 'spf', label: 'steps/frame', unit: '1', min: 1, max: 200, step: 1, value: 40, tip: 'Time steps per displayed frame' }
		],
		tools: [['obstacle', 'obstacle', 'Draw a solid obstacle (bounce-back)'], ['erase', 'erase', 'Remove obstacles']],
		presets: [
			['DFG 2D-2', { nD: 40, Re: 100, uMax: 0.1 }, 'Schafer-Turek benchmark 2D-2, Re 100 (St 0.295-0.305)'],
			['Re 20 steady', { nD: 40, Re: 20, uMax: 0.1 }, 'DFG 2D-1 Reynolds number: steady wake'],
			['Re 250', { nD: 40, Re: 250, uMax: 0.08 }, 'Stronger shedding']
		],
		caveat: 'realtime fidelity. Strouhal gate FL-04 passes (DevLog-005); drag and lift are not validated (staircase cylinder, c_D,max +5.9 %, c_L,max +12 % vs FEATFLOW at D 60).',
		async make(device, P, rt) {
			const { grid, params } = rt.dfgGrid(P.nD!);
			const k = new rt.LbmD2Q9();
			await k.init(device, { ...params, Re: P.Re!, uMax: P.uMax!, probeX: -1, probeY: -1 }, grid);
			return k as unknown as RealtimeKernelExt;
		},
		live(k, P) { k.setParams({ Re: P.Re!, uMax: P.uMax! }); },
		paintTool: (t) => (t === 'erase' ? 'erase' : 'obstacle'),
		phys: (k, i, j) => [i * k.grid.dx, (j - 0.5) * k.grid.dx, 'm']
	},
	'fdtd-tmz': {
		title: 'FDTD TMz: 2D waves',
		style: 'fdtd',
		view: 'ez',
		autoRange: true,
		params: [
			{ id: 'freq', label: 'f', unit: 'GHz', min: 1, max: 40, step: 0.1, value: 10, tip: 'Source frequency (CW); lambda0 = c0 / f' },
			{ id: 'pml', label: 'CPML', unit: 'cells', min: 0, max: 30, step: 1, value: 12, reinit: true, tip: 'CPML thickness (PEC-backed); 0 = PEC box' },
			{ id: 'spf', label: 'steps/frame', unit: '1', min: 1, max: 40, step: 1, value: 4, tip: 'Time steps per displayed frame (S = c0 dt / dx = 0.5)' }
		],
		tools: [['pec', 'PEC', 'Perfect electric conductor'], ['dielectric', 'dielectric', 'Lossless dielectric, eps_r 4'], ['erase', 'erase', 'Back to vacuum']],
		presets: [['point source', { scene: 0 }, 'Point source in free space']],
		caveat: 'realtime fidelity. Dispersion, CPML normal-incidence and PEC cavity gates pass (DevLog-005); oblique CPML reflection is not gated.',
		async make(device, P, rt) {
			const grid = { nx: 640, ny: 400, dx: 1e-3 };
			const k = new rt.FdtdTMz();
			await k.init(device, { freq: P.freq! * 1e9, srcType: 0, pml: P.pml!, srcX: 200, srcY: grid.ny / 2 }, grid);
			return k as unknown as RealtimeKernelExt;
		},
		live(k, P) { k.setParams({ freq: P.freq! * 1e9, srcType: 0 }); },
		paintTool: (t) => t,
		phys: (k, i, j) => [i * k.grid.dx, j * k.grid.dx, 'm']
	},
	'gray-scott': {
		title: 'Gray-Scott reaction-diffusion',
		style: 'none',
		view: 'v',
		autoRange: false,
		params: [
			{ id: 'f', label: 'f', unit: '1', min: 0.005, max: 0.1, step: 0.0005, value: 0.03, tip: 'Feed rate (The Well model units)' },
			{ id: 'k', label: 'k', unit: '1', min: 0.03, max: 0.075, step: 0.0005, value: 0.062, tip: 'Kill rate (The Well model units)' },
			{ id: 'spf', label: 'steps/frame', unit: '1', min: 1, max: 200, step: 1, value: 40, tip: 'Time steps (dt = 1) per displayed frame' }
		],
		tools: [['seed', 'seed', 'u = 0.5, v = 0.25'], ['erase', 'erase', 'u = 1, v = 0']],
		presets: [],
		caveat: 'realtime fidelity, model units (The Well domain). GPU vs CPU and pattern-class gates pass (DevLog-005); no pointwise match to The Well frames (explicit Euler vs ETDRK4).',
		async make(device, P, rt) {
			const k = new rt.GrayScott();
			await k.init(device, { f: P.f!, k: P.k!, ic: 0, blobs: 480, sigma: 0.04, seed: 7 }, { nx: 512, ny: 512, dx: 1 / 64 });
			return k as unknown as RealtimeKernelExt;
		},
		live(k, P) { k.setParams({ f: P.f!, k: P.k! }); },
		paintTool: (t) => t,
		phys: (k, i, j) => [i * k.grid.dx, j * k.grid.dx, 'model units']
	}
};
