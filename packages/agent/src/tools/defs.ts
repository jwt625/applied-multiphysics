// SPDX-License-Identifier: GPL-3.0-or-later
// Tool definitions for the provider, generated from the zod inputs (TOOL_INPUTS) and @amp/spec. Sorted by name and
// serialized deterministically so the tools prefix stays byte-identical across requests (prompt caching).

import * as z from 'zod';
import { TOOL_INPUTS, TOOL_DESCRIPTIONS, type ToolName } from './schemas.ts';
import type { ToolDef } from '../provider/types.ts';

const ANY_JSON_TYPES = ['array', 'boolean', 'null', 'number', 'object', 'string'].join();

/** A $defs entry that is zod's recursive "any JSON value" (z.json()). */
const isAnyJson = (d: unknown): boolean => {
  const any = (d as { anyOf?: Array<{ type?: string }> })?.anyOf;
  return Array.isArray(any) && any.map((x) => x.type ?? '').sort().join() === ANY_JSON_TYPES;
};

/**
 * JSON Schema for the provider. zod renders z.json() (the patch `value`) as a recursive $ref with propertyNames;
 * that is replaced by {} (any JSON value), which every tool-schema dialect accepts and which is smaller. The input is
 * still validated client-side with the full zod schema (JsonPatchSchema) before anything runs.
 */
function jsonSchemaOf(s: z.ZodType): Record<string, unknown> {
  const j = z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }) as Record<string, unknown> & { $defs?: Record<string, unknown> };
  const { $schema: _s, $defs, ...rest } = j;
  const anyRefs = new Set(Object.entries($defs ?? {}).filter(([, d]) => isAnyJson(d)).map(([k]) => `#/$defs/${k}`));
  const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.$ref === 'string' && anyRefs.has(o.$ref)) return {};
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, strip(v)]));
    }
    return x;
  };
  const kept = Object.fromEntries(Object.entries($defs ?? {}).filter(([k]) => !anyRefs.has(`#/$defs/${k}`)).map(([k, v]) => [k, strip(v)]));
  return { ...(strip(rest) as Record<string, unknown>), ...(Object.keys(kept).length ? { $defs: kept } : {}) };
}

let cache: ToolDef[] | null = null;

export function toolDefinitions(): ToolDef[] {
  if (cache) return cache;
  cache = (Object.keys(TOOL_INPUTS) as ToolName[]).sort().map((name) => ({ name, description: TOOL_DESCRIPTIONS[name], input_schema: jsonSchemaOf(TOOL_INPUTS[name]) }));
  return cache;
}

/** Size of the tool definitions as sent (minified JSON). Tokens are an estimate: bytes / 4, not a tokenizer count. */
export function toolDefinitionSize(defs: ToolDef[] = toolDefinitions()): { tools: number; bytes: number; tokensEstimate: number; perTool: Array<{ name: string; bytes: number }> } {
  const enc = new TextEncoder();
  const bytes = enc.encode(JSON.stringify(defs)).length;
  return {
    tools: defs.length, bytes, tokensEstimate: Math.round(bytes / 4),
    perTool: defs.map((d) => ({ name: d.name, bytes: enc.encode(JSON.stringify(d)).length })).sort((a, b) => b.bytes - a.bytes),
  };
}
