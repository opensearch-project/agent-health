/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `response-results` — ranked prediction read from the agent's FINAL ANSWER.
 *
 * Retrieval agents increasingly RETURN a ranked list as their answer — a
 * payload whose body is an ordered `results[]` of `{ id, rank?, score?,
 * title?, … }`, often with an empty answer text. Scoring should credit what
 * the agent RECOMMENDED, not everything it happened to retrieve along the
 * way (that is what `tool-hits-ordered` does, and it over-credits: a gold id
 * fetched by some exploratory tool call but never recommended still counts).
 *
 * Where the list is read from, in order — the first source that yields a
 * list wins and is recorded as `parsedFrom`:
 *   1. `json`      — the final response step's `content` IS a JSON object or
 *                    array.
 *   2. `fenced`    — a ```json … ``` (or bare ```) block inside the response
 *                    text whose body is a JSON object / array.
 *   3. `raw-event` — a non-streaming connector's single raw response payload
 *                    (`report.rawEvents` holding exactly ONE plain object,
 *                    e.g. the REST connector's `rawEvents: [data]`), consulted
 *                    ONLY when a response step exists: the step is then a
 *                    RENDERING of that payload and the structured payload is
 *                    more reliable than re-parsing the rendering. It never
 *                    stands in for a missing answer. Streaming connectors
 *                    store many raw events and are never consulted.
 *   4. `text`      — best-effort: list lines (`1.` / `-` / `*` / `•`) whose
 *                    item text STARTS with an `id` label or carries one in
 *                    brackets, e.g. `1. id 2079 — title` or
 *                    `- Some title (id: 123)`. The label is REQUIRED and
 *                    mid-sentence prose (`- user id 123 was checked`) is
 *                    ignored, so bare numbers are never taken as ids.
 *   5. `none`      — no list could be recognised → `present: false` ⇒ the
 *                    engine treats every metric as UNEVALUABLE. "Could not
 *                    extract" is NOT "the agent returned nothing": to score an
 *                    abstention the agent must return an explicit EMPTY list
 *                    (`results: []`, parsed as one of the forms above), which
 *                    is a real, scorable outcome (`present: true`, ranked
 *                    metrics 0, `abstain` 1).
 *
 * "Final response step" = the last `response` step of the trajectory, or the
 * last `assistant` step when there is no `response` step at all. No such step
 * ⇒ nothing is parsed (`hasAnswer: false`, `present: false`).
 *
 * Inside a parsed JSON value the list is found at `path` (dotted) when the
 * evaluator declares one — it must resolve to an array that is empty or whose
 * elements are objects carrying `idField`, otherwise nothing is found — else
 * auto-detected: the root array itself, then the conventional keys `results`
 * / `hits` / `items`, then the first root-level array whose elements are
 * objects carrying `idField` (no deeper recursion — declare `path` for nested
 * shapes). Items are ordered by `rankField` (ascending, when the field is
 * numeric on every item) else by array order; ids are deduped keeping the
 * first occurrence and capped at {@link MAX_CANDIDATES}.
 */

import type { DeterministicEvaluatorInputs, EvaluationReport, TrajectoryStep } from '@/types';
import { dedupeIds } from '@/lib/metrics/index';
import { getPath, MAX_CANDIDATES } from '@/lib/scoring/prediction/toolHitsOrdered';

export const RESPONSE_RESULTS_RULE = 'response-results' as const;
export const DEFAULT_RESPONSE_ID_FIELD = 'id';
export const DEFAULT_RESPONSE_RANK_FIELD = 'rank';
/** Keys tried (in order) when `path` is not declared and the root is an object. */
export const DEFAULT_RESPONSE_LIST_KEYS: ReadonlyArray<string> = ['results', 'hits', 'items'];

export type ResponseResultsParsedFrom = 'json' | 'fenced' | 'raw-event' | 'text' | 'none';
export const RESPONSE_RESULTS_FORMS = 'a JSON object/array with a results list, a fenced JSON block, or list lines labelled `id`';

export interface ResponseResultsOptions {
  /** Dotted path to the array inside the parsed JSON (default: auto-detect). */
  path?: string;
  /** Key carrying an item's id (default `id`). */
  idField?: string;
  /** Key carrying an item's 1-based rank (default `rank`); array order when absent/non-numeric. */
  rankField?: string;
}

export interface ResponseResultsPrediction {
  rule: typeof RESPONSE_RESULTS_RULE;
  /** Ranked recommended ids, deduped, capped. Empty = the agent returned nothing. */
  ranked: string[];
  /** Ids found before dedupe / cap. */
  candidateCount: number;
  /** Which form produced the list (`none` = no ranked list could be recognised). */
  parsedFrom: ResponseResultsParsedFrom;
  /** A ranked list WAS recognised (possibly empty) — false ⇒ every metric unevaluable. */
  present: boolean;
  /** Whether a `response` / `assistant` step was found in the trajectory. */
  hasAnswer: boolean;
}

interface ListItem {
  id: string;
  rank: number | undefined;
}

const idOf = (item: unknown, idField: string): string | null => {
  if (!item || typeof item !== 'object') return null;
  const v = (item as Record<string, unknown>)[idField];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

const rankOf = (item: unknown, rankField: string): number | undefined => {
  if (!item || typeof item !== 'object') return undefined;
  const v = (item as Record<string, unknown>)[rankField];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** A NON-EMPTY array whose elements are all objects, at least one carrying `idField`. */
const looksLikeResultList = (value: unknown, idField: string): value is unknown[] =>
  Array.isArray(value) && value.length > 0 && value.every(v => v && typeof v === 'object' && !Array.isArray(v)) && value.some(v => idOf(v, idField) !== null);

/** An EMPTY array, or a result list — the two shapes accepted as "the agent's ranked list". */
const isResultList = (value: unknown, idField: string): value is unknown[] =>
  Array.isArray(value) && (value.length === 0 || looksLikeResultList(value, idField));

/**
 * Locate the results array in a parsed JSON value. Returns the array (possibly
 * empty) or `undefined` when no list could be found. A declared `path` that
 * resolves to anything other than an empty / id-carrying array is NOT found —
 * a misconfigured path must surface as unevaluable, never as "returned nothing".
 */
export function findResultsArray(root: unknown, opts: Required<Pick<ResponseResultsOptions, 'idField'>> & Pick<ResponseResultsOptions, 'path'>): unknown[] | undefined {
  if (opts.path) {
    const v = getPath(root, opts.path);
    return isResultList(v, opts.idField) ? v : undefined;
  }
  if (Array.isArray(root)) return isResultList(root, opts.idField) ? root : undefined;
  if (!root || typeof root !== 'object') return undefined;
  const obj = root as Record<string, unknown>;
  for (const key of DEFAULT_RESPONSE_LIST_KEYS) {
    if (isResultList(obj[key], opts.idField)) return obj[key] as unknown[];
  }
  for (const key of Object.keys(obj)) {
    if (looksLikeResultList(obj[key], opts.idField)) return obj[key] as unknown[];
  }
  return undefined;
}

/** Ordered ids of a results array: by `rankField` when numeric on every item, else array order. */
export function idsFromResultsArray(items: unknown[], opts: Required<Pick<ResponseResultsOptions, 'idField' | 'rankField'>>): string[] {
  const listed: ListItem[] = [];
  for (const item of items) {
    const id = idOf(item, opts.idField);
    if (id === null) continue;
    listed.push({ id, rank: rankOf(item, opts.rankField) });
  }
  const allRanked = listed.length > 0 && listed.every(i => i.rank !== undefined);
  if (allRanked) {
    // Stable: equal ranks keep array order.
    listed.sort((a, b) => (a.rank as number) - (b.rank as number));
  }
  return listed.map(i => i.id);
}

const tryParseJson = (text: string): unknown => {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

// Any language tag: a non-JSON block (```js …```) must still consume its own
// closing fence so the following ```json block aligns.
const FENCE_RE = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;

/** Every parseable JSON object/array inside fenced code blocks, in order. */
export function fencedJsonBlocks(text: string): unknown[] {
  const out: unknown[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const parsed = tryParseJson(m[1]);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * Best-effort text fallback: list lines with an explicit `id` label.
 *   `1. id 2079 — Some title (score 6.3)`   → 2079   (label starts the item)
 *   `- Some title (id: 123)`                → 123    (label in brackets)
 *   `* ID #A-77`                            → A-77
 * A line must start like a list item (`1.` `1)` `-` `*` `•`) AND carry the
 * whole word `id` (case-insensitive) either as the FIRST word of the item or
 * opening a `(…)` / `[…]` group, followed by an optional `:`/`=`/`#` and the
 * id token. Mid-sentence prose (`- user id 123 was checked`) and lines
 * without the label are ignored, so prose numbers, scores and prices are
 * never mistaken for ids; null-ish tokens (`id: none`, `id: null`) are not ids.
 */
const LIST_LINE_RE = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/;
const ID_LABEL_RE = /(?:^|[(\[]\s*)[`*_"']*id[`*_"']*(?![A-Za-z0-9])\s*[:=#]?\s*[`"']?([A-Za-z0-9][A-Za-z0-9_.:\/-]*)/i;
const NOT_AN_ID = new Set(['null', 'none', 'n/a', 'na', 'undefined', 'nil']);

export function idsFromTextList(text: string): string[] {
  const ids: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = LIST_LINE_RE.exec(rawLine);
    if (!line) continue;
    const m = ID_LABEL_RE.exec(line[1]);
    if (!m) continue;
    // Trim a trailing sentence period (`id 42.`) but keep dotted ids (`doc.42`).
    const id = m[1].replace(/\.$/, '');
    if (NOT_AN_ID.has(id.toLowerCase())) continue;
    ids.push(id);
  }
  return ids;
}

/** The final response step: the last `response`, else the last `assistant` step with string content. */
export function finalResponseStep(trajectory: ReadonlyArray<TrajectoryStep> | null | undefined): TrajectoryStep | undefined {
  const steps = Array.isArray(trajectory) ? trajectory : [];
  let lastAssistant: TrajectoryStep | undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s || typeof s.content !== 'string') continue;
    if (s.type === 'response') return s;
    if (s.type === 'assistant' && !lastAssistant) lastAssistant = s;
  }
  return lastAssistant;
}

/** The single raw response payload of a non-streaming connector, when that is what `rawEvents` holds. */
const singleRawPayload = (rawEvents: unknown): Record<string, unknown> | undefined => {
  if (!Array.isArray(rawEvents) || rawEvents.length !== 1) return undefined;
  const only = rawEvents[0];
  return only && typeof only === 'object' && !Array.isArray(only) ? (only as Record<string, unknown>) : undefined;
};

export function extractResponseResults(
  report: Pick<EvaluationReport, 'trajectory'> & { rawEvents?: unknown[] },
  options: ResponseResultsOptions = {}
): ResponseResultsPrediction {
  const idField = options.idField?.trim() || DEFAULT_RESPONSE_ID_FIELD;
  const rankField = options.rankField?.trim() || DEFAULT_RESPONSE_RANK_FIELD;
  const path = options.path?.trim() || undefined;
  const step = finalResponseStep(report?.trajectory);
  // The raw payload only ever structures an EXISTING answer.
  const rawPayload = step ? singleRawPayload(report?.rawEvents) : undefined;
  const text = step?.content ?? '';

  const finish = (ids: string[], parsedFrom: ResponseResultsParsedFrom): ResponseResultsPrediction => ({
    rule: RESPONSE_RESULTS_RULE,
    ranked: dedupeIds(ids).slice(0, MAX_CANDIDATES),
    candidateCount: ids.length,
    parsedFrom,
    present: parsedFrom !== 'none',
    hasAnswer: step !== undefined,
  });
  const fromValue = (value: unknown): string[] | undefined => {
    const arr = findResultsArray(value, { idField, path });
    return arr ? idsFromResultsArray(arr, { idField, rankField }) : undefined;
  };

  // 1. The response IS JSON.
  const whole = tryParseJson(text);
  if (whole !== undefined) {
    const ids = fromValue(whole);
    if (ids) return finish(ids, 'json');
  }
  // 2. Fenced JSON inside the text.
  for (const block of fencedJsonBlocks(text)) {
    const ids = fromValue(block);
    if (ids) return finish(ids, 'fenced');
  }
  // 3. Single raw payload of a non-streaming connector.
  if (rawPayload) {
    const ids = fromValue(rawPayload);
    if (ids) return finish(ids, 'raw-event');
  }
  // 4. Rendered text list with explicit id labels.
  const textIds = text ? idsFromTextList(text) : [];
  if (textIds.length > 0) return finish(textIds, 'text');
  // 5. No ranked list recognised → unevaluable (NOT an empty prediction).
  return finish([], 'none');
}

/** Build the extractor options from an evaluator's declared `inputs.prediction`. */
export function responseResultsOptionsFromInputs(prediction: DeterministicEvaluatorInputs['prediction'] | undefined): ResponseResultsOptions {
  if (!prediction || prediction.source !== 'response-results') return {};
  return { path: prediction.path, idField: prediction.idField, rankField: prediction.rankField };
}
