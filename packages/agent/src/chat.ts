// SPDX-License-Identifier: GPL-3.0-or-later
// Chat-panel API for the workbench (apps/web, L5). Framework-neutral: a controller holding the panel state (rows,
// busy flag, budget, memory included per turn, last stop) with a subscribe() callback, so a Svelte component can
// mirror it into $state. The controller owns nothing the workbench owns: the OpLog, registry, navigation host,
// study runner and geometry are passed in, so agent edits land in the workbench's own timeline.
//
// Rows are plain text. Render them as text, never as HTML: assistant text is model output, and tool rows carry only
// the tool name, an error flag and a short trusted summary.

import { AgentSession } from './session.ts';
import { Agent, type AgentEvent, type Budget, type BudgetState, type Goal, type StopKind, type TurnResult } from './loop.ts';
import { KeyStore, KEY_STORAGE_NAME, type KeyValueStorage } from './keys.ts';
import { createOpenAICompatibleAdapter, type FetchLike, type ProviderPreset } from './provider/openai-compatible.ts';
import { MemoryStore } from './memory/store.ts';
import type { MemoryBackend } from './memory/backends.ts';
import { createAnthropicAdapter, type AnthropicClientLike, type AnthropicClientOptions, type Effort } from './provider/anthropic.ts';
import type { ProviderAdapter } from './provider/types.ts';
import type { NavigationHost } from './nav.ts';
import type { StudyRunner } from './runner.ts';
import type { ResultsHost } from './results.ts';
import type { OpLog, Registry, BuiltGeometry } from '@amp/spec';
import { isoNow } from '@amp/spec';
import { containsSecret, redactSecrets } from './secrets.ts';

export type ChatRow =
  | { kind: 'user'; ts: string; turn: number; text: string }
  | { kind: 'assistant'; ts: string; turn: number; text: string }
  | { kind: 'tool'; ts: string; turn: number; tool: string; isError: boolean; summary: string }
  | { kind: 'repair'; ts: string; turn: number; problems: string[] }
  | { kind: 'stop'; ts: string; turn: number; stop: StopKind; message?: string };

export interface ChatState {
  rows: ChatRow[];
  busy: boolean;
  /** Streaming text of the current model call (cleared when the call ends). */
  draft: string;
  budget: BudgetState | null;
  lastStop: StopKind | null;
  hasKey: boolean;
  keyPersisted: boolean;
  /** Prompt inspector: memory entries included per turn, with the reasons recall gave. */
  included: Array<{ turn: number; memory: Array<{ name: string; why: string[]; writtenBy: string | null; truncated: boolean }> }>;
}

export interface ChatControllerOptions {
  session: AgentSession;
  provider: ProviderAdapter;
  keys: KeyStore;
  budget?: Partial<Budget>;
  clock?: () => string;
}

export class ChatController {
  readonly session: AgentSession;
  readonly agent: Agent;
  readonly keys: KeyStore;
  private st: ChatState;
  private listeners = new Set<(s: ChatState) => void>();
  private ctl: AbortController | null = null;
  private clock: () => string;
  private pendingSummary = '';

  constructor(o: ChatControllerOptions) {
    this.session = o.session; this.keys = o.keys;
    this.clock = o.clock ?? (() => isoNow());
    this.agent = new Agent({ session: o.session, provider: o.provider, ...(o.budget ? { budget: o.budget } : {}), onEvent: (e) => this.onEvent(e) });
    this.st = { rows: [], busy: false, draft: '', budget: null, lastStop: null, hasKey: o.keys.hasKey, keyPersisted: o.keys.isPersisted, included: [] };
  }

  get state(): ChatState { return this.st; }

  /** Called on every state change with a fresh state object (cheap shallow copy). Returns an unsubscribe function. */
  subscribe(fn: (s: ChatState) => void): () => void { this.listeners.add(fn); fn(this.st); return () => this.listeners.delete(fn); }

  private emit(patch: Partial<ChatState>): void {
    this.st = { ...this.st, ...patch };
    for (const l of this.listeners) l(this.st);
  }
  private push(row: ChatRow): void { this.emit({ rows: [...this.st.rows, row] }); }

  private onEvent(e: AgentEvent): void {
    const turn = this.session.turn;
    if (e.type === 'text') this.emit({ draft: this.st.draft + e.delta });
    else if (e.type === 'tool_call') this.pendingSummary = toolSummary(e.input);
    else if (e.type === 'tool_result') { this.push({ kind: 'tool', ts: this.clock(), turn, tool: e.name, isError: e.isError, summary: this.pendingSummary }); this.pendingSummary = ''; }
    else if (e.type === 'repair') this.push({ kind: 'repair', ts: this.clock(), turn, problems: e.problems });
    else if (e.type === 'budget') {
      // a model call ended: its streamed text becomes an assistant row
      if (this.st.draft) this.push({ kind: 'assistant', ts: this.clock(), turn, text: this.st.draft });
      this.emit({ draft: '', budget: e.state });
    } else if (e.type === 'stop') this.push({ kind: 'stop', ts: this.clock(), turn, stop: e.stop, ...(e.message ? { message: e.message } : {}) });
  }

  /** True when the text carries the key or a credential-shaped token (check before sending; offer redact()). */
  hasSecret(text: string): boolean { return containsSecret(text, this.keys.forbidden()); }
  redact(text: string): string { return redactSecrets(text, this.keys.forbidden()); }

  /** Send a user message and run the turn. Rejects while a turn is running, and when the text holds a credential. */
  async send(text: string, opts: { goal?: Goal } = {}): Promise<TurnResult> {
    if (this.st.busy) throw new Error('a turn is already running');
    const t = text.trim();
    if (!t) throw new Error('empty message');
    if (this.hasSecret(t)) throw new SecretInMessageError();
    this.ctl = new AbortController();
    this.push({ kind: 'user', ts: this.clock(), turn: this.session.turn + 1, text: t });
    this.emit({ busy: true, draft: '' });
    try {
      const r = await this.agent.runTurn(t, { signal: this.ctl.signal, ...(opts.goal ? { goal: opts.goal } : {}) });
      this.emit({ lastStop: r.stop, included: [...this.agent.included] });
      return r;
    } finally {
      if (this.st.draft) this.push({ kind: 'assistant', ts: this.clock(), turn: this.session.turn, text: this.st.draft });
      this.ctl = null;
      this.emit({ busy: false, draft: '' });
    }
  }

  /** Cancel the running turn (the model call and a running study). */
  abort(): void { this.ctl?.abort(); }

  /** Revert every spec and memory op of one agent turn (user action, logged as the user). */
  revertTurn(turn: number): Promise<{ reverted: number; error?: string }> { return this.session.revertTurn(turn); }

  /** Key entry from the panel. `persist` is the explicit opt-in to localStorage. */
  setKey(key: string, persist = false): void { this.keys.set(key, { persist }); this.emit({ hasKey: true, keyPersisted: this.keys.isPersisted }); }
  setKeyPersist(on: boolean): void { this.keys.setPersist(on); this.emit({ keyPersisted: this.keys.isPersisted }); }
  clearKey(): void { this.keys.clear(); this.emit({ hasKey: false, keyPersisted: false }); }
}

export class SecretInMessageError extends Error {
  constructor() { super('the message contains a credential; it was not sent (use redact() and send again)'); }
}

/** Short summary of a tool call's arguments for the panel (pointer, study, mode, name, seq, counts). */
export function toolSummary(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 120);
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['pointer', 'study', 'mode', 'name', 'seq', 'log', 'kind', 'view']) if (typeof o[k] === 'string' || typeof o[k] === 'number') parts.push(`${k}=${String(o[k])}`);
  if (Array.isArray(o.ops)) parts.push(`${o.ops.length} op(s): ${o.ops.map((x) => (x as { path?: unknown }).path).filter((x) => typeof x === 'string').join(', ')}`);
  if (Array.isArray(o.ids)) parts.push(`${o.ids.length} id(s)`);
  return parts.join(' ').slice(0, 120);
}

export interface MountOptions {
  /** The workbench's operation log (same instance the UI edits through). */
  log: OpLog;
  registry: Registry;
  nav: NavigationHost;
  runner?: StudyRunner;
  /** Results values (evaluate / get_table tools; lane R3): the workbench's post worker through the adapter. */
  results?: ResultsHost;
  geometry?: () => BuiltGeometry | null;
  /** Memory backend: `await opfsBackend()` in the browser. */
  memoryBackend: MemoryBackend;
  /** window.localStorage (key persistence after opt-in only); omit to keep the key in memory only. */
  storage?: KeyValueStorage;
  /** Anthropic SDK client factory: `(o) => new Anthropic(o)`. Ignored when `provider` is given. */
  createClient?: (o: AnthropicClientOptions) => AnthropicClientLike;
  isApiError?: (e: unknown) => boolean;
  /** `(e) => e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)` (SDK 1.1.0, audit S1). */
  isToolInputParseError?: (e: unknown) => boolean;
  model?: string;
  effort?: Effort;
  /**
   * OpenAI-compatible provider instead of Anthropic (DevLog-018), e.g. `{preset: DEEPSEEK_PRESET, fetch:
   * globalThis.fetch.bind(globalThis)}`. The key is stored under its own name (`amp.agent.provider-key.<preset>`).
   */
  openaiCompatible?: { preset: ProviderPreset; fetch: FetchLike; model?: string; pricing?: 'peak' | 'time-of-use' };
  /** Override the provider (tests, the scripted mock, a future provider). */
  provider?: ProviderAdapter;
  budget?: Partial<Budget>;
  sessionId?: string;
}

/** Wire session, memory, key store and provider for the chat panel. */
export async function mountAgent(o: MountOptions): Promise<ChatController> {
  const oc = !o.provider ? o.openaiCompatible : undefined;
  const keys = new KeyStore(o.storage, oc ? `amp.agent.provider-key.${oc.preset.name}` : KEY_STORAGE_NAME);
  // reconcile at mount: files changed while the app was closed (or by a crash between log and file) become `external` ops
  const memory = await MemoryStore.open(o.memoryBackend, { forbidden: () => keys.forbidden(), reconcile: true });
  const session = new AgentSession({
    log: o.log, registry: o.registry, memory, nav: o.nav,
    ...(o.runner ? { runner: o.runner } : {}), ...(o.results ? { results: o.results } : {}), ...(o.geometry ? { geometry: o.geometry } : {}), ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    forbidden: () => keys.forbidden(),
  });
  let provider = o.provider;
  if (!provider && oc) provider = createOpenAICompatibleAdapter({ keys, fetch: oc.fetch, preset: oc.preset, ...(oc.model ? { model: oc.model } : {}), ...(oc.pricing ? { pricing: oc.pricing } : {}) });
  if (!provider) {
    if (!o.createClient) throw new Error('mountAgent: pass createClient (Anthropic SDK factory) or provider');
    provider = createAnthropicAdapter({ keys, createClient: o.createClient, ...(o.isApiError ? { isApiError: o.isApiError } : {}), ...(o.isToolInputParseError ? { isToolInputParseError: o.isToolInputParseError } : {}), ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) });
  }
  return new ChatController({ session, provider, keys, ...(o.budget ? { budget: o.budget } : {}) });
}
