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
 * ## Retrieved vs returned (labelled pair)
 *
 * A root / agent span often carries BOTH the union of everything the agent
 * looked at and the subset it actually handed back; readers mistake the
 * former for the answer. Two key families are therefore labelled:
 *
 * - `*.retrieved.*` — a `retrieved` key segment (`retrieval.retrieved.ids`,
 *   `myagent.retrieved.doc_ids`), or a segment ending in `_retrieved` /
 *   starting `retrieved_…ids` (`docs_retrieved`, `retrieved_ids`) →
 *   **Retrieved (seen)** — candidates the agent pulled in from any source.
 * - `*.results*` / `*.returned.*` / `*.recommended.*` — a key segment that is
 *   exactly `results`, `returned` or `recommended`, or one of those followed
 *   by `_…ids` (`retrieval.results.ids`, `myagent.results`, `x.returned_ids`)
 *   → **Returned (recommended)** — what the agent surfaced to the caller.
 *   Siblings such as `x.results_count` / `x.results.source` are NOT id lists
 *   and are left alone.
 *
 * Only list-shaped values count for the pair (a scalar or an unparseable blob
 * under one of these keys stays in the plain attribute table). Canonical
 * names: `retrieval.retrieved.ids` and `retrieval.results.ids`. When a span
 * carries both, the UI reports the overlap ("12 of 20 retrieved were
 * returned", over distinct ids). `*.hit_ids` / `*.result_ids` /
 * `retrieval.ids` stay neutral: on a search span they are simply the hits of
 * that one call.
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

/**
 * Which side of the retrieved/returned pair an id-list attribute belongs to.
 * `ids` is the neutral #527 convention (`*.hit_ids` / `*.result_ids` /
 * `retrieval.ids`) — the hits of one search call, no claim about the answer.
 */
export type RetrievalIdListRole = 'retrieved' | 'returned' | 'ids';

export interface RetrievalIdList {
  /** The attribute the ids were read from (e.g. `myagent.search.hit_ids`). */
  attribute: string;
  /** Parsed ids; empty when the value could not be parsed as a list. */
  ids: string[];
  /** The attribute value verbatim when it was NOT parseable as a list. */
  raw?: string;
  /** Role derived from the key (see module doc). */
  role: RetrievalIdListRole;
}

export interface RetrievedVsReturned {
  /** Lists whose key marks them as candidates the agent saw. */
  retrieved: RetrievalIdList[];
  /** Lists whose key marks them as what the agent returned / recommended. */
  returned: RetrievalIdList[];
  /** Distinct ids across all `retrieved` lists. */
  retrievedIds: string[];
  /** Distinct ids across all `returned` lists. */
  returnedIds: string[];
  /**
   * Overlap when BOTH sides parsed to at least one id: how many distinct
   * retrieved ids also appear in the returned set, and how many returned ids
   * were never retrieved (a hint the "returned" list came from elsewhere).
   */
  overlap: { returnedFromRetrieved: number; returnedNotRetrieved: number } | null;
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
/** `retrieved` as a segment (or `…_retrieved`, `retrieved_…ids`): `x.retrieved.ids`, `docs_retrieved`, `retrieved_ids`. */
const RETRIEVED_KEY_RE = /(^|[._])retrieved(_[a-z0-9_]*ids)?(\.|$)/;
/** `results` / `returned` / `recommended` as a segment (or followed by `_…ids`): `x.results`, `x.results.ids`, `x.returned_ids`. */
const RETURNED_KEY_RE = /(^|\.)(results|returned|recommended)(_[a-z0-9_]*ids)?(\.|$)/;

/** `retrieved` for the seen-candidates family, `returned` for the answer family, else `null`. */
export function classifyRetrievalIdListKey(key: string): RetrievalIdListRole | null {
  if (RETRIEVED_KEY_RE.test(key)) return 'retrieved';
  if (RETURNED_KEY_RE.test(key)) return 'returned';
  if (key === ID_LIST_EXACT_KEY || ID_LIST_KEY_RE.test(key)) return 'ids';
  return null;
}

export function isRetrievalIdListKey(key: string): boolean {
  return classifyRetrievalIdListKey(key) !== null;
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
    const role = classifyRetrievalIdListKey(key);
    if (!role) continue;
    const value = attrs[key];
    if (value === null || value === undefined || value === '') continue;
    const ids = parseIdList(value);
    if (ids) {
      if (ids.length > 0) lists.push({ attribute: key, ids, role });
      continue;
    }
    // Not list-shaped. The neutral `*.hit_ids` keys PROMISE a list, so their
    // value is kept verbatim rather than dropped (#527 behaviour). The
    // retrieved / returned families are matched by looser key patterns, so a
    // non-list value there (`x.results.source`, a list of result objects) is
    // simply not part of the pair — it stays in the plain attribute table.
    if (role === 'ids') {
      lists.push({ attribute: key, ids: [], raw: typeof value === 'string' ? value : JSON.stringify(value), role });
    }
  }
  return lists;
}

function distinct(lists: RetrievalIdList[]): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const id of l.ids) seen.add(id);
  return [...seen];
}

/**
 * Split a span's id lists into the labelled retrieved/returned pair and
 * compute the overlap. Works on any span (root, agent, tool, retrieval); both
 * sides are empty when the span uses neither key family.
 */
export function extractRetrievedVsReturned(span: Span): RetrievedVsReturned {
  const lists = extractRetrievalIdLists(span);
  const retrieved = lists.filter(l => l.role === 'retrieved');
  const returned = lists.filter(l => l.role === 'returned');
  const retrievedIds = distinct(retrieved);
  const returnedIds = distinct(returned);
  let overlap: RetrievedVsReturned['overlap'] = null;
  if (retrievedIds.length > 0 && returnedIds.length > 0) {
    const seen = new Set(retrievedIds);
    const returnedFromRetrieved = returnedIds.filter(id => seen.has(id)).length;
    overlap = { returnedFromRetrieved, returnedNotRetrieved: returnedIds.length - returnedFromRetrieved };
  }
  return { retrieved, returned, retrievedIds, returnedIds, overlap };
}

/** `"12 of 20 retrieved were returned"` (+ a note when some returned ids were never retrieved). */
export function describeOverlap(rr: RetrievedVsReturned): string | null {
  if (!rr.overlap) return null;
  const { returnedFromRetrieved, returnedNotRetrieved } = rr.overlap;
  const base = `${returnedFromRetrieved} of ${rr.retrievedIds.length} retrieved were returned`;
  return returnedNotRetrieved > 0
    ? `${base}; ${returnedNotRetrieved} returned id${returnedNotRetrieved === 1 ? ' was' : 's were'} not in the retrieved set`
    : base;
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
    const label = list.role === 'retrieved' ? 'Retrieved (seen) ' : list.role === 'returned' ? 'Returned (recommended) ' : '';
    outputLines.push(`${label}${list.attribute} (${list.ids.length}):`);
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
