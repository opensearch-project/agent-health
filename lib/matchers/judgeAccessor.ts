/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified judge accessor — single source of truth for "what the LLM judge
 * said" on an EvaluationReport.
 *
 * Background: historically the judge verdict + reasoning lived in two
 * parallel surfaces:
 *
 *   1. report.llmJudgeReasoning (string) — written by the legacy
 *      auto-judge path (services/evaluation/index.ts and the various
 *      runners that call callBedrockJudge against expectedOutcomes).
 *      One per report, last writer wins.
 *
 *   2. report.matcherResults[*] with method: 'llm-judge' — written by
 *      the SDK `judge(result, claim)` matcher. Many per report.
 *
 * Both ultimately come from the same Bedrock Judge endpoint. Storing
 * them in two places caused real bugs (notably issue #230, where the
 * trace-mode placeholder leaked into the legacy field and bled through
 * to the UI for deterministic SDK runs).
 *
 * The fix: `matcherResults[]` is the canonical surface. The legacy
 * `llmJudgeReasoning` field is kept populated as a derived
 * convenience for backward-compat readers, but new code MUST use
 * {@link getJudgeMatcherResults} on the read side and
 * {@link recordJudgeMatcherResult} on the write side.
 */

import type { MatcherResult } from './types.js';
import type { JudgeResult } from '../../types/index.js';

/** A minimal duck-typed report shape — accepts any object with the two fields. */
export interface JudgeAccessReport {
  matcherResults?: MatcherResult[];
  llmJudgeReasoning?: string;
}

/**
 * Returns every llm-judge MatcherResult on the report, including a
 * synthetic entry derived from the legacy `llmJudgeReasoning` field
 * when the report pre-dates the unified surface.
 *
 * Read-only: nothing is written back to the report.
 *
 * Behaviour matrix:
 *
 * | matcherResults has [llm-judge] | llmJudgeReasoning      | Returns                    |
 * |--------------------------------|------------------------|----------------------------|
 * | yes                            | anything               | the existing entries       |
 * | no                             | empty / placeholder    | []                         |
 * | no                             | real reasoning         | [<synthetic entry>]        |
 *
 * The placeholder string `Waiting for traces to become available...`
 * is treated as "no judge ran yet" \u2014 see issue #230.
 */
export function getJudgeMatcherResults(report: JudgeAccessReport): MatcherResult[] {
  const fromMatcher = (report.matcherResults ?? []).filter(
    m => m.method === 'llm-judge'
  );
  if (fromMatcher.length > 0) {
    return fromMatcher;
  }

  const legacy = report.llmJudgeReasoning?.trim();
  if (!legacy || isPlaceholderReasoning(legacy)) {
    return [];
  }

  // Old report: synthesize a single virtual matcher entry so UIs that
  // render only matcherResults still have something to show.
  return [
    {
      description: 'judge: expected outcomes',
      pass: inferPassFromReport(report),
      method: 'llm-judge',
      reasoning: legacy,
    },
  ];
}

/**
 * Convenience: the single most recent llm-judge reasoning string, or
 * empty when no judge ran. Used by surfaces that historically read
 * `llmJudgeReasoning` directly (HTML report, skills grader, compare
 * view) and only need a flat string.
 */
export function getJudgeReasoningText(report: JudgeAccessReport): string {
  const entries = getJudgeMatcherResults(report);
  if (entries.length === 0) return '';
  // Most-recent-first: prefer the last entry the runner pushed. If
  // multiple entries exist (SDK with several judge() calls) we join
  // them with horizontal-rule markers so a flat-string consumer still
  // sees every claim.
  if (entries.length === 1) return entries[0].reasoning ?? '';
  return entries
    .map((m, i) => {
      const claim = m.description?.replace(/^judge:\s*/, '') ?? `claim ${i + 1}`;
      const verdict = m.pass ? 'PASS' : 'FAIL';
      return `### ${verdict} \u2014 ${claim}\n\n${m.reasoning ?? ''}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Convert a `JudgeResult` from `callBedrockJudge` into a `MatcherResult`.
 * Pure: doesn't touch any report. Used by inline-return code paths in
 * services/evaluation/index.ts where building a fresh report object is
 * cleaner than the mutate-then-return pattern.
 */
export function buildJudgeMatcherEntry(
  judgeResult: JudgeResultLike,
  options?: { claim?: string; model?: string }
): MatcherResult {
  const claim = options?.claim?.trim() || 'expected outcomes';
  const accuracy = judgeResult.metrics?.accuracy;
  const score = typeof accuracy === 'number' ? accuracy / 100 : undefined;
  const pass = judgeResult.passFailStatus === 'passed';
  const reasoning = judgeResult.llmJudgeReasoning ?? '';

  return {
    description: `judge: ${claim}`,
    pass,
    method: 'llm-judge',
    durationMs: judgeResult.judgeDurationMs,
    score,
    reasoning,
    ...(options?.model ? { model: options.model } : {}),
    ...(pass ? {} : { errorMessage: reasoning }),
    // Carry the rest of the judge payload through so SDK
    // `getJudgeMatcherResults()` consumers see the same data the
    // legacy report-level fields used to expose. See MatcherResult.
    ...(Array.isArray(judgeResult.improvementStrategies) && judgeResult.improvementStrategies.length > 0
      ? { improvementStrategies: judgeResult.improvementStrategies }
      : {}),
    ...(judgeResult.metrics && typeof judgeResult.metrics === 'object'
      ? { judgeMetrics: { ...judgeResult.metrics } as any }
      : {}),
  };
}

/**
 * Format an arbitrary `expectedOutcomes` value into a single description
 * fragment suitable for the matcher entry's `description` field. Accepts
 * the SDK's flat `string[]` *and* the legacy `{ rootCauses, requiredFacts,
 * conclusions }` object — both shapes appear on persisted test cases.
 */
export function formatExpectedOutcomesAsClaim(outcomes?: unknown): string {
  const items: string[] = [];
  if (Array.isArray(outcomes)) {
    for (const o of outcomes) {
      if (typeof o === 'string' && o.trim()) items.push(o.trim());
    }
  } else if (outcomes && typeof outcomes === 'object') {
    // Legacy shape: { rootCauses?: string[]; requiredFacts?: string[]; conclusions?: string[] }
    for (const key of Object.keys(outcomes as Record<string, unknown>)) {
      const v = (outcomes as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        for (const s of v) {
          if (typeof s === 'string' && s.trim()) items.push(s.trim());
        }
      }
    }
  }
  if (items.length === 0) return 'expected outcomes';
  if (items.length === 1) return items[0];
  return `${items.length} expected outcomes`;
}

/**
 * Convert a `JudgeResult` from `callBedrockJudge` into a `MatcherResult`
 * and append it to `report.matcherResults`. Also keeps the legacy
 * `report.llmJudgeReasoning` field populated as a derived
 * backward-compat shim (it equals the reasoning of the just-pushed
 * entry, so direct readers continue to work).
 *
 * Mutates the passed report and returns the matcher entry.
 *
 * The `claim` argument is what the auto-judge was evaluating against
 * (the test case's expected outcomes). The matcher description ends
 * up as `judge: <claim>` matching the SDK convention.
 */
export function recordJudgeMatcherResult(
  report: JudgeAccessReport & { matcherResults?: MatcherResult[]; llmJudgeReasoning?: string },
  judgeResult: JudgeResultLike,
  options?: { claim?: string; model?: string }
): MatcherResult {
  const entry = buildJudgeMatcherEntry(judgeResult, options);

  const existing = report.matcherResults ?? [];
  report.matcherResults = [...existing, entry];

  // Backward-compat shim: keep the legacy field populated with the most
  // recent reasoning so external readers that haven't migrated still
  // work. Empty string is a deliberate signal for SDK-multi-judge runs
  // (the field can't represent multiple verdicts; consumers must look
  // at matcherResults).
  report.llmJudgeReasoning = entry.reasoning ?? '';

  return entry;
}

/** Subset of `JudgeResult` we depend on \u2014 keeps this module type-import-light. */
export interface JudgeResultLike {
  passFailStatus: 'passed' | 'failed';
  metrics: { accuracy?: number; [k: string]: number | undefined };
  llmJudgeReasoning: string;
  judgeDurationMs?: number;
  improvementStrategies?: Array<{
    category: string;
    issue: string;
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
  }>;
}

// ─── internal helpers ───────────────────────────────────────────────────────

/**
 * The trace-mode init path sets `llmJudgeReasoning` to a placeholder
 * before any real verdict exists. We must not synthesize a virtual
 * matcher entry from that string \u2014 it's a "judge has not run yet"
 * signal, not real reasoning.
 */
function isPlaceholderReasoning(s: string): boolean {
  return /^Waiting for traces/i.test(s);
}

/**
 * Best-effort guess at the verdict for a synthesized entry on an old
 * report. Prefers an explicit `passFailStatus` if present; otherwise
 * falls back to the report's metrics.accuracy (>=70 ~ pass), and
 * finally defaults to `false` so a missing verdict never silently
 * looks green.
 */
function inferPassFromReport(report: JudgeAccessReport & { passFailStatus?: string; metrics?: { accuracy?: number } }): boolean {
  if (report.passFailStatus === 'passed') return true;
  if (report.passFailStatus === 'failed') return false;
  const acc = report.metrics?.accuracy;
  if (typeof acc === 'number') return acc >= 70;
  return false;
}

// Re-export the JudgeResult import path so callers can grab both the
// helpers and the type from one place.
export type { JudgeResult } from '../../types/index.js';
