// SPDX-License-Identifier: GPL-3.0-or-later
// Settings forms generated from the registry's JSON Schema (`specJsonSchema`, draft 2020-12, DevLog-011 s.1.4): walk
// $ref, properties, items/prefixItems and discriminated oneOf (by `type.const`) down to the subschema at a JSON Pointer;
// classify leaves into widgets by the schema (x-amp-quantity, x-amp-selection, enum, primitive types). Anything else is
// edited as a YAML snippet of that subtree. No field is invented: only what the schema declares is shown.
export type JS = Record<string, unknown>;

export type Widget =
	| { kind: 'quantity'; dim: string; dimensionless: boolean }
	| { kind: 'vector'; dim: string; n: number | null }
	| { kind: 'selection'; kinds: string[] }
	| { kind: 'enum'; options: string[] }
	| { kind: 'boolean' }
	| { kind: 'number'; integer: boolean; min?: number; max?: number }
	| { kind: 'string'; untrusted: boolean; pattern?: string }
	| { kind: 'idlist' }
	| { kind: 'object' }
	| { kind: 'snippet' };

export interface Field {
	key: string;
	pointer: string;
	schema: JS;
	widget: Widget;
	required: boolean;
	description?: string;
	value: unknown;
}

const isObj = (x: unknown): x is JS => !!x && typeof x === 'object' && !Array.isArray(x);
const esc = (k: string | number) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

export class SchemaWalker {
	readonly root: JS;
	private defs: Record<string, JS>;

	constructor(root: JS) {
		this.root = root;
		this.defs = (root.$defs as Record<string, JS>) ?? {};
	}

	deref(s: JS): JS {
		let cur = s;
		for (let i = 0; i < 16 && typeof cur.$ref === 'string'; i++) {
			const ref = cur.$ref as string;
			const m = /^#\/\$defs\/(.+)$/.exec(ref);
			const target = m ? this.defs[m[1]!] : undefined;
			if (!target) break;
			const { $ref: _r, ...rest } = cur;
			cur = { ...target, ...rest };
		}
		return cur;
	}

	/** Branch of a oneOf/anyOf that matches the value (discriminated by type.const), or null. */
	branch(s: JS, value: unknown): JS | null {
		const alts = (s.oneOf ?? s.anyOf) as JS[] | undefined;
		if (!alts) return null;
		if (isObj(value) && typeof value.type === 'string') {
			for (const a0 of alts) {
				const a = this.deref(a0);
				const t = (a.properties as JS | undefined)?.type as JS | undefined;
				if (t && t.const === value.type) return a;
			}
		}
		return null;
	}

	/** Subschema at a pointer of the data (null when the schema does not reach it). */
	at(data: unknown, pointer: string): JS | null {
		let s: JS | null = this.deref(this.root);
		let cur: unknown = data;
		if (pointer === '') return s;
		for (const raw of pointer.slice(1).split('/')) {
			if (!s) return null;
			const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
			s = this.deref(this.branch(s, cur) ?? s);
			if (Array.isArray(cur)) {
				const i = Number(k);
				const pre = s.prefixItems as JS[] | undefined;
				s = pre?.[i] ? this.deref(pre[i]!) : isObj(s.items) ? this.deref(s.items as JS) : null;
				cur = cur[i];
			} else {
				const props = s.properties as Record<string, JS> | undefined;
				s = props?.[k] ? this.deref(props[k]!) : isObj(s.additionalProperties) ? this.deref(s.additionalProperties as JS) : null;
				cur = isObj(cur) ? cur[k] : undefined;
			}
			if (s && cur !== undefined) s = this.deref(this.branch(s, cur) ?? s);
		}
		return s;
	}

	widget(s0: JS): Widget {
		const s = this.deref(s0);
		if (typeof s['x-amp-quantity'] === 'string') return { kind: 'quantity', dim: s['x-amp-quantity'] as string, dimensionless: !!s['x-amp-dimensionless'] };
		if (Array.isArray(s['x-amp-selection'])) return { kind: 'selection', kinds: s['x-amp-selection'] as string[] };
		if (Array.isArray(s.enum)) return { kind: 'enum', options: (s.enum as unknown[]).map(String) };
		const alts = (s.anyOf ?? s.oneOf) as JS[] | undefined;
		if (alts) {
			for (const a0 of alts) {
				const a = this.deref(a0);
				if (a.type === 'array' && isObj(a.items)) {
					const it = this.deref(a.items as JS);
					if (typeof it['x-amp-quantity'] === 'string') return { kind: 'vector', dim: it['x-amp-quantity'] as string, n: typeof a.minItems === 'number' && a.minItems === a.maxItems ? (a.minItems as number) : null };
				}
			}
			return { kind: 'snippet' };
		}
		if (s.type === 'boolean') return { kind: 'boolean' };
		if (s.type === 'number' || s.type === 'integer') {
			const w: Widget = { kind: 'number', integer: s.type === 'integer' };
			if (typeof s.minimum === 'number') w.min = s.minimum;
			if (typeof s.maximum === 'number' && s.maximum < 1e15) w.max = s.maximum;
			return w;
		}
		if (s.type === 'string') return { kind: 'string', untrusted: !!s['x-amp-untrusted'], ...(typeof s.pattern === 'string' ? { pattern: s.pattern } : {}) };
		if (s.type === 'array' && isObj(s.items) && this.deref(s.items as JS).type === 'string') return { kind: 'idlist' };
		if (s.type === 'object' && isObj(s.properties)) return { kind: 'object' };
		return { kind: 'snippet' };
	}

	/** Fields of the object at `pointer`; `skip` lists keys shown elsewhere (child tree nodes). */
	fields(data: unknown, pointer: string, value: unknown, skip: ReadonlySet<string> = new Set()): Field[] {
		const s0 = this.at(data, pointer);
		if (!s0) return [];
		const s = this.deref(this.branch(s0, value) ?? s0);
		const props = (s.properties as Record<string, JS> | undefined) ?? {};
		const req = new Set((s.required as string[] | undefined) ?? []);
		const out: Field[] = [];
		for (const [key, ps0] of Object.entries(props)) {
			if (skip.has(key)) continue;
			const ps = this.deref(ps0);
			const v = isObj(value) ? value[key] : undefined;
			const sub = this.deref(this.branch(ps, v) ?? ps);
			const desc = typeof sub.description === 'string' ? sub.description : typeof ps.description === 'string' ? ps.description : undefined;
			out.push({ key, pointer: `${pointer}/${esc(key)}`, schema: sub, widget: this.widget(sub), required: req.has(key), value: v, ...(desc ? { description: desc } : {}) });
		}
		return out;
	}
}
