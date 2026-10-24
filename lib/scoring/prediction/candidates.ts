/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Candidate extraction for deterministic evaluators — an ORDERED SOURCE
 * CHAIN with every attempt recorded.
 *
 * Owner incident: a 5-case run re-scored with a ranked-retrieval evaluator
 * came back "0 succeeded · 3 still failed" with "no candidate ids found in
 * the stored tool results" / "every retrieved id was an anchor" — while the
 * agent's final ranked list sat in plain sight in the LAST tool's result
 * (`records[]`), in the single raw response payload (`results[]`) and in the
 * answer text (`1. id 123 — …`). The `tool-hits-ordered` rule only read the
 * configured `hits` / `results` paths of every tool result, found nothing
 * (or only the anchor) and blamed the data. The extractor must exhaust the
 * places a ranked answer can live, in order of trust, and say which one it
 * used.
 *
 * Sources, in order — the first that yields a list (possibly an EXPLICITLY
 * empty one) wins and is recorded as `sourceUsed`; every attempt lands in
 * `sourceTried` with its count so a miss is explainable:
 *   1. `report.output`     — a typed output the connector declared
 *                            (`{ results: [{ id, rank? }] }`, `{ ids: [] }`,
 *                            or a bare array). Most trusted when present.
 *   2. `response-results`  — the agent's final answer
 *                            (`prediction/responseResults.ts`: JSON, fenced
 *                            JSON, the single raw payload, labelled list
 *                            lines). An explicit empty list is a real answer.
 *   3. `results-tool`      — the LAST tool result whose tool name matches
 *                            `resultsTool` (default: `return_results` /
 *                            `final_results` / `submit_results` / `results`),
 *                            or — regardless of name — whose payload carries
 *                            an ordered id list under an EXPLICITLY-returned
 *                            key (`returned_ids`, `recommended_ids`,
 *                            `result_ids`; the trace convention for
 *                            retrieved-vs-returned ids). Plain `results` /
 *                            `hits` are NOT enough on an arbitrary tool: a
 *                            search tool's `results[]` is what it RETRIEVED
 *                            (codex_review) — those are read only from a
 *                            name-matched results tool.
 *   4. `tool-hits`         — the evaluator's configured tool hits
 *                            (`prediction/toolHitsOrdered.ts`: every tool
 *                            result's `hitsPaths`, most recent first, cited
 *                            ids first). Credits everything RETRIEVED.
 *   5. `generic-scan`      — last resort, flagged `weak`: every value of an
 *                            id field (`id` / `_id` / …) anywhere inside every
 *                            tool result payload, most recent call first.
 *
 * Sources 1–3 are what the agent RETURNED (`returned: true`): an empty list
 * from them is an abstention and scores (`emptyRanking: 'zero'`, `abstain`
 * observable). Sources 4–5 are what the agent RETRIEVED: an empty list there
 * means "nothing found to score" (unevaluable), never an abstention — and an
 * evaluator that declared `source: 'response-results'` never falls through
 * to them at all (it opted into scoring what was returned; crediting every
 * retrieved hit is exactly what it exists to avoid). Their counts are still
 * recorded in `sourceTried` so a miss is explainable.
 *
 * The anchor filter (`anchorTools`) is applied AFTER extraction, to the
 * winning source's list, and is reported as `anchorRemoved` — so a list
 * emptied by the filter still says which source it came from and how many
 * ids it dropped.
 */

import type { DeterministicEvaluatorInputs, EvaluationReport, TrajectoryStep } from '@/types';
import { dedupeIds } from '@/lib/metrics/index';
import {
  extractToolHitsOrdered,
  idsFromToolResult,
  MAX_CANDIDATES,
  parseToolResultContent,
  toolHitsOptionsFromInputs,
  DEFAULT_HITS_PATHS,
  DEFAULT_ID_FIELDS,
} from '@/lib/scoring/prediction/toolHitsOrdered';
import {
  extractResponseResults,
  findResultsArray,
  idsFromResultsArray,
  responseResultsOptionsFromInputs,
  type ResponseResultsParsedFrom,
} from '@/lib/scoring/prediction/responseResults';

export type CandidateSource = 'report.output' | 'response-results' | 'results-tool' | 'tool-hits' | 'generic-scan';

export const CANDIDATE_SOURCE_ORDER: ReadonlyArray<CandidateSource> = ['report.output', 'response-results', 'results-tool', 'tool-hits', 'generic-scan'];

/** Sources that carry what the agent RETURNED (an empty list = abstention). */
export const RETURNED_SOURCES: ReadonlyArray<CandidateSource> = ['report.output', 'response-results', 'results-tool'];

/** Default tool-name pattern for the results tool (source 3); evaluator `inputs.prediction.resultsTool` overrides. */
export const DEFAULT_RESULTS_TOOL_PATTERN = '^(return|final|submit|commit)_?results?$|^results?$';

/** Payload keys that unambiguously name a RETURNED id list on ANY tool (source 3, name-independent). */
export const RETURNED_LIST_KEYS: ReadonlyArray<string> = ['returned_ids', 'recommended_ids', 'result_ids'];

/** Keys tried on a NAME-matched results tool (an agent's own "here is my answer" payload). */
export const RESULTS_TOOL_LIST_KEYS: ReadonlyArray<string> = [...RETURNED_LIST_KEYS, 'results', 'records', 'items', 'ids', 'hits'];

export interface CandidateAttempt {
  source: CandidateSource;
  /** Ids the attempt found (before anchor filtering). */
  count: number;
  /** Where exactly: parsed form, tool name, path list … (for humans). */
  detail: string;
}

export interface CandidateExtraction {
  /** Ranked candidate ids after the anchor filter, deduped, capped. */
  ranked: string[];
  /** A list was found (possibly explicitly empty) — false ⇒ nothing to score. */
  present: boolean;
  sourceUsed: CandidateSource | 'none';
  sourceTried: CandidateAttempt[];
  /** Ids the winning source produced, before the anchor filter. */
  candidateCount: number;
  anchorRemoved: number;
  /** Winning source is one the agent RETURNED (see RETURNED_SOURCES). */
  returned: boolean;
  /** Winning source is the generic scan — a guess, not a declared list. */
  weak: boolean;
  /** The evaluator scores RETURNED lists only (`response-results`): retrieved sources were recorded, never used. */
  returnedOnly: boolean;
  /** Distinct tool names whose results were inspected, in trajectory order. */
  toolsScanned: string[];
  /** `tool-hits` only: retrieved ids cited in the final answer (they lead the ranking). */
  citedCount: number;
  /** `response-results` only: which form produced the list. */
  parsedFrom?: ResponseResultsParsedFrom;
  /** Whether a final `response` / `assistant` step exists. */
  hasAnswer: boolean;
}

export interface CandidateChainOptions {
  prediction: DeterministicEvaluatorInputs['prediction'];
}

type StepLike = TrajectoryStep & { toolName?: string; toolArgs?: unknown; toolOutput?: unknown };

const toolResults = (trajectory: ReadonlyArray<TrajectoryStep> | null | undefined): StepLike[] =>
  (Array.isArray(trajectory) ? trajectory : []).filter((s): s is StepLike => !!s && s.type === 'tool_result');

/** Parsed payload of a tool result step (content, else toolOutput). */
const payloadOf = (step: StepLike): unknown => {
  const content = (step as any).content;
  return parseToolResultContent(
    typeof content === 'string' && content.trim() === '' ? step.toolOutput : content ?? step.toolOutput
  );
};

/** Ids of an array that is either bare ids or id-carrying objects; `undefined` when it is neither. */
function idsOfList(value: unknown, idField: string, rankField: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  if (value.every(v => typeof v === 'string' || typeof v === 'number')) {
    return dedupeIds(value as Array<string | number>);
  }
  if (value.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
    const ids = idsFromResultsArray(value, { idField, rankField });
    return ids.length > 0 ? ids : undefined;
  }
  return undefined;
}

/** The returned id list inside a payload, trying `keys` in order (top level, then one level down). */
function returnedListIn(payload: unknown, keys: ReadonlyArray<string>, idField: string, rankField: string): { ids: string[]; key: string } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (Array.isArray(payload)) {
    const ids = idsOfList(payload, idField, rankField);
    return ids ? { ids, key: '(root array)' } : undefined;
  }
  const obj = payload as Record<string, unknown>;
  for (const key of keys) {
    const ids = idsOfList(obj[key], idField, rankField);
    if (ids) return { ids, key };
  }
  for (const [outer, inner] of Object.entries(obj)) {
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    for (const key of keys) {
      const ids = idsOfList((inner as Record<string, unknown>)[key], idField, rankField);
      if (ids) return { ids, key: `${outer}.${key}` };
    }
  }
  return undefined;
}

/** Every value of an id field anywhere inside `value` (depth-first, document order). */
function scanIdFields(value: unknown, idFields: ReadonlyArray<string>, out: string[], depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) scanIdFields(v, idFields, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (idFields.includes(k)) {
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
      else if (typeof v === 'number' && Number.isFinite(v)) out.push(String(v));
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' || typeof x === 'number') out.push(String(x).trim());
      continue;
    }
    scanIdFields(v, idFields, out, depth + 1);
  }
}

const anchorIdsOf = (trajectory: ReadonlyArray<TrajectoryStep> | null | undefined, anchorTools: ReadonlyArray<{ tool: string; argKey: string }>): Set<string> => {
  const anchors = new Set<string>();
  if (anchorTools.length === 0) return anchors;
  for (const step of Array.isArray(trajectory) ? trajectory : []) {
    if (!step || step.type !== 'action') continue;
    const toolName = (step as StepLike).toolName;
    const args = (step as StepLike).toolArgs;
    for (const a of anchorTools) {
      if (a.tool !== toolName || !args || typeof args !== 'object') continue;
      const v = (args as Record<string, unknown>)[a.argKey];
      if (Array.isArray(v)) for (const id of dedupeIds(v)) anchors.add(id);
      else if (typeof v === 'string' || typeof v === 'number') for (const id of dedupeIds([v])) anchors.add(id);
    }
  }
  return anchors;
};

function compileResultsTool(pattern: string | undefined): RegExp {
  try {
    return new RegExp(pattern && pattern.trim() ? pattern : DEFAULT_RESULTS_TOOL_PATTERN, 'i');
  } catch {
    return new RegExp(DEFAULT_RESULTS_TOOL_PATTERN, 'i');
  }
}

/**
 * Run the chain. Pure — reads the report + evaluator inputs, returns the
 * ranked list with full provenance.
 */
export function extractCandidates(
  report: Pick<EvaluationReport, 'trajectory'> & { rawEvents?: unknown[]; output?: unknown },
  { prediction }: CandidateChainOptions
): CandidateExtraction {
  const toolHitsOpts = toolHitsOptionsFromInputs(prediction);
  const responseOpts = responseResultsOptionsFromInputs(prediction);
  const idField = responseOpts.idField?.trim() || 'id';
  const rankField = responseOpts.rankField?.trim() || 'rank';
  const idFields = toolHitsOpts.idFields && toolHitsOpts.idFields.length > 0 ? toolHitsOpts.idFields : DEFAULT_ID_FIELDS;
  const hitsPaths = toolHitsOpts.hitsPaths && toolHitsOpts.hitsPaths.length > 0 ? toolHitsOpts.hitsPaths : DEFAULT_HITS_PATHS;
  const anchorTools = toolHitsOpts.anchorTools ?? [];
  const resultsToolRe = compileResultsTool(prediction.source === 'tool-hits-ordered' ? prediction.resultsTool : undefined);

  // A `response-results` evaluator scores what was RETURNED only.
  const retrievedAllowed = prediction.source !== 'response-results';
  const notUsedNote = retrievedAllowed ? '' : ' (not used: this evaluator scores returned lists only)';

  const steps = toolResults(report?.trajectory);
  const toolsScanned = Array.from(new Set(steps.map(s => s.toolName || '(unnamed tool)')));
  const attempts: CandidateAttempt[] = [];
  type Winner = { source: CandidateSource; ids: string[]; parsedFrom?: ResponseResultsParsedFrom; cited?: number; preFiltered?: { candidateCount: number; anchorsRemoved: number } };
  let winner: Winner | undefined;
  const claim = (source: CandidateSource, ids: string[], extra: Omit<Winner, 'source' | 'ids'> = {}) => {
    if (!winner) winner = { source, ids, ...extra };
  };

  // 1. Typed output.
  const output = report?.output;
  if (output !== undefined && output !== null) {
    const found = returnedListIn(output, [...RETURNED_LIST_KEYS, 'results', 'ids', 'items', 'records'], idField, rankField)
      ?? (() => { const arr = findResultsArray(output, { idField, path: responseOpts.path }); return arr ? { ids: idsFromResultsArray(arr, { idField, rankField }), key: responseOpts.path ?? '(auto)' } : undefined; })();
    attempts.push({ source: 'report.output', count: found?.ids.length ?? 0, detail: found ? `report.output.${found.key}` : 'report.output (no id list recognised)' });
    if (found) claim('report.output', found.ids);
  }

  // 2. The final answer.
  const response = extractResponseResults(report, responseOpts);
  attempts.push({
    source: 'response-results',
    count: response.present ? response.ranked.length : 0,
    detail: response.present
      ? `final response (${response.parsedFrom})`
      : response.hasAnswer ? 'final response (no ranked list recognised)' : 'no final response step',
  });
  if (response.present) claim('response-results', response.ranked, { parsedFrom: response.parsedFrom });

  // 3. Results tool — last matching call wins; name match first, then payload convention.
  let resultsTool: { ids: string[]; detail: string } | undefined;
  for (let i = steps.length - 1; i >= 0 && !resultsTool; i--) {
    const step = steps[i];
    const name = step.toolName || '';
    const payload = payloadOf(step);
    if (resultsToolRe.test(name)) {
      const found = returnedListIn(payload, RESULTS_TOOL_LIST_KEYS, idField, rankField);
      attempts.push({ source: 'results-tool', count: found?.ids.length ?? 0, detail: found ? `tool '${name}' ${found.key}` : `tool '${name}' (no id list recognised)` });
      if (found) resultsTool = { ids: found.ids, detail: `tool '${name}' ${found.key}` };
    } else {
      const found = returnedListIn(payload, RETURNED_LIST_KEYS, idField, rankField);
      if (found && found.ids.length > 0) {
        attempts.push({ source: 'results-tool', count: found.ids.length, detail: `tool '${name}' ${found.key}` });
        resultsTool = { ids: found.ids, detail: `tool '${name}' ${found.key}` };
      }
    }
  }
  if (resultsTool) claim('results-tool', resultsTool.ids);

  // 4. Configured tool hits (per tool, so a miss names the tools it looked at).
  const perTool = new Map<string, number>();
  for (const step of steps) {
    const name = step.toolName || '(unnamed tool)';
    const ids = idsFromToolResult(payloadOf(step), { idFields, hitsPaths });
    perTool.set(name, (perTool.get(name) ?? 0) + ids.length);
  }
  // The tool-hits extractor applies the anchor filter itself (cited-first
  // ordering must see the non-anchor ids) — its counts are carried over.
  const hits = extractToolHitsOrdered(report?.trajectory, { idFields, hitsPaths, anchorTools });
  if (perTool.size === 0) {
    attempts.push({ source: 'tool-hits', count: 0, detail: 'no tool results in the stored trajectory' });
  } else {
    for (const [name, n] of perTool) attempts.push({ source: 'tool-hits', count: n, detail: `tool '${name}' hits (${hitsPaths.join(' / ')})${n > 0 ? notUsedNote : ''}` });
  }
  if (retrievedAllowed && hits.candidateCount > 0) claim('tool-hits', hits.ranked, { cited: hits.citedCount, preFiltered: { candidateCount: hits.candidateCount, anchorsRemoved: hits.anchorsRemoved } });

  // 5. Generic scan (weak).
  if (retrievedAllowed && !winner && steps.length > 0) {
    const perCall: string[][] = [];
    for (const step of steps) {
      const out: string[] = [];
      scanIdFields(payloadOf(step), idFields, out);
      if (out.length > 0) perCall.push(out);
    }
    const scanned = dedupeIds(perCall.slice().reverse().flat());
    attempts.push({ source: 'generic-scan', count: scanned.length, detail: `every '${idFields.join("' / '")}' value in ${steps.length} tool result${steps.length === 1 ? '' : 's'} (weak)` });
    if (scanned.length > 0) claim('generic-scan', scanned);
  }

  // Anchor filter — after extraction, on the winner only (the tool-hits
  // extractor already applied it and reports its own counts).
  const anchors = anchorIdsOf(report?.trajectory, anchorTools);
  const w = winner as Winner | undefined;
  const before = w ? dedupeIds(w.ids) : [];
  const afterAnchors = w?.preFiltered ? before : before.filter(id => !anchors.has(id));
  const ranked = afterAnchors.slice(0, MAX_CANDIDATES);

  return {
    ranked,
    present: !!w,
    sourceUsed: w?.source ?? 'none',
    sourceTried: attempts,
    candidateCount: w?.preFiltered ? w.preFiltered.candidateCount : before.length,
    anchorRemoved: w?.preFiltered ? w.preFiltered.anchorsRemoved : before.length - afterAnchors.length,
    returned: !!w && RETURNED_SOURCES.includes(w.source),
    weak: w?.source === 'generic-scan',
    returnedOnly: !retrievedAllowed,
    toolsScanned,
    citedCount: w?.source === 'tool-hits' ? (w.cited ?? 0) : 0,
    ...(w?.parsedFrom ? { parsedFrom: w.parsedFrom } : {}),
    hasAnswer: response.hasAnswer,
  };
}

/** Human one-liner: "0 from tool 'search' hits, 3 from tool 'return_results' records (used); anchor removed 1". */
export function describeCandidateSources(extraction: Pick<CandidateExtraction, 'sourceTried' | 'sourceUsed' | 'anchorRemoved' | 'candidateCount'>): string {
  let marked = false;
  const parts = extraction.sourceTried.map(a => {
    const isUsed = !marked && a.source === extraction.sourceUsed && a.count === extraction.candidateCount;
    if (isUsed) marked = true;
    return `${a.count} from ${a.detail}${isUsed ? ' (used)' : ''}`;
  });
  const anchor = extraction.anchorRemoved > 0 ? `; anchor removed ${extraction.anchorRemoved}` : '';
  return `${parts.join(', ') || 'no source produced candidates'}${anchor}`;
}
