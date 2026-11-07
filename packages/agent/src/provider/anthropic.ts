// SPDX-License-Identifier: GPL-3.0-or-later
// Anthropic Messages API adapter, called directly from the browser with the user's own key (DevLog-001 Q7).
// Written from the `claude-api` skill (loaded 2026-11-06): default model claude-opus-5-5, adaptive thinking, explicit
// effort (Opus 5.5 defaults to medium), streaming with finalMessage(), eager_input_streaming on every client tool
// (so inputs are validated client-side by the executor), prompt caching with a breakpoint on the last system block
// (tools render before system, so tools + system are cached together), server-side refusal fallbacks
// (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), refusal / max_tokens / unparseable tool input
// handled before any tool runs.
//
// The official SDK (`@anthropic-ai/sdk`) is not yet an approved dependency (DevLog-012 s.5), so the host constructs
// the client: `createClient: (o) => new Anthropic(o)`. The adapter passes exactly {apiKey, dangerouslyAllowBrowser},
// which makes the SDK send `anthropic-dangerous-direct-browser-access: true` (SDK src/client.ts, checked
// 2026-11-06). The key is read from the KeyStore at call time and handed only to that factory; error messages are
// redacted before they leave the adapter.

import type { KeyStore } from '../keys.ts';
import { ProviderError, type Block, type Message, type ProviderAdapter, type ProviderRequest, type ProviderResponse, type SendOptions, type StopReason } from './types.ts';

/** Structural subset of an SDK Message used here. */
export interface AnthropicMessageLike {
  model: string;
  content: Array<{ type: string; [k: string]: unknown }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

export interface AnthropicStreamLike {
  on(event: 'text', cb: (delta: string) => void): unknown;
  finalMessage(): Promise<AnthropicMessageLike>;
}

/** Structural subset of the SDK client (`client.beta.messages.stream`). */
export interface AnthropicClientLike {
  beta: { messages: { stream(body: Record<string, unknown>, options?: { signal?: AbortSignal }): AnthropicStreamLike } };
}

export interface AnthropicClientOptions { apiKey: string; dangerouslyAllowBrowser: true }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicAdapterOptions {
  keys: KeyStore;
  createClient: (o: AnthropicClientOptions) => AnthropicClientLike;
  /** Classifies SDK errors without string matching: `(e) => e instanceof Anthropic.APIError`. */
  isApiError?: (e: unknown) => boolean;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Server-side refusal fallback (default on, as the claude-api skill recommends for claude-opus-5-5). */
  fallbacks?: 'default' | 'off';
  /** Re-issue a turn whose tool input could not be parsed at all (eager input streaming), at most this many times. */
  jsonRetries?: number;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

function toParam(m: Message): Record<string, unknown> {
  if (m.role === 'assistant' && m.raw?.provider === 'anthropic') return { role: 'assistant', content: m.raw.content };
  const content = m.content.map((b): unknown => {
    switch (b.type) {
      case 'text': return { type: 'text', text: b.text };
      case 'image': return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.base64 } };
      case 'tool_use': return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      case 'tool_result': return {
        type: 'tool_result', tool_use_id: b.tool_use_id,
        content: b.content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.base64 } })),
        ...(b.is_error ? { is_error: true } : {}),
      };
      case 'opaque': return b.block;
    }
  });
  return { role: m.role, content };
}

function fromContent(content: AnthropicMessageLike['content']): Block[] {
  return content.map((b): Block => {
    if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input };
    return { type: 'opaque', provider: 'anthropic', kind: b.type, block: b };
  });
}

const STOPS: readonly StopReason[] = ['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn', 'stop_sequence'];

/** Build the Messages request body (exported for tests: the key must never appear in it). */
export function anthropicBody(req: ProviderRequest, o: { model: string; effort: Effort; maxTokens: number; fallbacks: 'default' | 'off' }): Record<string, unknown> {
  const tools = [...req.tools].sort((a, b) => (a.name < b.name ? -1 : 1)).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));
  return {
    model: o.model,
    max_tokens: req.maxTokens ?? o.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    tools,
    thinking: { type: 'adaptive' },
    output_config: { effort: o.effort },
    messages: req.messages.map(toParam),
    ...(o.fallbacks === 'default' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  };
}

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): ProviderAdapter {
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? 'high';
  const maxTokens = opts.maxTokens ?? 64000;
  const fallbacks = opts.fallbacks ?? 'default';
  const jsonRetries = opts.jsonRetries ?? 2;
  const redact = (s: string) => opts.keys.redact(s);

  function classify(e: unknown): ProviderError {
    const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
    const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 500);
    if ((e as { name?: string })?.name === 'AbortError') return new ProviderError('aborted', 'request aborted');
    if (status === 401 || status === 403) return new ProviderError('auth', `authentication failed (${status}): ${msg}`, status);
    if (status === 429) return new ProviderError('rate_limit', `rate limited (429): ${msg}`, status);
    if (status !== null && status >= 500) return new ProviderError('server', `server error (${status}): ${msg}`, status);
    if (status !== null && status >= 400) return new ProviderError('bad_request', `request rejected (${status}): ${msg}`, status);
    return new ProviderError(opts.isApiError?.(e) ? 'other' : 'network', msg, status);
  }

  return {
    id: 'anthropic',
    model,
    async send(req: ProviderRequest, so: SendOptions = {}): Promise<ProviderResponse> {
      const key = opts.keys.reveal();
      if (!key) throw new ProviderError('no_key', 'no API key set');
      const client = opts.createClient({ apiKey: key, dangerouslyAllowBrowser: true });
      const body = anthropicBody(req, { model, effort, maxTokens, fallbacks });
      for (let attempt = 0; ; attempt++) {
        let msg: AnthropicMessageLike;
        try {
          const stream = client.beta.messages.stream(body, so.signal ? { signal: so.signal } : undefined);
          if (so.onText) stream.on('text', so.onText);
          msg = await stream.finalMessage();
        } catch (e) {
          // Unparseable tool input (eager input streaming) is not an API error: re-issue the turn a bounded number of times.
          const api = opts.isApiError ? opts.isApiError(e) : typeof (e as { status?: unknown })?.status === 'number';
          if (!api && e instanceof SyntaxError && attempt < jsonRetries) continue;
          if (!api && e instanceof SyntaxError) throw new ProviderError('invalid_tool_input', 'tool input was not parseable JSON after retries');
          throw classify(e);
        }
        const stop = (STOPS as readonly string[]).includes(msg.stop_reason ?? '') ? (msg.stop_reason as StopReason) : 'other';
        return {
          content: fromContent(msg.content),
          raw: { provider: 'anthropic', content: msg.content },
          stopReason: stop,
          ...(stop === 'refusal' && msg.stop_details ? { stopDetails: { category: msg.stop_details.category ?? null, explanation: msg.stop_details.explanation ?? null } } : {}),
          usage: {
            inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
          },
          model: msg.model,
        };
      }
    },
  };
}

/**
 * Price table for the cost estimate shown to the user (USD per million tokens). Source: claude-api skill, model table
 * cached 2026-10-06 (first-party API rates). Cache writes (5 min TTL) at about 1.25x input, as the skill states.
 * An estimate only; unknown models give null (shown as N/A).
 */
export const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number | null }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: null },
};

export function estimateCostUSD(model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | null {
  const p = PRICES_USD_PER_MTOK[model];
  if (!p) return null;
  if (u.cacheReadTokens > 0 && p.cacheRead === null) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * (p.cacheRead ?? 0) + u.cacheWriteTokens * 1.25 * p.input) / 1e6;
}
