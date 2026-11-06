// SPDX-License-Identifier: GPL-3.0-or-later
// Types of expr.mjs (ported from eo-modulator-atlas engine/src/postproc/expr.mjs at 0546007; declarations follow
// EO postproc/index.d.mts with the compiled-expression fields documented in expr.mjs).
import type { Dim } from './units.d.mts';
export class ExpressionError extends Error {
  constructor(message: string, pos?: number | null);
  pos: number | null;
}
export const MAX_EXPRESSION_LENGTH: number;
export const EXPRESSION_FUNCTIONS: readonly string[];
export interface ExprAst { k: 'num' | 'ref' | 'unit' | 'neg' | 'not' | 'bin' | 'call'; pos: number; [key: string]: unknown }
export type ScopeEntry =
  | { kind: 'const'; re: number; im?: number; dim: Dim; global?: boolean }
  | { kind: 'field'; key: string; dim: Dim; complex: boolean; continuous: boolean; mesh?: string | null };
export interface ExprScope { resolve(name: string): ScopeEntry | null; describe?(name: string): string }
export interface FieldValues { re: Float64Array; im: Float64Array | null }
export interface CompiledExpression {
  src: string; ast: ExprAst; dim: number[]; unit: string; complex: boolean; global: boolean; continuous: boolean;
  fields: Map<string, unknown>;
  constant: { re: number; im: number } | null;
  run(ctx: { n: number; get(key: string): FieldValues }): unknown;
}
export function parseExpression(src: string): ExprAst;
export function referencedNames(ast: ExprAst): string[];
export function compileExpression(src: string, scope: ExprScope): CompiledExpression;
export function evaluateConstant(compiled: CompiledExpression): { re: number; im: number } | null;
