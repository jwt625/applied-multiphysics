// SPDX-License-Identifier: GPL-3.0-or-later
// Provider choice of the agent panel (DevLog-053): Anthropic, DeepSeek (OpenAI-compatible preset) or a custom
// OpenAI-compatible endpoint. Bring-your-own key only (DevLog-001 Q7): each provider keeps its own key name in the
// KeyStore (memory by default, localStorage after the explicit opt-in), a custom endpoint one per origin, so a key is
// never sent to another host than the one it was entered for. The choice itself (not secret) is kept in localStorage.
// Network: the page CSP `connect-src` lists this origin and the preset hosts only. A custom endpoint works only when
// its origin is allowed by the page CSP (a self-hosted build adds it in vite.config.ts and static/_headers); the panel
// checks it before mounting and sends nothing to a blocked origin. No runtime import of @amp/agent here (bundle).

export type ProviderId = 'anthropic' | 'deepseek' | 'custom';
export interface ProviderChoice { id: ProviderId; model?: string; baseURL?: string }

export const PROVIDER_STORAGE = 'amp.agent.provider';
export const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: 'Anthropic', deepseek: 'DeepSeek', custom: 'OpenAI-compatible' };
/** Endpoint origins of the presets; the build CSP connect-src lists exactly these besides 'self'. */
export const PRESET_ORIGINS = { anthropic: 'https://api.anthropic.com', deepseek: 'https://api.deepseek.com' } as const;
/** connect-src of the build (vite.config.ts kit.csp and static/_headers; a test keeps the three in step). */
export const BUILD_CONNECT_SRC: readonly string[] = ["'self'", PRESET_ORIGINS.anthropic, PRESET_ORIGINS.deepseek];

interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function loadChoice(storage: KV | null | undefined): ProviderChoice {
	try {
		const v = JSON.parse(storage?.getItem(PROVIDER_STORAGE) ?? 'null') as Partial<ProviderChoice> | null;
		if (v && (v.id === 'anthropic' || v.id === 'deepseek' || v.id === 'custom')) {
			return { id: v.id, ...(typeof v.model === 'string' && v.model ? { model: v.model } : {}), ...(typeof v.baseURL === 'string' && v.baseURL ? { baseURL: v.baseURL } : {}) };
		}
	} catch { /* storage blocked or bad JSON: default */ }
	return { id: 'anthropic' };
}

export function saveChoice(storage: KV | null | undefined, c: ProviderChoice): void {
	try { storage?.setItem(PROVIDER_STORAGE, JSON.stringify(c)); } catch { /* storage blocked: the choice lasts for this page */ }
}

/** A custom base URL: https only, no credentials, query or fragment; trailing slashes removed. */
export function normalizeBaseURL(raw: string): { ok: true; url: string; origin: string } | { ok: false; message: string } {
	let u: URL;
	try { u = new URL(raw.trim()); } catch { return { ok: false, message: 'not a URL' }; }
	if (u.protocol !== 'https:') return { ok: false, message: 'https only (the key travels in a header)' };
	if (u.username || u.password) return { ok: false, message: 'no credentials in the URL' };
	if (u.search || u.hash) return { ok: false, message: 'no query or fragment' };
	return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, origin: u.origin };
}

/** connect-src sources of a CSP string (null when the directive is absent). */
export function connectSrcOf(csp: string): string[] | null {
	for (const d of csp.split(';')) {
		const t = d.trim().split(/\s+/);
		if (t[0]?.toLowerCase() === 'connect-src') return t.slice(1);
	}
	return null;
}

/** connect-src the page runs under: its CSP meta tag (prerendered pages), else the build list. */
export function pageConnectSrc(doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document): { sources: string[]; from: 'meta' | 'build' } {
	const meta = doc?.querySelector('meta[http-equiv="content-security-policy" i]')?.getAttribute('content') ?? null;
	const src = meta ? connectSrcOf(meta) : null;
	return src ? { sources: src, from: 'meta' } : { sources: [...BUILD_CONNECT_SRC], from: 'build' };
}

/**
 * True when a request to `url` is allowed by connect-src `sources` (CSP Level 3 source matching, the subset used
 * here): 'self', '*' (network schemes), a scheme source (`https:`), a host source with optional scheme, `*.` host
 * wildcard, port and path prefix. 'none' allows nothing.
 */
export function connectAllowed(url: string, sources: readonly string[], selfOrigin: string): boolean {
	let u: URL;
	try { u = new URL(url); } catch { return false; }
	const self = new URL(selfOrigin);
	for (const raw of sources) {
		const s = raw.trim();
		const low = s.toLowerCase();
		if (low === "'none'") continue;
		if (low === "'self'") { if (u.origin === self.origin) return true; continue; }
		if (s === '*') { if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'wss:' || u.protocol === 'ws:') return true; continue; }
		if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) { if (u.protocol === low) return true; continue; }
		const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/i.exec(s);
		if (!m) continue;
		const [, scheme, wild, host, port, path] = m;
		if (scheme ? u.protocol !== `${scheme.toLowerCase()}:` : u.protocol !== self.protocol && u.protocol !== 'https:') continue;
		const h = u.hostname.toLowerCase(), hs = host!.toLowerCase();
		if (wild ? !h.endsWith(`.${hs}`) : h !== hs) continue;
		const defPort = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
		if (port !== '*' && (u.port || defPort) !== (port ?? defPort)) continue;
		if (path && path !== '/' && !(path.endsWith('/') ? u.pathname.startsWith(path) : u.pathname === path)) continue;
		return true;
	}
	return false;
}

/** The URL the adapter posts to for a choice (Anthropic: the Messages API host). */
export function endpointOf(c: ProviderChoice): string | null {
	if (c.id === 'anthropic') return `${PRESET_ORIGINS.anthropic}/v1/messages`;
	if (c.id === 'deepseek') return `${PRESET_ORIGINS.deepseek}/chat/completions`;
	const b = c.baseURL ? normalizeBaseURL(c.baseURL) : null;
	return b?.ok ? `${b.url}/chat/completions` : null;
}

/** Why a choice cannot be mounted (null: it can): a custom endpoint needs a valid https base URL, a model id, and an
 *  origin the page CSP allows. */
export function choiceProblem(c: ProviderChoice, sources: readonly string[], selfOrigin: string): string | null {
	if (c.id !== 'custom') return null;
	if (!c.baseURL) return 'set a base URL';
	const b = normalizeBaseURL(c.baseURL);
	if (!b.ok) return `base URL: ${b.message}`;
	if (!c.model?.trim()) return 'set a model id';
	if (!connectAllowed(`${b.url}/chat/completions`, sources, selfOrigin)) return `${b.origin} is not allowed by this page's Content-Security-Policy (connect-src ${sources.join(' ')}); a self-hosted build can add it`;
	return null;
}
