// SPDX-License-Identifier: GPL-3.0-or-later
// Mounting the L9 chat panel (DevLog-012 s.6.1) on an open model: the agent writes through the model's own op log
// (ModelState.agentLog binds the actor), runs studies through the session's C6 worker, and navigates through the
// host's NavigationHost (calls recorded in the navigation trail). Bring-your-own key only: the key lives in memory
// unless the user ticks "remember on this device" (KeyStore opt-in); it is never rendered, logged or captured.
// The Anthropic SDK (1.1.0, exact pin) is imported only when the panel mounts without a test provider.
import type { ChatController, NavigationHost, ProviderAdapter, StudyOutcome, StudyRunner } from '@amp/agent';
import type { Session } from '../workbench/session.svelte';
import { agentStore } from './store.svelte';
import { agentResultsHost } from '../results/eval-host.ts';

export const DEFAULT_CAPS = { maxCostUSD: 1, maxSessionCostUSD: 5 };

function newSessionId(): string {
	const b = new Uint8Array(6);
	crypto.getRandomValues(b);
	return 's-' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** StudyRunner over the session's worker (C6): solves the current model text, first study (browser runner limit). */
export function studyRunner(s: Session, summarize: (sol: never) => unknown): StudyRunner {
	return {
		async run({ specText, studyId, signal }): Promise<StudyOutcome> {
			const studies = ((s.model.data as { studies?: Array<{ id: string }> } | null)?.studies ?? []);
			if (specText !== s.model.text) return { ok: false, study: studyId, stage: 'runner', message: 'the browser runner solves the current model text only' };
			if (studies[0]?.id !== studyId) return { ok: false, study: studyId, stage: 'runner', message: `the browser runner solves the first study (${studies[0]?.id ?? 'none'}) only` };
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

export async function mountPanel(s: Session, nav: (actor: string) => NavigationHost, o: { provider?: ProviderAdapter } = {}): Promise<ChatController> {
	const A = await import('@amp/agent');
	const sessionId = newSessionId();
	let backend;
	try { backend = await A.opfsBackend(); } catch { backend = A.memoryBackend(); }
	const common = {
		log: s.model.agentLog(sessionId),
		registry: s.model.reg,
		nav: nav(`agent:${sessionId}`),
		runner: studyRunner(s, A.summarizeSolution as never),
		// evaluate / get_table read the displayed dataset through the post worker (lane R3, DevLog-028)
		results: agentResultsHost(s),
		memoryBackend: backend,
		storage: window.localStorage,
		budget: { ...DEFAULT_CAPS },
		sessionId
	};
	let chat: ChatController;
	if (o.provider) chat = await A.mountAgent({ ...common, provider: o.provider });
	else {
		const { default: Anthropic } = await import('@anthropic-ai/sdk');
		chat = await A.mountAgent({
			...common,
			createClient: (opts) => new Anthropic(opts as never) as never,
			isApiError: (e) => e instanceof Anthropic.APIError,
			isToolInputParseError: (e) => e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)
		});
	}
	agentStore.chat = chat;
	return chat;
}
