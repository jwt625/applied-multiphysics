// SPDX-License-Identifier: GPL-3.0-or-later
// Bring-your-own API key (DevLog-001 Q7). The key lives in memory; it goes to localStorage only after an explicit
// opt-in, and is removed from there when the user turns persistence off or clears the key. Nothing in this package
// reads the key except the provider adapter, which hands it to the provider client it constructs. No tool exposes it.
// `redact()` replaces the key in any text (error messages, logs) before it leaves the adapter.

export interface KeyValueStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export const KEY_STORAGE_NAME = 'amp.agent.provider-key.anthropic';

export class KeyStore {
  private key: string | null = null;
  private persisted = false;
  /** `storage`: window.localStorage in the browser; omitted in Node or when the page has no storage. */
  private storage: KeyValueStorage | undefined;
  private storageName: string;
  constructor(storage?: KeyValueStorage, storageName = KEY_STORAGE_NAME) {
    this.storage = storage; this.storageName = storageName;
    try {
      const v = storage?.getItem(storageName) ?? null;
      if (v) { this.key = v; this.persisted = true; }
    } catch { /* storage blocked: memory only */ }
  }

  get hasKey(): boolean { return this.key !== null; }
  get isPersisted(): boolean { return this.persisted; }

  /** Set the key. `persist: true` is the explicit opt-in to localStorage; false (default) removes any stored copy. */
  set(key: string, opts: { persist?: boolean } = {}): void {
    const k = key.trim();
    if (!k) throw new Error('empty key');
    this.key = k;
    this.setPersist(opts.persist === true);
  }

  setPersist(on: boolean): void {
    if (!this.storage) { this.persisted = false; if (on) throw new Error('no storage available; the key stays in memory only'); return; }
    try {
      if (on && this.key) { this.storage.setItem(this.storageName, this.key); this.persisted = true; }
      else { this.storage.removeItem(this.storageName); this.persisted = false; }
    } catch { this.persisted = false; if (on) throw new Error('storage blocked; the key stays in memory only'); }
  }

  clear(): void {
    this.key = null;
    try { this.storage?.removeItem(this.storageName); } catch { /* ignore */ }
    this.persisted = false;
  }

  /** For the provider adapter only. */
  reveal(): string | null { return this.key; }

  /** Replace the key (and any sk-ant- shaped token) in a text. */
  redact(text: string): string {
    let t = text;
    if (this.key) t = t.split(this.key).join('[redacted key]');
    return t.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted key]');
  }

  /** The key, for "never write this" checks (memory store `forbidden`). */
  forbidden(): string[] { return this.key ? [this.key] : []; }

  /** Never serialize the key. */
  toJSON(): Record<string, unknown> { return { hasKey: this.hasKey, persisted: this.persisted }; }
}
