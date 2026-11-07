// SPDX-License-Identifier: GPL-3.0-or-later
// One open model: the YAML text is owned by the @amp/spec operation log (A4). Every UI edit (forms, sliders, drags,
// YAML tab, presets, share URLs) becomes an RFC 6902 patch applied with `log.apply` (comment-preserving splice); undo,
// redo and revert append operations. Nothing else writes the text.
import { applyPatch, createOpLog, parseSpecText, parseYaml, type OpLog, type ParseResult, type Registry } from '@amp/spec';
import type { JsonPatchOp, Operation } from '@amp/spec/types';
import { diffPatch, encodeShare } from './diff';

export type EditListener = (op: Operation) => void;

export class ModelState {
	readonly id: string;
	readonly original: string;
	readonly reg: Registry;
	private log!: OpLog;
	originalData: unknown = null;
	text = $state('');
	data = $state.raw<unknown>(null);
	parsed = $state.raw<ParseResult | null>(null);
	ops = $state.raw<readonly Operation[]>([]);
	canUndo = $state(false);
	canRedo = $state(false);
	parseMs = $state(0);
	private listeners = new Set<EditListener>();

	private constructor(id: string, text: string, reg: Registry) {
		this.id = id;
		this.original = text;
		this.reg = reg;
	}

	static async open(id: string, text: string, reg: Registry): Promise<ModelState> {
		const m = new ModelState(id, text, reg);
		m.log = await createOpLog(text, { registry: reg });
		m.originalData = m.log.data;
		m.refresh();
		return m;
	}

	private refresh(): void {
		const t0 = performance.now();
		this.text = this.log.text;
		this.data = this.log.data;
		this.parsed = parseSpecText(this.log.text, this.reg);
		this.parseMs = performance.now() - t0;
		this.ops = [...this.log.ops];
		this.canUndo = this.log.canUndo;
		this.canRedo = this.log.canRedo;
	}

	onEdit(fn: EditListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private done(op: Operation | null): Operation | null {
		this.refresh();
		if (op) for (const f of this.listeners) f(op);
		return op;
	}

	/** A drag or slider gesture is live: its steps coalesce into one op (amp-oplog/1 `coalesce`). */
	dragging = $state(false);
	/** Reverts refused by the op log guards, with the reason (shown in the timeline). */
	refused = $state<Record<number, string>>({});

	async apply(patch: JsonPatchOp[], reason?: string, opts: { coalesce?: boolean } = {}): Promise<Operation | null> {
		if (!patch.length) return null;
		const op = await this.log.apply(patch, { actor: 'user', ...(reason ? { reason } : {}) }, opts.coalesce ? { coalesce: { windowMs: 1500 } } : undefined);
		return this.done(op);
	}

	/** One step of a drag: every step goes through the op log and merges into the gesture's op. */
	async dragStep(patch: JsonPatchOp[], reason: string): Promise<Operation | null> {
		// the first step of a gesture opens a new op; later steps merge into it
		const first = !this.dragging;
		this.dragging = true;
		return this.apply(patch, reason, { coalesce: !first });
	}

	endDrag(): void {
		this.dragging = false;
	}

	effectOf(seq: number): 'applied' | 'undone' | 'reverted' | null {
		return this.log.effectOf(seq);
	}

	async undo(): Promise<Operation | null> {
		return this.done(await this.log.undo({ actor: 'user' }));
	}

	async redo(): Promise<Operation | null> {
		return this.done(await this.log.redo({ actor: 'user' }));
	}

	/** Revert an op; a refusal by the guards is recorded with its reason and returns null. */
	async revert(seq: number): Promise<Operation | null> {
		try {
			const op = await this.log.revert(seq, { actor: 'user', reason: `revert #${seq}` });
			delete this.refused[seq];
			return this.done(op);
		} catch (e) {
			this.refused[seq] = (e as Error).message;
			return null;
		}
	}

	/** YAML tab: diff the typed text against the current data and apply it as one op. */
	async applyYaml(newText: string): Promise<{ op: Operation | null; error?: string; reformatted: boolean }> {
		const y = parseYaml(newText);
		if (!y.doc || y.issues.length) return { op: null, error: y.issues.map((i) => `${i.line ?? ''}:${i.col ?? ''} ${i.message}`).join('\n') || 'YAML does not parse', reformatted: false };
		let patch: JsonPatchOp[];
		try {
			patch = diffPatch(this.data, y.data);
		} catch (e) {
			return { op: null, error: (e as Error).message, reformatted: false };
		}
		const op = await this.apply(patch, 'YAML tab edit');
		return { op, reformatted: this.text !== newText };
	}

	/** Patch from the original model to the current one (share URL). */
	sharePatch(): JsonPatchOp[] {
		return diffPatch(this.originalData, this.data);
	}

	shareCode(): string {
		return encodeShare(this.sharePatch());
	}

	jsonl(): string {
		return this.log.toJSONL();
	}

	/** Data of the model with a patch applied, without logging (drag previews). */
	previewData(patch: JsonPatchOp[]): unknown {
		return applyPatch(this.data, patch).doc;
	}
}
