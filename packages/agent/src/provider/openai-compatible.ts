// SPDX-License-Identifier: GPL-3.0-or-later
// OpenAI-compatible Chat Completions adapter (`POST {baseURL}/chat/completions`), with a DeepSeek preset
// (DevLog-018). Bring-your-own key: the key is read from the KeyStore at call time and goes only into the
// Authorization header; error texts are redacted before they leave the adapter. The host injects `fetch`, so this
// package still makes no network call of its own.
//
// reasoning_content (DeepSeek thinking mode, https://api-docs.deepseek.com/guides/thinking_mode, accessed
// 2026-11-06): when a request carries `tools`, the reasoning_content of every previous assistant message "must be
// fully passed back to the API in all subsequent requests", also across user turns, else the API returns 400. Every
// request of the agent loop carries tools, so the default mode replays it: assistant messages produced by this adapter
// are resent as returned (content, reasoning_content, tool_calls). In the neutral history the reasoning travels as an
// opaque block, so a reasoning-only message (no text, no tool call) is not kept by the loop (DevLog-012 s.7.2 B1).
// Mode 'drop' omits the field, for providers that reject unknown message fields.
//
// Non-streaming (stream: false): onText receives the whole text once. Unparseable tool-call arguments re-issue the
// request at most `jsonRetries` times, then fail as `invalid_tool_input` (Chat Completions does not accept tool calls
// the model did not make, https://api-docs.deepseek.com/guides/tool_calls, so a broken call cannot be answered).

import type { KeyStore } from '../keys.ts';
import { wireProblems } from './wire.ts';
import { ProviderError, type Block, type Message, type Price, type ProviderAdapter, type ProviderRequest, type ProviderResponse, type SendOptions, type StopReason } from './types.ts';

export const OPENAI_COMPATIBLE_ID = 'openai-compatible';

/** Structural subset of `fetch` (the host passes `globalThis.fetch.bind(globalThis)`). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Time-of-use pricing: USD per 1M tokens at peak and off-peak, and the peak windows (UTC, Monday-Friday). */
export interface TimeOfUsePrice { peak: Price; offPeak: Price; peakWindowsUTC: Array<[number, number]>; peakDays: number[] }

export interface ProviderPreset {
  name: string;
  baseURL: string;
  model: string;
  prices: Record<string, TimeOfUsePrice>;
  pricingSource: { url: string; accessed: string; note: string };
  reasoning: 'replay' | 'drop';
  /** Extra body fields (provider specific). */
  extraBody: Record<string, unknown>;
}

/**
 * DeepSeek preset. Prices: https://api-docs.deepseek.com/quick_start/pricing, accessed 2026-11-06 (per 1M tokens,
 * deepseek-flash): input cache hit USD 0.006 peak / 0.003 off-peak, cache miss 0.3 / 0.15, output 1.2 / 0.6.
 * "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through
 * Friday, excluding Chinese public holidays." Holidays are not modelled, so time-of-use pricing here is an upper bound
 * of the billed price. The API returns the model id only (no version string); the pricing page lists the version
 * behind `deepseek-flash` as DeepSeek-V4.1-Flash-1017 (2026-11-06). deepseek-v4-pro (same page): hit 0.044 / 0.022,
 * miss 1.32 / 0.66, output 3.96 / 1.98.
 */
export const DEEPSEEK_PRESET: ProviderPreset = {
  name: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  prices: {
    'deepseek-flash': {
      peak: { input: 0.3, output: 1.2, cacheRead: 0.006 }, offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
      peakWindowsUTC: [[1, 4], [6, 10]], peakDays: [1, 2, 3, 4, 5],
    },
    'deepseek-v4-pro': {
      peak: { input: 1.32, output: 3.96, cacheRead: 0.044 }, offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
      peakWindowsUTC: [[1, 4], [6, 10]], peakDays: [1, 2, 3, 4, 5],
    },
  },
  pricingSource: { url: 'https://api-docs.deepseek.com/quick_start/pricing', accessed: '2026-11-06', note: 'USD per 1M tokens; Chinese public holidays (off-peak) not modelled' },
  reasoning: 'replay',
  // thinking on (the documented default) and effort high, sent explicitly so runs are reproducible
  extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
};

/** True when `at` falls in a peak window (UTC hour in [start, end), weekday in peakDays). */
export function isPeak(p: TimeOfUsePrice, at: Date): boolean {
  if (!p.peakDays.includes(at.getUTCDay())) return false;
  const h = at.getUTCHours() + at.getUTCMinutes() / 60;
  return p.peakWindowsUTC.some(([a, b]) => h >= a && h < b);
}

export interface OpenAICompatibleOptions {
  keys: KeyStore;
  fetch: FetchLike;
  preset?: ProviderPreset;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  /** 'peak' (default, an upper bound) or 'time-of-use' (price at the time price() is called; holidays ignored). */
  pricing?: 'peak' | 'time-of-use';
  reasoning?: 'replay' | 'drop';
  extraBody?: Record<string, unknown>;
  jsonRetries?: number;
  /** Clock for time-of-use pricing (tests). */
  now?: () => Date;
}

type OAIToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type OAIMessage = { role: string; content?: unknown; reasoning_content?: string | null; tool_calls?: OAIToolCall[]; tool_call_id?: string };

const imagePart = (mediaType: string, base64: string) => ({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } });

/** Neutral history -> Chat Completions messages (exported for tests). */
export function toOpenAIMessages(req: ProviderRequest, reasoning: 'replay' | 'drop'): OAIMessage[] {
  const out: OAIMessage[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'assistant') out.push(assistantParam(m, reasoning));
    else out.push(...userParams(m));
  }
  return out;
}

function assistantParam(m: Message, reasoning: 'replay' | 'drop'): OAIMessage {
  if (m.raw?.provider === OPENAI_COMPATIBLE_ID && m.raw.content[0]) {
    const r = { ...(m.raw.content[0] as OAIMessage) };
    if (reasoning === 'drop') delete r.reasoning_content;
    return r;
  }
  const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
  const calls: OAIToolCall[] = m.content.filter((b) => b.type === 'tool_use').map((b) => {
    const u = b as Extract<Block, { type: 'tool_use' }>;
    return { id: u.id, type: 'function', function: { name: u.name, arguments: typeof u.input === 'string' ? u.input : JSON.stringify(u.input ?? {}) } };
  });
  const rc = m.content.find((b) => b.type === 'opaque' && b.provider === OPENAI_COMPATIBLE_ID && b.kind === 'reasoning_content') as Extract<Block, { type: 'opaque' }> | undefined;
  return {
    role: 'assistant', content: text,
    ...(reasoning === 'replay' && rc && typeof rc.block === 'string' ? { reasoning_content: rc.block } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

function userParams(m: Message): OAIMessage[] {
  const out: OAIMessage[] = [];
  // tool results first: they must follow the assistant message that made the calls
  for (const b of m.content) {
    if (b.type !== 'tool_result') continue;
    const hasImage = b.content.some((c) => c.type === 'image');
    const content = hasImage
      ? b.content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : imagePart(c.mediaType, c.base64)))
      : b.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    out.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
  }
  const rest = m.content.filter((b) => b.type === 'text' || b.type === 'image');
  if (rest.length) {
    const onlyText = rest.every((b) => b.type === 'text');
    out.push({
      role: 'user',
      content: onlyText
        ? rest.map((b) => (b as { text: string }).text).join('\n\n')
        : rest.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : imagePart((b as { mediaType: string }).mediaType, (b as { base64: string }).base64))),
    });
  }
  return out;
}

/** Request body (exported for tests: the key must never appear in it). */
export function openaiBody(req: ProviderRequest, o: { model: string; maxTokens: number; reasoning: 'replay' | 'drop'; extraBody: Record<string, unknown> }): Record<string, unknown> {
  const tools = [...req.tools].sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  return {
    model: o.model,
    messages: toOpenAIMessages(req, o.reasoning),
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    max_tokens: req.maxTokens ?? o.maxTokens,
    stream: false,
    ...o.extraBody,
  };
}

const FINISH: Record<string, StopReason> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

class ToolJsonError extends Error {}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ProviderAdapter & { readonly preset: ProviderPreset | null } {
  const preset = opts.preset ?? null;
  const baseURL = (opts.baseURL ?? preset?.baseURL ?? '').replace(/\/+$/, '');
  const model = opts.model ?? preset?.model ?? '';
  if (!baseURL || !model) throw new Error('baseURL and model are required (or a preset)');
  const maxTokens = opts.maxTokens ?? 16000;
  const reasoning = opts.reasoning ?? preset?.reasoning ?? 'replay';
  const extraBody = opts.extraBody ?? preset?.extraBody ?? {};
  const jsonRetries = opts.jsonRetries ?? 2;
  const pricing = opts.pricing ?? 'peak';
  const now = opts.now ?? (() => new Date());

  const redact = (s: string): string => opts.keys.redact(s)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted key]');

  function httpError(status: number, bodyText: string): ProviderError {
    let msg = bodyText;
    try { const j = JSON.parse(bodyText) as { error?: { message?: unknown } }; if (typeof j?.error?.message === 'string') msg = j.error.message; } catch { /* keep text */ }
    msg = redact(msg).slice(0, 500);
    if (status === 401 || status === 403) return new ProviderError('auth', `authentication failed (${status}): ${msg}`, status);
    if (status === 402) return new ProviderError('billing', `insufficient balance (402): ${msg}`, status);
    if (status === 429) return new ProviderError('rate_limit', `rate limited (429): ${msg}`, status);
    if (status >= 500) return new ProviderError('server', `server error (${status}): ${msg}`, status);
    return new ProviderError('bad_request', `request rejected (${status}): ${msg}`, status);
  }
  function thrownError(e: unknown): ProviderError {
    if (e instanceof ProviderError) return e;
    if ((e as { name?: string })?.name === 'AbortError') return new ProviderError('aborted', 'request aborted');
    const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 500);
    if (e instanceof TypeError) return new ProviderError('network', `connection failed: ${msg}`);
    return new ProviderError('other', msg);
  }

  function parse(json: unknown): ProviderResponse & { reasoningTokens: number | null } {
    const j = json as {
      model?: string;
      choices?: Array<{ finish_reason?: string; message?: OAIMessage }>;
      usage?: { prompt_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const ch = j.choices?.[0];
    if (!ch?.message) throw new ProviderError('other', 'response has no choices[0].message');
    const msg = ch.message;
    if (ch.finish_reason === 'insufficient_system_resource') throw new ProviderError('server', 'generation interrupted: insufficient_system_resource');
    const content: Block[] = [];
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length) content.push({ type: 'opaque', provider: OPENAI_COMPATIBLE_ID, kind: 'reasoning_content', block: msg.reasoning_content });
    if (typeof msg.content === 'string' && msg.content.length) content.push({ type: 'text', text: msg.content });
    for (const c of msg.tool_calls ?? []) {
      let input: unknown;
      try { input = JSON.parse(c.function.arguments || '{}'); } catch { throw new ToolJsonError(c.function.name); }
      content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
    }
    const stop = FINISH[ch.finish_reason ?? ''] ?? 'other';
    const u = j.usage ?? {};
    const hit = u.prompt_cache_hit_tokens ?? 0;
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit);
    // raw keeps exactly what the docs say to send back: role, content, reasoning_content, tool_calls
    const raw: OAIMessage = { role: 'assistant', content: msg.content ?? '', ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}), ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) };
    return {
      content, raw: { provider: OPENAI_COMPATIBLE_ID, content: [raw] }, stopReason: stop,
      ...(stop === 'refusal' ? { stopDetails: { category: 'content_filter', explanation: null } } : {}),
      usage: { inputTokens: miss, outputTokens: u.completion_tokens ?? 0, cacheReadTokens: hit, cacheWriteTokens: 0 },
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
      model: j.model ?? model,
    };
  }

  return {
    id: preset ? `${OPENAI_COMPATIBLE_ID}:${preset.name}` : OPENAI_COMPATIBLE_ID,
    model,
    maxTokens,
    preset,
    price(m: string): Price | null {
      const p = preset?.prices[m];
      if (!p) return null;
      return pricing === 'time-of-use' && !isPeak(p, now()) ? p.offPeak : p.peak;
    },
    async send(req: ProviderRequest, so: SendOptions = {}): Promise<ProviderResponse> {
      const key = opts.keys.reveal();
      if (!key) throw new ProviderError('no_key', 'no API key set');
      const wire = wireProblems(req);
      if (wire.length) throw new ProviderError('bad_request', `invalid request built locally (not sent): ${wire.slice(0, 3).join('; ')}`);
      let body: string;
      try { body = JSON.stringify(openaiBody(req, { model, maxTokens, reasoning, extraBody })); } catch (e) { throw thrownError(e); }
      for (let attempt = 0; ; attempt++) {
        let status: number, text: string, ok: boolean;
        try {
          const r = await opts.fetch(`${baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body,
            ...(so.signal ? { signal: so.signal } : {}),
          });
          status = r.status; ok = r.ok; text = await r.text();
        } catch (e) { throw thrownError(e); }
        if (!ok) throw httpError(status, text);
        let json: unknown;
        try { json = JSON.parse(text); } catch { throw new ProviderError('other', `response is not JSON (${status})`); }
        try {
          const out = parse(json);
          const t = out.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
          if (t) so.onText?.(t);
          return out;
        } catch (e) {
          if (e instanceof ToolJsonError) {
            if (attempt < jsonRetries) continue;
            throw new ProviderError('invalid_tool_input', `tool call arguments were not parseable JSON after ${jsonRetries + 1} attempts (${redact(e.message).slice(0, 60)})`);
          }
          throw thrownError(e);
        }
      }
    },
  };
}
