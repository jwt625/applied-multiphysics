// SPDX-License-Identifier: GPL-3.0-or-later
// Agent loop (DevLog-012 s.1.5; R5 s.3: execution feedback is the largest measured lever, FoamBench/2609.03718).
//   1. context: spec digest + memory index + recalled entries, all inside one untrusted block, then the user's request
//   2. model turn -> tool calls (executed in order) -> results -> next model turn ...
//   3. when the model stops, a check runs: validation of the spec this turn edited, the outcome of the last run_study
//      of this turn (error, failed eval gates) and an optional user goal. Problems go back to the model as a
//      structured feedback message (repair), at most maxRepairs times.
// Bounds: model calls, tool calls, repairs, optional token and cost caps. Every model call emits a budget event with
// tokens and an estimated cost (estimate; N/A for models without a price entry).

import { specHash } from '@amp/spec';
import { SYSTEM_PROMPT } from './prompt.ts';
import { toolDefinitions } from './tools/defs.ts';
import { toolText, untrustedBlock, structuredIssues } from './untrusted.ts';
import { recall } from './memory/recall.ts';
import { estimateCostUSD } from './provider/anthropic.ts';
import { zeroUsage, type Block, type Message, type ProviderAdapter, type ToolResultBlock, type Usage } from './provider/types.ts';
import type { AgentSession } from './session.ts';
import type { StudyOutcome } from './runner.ts';

export interface Budget { maxModelCalls: number; maxToolCalls: number; maxRepairs: number; maxOutputTokens?: number; maxCostUSD?: number }
export const DEFAULT_BUDGET: Budget = { maxModelCalls: 12, maxToolCalls: 40, maxRepairs: 2 };

export type StopKind = 'end_turn' | 'refusal' | 'truncated' | 'budget_model_calls' | 'budget_tool_calls' | 'budget_tokens' | 'budget_cost' | 'aborted' | 'provider_error' | 'unresolved';

export interface BudgetState { turn: number; modelCalls: number; toolCalls: number; repairs: number; usage: Usage; costUSD: number | null; budget: Budget }

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

const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens });

export class Agent {
  readonly session: AgentSession;
  readonly provider: ProviderAdapter;
  readonly messages: Message[] = [];
  readonly budget: Budget;
  private onEvent: (e: AgentEvent) => void;
  private recallLimit: number;
  /** Prompt inspector: the memory entries included in each turn's context, and why. */
  readonly included: Array<{ turn: number; memory: Array<{ name: string; why: string[] }> }> = [];

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
      results: arr('results').map((r) => String(r.id)),
      validation: { ok: v.ok, issues: v.issues },
      lastRuns: s.results.studies().map((id) => { const r = s.results.get(id)!; return { study: id, ok: r.outcome.ok, at: r.at }; }),
    };
    const { entries, invalid } = s.memory.entries();
    const picked = recall(entries, { query: userText, physicsTypes: s.physicsTypes() }, this.recallLimit);
    this.included.push({ turn: s.turn, memory: picked.map((p) => ({ name: p.entry.name, why: p.why })) });
    const memory = {
      index: s.memory.index(),
      recalled: picked.map((p) => ({ name: p.entry.name, type: p.entry.type, updated: p.entry.updated, body: p.entry.body })),
      invalidFiles: invalid.map((i) => i.file),
    };
    return untrustedBlock({ spec: digest, memory }, 'context');
  }

  /** Run one user turn to completion (or a bound). */
  async runTurn(userText: string, opts: { signal?: AbortSignal; goal?: Goal } = {}): Promise<TurnResult> {
    const s = this.session;
    s.turn++;
    const turn = s.turn;
    const specBefore = s.log.ops.length;
    const memBefore = s.memory.ops.length;
    const runsBefore = s.sideEffects.length;
    this.messages.push({ role: 'user', content: [{ type: 'text', text: this.context(userText) }, { type: 'text', text: `User request:\n${userText}` }] });

    let usage = zeroUsage();
    let modelCalls = 0, toolCalls = 0, repairs = 0;
    const calls: TurnResult['toolCalls'] = [];
    let lastText = '';
    let problems: string[] = [];
    let lastFeedback = '';
    const tools = toolDefinitions();
    const cost = () => estimateCostUSD(this.provider.model, usage);
    const state = (): BudgetState => ({ turn, modelCalls, toolCalls, repairs, usage, costUSD: cost(), budget: this.budget });
    const finish = (stop: StopKind, message?: string): TurnResult => {
      this.onEvent({ type: 'stop', stop, ...(message ? { message } : {}) });
      return {
        stop, text: lastText,
        specOps: s.log.ops.slice(specBefore).filter((o) => o.actor === s.actor).map((o) => o.seq),
        memoryOps: s.memory.ops.slice(memBefore).filter((o) => o.actor === s.actor).map((o) => o.seq),
        toolCalls: calls, repairs, usage, costUSD: cost(), problems, ...(message ? { message } : {}),
      };
    };

    for (;;) {
      if (opts.signal?.aborted) return finish('aborted');
      if (modelCalls >= this.budget.maxModelCalls) return finish('budget_model_calls');
      if (this.budget.maxOutputTokens !== undefined && usage.outputTokens >= this.budget.maxOutputTokens) return finish('budget_tokens');
      const c = cost();
      if (this.budget.maxCostUSD !== undefined && c !== null && c >= this.budget.maxCostUSD) return finish('budget_cost');
      let resp;
      try {
        resp = await this.provider.send({ system: SYSTEM_PROMPT, tools, messages: this.messages }, { ...(opts.signal ? { signal: opts.signal } : {}), onText: (d) => this.onEvent({ type: 'text', delta: d }) });
      } catch (e) {
        return finish(opts.signal?.aborted ? 'aborted' : 'provider_error', (e as Error).message);
      }
      modelCalls++;
      usage = addUsage(usage, resp.usage);
      this.onEvent({ type: 'budget', state: state() });
      this.messages.push({ role: 'assistant', content: resp.content, ...(resp.raw ? { raw: resp.raw } : {}) });
      const text = resp.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
      if (text) lastText = text;
      if (resp.stopReason === 'refusal') return finish('refusal', resp.stopDetails?.category ?? undefined);
      if (resp.stopReason === 'pause_turn') continue;
      const uses = resp.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (uses.length && resp.stopReason === 'max_tokens') { this.messages.pop(); return finish('truncated', 'tool input truncated at max_tokens; not executed'); }

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
        const out = await s.execute(u.name, u.input, opts.signal);
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
