// SPDX-License-Identifier: GPL-3.0-or-later
// Provider-neutral conversation and adapter types. Adapters: Anthropic (DevLog-012) and OpenAI-compatible Chat
// Completions with a DeepSeek preset (DevLog-018); another provider plugs in by implementing ProviderAdapter. Blocks a provider needs back unchanged (thinking, fallback markers) travel
// as `opaque`, and an assistant message keeps the provider's raw content so it can be replayed byte for byte.

export interface TextBlock { type: 'text'; text: string }
export interface ImageBlock { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: Array<TextBlock | ImageBlock>; is_error?: boolean }
export interface OpaqueBlock { type: 'opaque'; provider: string; kind: string; block: unknown }
export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
  /** Assistant messages: the provider's own content array, replayed unchanged on the next request. */
  raw?: { provider: string; content: unknown[] };
}

export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }

export interface ProviderRequest {
  /** Frozen system prompt (cacheable: no timestamps or ids). */
  system: string;
  tools: ToolDef[];
  messages: Message[];
  maxTokens?: number;
}

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'stop_sequence' | 'other';

export interface ProviderResponse {
  content: Block[];
  raw?: { provider: string; content: unknown[] };
  stopReason: StopReason;
  stopDetails?: { category: string | null; explanation: string | null };
  usage: Usage;
  /** Model that served the response (may differ from the requested one after a server-side fallback). */
  model: string;
  /** Reasoning tokens inside outputTokens, when the provider reports them (OpenAI-compatible); null or absent otherwise. */
  reasoningTokens?: number | null;
}

export interface SendOptions { signal?: AbortSignal; onText?: (delta: string) => void }

export interface Price { input: number; output: number; cacheRead: number | null }

export interface ProviderAdapter {
  readonly id: string;
  /** Model requested; the response's `model` is the one that served (may differ after a server-side fallback). */
  readonly model: string;
  /** max_tokens of each request (the loop reserves its worst-case cost before a call). */
  readonly maxTokens?: number;
  /** USD per million tokens for a model id, or null when unknown (cost shown as N/A). */
  price?(model: string): Price | null;
  send(req: ProviderRequest, opts?: SendOptions): Promise<ProviderResponse>;
}

export type ProviderErrorKind = 'no_key' | 'auth' | 'rate_limit' | 'billing' | 'bad_request' | 'server' | 'network' | 'invalid_tool_input' | 'aborted' | 'other';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  constructor(kind: ProviderErrorKind, message: string, status: number | null = null) { super(message); this.kind = kind; this.status = status; }
}

export const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
