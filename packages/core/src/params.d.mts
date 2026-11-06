// Ported from advanced-packaging-atlas/engine/src/params/params.d.mts at fe39985 (GPL-3.0-or-later). Changes: declarations added for MAX_PARAMS, PARAM_NAME, expressionUnit and the skipKeys option (exported by params.mjs, missing from the atlas .d.mts).
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from eo-modulator-atlas engine/src/params.d.mts at eb97f96 (GPL-3.0-or-later).
// Local changes: none (verbatim copy).
export const EXPRESSION_PREFIX: string;
export const MAX_EXPRESSION_LENGTH: number;
export type ExprNode = { k: 'num'; v: number } | { k: 'ref'; name: string } | { k: 'neg'; a: ExprNode }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: ExprNode; b: ExprNode } | { k: 'call'; name: string; args: ExprNode[] };
export function parseExpression(src: string): ExprNode;
export function evaluateExpression(src: string, values?: Record<string, number>): number;
export function evaluateAst(ast: ExprNode, values: Record<string, number>, src?: string): number;
export function referencedNames(ast: ExprNode): string[];
export function isExpression(v: unknown): boolean;
export function unitOfKey(key: string): string | null;
export function normalizeUnit(u: string | null | undefined): string | null;
export function resolveParams(raw: unknown, overrides?: Record<string, number>): {
  values: Record<string, number>;
  defs: Record<string, { value: number | string; unit: string | null; description: string | null; expression: string | null; overridden: boolean }>;
};
export function substituteExpressions<T>(tree: T, values: Record<string, number>, units?: Record<string, string | null>, options?: { skip?: string[]; skipKeys?: string[] }):
  { tree: T; substitutions: { path: string; expression: string; value: number; unitChecked: boolean }[] };
export const MAX_PARAMS: number;
export const PARAM_NAME: RegExp;
export type ExpressionUnit = { kind: 'num' } | { kind: 'exact'; unit: string } | { kind: 'scaled'; unit: string } | { kind: 'unknown' };
export function expressionUnit(ast: ExprNode, units: Record<string, string | null>, src?: string): ExpressionUnit;
