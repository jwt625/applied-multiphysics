// SPDX-License-Identifier: GPL-3.0-or-later
// Mounting the L9 chat panel (DevLog-012 s.6.1) on an open model: the agent writes through the model's own op log
// (ModelState.agentLog binds the actor), runs studies through the session's C6 worker, and navigates through the
// host's NavigationHost (calls recorded in the navigation trail). Bring-your-own key only: the key lives in memory
// unless the user ticks "remember on this device" (KeyStore opt-in); it is never rendered, logged or captured.
// The Anthropic SDK (1.1.0, exact pin) is imported only when the Anthropic provider is mounted. DeepSeek and custom
// OpenAI-compatible endpoints use the @amp/agent adapter over the page's fetch (DevLog-018, DevLog-053), each with its
// own key name. The agent's navigation host is the view's host plus the parity methods (state/nav.svelte.ts
// agentNavHost): cancel, sweep point, probes, quick view, camera presets of the 3D view.
import type { ChatController, NavigationHost, ProviderAdapter, ProviderPreset, StudyOutcome, StudyRunner } from '@amp/agent';
import { modelEditor } from './editor.ts';
import type { Session } from '../workbench/session.svelte';
import { agentStore } from './store.svelte';
import { agentResultsHost } from '../results/eval-host.ts';
import { agentNavHost, type CameraFn } from '../state/nav.svelte';
import { PRESET_ORIGINS, normalizeBaseURL, type ProviderChoice } from './providers';

export const DEFAULT_CAPS = { maxCostUSD: 1, maxSessionCostUSD: 5 };

function newSessionId(): string {
	const b = new Uint8Array(6);
	crypto.getRandomValues(b);
	return 's-' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** StudyRunner over the session's worker (C6): solves the current model text; any study of the spec (run_study's
 *  `study` becomes the workbench study choice, so the picker, plots and tables follow it; DevLog-040). */
export function studyRunner(s: Session, summarize: (sol: never) => unknown): StudyRunner {
	return {
		// run_study without a study: the workbench picker's study (DevLog-053)
		defaultStudy: () => s.runStudy,
		async run({ specText, studyId, signal }): Promise<StudyOutcome> {
			const studies = ((s.model.data as { studies?: Array<{ id: string }> } | null)?.studies ?? []);
			if (specText !== s.model.text) return { ok: false, study: studyId, stage: 'runner', message: 'the browser runner solves the current model text only' };
			if (!studies.some((x) => x.id === studyId)) return { ok: false, study: studyId, stage: 'runner', message: `no study '${studyId}' (studies: ${studies.map((x) => x.id).join(', ') || 'none'})` };
			s.study = studyId;
			const onAbort = () => s.cancel();
			signal.addEventListener('abort', onAbort, { once: true });
			try {
				const o = await s.compute();
				if (o.kind === 'result') return { ok: true, study: studyId, solution: summarize(o.solution as never) as never };
				if (o.kind === 'unavailable') return { ok: false, study: studyId, stage: 'readiness', message: o.reasons.join('; ') };
				if (o.kind === 'error') return { ok: false, study: studyId, stage: o.stage ?? 'run', message: o.message };
				return { ok: false, study: studyId, stage: 'run', message: 'cancelled' };
			} finally {
				signal.removeEventListener('abort', onAbort);
			}
		}
	};
}

/** setCameraPreset of gfx/camera.ts when that module exists (a glob import: no build error while it is absent). */
async function loadCamera(): Promise<CameraFn | null> {
	let mods: Record<string, () => Promise<unknown>> = {};
	try { mods = import.meta.glob('../gfx/camera.ts'); } catch { /* not under Vite */ }
	const load = Object.values(mods)[0];
	if (!load) return null;
	try {
		const m = (await load()) as { setCameraPreset?: unknown };
		return typeof m.setCameraPreset === 'function' ? (m.setCameraPreset as CameraFn) : null;
	} catch { return null; }
}

/** Preset of a custom OpenAI-compatible endpoint: no price table (cost N/A), reasoning field not replayed, no extra
 *  body fields. The name carries the origin, so the key store name is per origin. */
export function customPreset(baseURL: string, model: string): ProviderPreset {
	const b = normalizeBaseURL(baseURL);
	if (!b.ok) throw new Error(`base URL: ${b.message}`);
	return { name: `custom:${b.origin}`, baseURL: b.url, model, prices: {}, pricingSource: { url: '', accessed: '', note: 'no price table: cost N/A' }, reasoning: 'drop', extraBody: {} };
}

/** Endpoint and price facts of a mounted choice, for the panel's tooltip. */
export interface ProviderAbout { endpoint: string; model: string; price: string }

export async function mountPanel(s: Session, nav: (actor: string) => NavigationHost, o: { provider?: ProviderAdapter; choice?: ProviderChoice } = {}): Promise<{ chat: ChatController; about: ProviderAbout | null }> {
	const A = await import('@amp/agent');
	const sessionId = newSessionId();
	let backend;
	try { backend = await A.opfsBackend(); } catch { backend = A.memoryBackend(); }
	const actor = `agent:${sessionId}`;
	const camera = await loadCamera();
	const common = {
		log: s.model.agentLog(sessionId),
		registry: s.model.reg,
		nav: agentNavHost(nav(actor), actor, { session: s, camera }),
		runner: studyRunner(s, A.summarizeSolution as never),
		// evaluate / get_table read the displayed dataset through the post worker (lane R3, DevLog-028)
		results: agentResultsHost(s),
		editor: modelEditor(s.model.reg, (id) => { s.study = id; }),
		memoryBackend: backend,
		storage: window.localStorage,
		budget: { ...DEFAULT_CAPS },
		sessionId
	};
	let chat: ChatController;
	let about: ProviderAbout | null = null;
	const c = o.choice ?? { id: 'anthropic' };
	if (o.provider) chat = await A.mountAgent({ ...common, provider: o.provider });
	else if (c.id === 'deepseek' || c.id === 'custom') {
		const preset = c.id === 'deepseek' ? A.DEEPSEEK_PRESET : customPreset(c.baseURL ?? '', c.model ?? '');
		const model = c.id === 'deepseek' && c.model && c.model in preset.prices ? c.model : preset.model;
		chat = await A.mountAgent({ ...common, openaiCompatible: { preset, fetch: globalThis.fetch.bind(globalThis), model, ...(c.id === 'deepseek' ? { pricing: 'time-of-use' as const } : {}) } });
		const p = preset.prices[model];
		about = {
			endpoint: `${preset.baseURL}/chat/completions`, model,
			price: p ? `USD per 1M tokens, peak / off-peak: input ${p.peak.input} / ${p.offPeak.input}, cached input ${p.peak.cacheRead ?? 'N/A'} / ${p.offPeak.cacheRead ?? 'N/A'}, output ${p.peak.output} / ${p.offPeak.output}; cost estimated at the time-of-use rate (holidays not modelled). Source: ${preset.pricingSource.url}, accessed ${preset.pricingSource.accessed}` : 'no price table: cost N/A'
		};
	} else {
		const { default: Anthropic } = await import('@anthropic-ai/sdk');
		chat = await A.mountAgent({
			...common,
			createClient: (opts) => new Anthropic(opts as never) as never,
			isApiError: (e) => e instanceof Anthropic.APIError,
			isToolInputParseError: (e) => e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)
		});
	}
	if (!o.provider && c.id === 'anthropic') {
		const model = chat.agent.provider.model, p = chat.agent.provider.price?.(model) ?? null;
		about = { endpoint: `${PRESET_ORIGINS.anthropic}/v1/messages`, model, price: p ? `USD per 1M tokens: input ${p.input}, cached input ${p.cacheRead ?? 'N/A'}, output ${p.output} (adapter price table)` : 'no price table: cost N/A' };
	}
	agentStore.chat = chat;
	return { chat, about };
}
