// SPDX-License-Identifier: GPL-3.0-or-later
// Canonical JSON and sha-256 (DevLog-003 s.1.5). Canonical form: object keys sorted by UTF-16 code units, no
// whitespace, numbers in ECMAScript shortest round-trip form (as JSON.stringify), strings as JSON.stringify: the
// RFC 8785 (JCS) rules for the value types a spec contains. Hashing uses WebCrypto (crypto.subtle), present in
// browsers (secure contexts) and Node >= 19.

/** Canonical JSON text. Throws on values JSON cannot represent (undefined in arrays, non-finite numbers, functions). */
export function canonicalJson(value: unknown): string {
  return enc(value, '');
}

function enc(v: unknown, at: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${at || '/'}`);
      return JSON.stringify(v);
    case 'string': return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x, i) => (x === undefined ? fail(`${at}/${i}`) : enc(x, `${at}/${i}`))).join(',')}]`;
      if (ArrayBuffer.isView(v)) throw new Error(`canonicalJson: typed array at ${at || '/'} (hash bytes with sha256Hex)`);
      const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${enc((v as Record<string, unknown>)[k], `${at}/${k}`)}`).join(',')}}`;
    }
    default: throw new Error(`canonicalJson: cannot encode ${typeof v} at ${at || '/'}`);
  }
}
const fail = (at: string): never => { throw new Error(`canonicalJson: undefined at ${at}`); };

const subtle = (): typeof globalThis.crypto.subtle => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto crypto.subtle is unavailable (insecure context?)');
  return s;
};

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Lowercase hex sha-256 of a string (UTF-8) or bytes. */
export async function sha256Hex(data: string | ArrayBufferView | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
    : data instanceof ArrayBuffer ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const d = new Uint8Array(await subtle().digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let s = '';
  for (const b of d) s += HEX[b];
  return s;
}

/** Stable hash of a spec: sha-256 of its canonical JSON (comments, key order and YAML formatting do not count). */
export const specHash = (spec: unknown): Promise<string> => sha256Hex(canonicalJson(spec));

/** Order-insensitive deep equality of plain JSON values. */
export const jsonEqual = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
