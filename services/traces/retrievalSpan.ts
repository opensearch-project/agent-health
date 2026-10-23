/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retrieval (database / search) span helpers.
 *
 * Extracts the display-worthy input/output of a span that follows the OTel
 * database semantic conventions — the query that was sent and what came back.
 *
 * Input:  `db.query.text` (Recommended; legacy `db.statement`), pretty-printed
 *         when it is JSON, captioned with `db.operation.name` and the target
 *         (`db.collection.name`, falling back to `db.namespace`).
 * Output: `db.response.returned_rows` and `db.response.status_code`, plus any
 *         retrieved-id list the instrumentation chose to record.
 *
 * ## Id-list convention
 *
 * The DB conventions have no attribute for "which documents came back", yet
 * that is exactly what a retrieval-quality judge needs. Agents can expose it
 * with ANY attribute whose key ends in `.hit_ids` or `.result_ids`, or the
 * neutral key `retrieval.ids` — e.g. `myagent.search.hit_ids`. The value
 * should be an OTel string array or a JSON array serialised to text; a
 * single-quoted list literal (what `str(list)` yields in Python) is accepted
 * as well. Anything else is shown verbatim rather than guessed at. Nothing
 * here is specific to one agent.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/db/db-spans/
 */

import { Span } from '@/types';
import {
  ATTR_DB_SYSTEM_NAME,
  ATTR_DB_SYSTEM,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_STATEMENT,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_NAMESPACE,
  ATTR_DB_COLLECTION_NAME,
  ATTR_DB_RESPONSE_RETURNED_ROWS,
  ATTR_DB_RESPONSE_STATUS_CODE,
} from '@opentelemetry/semantic-conventions/incubating';

export interface RetrievalIdList {
  /** The attribute the ids were read from (e.g. `myagent.search.hit_ids`). */
  attribute: string;
  /** Parsed ids; empty when the value could not be parsed as a list. */
  ids: string[];
  /** The attribute value verbatim when it was NOT parseable as a list. */
  raw?: string;
}

export interface RetrievalIO {
  /** `db.system.name` (or legacy `db.system`). */
  system: string | null;
  /** `db.operation.name`. */
  operation: string | null;
  /** `db.collection.name`, falling back to `db.namespace`. */
  target: string | null;
  /** `db.namespace` (database / index namespace), when distinct from target. */
  namespace: string | null;
  /** One-line caption: `search products (opensearch)`. */
  caption: string | null;
  /** Query text, pretty-printed when it parses as JSON. Null when absent. */
  queryText: string | null;
  /** `db.response.returned_rows` as a number when parseable. */
  returnedRows: number | null;
  /** `db.response.status_code` verbatim. */
  statusCode: string | null;
  /** Retrieved-id lists found via the `*.hit_ids` / `*.result_ids` / `retrieval.ids` convention. */
  idLists: RetrievalIdList[];
  /** Human-readable output block (rows, status, ids) or null when nothing is known. */
  outputText: string | null;
}

/** Attribute keys that carry retrieved ids (see module doc). */
const ID_LIST_KEY_RE = /(^|\.)(hit_ids|result_ids)$/;
const ID_LIST_EXACT_KEY = 'retrieval.ids';

export function isRetrievalIdListKey(key: string): boolean {
  return key === ID_LIST_EXACT_KEY || ID_LIST_KEY_RE.test(key);
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'string' ? v : String(v);
}

/** Pretty-print JSON-shaped text; return other text verbatim. */
export function prettyPrintIfJson(text: string): string {
  const trimmed = text.trim();
  const looksJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksJson) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/** Scalar list items are stringified; nested objects/arrays are not ids. */
function scalarsToIds(items: unknown[]): string[] | null {
  const ids: string[] = [];
  for (const v of items) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') return null;
    const s = String(v);
    if (s.length > 0) ids.push(s);
  }
  return ids;
}

/**
 * Parse an id-list attribute value into `string[]`, or `null` when the value
 * is not a list. Accepts a native array, a JSON array serialised to text, and
 * a Python-style list literal (`['a', 'b']` — JSON with single quotes). No
 * comma-splitting of arbitrary strings: an unparseable value is left to the
 * caller to show verbatim.
 */
export function parseIdList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return scalarsToIds(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) return null;
  for (const candidate of [trimmed, trimmed.replace(/'/g, '"')]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return scalarsToIds(parsed);
      return null;
    } catch {
      /* try the next candidate encoding */
    }
  }
  return null;
}

/**
 * Collect every id-list attribute on the span following the convention.
 * Unparseable values are kept with `raw` set so nothing is silently dropped.
 */
export function extractRetrievalIdLists(span: Span): RetrievalIdList[] {
  const attrs = span.attributes || {};
  const lists: RetrievalIdList[] = [];
  for (const key of Object.keys(attrs)) {
    if (!isRetrievalIdListKey(key)) continue;
    const value = attrs[key];
    if (value === null || value === undefined || value === '') continue;
    const ids = parseIdList(value);
    if (ids) {
      if (ids.length > 0) lists.push({ attribute: key, ids });
    } else {
      lists.push({ attribute: key, ids: [], raw: typeof value === 'string' ? value : JSON.stringify(value) });
    }
  }
  return lists;
}

/**
 * Extract the retrieval input/output of a DB-semconv span. Works on any span —
 * fields are null when the attributes are absent — so callers can use it as a
 * fallback without first checking the category.
 */
export function extractRetrievalIO(span: Span): RetrievalIO {
  const attrs = span.attributes || {};

  const system = toStr(attrs[ATTR_DB_SYSTEM_NAME] ?? attrs[ATTR_DB_SYSTEM]);
  const operation = toStr(attrs[ATTR_DB_OPERATION_NAME]);
  const collection = toStr(attrs[ATTR_DB_COLLECTION_NAME]);
  const namespace = toStr(attrs[ATTR_DB_NAMESPACE]);
  const target = collection ?? namespace;

  const rawQuery = attrs[ATTR_DB_QUERY_TEXT] ?? attrs[ATTR_DB_STATEMENT];
  let queryText: string | null = null;
  if (rawQuery !== null && rawQuery !== undefined && rawQuery !== '') {
    queryText = typeof rawQuery === 'string'
      ? prettyPrintIfJson(rawQuery)
      : JSON.stringify(rawQuery, null, 2);
  }

  const rowsRaw = attrs[ATTR_DB_RESPONSE_RETURNED_ROWS];
  const rowsNum = rowsRaw === null || rowsRaw === undefined || rowsRaw === '' ? NaN : Number(rowsRaw);
  const returnedRows = Number.isFinite(rowsNum) ? rowsNum : null;
  const statusCode = toStr(attrs[ATTR_DB_RESPONSE_STATUS_CODE]);
  const idLists = extractRetrievalIdLists(span);

  const captionParts = [operation, target].filter(Boolean);
  let caption: string | null = captionParts.length > 0 ? captionParts.join(' ') : null;
  if (system) caption = caption ? `${caption} (${system})` : system;

  const outputLines: string[] = [];
  if (returnedRows !== null) outputLines.push(`returned_rows: ${returnedRows}`);
  if (statusCode) outputLines.push(`status_code: ${statusCode}`);
  for (const list of idLists) {
    if (list.raw !== undefined) {
      outputLines.push(`${list.attribute}: ${list.raw}`);
      continue;
    }
    outputLines.push(`${list.attribute} (${list.ids.length}):`);
    outputLines.push(...list.ids.map(id => `  - ${id}`));
  }

  return {
    system,
    operation,
    target,
    namespace: namespace && namespace !== target ? namespace : null,
    caption,
    queryText,
    returnedRows,
    statusCode,
    idLists,
    outputText: outputLines.length > 0 ? outputLines.join('\n') : null,
  };
}
