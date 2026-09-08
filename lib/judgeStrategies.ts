/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Improvement-strategy recovery from a judge's raw output.
 *
 * Why this exists
 * ---------------
 * Every judge provider persists the model's verbatim text on
 * `report.llmJudgeResponse.rawResponse` and the parsed
 * `improvement_strategies` array on `report.improvementStrategies` (plus the
 * `[llm-judge]` matcher entry). For a window of time the agentic trace judge
 * forced the parsed array to `[]` on the way out (an RFC-era stance that the
 * verdict should not carry recommendations) while the raw text still held the
 * full `improvement_strategies` the evaluator prompt asked for. Every report
 * judged by that provider in the window therefore shows an empty Judge
 * Evaluation tab even though the data is sitting one field over.
 *
 * This module is the single place that knows how to get those strategies
 * back out of `rawResponse`. It is shared by:
 *
 *   - the run-report UI (RunDetailsContent), which renders recovered
 *     strategies with a "recovered" notice instead of a blank section;
 *   - `scripts/backfill-improvement-strategies.ts`, which persists the
 *     recovered arrays so every other reader (comparison page, HTML report,
 *     failure clustering) sees them too.
 *
 * It lives in `lib/` (not `server/services/judgeResponseParser.ts`) because
 * the browser bundle imports it and the SDK build (`tsconfig.lib.json`) must
 * not pull the server tree in.
 */

import type { ImprovementStrategy } from '../types/index.js';

/**
 * Extract the JSON object from a raw judge response.
 *
 * Handles three observed shapes from the wild:
 *   - markdown ```json fenced blocks
 *   - bare `{...}` JSON
 *   - JSON with leading/trailing prose that some models still emit despite
 *     being told not to
 *
 * Returns `undefined` when no `{...}` substring is present at all.
 */
export function extractJsonFromResponse(raw: string): string | undefined {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];
  const startIdx = trimmed.indexOf('{');
  const endIdx = trimmed.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return trimmed.slice(startIdx, endIdx + 1);
  }
  return undefined;
}

const VALID_STRATEGY_PRIORITIES = new Set(['high', 'medium', 'low']);

/**
 * Coerce whatever the model emitted for `improvement_strategies` into a
 * well-typed `ImprovementStrategy[]`. Non-object junk is dropped; a bare
 * string (some older prompts/models emit an array of plain strings) becomes
 * an entry with the string as the `issue`; an unknown `priority` defaults to
 * `medium`. The run-report UI indexes straight into `strategy.category` /
 * `strategy.priority`, so anything returned from here must be fully shaped.
 */
export function normalizeImprovementStrategies(value: unknown): ImprovementStrategy[] {
  if (!Array.isArray(value)) return [];
  const out: ImprovementStrategy[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ category: 'general', issue: entry, recommendation: '', priority: 'medium' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const priority = typeof raw.priority === 'string' && VALID_STRATEGY_PRIORITIES.has(raw.priority)
      ? (raw.priority as ImprovementStrategy['priority'])
      : 'medium';
    out.push({
      category: typeof raw.category === 'string' ? raw.category : 'general',
      issue: typeof raw.issue === 'string' ? raw.issue : '',
      recommendation: typeof raw.recommendation === 'string' ? raw.recommendation : '',
      priority,
    });
  }
  return out;
}

/**
 * Re-parse a judge's raw text and return the `improvement_strategies` it
 * contains, normalized. `[]` when the text is missing, not JSON, or carries
 * no strategies. Never throws — this runs on every render of the judge tab.
 */
export function recoverImprovementStrategies(rawResponse: string | undefined | null): ImprovementStrategy[] {
  if (!rawResponse || !rawResponse.includes('improvement_strategies')) return [];
  const jsonText = extractJsonFromResponse(rawResponse);
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText);
    return normalizeImprovementStrategies(parsed?.improvement_strategies);
  } catch {
    return [];
  }
}

/** The minimal report shape the helpers below read. */
export interface StrategyBearingReport {
  improvementStrategies?: ImprovementStrategy[];
  llmJudgeResponse?: {
    rawResponse?: string;
    improvementStrategies?: ImprovementStrategy[];
  };
  matcherResults?: Array<{
    method?: string;
    improvementStrategies?: ImprovementStrategy[];
  }>;
}

/**
 * Strategies to show for a report: the persisted array when present,
 * otherwise whatever can be recovered from the raw judge text.
 * `recovered` is true only when the UI is showing recovered (unpersisted)
 * strategies, so callers can render a notice pointing at the backfill.
 */
export function resolveImprovementStrategies(
  report: StrategyBearingReport
): { strategies: ImprovementStrategy[]; recovered: boolean } {
  // Persisted arrays are normalized too, so a malformed stored entry can't
  // crash the renderer any more than a recovered one can.
  const stored = normalizeImprovementStrategies(report.improvementStrategies);
  if (stored.length > 0) return { strategies: stored, recovered: false };
  const recovered = recoverImprovementStrategies(report.llmJudgeResponse?.rawResponse);
  return { strategies: recovered, recovered: recovered.length > 0 };
}

/**
 * The single `[llm-judge]` matcher row that the report-level judge response
 * belongs to, or `undefined` when there isn't exactly one. A report with
 * several judge rows (SDK tests calling `judge()` more than once) has one
 * `llmJudgeResponse` for the LAST call only, so stamping its strategies onto
 * every row would attribute advice to the wrong claim — in that case the
 * report-level array is still shown/persisted but no row is touched.
 */
export function soleJudgeMatcherIndex(report: StrategyBearingReport): number | undefined {
  const rows = report.matcherResults ?? [];
  const judgeIdx = rows.map((m, i) => (m.method === 'llm-judge' ? i : -1)).filter((i) => i >= 0);
  return judgeIdx.length === 1 ? judgeIdx[0] : undefined;
}

/** The exact PATCH body the backfill sends for one report. */
export interface ImprovementStrategiesBackfillPatch<R extends StrategyBearingReport = StrategyBearingReport> {
  improvementStrategies: ImprovementStrategy[];
  llmJudgeResponse: NonNullable<R['llmJudgeResponse']>;
  matcherResults?: NonNullable<R['matcherResults']>;
}

/**
 * Build the PATCH that persists recovered strategies onto a report, or
 * `null` when there is nothing to do (strategies already stored, or none
 * recoverable). Idempotent by construction: once applied, the top-level
 * array is non-empty and the next call returns `null`.
 *
 * `PATCH /api/storage/runs/:id` shallow-merges top-level fields, so nested
 * objects (`llmJudgeResponse`, `matcherResults`) are sent whole with only the
 * strategies filled in. `matcherResults` is included only when the report has
 * exactly one `[llm-judge]` row (see {@link soleJudgeMatcherIndex}) and that
 * row's own array is empty; code matchers and already-populated judge rows
 * are passed through untouched.
 */
export function buildImprovementStrategiesBackfillPatch<R extends StrategyBearingReport>(
  report: R
): ImprovementStrategiesBackfillPatch<R> | null {
  const { strategies, recovered } = resolveImprovementStrategies(report);
  if (!recovered || !report.llmJudgeResponse) return null;
  const patch: ImprovementStrategiesBackfillPatch<R> = {
    improvementStrategies: strategies,
    llmJudgeResponse: { ...report.llmJudgeResponse, improvementStrategies: strategies } as NonNullable<R['llmJudgeResponse']>,
  };
  const idx = soleJudgeMatcherIndex(report);
  if (idx !== undefined && !(report.matcherResults![idx].improvementStrategies?.length)) {
    patch.matcherResults = report.matcherResults!.map((m, i) =>
      i === idx ? { ...m, improvementStrategies: strategies } : m
    ) as NonNullable<R['matcherResults']>;
  }
  return patch;
}
