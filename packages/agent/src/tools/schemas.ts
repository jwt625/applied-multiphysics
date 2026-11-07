// SPDX-License-Identifier: GPL-3.0-or-later
// Tool input schemas (one zod definition per tool: TS type, JSON Schema for the provider, runtime validation).
// Spec shapes are never copied here: `apply_ops.ops` is @amp/spec JsonPatchSchema, and per-type spec schemas are
// served on demand by the schema_at tool (@amp/spec schemaAt), so the tool list stays small (L2 audit S6).

import * as z from 'zod';
import { JsonPatchSchema, ENTITY_ID } from '@amp/spec';
import { MEMORY_TYPES, MEMORY_NAME } from '../memory/frontmatter.ts';

const reason = z.string().min(1).max(500).describe('Why: shown to the user in the timeline');
const pointer = z.string().max(1024).describe('JSON Pointer into the spec; @<id> addresses an array element by id, e.g. /physics/@solid/bcs/@tension');

export const TOOL_INPUTS = {
  // ---- edits (operation log) ----
  apply_ops: z.strictObject({
    ops: JsonPatchSchema.min(1).max(200).describe('RFC 6902 patch on the parsed spec. Extensions: @<id> / @<id>+ tokens, op "absent"'),
    reason,
  }),
  revert_op: z.strictObject({
    seq: z.number().int().min(1),
    log: z.enum(['spec', 'memory']).optional().describe('default spec'),
    reason,
  }),
  undo: z.strictObject({
    log: z.enum(['spec', 'memory']).optional().describe('default spec'),
    allow_other_actor: z.boolean().optional().describe('also undo when the newest op is not yours (only when the user asked)'),
    reason,
  }),
  redo: z.strictObject({ reason }),
  // ---- reads ----
  get_spec: z.strictObject({
    pointer: pointer.optional().describe('omit for the YAML text'),
    from_line: z.number().int().min(1).optional().describe('YAML page start (1-based); large specs come in pages'),
    to_line: z.number().int().min(1).optional(),
  }),
  schema_at: z.strictObject({
    pointer,
    type: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional().describe('registered type of a new element (e.g. a bc type) when the pointer ends in "-"'),
  }),
  list_entities: z.strictObject({
    kind: z.enum(['params', 'features', 'materials', 'physics', 'studies', 'results', 'geometry', 'types', 'all']).optional().describe('default all; geometry = entity ids of the built model; types = registered types'),
  }),
  list_ops: z.strictObject({
    log: z.enum(['spec', 'memory']).optional().describe('default spec'),
    limit: z.number().int().min(1).max(50).optional().describe('newest first; default 10'),
  }),
  get_run_record: z.strictObject({ study: z.string().max(64).optional() }),
  get_results_summary: z.strictObject({ study: z.string().max(64).optional() }),
  run_study: z.strictObject({ study: z.string().max(64), reason }),
  evaluate: z.strictObject({
    node: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/).optional().describe('results node id: an evaluation group, item or table (values), or a cutpoint / cutline / edge dataset (points, with expr: values there)'),
    data: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/).optional().describe('ad hoc: dataset id to evaluate on (e.g. the solution dataset)'),
    kind: z.enum(['point', 'global', 'integral', 'average', 'max', 'min', 'measure']).optional().describe('ad hoc evaluation kind'),
    expr: z.string().min(1).max(2000).optional().describe('result expression (<physics>.<field>[.x|.y|.z|.r], params, x y z r, d(f, v)); with node = a dataset: values at its points'),
    unit: z.string().max(64).optional().describe('display unit, dimension-checked'),
    over: z.array(z.string().regex(ENTITY_ID)).min(1).max(200).optional().describe('ad hoc on a solution dataset: selection (dom:... or bnd:...)'),
    method: z.enum(['nodal', 'quad', 'points', 'lattice']).optional().describe('max / min method'),
    from: z.array(z.union([z.number(), z.string().max(200)])).min(2).max(3).optional().describe('ad hoc temporary cut line start, quantities ("5 mm", "a", 0.01 = m)'),
    to: z.array(z.union([z.number(), z.string().max(200)])).min(2).max(3).optional(),
    n: z.number().int().min(2).max(2000).optional().describe('uniform points on the temporary cut line (absent: element crossings)'),
    at: z.array(z.array(z.union([z.number(), z.string().max(200)])).min(2).max(3)).min(1).max(50).optional().describe('ad hoc temporary cut points'),
    step: z.union([z.number().int().min(0), z.enum(['first', 'last'])]).optional().describe('one step (default: the item / group steps, or last)'),
    max_points: z.number().int().min(1).max(500).optional().describe('dataset values: at most this many points listed (default 50; min / max / ends always given)'),
  }),
  get_table: z.strictObject({
    table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/).describe('table or evaluation group id'),
    from_row: z.number().int().min(1).optional().describe('1-based, default 1'),
    to_row: z.number().int().min(1).optional().describe('default from_row + 49'),
  }),
  // ---- navigation (UI state only) ----
  focus_node: z.strictObject({ pointer }),
  open_settings: z.strictObject({ pointer, field: z.string().max(64).optional() }),
  highlight_selection: z.strictObject({
    ids: z.array(z.string().regex(ENTITY_ID)).min(1).max(200).describe('entity ids, e.g. bnd:hole.edge'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
  set_camera: z.strictObject({
    kind: z.enum(['fit', 'preset', 'look_at']),
    preset: z.enum(['iso', 'front', 'back', 'top', 'bottom', 'left', 'right']).optional(),
    target: z.array(z.number()).length(3).optional().describe('look_at target, metres'),
    distance: z.number().positive().optional().describe('metres'),
  }),
  set_view_mode: z.strictObject({ mode: z.enum(['geometry', 'mesh', 'results']) }),
  screenshot: z.strictObject({ view: z.enum(['graphics', 'workbench']).optional() }),
  show_plot: z.strictObject({ plot: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/).describe('plot group id under results.plots') }),
  // ---- memory (memory op log) ----
  memory_read: z.strictObject({ name: z.string().regex(MEMORY_NAME) }),
  memory_write: z.strictObject({
    name: z.string().regex(MEMORY_NAME),
    type: z.enum(MEMORY_TYPES),
    description: z.string().min(1).max(300).describe('one line; recall matches on it'),
    applies_when: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(20).optional().describe('physics types; omit = always'),
    body: z.string().max(20000),
    reason,
  }),
  memory_delete: z.strictObject({ name: z.string().regex(MEMORY_NAME), reason }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_INPUTS)[N]>;

export const NAV_TOOLS: ReadonlySet<ToolName> = new Set(['focus_node', 'open_settings', 'highlight_selection', 'set_camera', 'set_view_mode', 'screenshot', 'show_plot']);
export const EDIT_TOOLS: ReadonlySet<ToolName> = new Set(['apply_ops', 'revert_op', 'undo', 'redo', 'memory_write', 'memory_delete']);

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  apply_ops: 'Edit the model spec with a JSON Patch. Applied at once and logged with your reason; the result lists validation issues and invalidated artifacts. Call schema_at first for unfamiliar nodes.',
  revert_op: 'Revert one earlier operation (spec or memory log) by appending its inverse.',
  undo: 'Undo the newest undoable operation of the spec (or memory) log when it is yours; for an older op of yours use revert_op.',
  redo: 'Redo the last undone spec operation.',
  get_spec: 'Read the spec: the YAML text (paged when large; the result says if it is complete), or the JSON value at a pointer.',
  schema_at: 'JSON Schema of the value at a pointer (resolves registered types); large schemas come as a summary, narrow the pointer for detail. Use before adding or changing nodes.',
  list_entities: 'List ids: params, geometry features, materials, physics with conditions, studies, results, built geometry entities, registered types.',
  list_ops: 'Recent operations of the spec or memory log, newest first: seq, actor, kind, reason, effect (applied, undone, reverted), touched paths.',
  get_run_record: 'Run record of the latest run of a study (engine, spec hash, mesh hash, time, platform) and whether it is stale.',
  get_results_summary: 'Derived scalars with units, solver stats, readiness and eval-gate status of the latest run of a study.',
  run_study: 'Mesh and solve a study with the current spec. Spends compute; recorded, not undoable.',
  evaluate: 'Values from the latest solution, changing nothing: a results node (evaluation group, item or table: values with units, method, NaN / outside counts; a line or point dataset: points and an expression there), or ad hoc {data, kind, expr, unit, over | from, to, n | at}. To keep an evaluation, add it with apply_ops.',
  get_table: 'Rows of a table or evaluation group (column names with units, paged), computed from the latest solution.',
  focus_node: 'Select and reveal a node in the model tree (UI only).',
  open_settings: 'Open the settings panel of a node, optionally at one field (UI only).',
  highlight_selection: 'Highlight geometry entities in the graphics view (UI only).',
  set_camera: 'Move the 3D/2D camera (UI only).',
  set_view_mode: 'Switch the graphics view between geometry, mesh and results (UI only).',
  screenshot: 'Capture the graphics view as an image (UI only).',
  show_plot: 'Select and draw a plot group of results.plots in the graphics view (UI only); pair with screenshot.',
  memory_read: 'Read one memory file (markdown with front matter).',
  memory_write: 'Create or replace a memory entry (logged, revertible). Only for preferences or configs the user wants kept. Never secrets.',
  memory_delete: 'Delete a memory entry (logged, revertible).',
};
