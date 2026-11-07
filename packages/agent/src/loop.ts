// SPDX-License-Identifier: GPL-3.0-or-later
// Agent loop (DevLog-012 s.1.5; R5 s.3: execution feedback is the largest measured lever, FoamBench/2609.03718).
//   1. context: spec digest + memory index + recalled entries, all inside one untrusted block, then the user's request
//   2. model turn -> tool calls (executed in order) -> results -> next model turn ...
//   3. when the model stops, a check runs: validation of the spec this turn edited, the outcome of the last run_study
//      of this turn (error, failed eval gates) and an optional user goal. Problems go back to the model as a
//      structured feedback message (repair), at most maxRepairs times.
// Bounds: model calls, tool calls, repairs, optional token and cost caps. Every model call emits a budget event with
// tokens and an estimated cost (estimate; N/A for models without a price entry).

import { specHash, resultNodes } from '@amp/spec';
import { SYSTEM_PROMPT } from './prompt.ts';
import { toolDefinitions } from './tools/defs.ts';
import { toolText, untrustedBlock, structuredIssues } from './untrusted.ts';
import { recall } from './memory/recall.ts';
import { zeroUsage, type Block, type Message, type ProviderAdapter, type ToolResultBlock, type Usage } from './provider/types.ts';
import type { AgentSession, ToolOutput } from './session.ts';
import type { StudyOutcome } from './runner.ts';

export interface Budget {
  maxModelCalls: number; maxToolCalls: number; maxRepairs: number; maxOutputTokens?: number;
  /** Per-turn cap in USD (estimate). Checked before every call against spent + the next call's worst case. */
  maxCostUSD?: number;
  /** Cap over all turns of this Agent in USD (estimate). */
  maxSessionCostUSD?: number;
}
/**
 * Defaults (DevLog-012 s.7.2). Cost caps: USD 1.00 per turn, USD 5.00 per session, estimates at the claude-api skill
 * price table (cached 2026-10-06). With max_tokens 16,000 the output worst case of one claude-opus-5-5 call is
 * 16,000 x 20 / 1e6 = USD 0.32, so a turn can always make at least two worst-case calls (plus input) before the cap,
 * and the uncapped worst case the audit computed (12 calls x 64,000 tokens = USD 15.36 output) cannot happen.
 * The user changes both in the panel.
 */
export const DEFAULT_BUDGET: Budget = { maxModelCalls: 12, maxToolCalls: 40, maxRepairs: 2, maxCostUSD: 1, maxSessionCostUSD: 5 };

export type StopKind = 'end_turn' | 'refusal' | 'truncated' | 'budget_model_calls' | 'budget_tool_calls' | 'budget_tokens' | 'budget_cost' | 'aborted' | 'provider_error' | 'unresolved' | 'blocked_secret' | 'unexpected_stop';

export interface BudgetState {
  turn: number; modelCalls: number; toolCalls: number; repairs: number; usage: Usage;
  /** Estimate, priced by the model that served each call; null (N/A) when any call's model has no price. */
  costUSD: number | null;
  sessionCostUSD: number | null;
  budget: Budget;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; isError: boolean }
  | { type: 'repair'; problems: string[] }
  | { type: 'budget'; state: BudgetState }
  | { type: 'stop'; stop: StopKind; message?: string };

/** A user-stated goal checked after the turn (e.g. "K_t within 1 % of 3"). `check` sees the latest outcomes. */
export interface Goal { describe: string; check(outcomes: StudyOutcome[]): { ok: boolean; detail: string } }

export interface TurnResult {
  stop: StopKind;
  text: string;
  specOps: number[];
  memoryOps: number[];
  toolCalls: Array<{ name: string; input: unknown; isError: boolean }>;
  repairs: number;
  usage: Usage;
  costUSD: number | null;
  problems: string[];
  message?: string;
}

export interface AgentOptions { session: AgentSession; provider: ProviderAdapter; budget?: Partial<Budget>; onEvent?: (e: AgentEvent) => void; recallLimit?: number }

const enc = new TextEncoder();
/** Input tokens of a request, estimated as bytes / 4 (not a tokenizer count). */
const estimateTokens = (x: unknown): number => Math.ceil(enc.encode(JSON.stringify(x)).length / 4);
const costOf = (p: { input: number; output: number; cacheRead: number | null } | null, u: Usage): number | null => {
  if (!p) return null;
  if (u.cacheReadTokens > 0 && p.cacheRead === null) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * (p.cacheRead ?? 0) + u.cacheWriteTokens * 1.25 * p.input) / 1e6;
};

const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens });

export class Agent {
  readonly session: AgentSession;
  readonly provider: ProviderAdapter;
  readonly messages: Message[] = [];
  readonly budget: Budget;
  private onEvent: (e: AgentEvent) => void;
  private recallLimit: number;
  /** Prompt inspector: the memory entries included in each turn's context, and why. */
  readonly included: Array<{ turn: number; memory: Array<{ name: string; why: string[]; writtenBy: string | null; truncated: boolean }> }> = [];
  /** Spent over all turns (estimate); null once any call could not be priced. */
  sessionCostUSD: number | null = 0;
  /** Characters of recalled memory bodies put into one turn's context; longer entries are cut and flagged. */
  static readonly RECALL_BUDGET_CHARS = 12_000;

  constructor(o: AgentOptions) {
    this.session = o.session; this.provider = o.provider;
    this.budget = { ...DEFAULT_BUDGET, ...o.budget };
    this.onEvent = o.onEvent ?? (() => undefined);
    this.recallLimit = o.recallLimit ?? 5;
  }

  /** Context block for a new user turn: spec digest, validation state, memory index and recalled entries. */
  context(userText: string): string {
    const s = this.session;
    const data = s.log.data as Record<string, unknown>;
    const v = structuredIssues(data, s.registry, 20);
    const arr = (k: string) => (Array.isArray(data[k]) ? (data[k] as Array<Record<string, unknown>>) : []);
    const digest = {
      id: data.id ?? null, title: data.title ?? null, description: data.description ?? null,
      params: data.params ?? {},
      features: ((data.geometry as { dim?: unknown; features?: Array<Record<string, unknown>> } | undefined)?.features ?? []).map((f) => `${String(f.id)}:${String(f.type)}`),
      dim: (data.geometry as { dim?: unknown } | undefined)?.dim ?? null,
      materials: arr('materials').map((m) => ({ id: m.id, ref: m.ref ?? null, select: m.select ?? [] })),
      physics: arr('physics').map((p) => ({ id: p.id, type: p.type, bcs: (Array.isArray(p.bcs) ? (p.bcs as Array<Record<string, unknown>>) : []).map((b) => `${String(b.id)}:${String(b.type)}`) })),
      studies: arr('studies').map((t) => `${String(t.id)}:${String(t.type)}`),
      results: resultNodes(data.results).map((r) => `${r.id}:${r.type}`),
      validation: { ok: v.ok, issues: v.issues },
      lastRuns: s.results.studies().map((id) => { const r = s.results.get(id)!; return { study: id, ok: r.outcome.ok, at: r.at }; }),
    };
    const { entries, invalid } = s.memory.entries();
    const picked = recall(entries, { query: userText, physicsTypes: s.physicsTypes() }, this.recallLimit);
    let left = Agent.RECALL_BUDGET_CHARS;
    const recalled = picked.map((p) => {
      const b = p.entry.body;
      const cut = b.length > left;
      const body = cut ? b.slice(0, Math.max(0, left)) : b;
      left -= body.length;
      // never a silent cut (audit B2): flagged here, and a rewrite needs a full memory_read first
      if (cut) s.partialMemory.add(p.entry.file); else s.partialMemory.delete(p.entry.file);
      return { name: p.entry.name, type: p.entry.type, updated: p.entry.updated, writtenBy: s.memory.lastWriter(p.entry.file), body, ...(cut ? { bodyTruncated: true, bodyChars: b.length } : {}) };
    });
    this.included.push({ turn: s.turn, memory: picked.map((p, i) => ({ name: p.entry.name, why: p.why, writtenBy: recalled[i]!.writtenBy, truncated: 'bodyTruncated' in recalled[i]! })) });
    const memory = { index: s.memory.index(), recalled, invalidFiles: invalid.map((i) => i.file) };
    return untrustedBlock({ spec: digest, memory }, 'context');
  }

  /** Run one user turn to completion (or a bound). */
  async runTurn(userText: string, opts: { signal?: AbortSignal; goal?: Goal } = {}): Promise<TurnResult> {
    const s = this.session;
    // a credential pasted into the chat never goes to the model, the transcript or a spec (audit M1)
    if (s.containsSecret(userText)) {
      const message = 'the message contains a credential; redact it (redactSecrets) and send again';
      this.onEvent({ type: 'stop', stop: 'blocked_secret', message });
      return { stop: 'blocked_secret', text: '', specOps: [], memoryOps: [], toolCalls: [], repairs: 0, usage: zeroUsage(), costUSD: 0, problems: [], message };
    }
    s.turn++;
    const turn = s.turn;
    const specBefore = s.log.ops.length;
    const memBefore = s.memory.ops.length;
    const runsBefore = s.sideEffects.length;
    this.messages.push({ role: 'user', content: [{ type: 'text', text: this.context(userText) }, { type: 'text', text: `User request:\n${userText}` }] });

    let usage = zeroUsage();
    let spent: number | null = 0;
    let modelCalls = 0, toolCalls = 0, repairs = 0;
    const calls: TurnResult['toolCalls'] = [];
    let lastText = '';
    let problems: string[] = [];
    let lastFeedback = '';
    const tools = toolDefinitions();
    const price = (m: string) => this.provider.price?.(m) ?? null;
    const state = (): BudgetState => ({ turn, modelCalls, toolCalls, repairs, usage, costUSD: spent, sessionCostUSD: this.sessionCostUSD, budget: this.budget });
    const finish = (stop: StopKind, message?: string): TurnResult => {
      this.onEvent({ type: 'stop', stop, ...(message ? { message } : {}) });
      return {
        stop, text: lastText,
        specOps: s.log.ops.slice(specBefore).filter((o) => o.actor === s.actor).map((o) => o.seq),
        memoryOps: s.memory.ops.slice(memBefore).filter((o) => o.actor === s.actor).map((o) => o.seq),
        toolCalls: calls, repairs, usage, costUSD: spent, problems, ...(message ? { message } : {}),
      };
    };
    const textOf = (bs: Block[]) => bs.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');

    for (;;) {
      if (opts.signal?.aborted) return finish('aborted');
      if (modelCalls >= this.budget.maxModelCalls) return finish('budget_model_calls');
      if (this.budget.maxOutputTokens !== undefined && usage.outputTokens >= this.budget.maxOutputTokens) return finish('budget_tokens');
      const req = { system: SYSTEM_PROMPT, tools, messages: this.messages };
      // reserve the worst case of the next call (input uncached at bytes/4, output at max_tokens) before making it
      const p = price(this.provider.model);
      if (p) {
        const next = (estimateTokens(req) * p.input + (this.provider.maxTokens ?? 0) * p.output) / 1e6;
        if (this.budget.maxCostUSD !== undefined && spent !== null && spent + next > this.budget.maxCostUSD) return finish('budget_cost', 'per-turn cost cap reached (estimate)');
        if (this.budget.maxSessionCostUSD !== undefined && this.sessionCostUSD !== null && this.sessionCostUSD + next > this.budget.maxSessionCostUSD) return finish('budget_cost', 'session cost cap reached (estimate)');
      }
      let resp;
      try {
        resp = await this.provider.send(req, { ...(opts.signal ? { signal: opts.signal } : {}), onText: (d) => this.onEvent({ type: 'text', delta: d }) });
      } catch (e) {
        return finish(opts.signal?.aborted ? 'aborted' : 'provider_error', (e as Error).message);
      }
      modelCalls++;
      usage = addUsage(usage, resp.usage);
      // aborted while the call ran: nothing of this response runs or enters the history
      if (opts.signal?.aborted) {
        const c0 = costOf(price(resp.model), resp.usage);
        spent = spent === null || c0 === null ? null : spent + c0;
        this.sessionCostUSD = this.sessionCostUSD === null || c0 === null ? null : this.sessionCostUSD + c0;
        return finish('aborted');
      }
      // priced by the model that served (a server-side fallback may differ); unknown -> N/A from here on
      const c = costOf(price(resp.model), resp.usage);
      spent = spent === null || c === null ? null : spent + c;
      this.sessionCostUSD = this.sessionCostUSD === null || c === null ? null : this.sessionCostUSD + c;
      this.onEvent({ type: 'budget', state: state() });
      const uses = resp.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      const assistant: Message = { role: 'assistant', content: resp.content, ...(resp.raw ? { raw: resp.raw } : {}) };
      // B1: a refused, cut or empty assistant message never enters the history (it would 400 every later request)
      if (resp.stopReason === 'refusal') { lastText = ''; return finish('refusal', resp.stopDetails?.category ?? 'refused'); }
      if (uses.length && resp.stopReason !== 'tool_use') return finish(resp.stopReason === 'max_tokens' ? 'truncated' : 'unexpected_stop', resp.stopReason === 'max_tokens' ? 'tool input cut at max_tokens; not executed' : `tool calls with stop reason ${resp.stopReason}; not executed`);
      if (resp.stopReason === 'pause_turn') return finish('unexpected_stop', 'pause_turn (no server tools are declared)');
      const text = textOf(resp.content);
      if (resp.content.length && !(uses.length === 0 && !text && resp.content.every((b) => b.type === 'opaque'))) this.messages.push(assistant);
      if (text) lastText = text;
      if (resp.stopReason === 'max_tokens') return finish('truncated', 'answer cut at max_tokens');

      if (!uses.length) {
        problems = await this.check(turn, specBefore, runsBefore, opts.goal);
        // the same problems as the last feedback: the model could not or would not fix them; stop instead of looping
        const sig = JSON.stringify([problems, this.details]);
        const repeated = sig === lastFeedback;
        if (problems.length && !repeated && repairs < this.budget.maxRepairs) {
          lastFeedback = sig;
          repairs++;
          this.onEvent({ type: 'repair', problems });
          this.messages.push({ role: 'user', content: [{ type: 'text', text: this.feedback(problems) }] });
          continue;
        }
        return finish(problems.length ? 'unresolved' : 'end_turn');
      }

      const results: ToolResultBlock[] = [];
      let exhausted = false;
      for (const u of uses) {
        if (exhausted || toolCalls >= this.budget.maxToolCalls) {
          exhausted = true;
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: [{ type: 'text', text: toolText({ ok: false, error: 'tool_budget_exhausted' }) }] });
          continue;
        }
        toolCalls++;
        const shown = s.containsSecret(u.input) ? '[refused: contains a secret]' : u.input;
        this.onEvent({ type: 'tool_call', name: u.name, input: shown });
        // S5: whatever happens, this tool_use gets its tool_result
        let out: ToolOutput;
        try { out = await s.execute(u.name, u.input, opts.signal); }
        catch { out = { content: [{ type: 'text', text: toolText({ ok: false, error: 'tool_threw' }) }], isError: true }; }
        calls.push({ name: u.name, input: shown, isError: out.isError });
        this.onEvent({ type: 'tool_result', name: u.name, isError: out.isError });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      this.messages.push({ role: 'user', content: results });
      if (exhausted) return finish('budget_tool_calls');
    }
  }

  /** Post-turn check (execution feedback). Problem strings are fixed texts; details travel in the feedback block. */
  private details: unknown[] = [];
  private async check(turn: number, specBefore: number, runsBefore: number, goal?: Goal): Promise<string[]> {
    const s = this.session;
    const out: string[] = [];
    this.details = [];
    const edited = s.log.ops.slice(specBefore).some((o) => o.actor === s.actor);
    if (edited) {
      const v = structuredIssues(s.log.data, s.registry, 20);
      if (!v.ok) { out.push('validation_issues'); this.details.push({ validation: v.issues }); }
    }
    const runs = s.sideEffects.slice(runsBefore).filter((r) => r.turn === turn);
    const outcomes: StudyOutcome[] = [];
    for (const study of [...new Set(runs.map((r) => r.study))]) {
      const r = s.results.get(study);
      if (!r) continue;
      outcomes.push(r.outcome);
      if (!r.outcome.ok) { out.push('run_failed'); this.details.push({ study, stage: r.outcome.stage, message: r.outcome.message }); continue; }
      const failed = (r.outcome.gates ?? []).filter((g) => g.pass === false);
      if (failed.length) { out.push('eval_gate_failed'); this.details.push({ study, failedGates: failed }); }
      if (edited && r.specHash !== (await specHash(s.log.data))) { out.push('results_stale'); this.details.push({ study, note: 'the spec changed after this run' }); }
    }
    if (goal) {
      const g = goal.check(outcomes);
      if (!g.ok) { out.push('goal_not_met'); this.details.push({ goal: goal.describe, detail: g.detail }); }
    }
    return out;
  }

  private feedback(problems: string[]): string {
    return `${toolText({ check: 'post_turn', problems })}\nAutomatic check after your last step. Fix these problems if you can within the budget, or explain to the user why they remain.\n${untrustedBlock(this.details, 'check')}`;
  }
}
