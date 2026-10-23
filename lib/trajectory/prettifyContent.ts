/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers that turn a trajectory step's `content` (or `toolArgs`) into
 * something a human can read.
 *
 * Tool results reach the UI as opaque strings. In practice they are very
 * often a *content envelope* — e.g. the MCP shape
 * `[{ "type": "text", "text": "<JSON encoded as a string>" }]` — whose inner
 * payload is itself JSON serialised to a string, so the raw value is a wall
 * of `\"` escapes. Nothing here knows about any particular agent or tool;
 * every decision is driven by the *shape* of the value:
 *
 *   1. parse the string as JSON when it parses;
 *   2. peel well-known envelopes (array of text items, `{content:[…]}`,
 *      `{output:'…'}`), recording each layer removed in `unwrapped`;
 *   3. recursively parse string values that are themselves JSON documents
 *      (depth-limited so a pathological payload can't recurse forever);
 *   4. classify whatever is left as `json`, `markdown` or plain `text`.
 *
 * Never throws — anything that doesn't fit falls back to `text`.
 *
 * Kept free of React so it can be unit-tested under Jest's node environment
 * and shared by every trajectory surface.
 */

import { hasRealMarkdown } from '@/lib/markdown';

export type NormalizedKind = 'json' | 'text' | 'markdown';

/** A layer that {@link normalizeStepContent} peeled off the original value. */
export type UnwrapLayer =
  /** Top-level string parsed as a JSON document. */
  | 'json-string'
  /** `[{type:'text', text}]` / `[{text}]` item list → concatenated text. */
  | 'mcp-content'
  /** `{ content: [ …text items… ] }` wrapper. */
  | 'content'
  /** `{ output: '<string>' }` wrapper. */
  | 'output'
  /** At least one nested string value was itself JSON and got parsed. */
  | 'nested-json';

export interface NormalizedContent {
  kind: NormalizedKind;
  /** Parsed value for `json`; the (possibly unwrapped) string for text/markdown. */
  value: unknown;
  /** Envelope layers removed, outermost first. Empty when nothing was unwrapped. */
  unwrapped: UnwrapLayer[];
  /** The original input as a string (what the "Raw" toggle shows). */
  raw: string;
  /**
   * True when the nested-string walk stopped early (node budget exhausted or
   * depth limit hit while a deeper string still looked like JSON), so some
   * string values that are JSON documents were left as strings.
   */
  truncated?: boolean;
}

export interface NormalizeOptions {
  /**
   * How many levels of "string that is itself a JSON document" to parse
   * while walking the value. Default 3. The top-level parse does not count.
   */
  maxDepth?: number;
  /**
   * Upper bound on the number of container nodes visited during the nested
   * walk, so a multi-megabyte result can't stall the UI. Default 20 000.
   */
  nodeBudget?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_NODE_BUDGET = 20_000;

/** Keys that are pure metadata on a content envelope — dropping them loses nothing. */
const ENVELOPE_META_KEYS = new Set(['type', 'role', 'id', 'tool_use_id', 'name']);
/** Error flags are metadata only while falsy — a `true` must stay visible. */
const ENVELOPE_FLAG_KEYS = new Set(['isError', 'is_error']);

/** Is `key` on `obj` an envelope-metadata key whose value can be dropped without losing information? */
function isDroppableEnvelopeKey(obj: Record<string, unknown>, key: string): boolean {
  if (ENVELOPE_META_KEYS.has(key)) return true;
  if (ENVELOPE_FLAG_KEYS.has(key)) return !obj[key];
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Does this string *look* like a JSON document? Cheap gate before the
 * (comparatively expensive) `JSON.parse` — a prose sentence never starts
 * with `{` or `[`. Scalars (`"abc"`, `42`, `true`) are deliberately not
 * treated as JSON documents: showing `42` as a tree helps nobody.
 */
export function looksLikeJsonDocument(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  const first = t[0];
  const last = t[t.length - 1];
  return (first === '{' && last === '}') || (first === '[' && last === ']');
}

/** `JSON.parse` that returns `undefined` instead of throwing, gated by shape. */
export function tryParseJsonDocument(s: string): unknown {
  if (!looksLikeJsonDocument(s)) return undefined;
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One `{ type?: 'text', text: string }` item of a content list. */
function isTextItem(v: unknown): v is { text: string; type?: string } {
  if (!isPlainObject(v)) return false;
  if (typeof v.text !== 'string') return false;
  if ('type' in v && v.type !== undefined && v.type !== 'text') return false;
  for (const k of Object.keys(v)) {
    if (k !== 'text' && !isDroppableEnvelopeKey(v, k)) return false;
  }
  return true;
}

/** Is `v` a non-empty array made only of text items? */
function isTextItemList(v: unknown): v is Array<{ text: string }> {
  return Array.isArray(v) && v.length > 0 && v.every(isTextItem);
}

function joinTextItems(items: Array<{ text: string }>): string {
  return items.map((i) => i.text).join('\n');
}

/**
 * Peel one envelope layer. Returns `undefined` when `v` is not an envelope.
 * The result is a *string* for text envelopes (the caller re-runs the JSON
 * gate on it) or a nested value for `{content:[…]}` whose items aren't text.
 */
function unwrapOnce(v: unknown): { layer: UnwrapLayer; value: unknown } | undefined {
  if (isTextItemList(v)) {
    return { layer: 'mcp-content', value: joinTextItems(v) };
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    const others = keys.filter((k) => !isDroppableEnvelopeKey(v, k));
    if (others.length === 1 && others[0] === 'content' && isTextItemList(v.content)) {
      return { layer: 'content', value: joinTextItems(v.content) };
    }
    if (others.length === 1 && others[0] === 'output' && typeof v.output === 'string') {
      return { layer: 'output', value: v.output };
    }
  }
  return undefined;
}

/**
 * Walk `value`, replacing any string that is itself a JSON document with its
 * parsed form. `depth` counts string→JSON hops, not object nesting: the
 * common `{"result": "{\"hits\": [...]}"}` is one hop. Returns the new value
 * and whether anything changed. Never mutates the input.
 */
function deepParseStrings(
  value: unknown,
  depth: number,
  budget: { left: number; truncated: boolean }
): { value: unknown; changed: boolean } {
  if (budget.left <= 0 || depth <= 0) {
    // Out of budget / hops: anything below that still looks like JSON stays a
    // string. Record that so the UI can say so instead of looking complete.
    if (!budget.truncated && containsJsonLikeString(value, 200)) budget.truncated = true;
    return { value, changed: false };
  }

  if (typeof value === 'string') {
    const parsed = tryParseJsonDocument(value);
    if (parsed === undefined) return { value, changed: false };
    // A string hop consumed one depth level; keep walking the parsed doc.
    const inner = deepParseStrings(parsed, depth - 1, budget);
    return { value: inner.value, changed: true };
  }

  if (Array.isArray(value)) {
    budget.left -= 1;
    let changed = false;
    const out = value.map((item) => {
      const r = deepParseStrings(item, depth, budget);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed } : { value, changed };
  }

  if (isPlainObject(value)) {
    budget.left -= 1;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = deepParseStrings(v, depth, budget);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return changed ? { value: out, changed } : { value, changed };
  }

  return { value, changed: false };
}

/** Bounded scan: does this value (or anything under it, visiting ≤ `limit` values) hold a JSON-looking string? */
function containsJsonLikeString(value: unknown, limit: number): boolean {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited < limit) {
    const v = stack.pop();
    visited += 1;
    if (typeof v === 'string') {
      if (looksLikeJsonDocument(v)) return true;
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (isPlainObject(v)) {
      for (const item of Object.values(v)) stack.push(item);
    }
  }
  return false;
}

function toRawString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  try {
    return JSON.stringify(content, null, 2) ?? String(content);
  } catch {
    return String(content);
  }
}

function classifyText(s: string): NormalizedContent['kind'] {
  return hasRealMarkdown(s) ? 'markdown' : 'text';
}

/**
 * Normalise a trajectory step's content for display. See the module docs for
 * the algorithm. `content` may be the persisted string or an already-parsed
 * object (e.g. `step.toolArgs`).
 */
export function normalizeStepContent(content: string | unknown, options: NormalizeOptions = {}): NormalizedContent {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const budget = { left: options.nodeBudget ?? DEFAULT_NODE_BUDGET, truncated: false };
  const raw = toRawString(content);
  const unwrapped: UnwrapLayer[] = [];

  try {
    let value: unknown = content;

    if (typeof value === 'string') {
      const parsed = tryParseJsonDocument(value);
      if (parsed === undefined) {
        return { kind: classifyText(value), value, unwrapped, raw };
      }
      value = parsed;
      unwrapped.push('json-string');
    }

    if (value === null || typeof value !== 'object') {
      // A bare scalar was handed in (not a string) — nothing to prettify.
      return { kind: 'text', value: raw, unwrapped, raw };
    }

    // Peel envelopes. Each text envelope yields a string, which may itself be
    // JSON (the MCP case) or prose. Bounded by the same depth as the walk so
    // the worst case is `maxDepth` envelope layers.
    for (let i = 0; i < maxDepth + 1; i++) {
      const peeled = unwrapOnce(value);
      if (!peeled) break;
      unwrapped.push(peeled.layer);
      value = peeled.value;
      if (typeof value === 'string') {
        const parsed = tryParseJsonDocument(value);
        if (parsed === undefined) {
          return { kind: classifyText(value), value, unwrapped, raw };
        }
        value = parsed;
      }
    }

    const walked = deepParseStrings(value, maxDepth, budget);
    if (walked.changed) unwrapped.push('nested-json');

    const result: NormalizedContent = { kind: 'json', value: walked.value, unwrapped, raw };
    if (budget.truncated) result.truncated = true;
    return result;
  } catch {
    return { kind: classifyText(raw), value: raw, unwrapped: [], raw };
  }
}

// ---------------------------------------------------------------------------
// Shape helpers used by the renderer (and by previews in TrajectoryView).
// ---------------------------------------------------------------------------

export interface TabularShape {
  /** Union of row keys, in first-seen order. */
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Minimum rows before an array of objects is offered as a table. */
export const TABLE_MIN_ROWS = 3;
/** Above this many columns a table is unreadable — stay a tree. */
export const TABLE_MAX_COLUMNS = 30;

/**
 * Is `value` an array of ≥{@link TABLE_MIN_ROWS} plain objects that share at
 * least half of the union of keys? (Search hits, ranked results, log rows…)
 * Returns the column list when it is, `null` otherwise.
 */
export function detectTabular(value: unknown): TabularShape | null {
  if (!Array.isArray(value) || value.length < TABLE_MIN_ROWS) return null;
  if (!value.every(isPlainObject)) return null;
  const rows = value as Record<string, unknown>[];

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
        if (columns.length > TABLE_MAX_COLUMNS) return null;
      }
    }
  }
  if (columns.length === 0) return null;

  const threshold = columns.length / 2;
  for (const row of rows) {
    const present = Object.keys(row).length;
    if (present < threshold) return null;
  }
  return { columns, rows };
}

export type ValueType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined';

export function typeOfValue(v: unknown): ValueType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'object') return 'object';
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return t;
  return 'string';
}

/**
 * One-line description of a value: `object · 6 keys`, `array · 20 items`,
 * `table · 20 rows × 7 cols` for a homogeneous array, `string · 8178 chars`.
 * Pass a precomputed `detectTabular` result to avoid a second scan.
 */
export function summarizeValue(value: unknown, table: TabularShape | null = detectTabular(value)): string {
  if (table) return `table · ${table.rows.length} rows × ${table.columns.length} cols`;
  switch (typeOfValue(value)) {
    case 'array': {
      const n = (value as unknown[]).length;
      return `array · ${n} ${n === 1 ? 'item' : 'items'}`;
    }
    case 'object': {
      const n = Object.keys(value as object).length;
      return `object · ${n} ${n === 1 ? 'key' : 'keys'}`;
    }
    case 'string':
      return `string · ${(value as string).length} chars`;
    case 'number':
      return `number · ${String(value)}`;
    case 'boolean':
      return `boolean · ${String(value)}`;
    case 'null':
      return 'null';
    default:
      return 'undefined';
  }
}

/** Render a scalar the way the tree shows it (strings quoted). */
export function formatScalar(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  return String(v);
}

/**
 * Compact single-line preview for the collapsed state of a step: the summary
 * plus the first few keys (objects) or the first few scalar items (arrays),
 * never an escaped blob. Always ≤ `maxLength` characters.
 */
export function compactPreview(value: unknown, maxLength = 120): string {
  const table = detectTabular(value);
  const summary = summarizeValue(value, table);
  let detail = '';
  if (table) {
    const cols = table.columns;
    const shown = cols.slice(0, 6).join(', ');
    detail = cols.length > 6 ? `${shown}, …` : shown;
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const shown = keys.slice(0, 6).join(', ');
    detail = keys.length > 6 ? `${shown}, …` : shown;
  } else if (Array.isArray(value) && value.length > 0) {
    const scalars = value.filter((x) => x === null || typeof x !== 'object');
    if (scalars.length === value.length) {
      const shown = value.slice(0, 5).map(formatScalar).join(', ');
      detail = value.length > 5 ? `${shown}, …` : shown;
    }
  }
  const out = detail ? `${summary} · ${detail}` : summary;
  return out.length > maxLength ? out.slice(0, maxLength - 1).trimEnd() + '…' : out;
}

/** Pretty JSON for copy / tree fallback; never throws. */
export function stringifyPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}
