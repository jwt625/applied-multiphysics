// Ported from eo-modulator-atlas/engine/src/yaml-edit.d.mts at 5a06dfd (GPL-3.0-or-later). Changes: declarations for
// parseStrict, disallowed, FORBIDDEN_KEYS, fmt, insertIn, stats and the deleteIn {prune} option.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Document } from 'yaml';
export type PathKey = string | number;
export { parseDocument as parseYamlDocument } from 'yaml';
/** Fallback printer options (lineWidth 0, flowCollectionPadding false); setIn/deleteIn splice the source when possible. */
export const PRINT: { readonly lineWidth: 0; readonly flowCollectionPadding: false };
/** Mapping keys rejected everywhere (audit S3). */
export const FORBIDDEN_KEYS: ReadonlySet<string>;
/** Reason a YAML node or pair is not allowed (alias, anchor, custom tag, forbidden key), or null. */
export function disallowed(n: unknown): string | null;
/** Parse with duplicate keys, anchors, aliases, custom tags and forbidden keys rejected; throws Error('YAML: ...'). */
export function parseStrict(text: string): Document.Parsed;
/** One-line flow YAML for a plain value. */
export function fmt(v: unknown): string;
export function splitPath(path: string | PathKey[]): PathKey[];
export function getIn(text: string, path: string | PathKey[]): unknown;
export function setIn(text: string, path: string | PathKey[], value: unknown): string;
export function deleteIn(text: string, path: string | PathKey[], opts?: { prune?: boolean }): string;
export function insertIn(text: string, path: string | PathKey[], index: number, value: unknown): string;
export function applyOverrides(text: string, overrides: [string | PathKey[], unknown][]): string;
/** Counters: verified source splices vs document-printer fallbacks. */
export const stats: { splice: number; fallback: number };
