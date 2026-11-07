// SPDX-License-Identifier: GPL-3.0-or-later
// Scripted mock provider: replays hand-written model turns (no network, no cost). A step is a fixed response or a
// function of the request (so a scripted turn can quote a tool result, as a real model would). Every request is
// recorded (deep copy) so tests and eval checkers can inspect exactly what the model would have been sent.

import { wireProblems } from './wire.ts';
import { zeroUsage, type Block, type ProviderAdapter, type ProviderRequest, type ProviderResponse, type SendOptions, type StopReason, type Usage } from './types.ts';

export interface ScriptTurn { content: Block[]; stopReason?: StopReason; usage?: Partial<Usage>; model?: string; stopDetails?: { category: string | null; explanation: string | null } }
/** A scripted provider failure (thrown instead of a response), e.g. a ProviderError or an SDK-like error. */
export interface ScriptThrow { throws: unknown }
export type ScriptStep = ScriptTurn | ScriptThrow | ((req: ProviderRequest, call: number) => ScriptTurn | ScriptThrow);

export class ScriptExhausted extends Error {}

export class ScriptedProvider implements ProviderAdapter {
  readonly id = 'mock';
  readonly requests: ProviderRequest[] = [];
  /** Wire problems of every request received (audit B1); a correct loop leaves this empty. */
  readonly wireViolations: Array<{ call: number; problems: string[] }> = [];
  private i = 0;
  private steps: ScriptStep[];
  readonly model: string;
  private prices: Record<string, { input: number; output: number; cacheRead: number | null }>;
  readonly maxTokens: number;
  /** `prices` lets tests exercise the cost caps with a priced mock; the default mock is unpriced (cost N/A). */
  constructor(steps: ScriptStep[], model = 'mock-scripted', o: { prices?: Record<string, { input: number; output: number; cacheRead: number | null }>; maxTokens?: number } = {}) {
    this.steps = steps; this.model = model; this.prices = o.prices ?? {}; this.maxTokens = o.maxTokens ?? 16000;
  }
  price(m: string) { return this.prices[m] ?? null; }
  get remaining(): number { return this.steps.length - this.i; }
  async send(req: ProviderRequest, opts: SendOptions = {}): Promise<ProviderResponse> {
    if (opts.signal?.aborted) throw new Error('aborted');
    this.requests.push(structuredClone(req));
    const w = wireProblems(req);
    if (w.length) this.wireViolations.push({ call: this.requests.length, problems: w });
    const step = this.steps[this.i];
    if (!step) throw new ScriptExhausted(`script exhausted after ${this.i} turns`);
    const call = this.i++;
    const t = typeof step === 'function' ? step(req, call) : step;
    if ('throws' in t) throw t.throws;
    for (const b of t.content) if (b.type === 'text') opts.onText?.(b.text);
    const stop = t.stopReason ?? (t.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    return { content: structuredClone(t.content), stopReason: stop, ...(t.stopDetails ? { stopDetails: t.stopDetails } : {}), usage: { ...zeroUsage(), ...t.usage }, model: t.model ?? this.model };
  }
}

let n = 0;
/** Script helpers. */
export const say = (text: string): Block => ({ type: 'text', text });
export const use = (name: string, input: unknown, id = `toolu_${String(++n).padStart(4, '0')}`): Block => ({ type: 'tool_use', id, name, input });
export const turn = (...content: Block[]): ScriptTurn => ({ content });

/** Text of the last tool_result for a tool name in a request (for scripted turns that quote results). */
export function lastToolResult(req: ProviderRequest, toolName: string): string | null {
  const ids = new Map<string, string>();
  for (const m of req.messages) for (const b of m.content) if (b.type === 'tool_use') ids.set(b.id, b.name);
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j]!;
      if (b.type === 'tool_result' && ids.get(b.tool_use_id) === toolName) return b.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    }
  }
  return null;
}
