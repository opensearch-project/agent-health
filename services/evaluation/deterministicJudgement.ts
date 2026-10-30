/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * First judgement of a NEW run's report with a `kind: 'deterministic'`
 * evaluator (lib/evaluators/deterministic.ts) — the runner-side counterpart
 * of Retry judgement's `applyDeterministicJudgement`
 * (services/evaluation/retryJudgement.ts).
 *
 * Why this exists: a deterministic evaluator has no system prompt. Until this
 * module, the evaluation-run and benchmark runners forwarded ANY
 * `run.evaluatorId` to the LLM judge, so a new run with a ranked-hit /
 * ranked-recall / mrr evaluator ran the agent fine and then POSTed
 * `/api/judge`, which built a Bedrock Converse request with
 * `system: [{ text: '' }]` → `ValidationException` → 10 client retries with
 * exponential back-off (~8.5 min per case) and an errored report. Only Retry
 * judgement knew to score deterministic evaluators in code.
 *
 * The scoring itself is the single shared engine
 * (`lib/scoring/deterministicScoring.ts#scoreDeterministic`); this module only
 * turns its result into the report patch of a FIRST judgement:
 *   - evaluable      → verdict + metrics + snapshot + matcher rows,
 *                      `judgeMode: 'deterministic'`, no judge model, no LLM
 *                      fields;
 *   - not evaluable  → the canonical evaluator-error patch
 *                      (`metricsStatus: 'error'`, `passFailStatus: null`,
 *                      `traceError` says why) — "errored / not evaluable",
 *                      excluded from the pass rate, never a silent pass or a
 *                      fake zero (see the module comment in
 *                      lib/scoring/deterministicScoring.ts);
 *   - scorer threw   → the same error patch with the exception message.
 *
 * Persistence is the caller's: the non-traced runner path merges the patch
 * into the report BEFORE its one save; the trace-mode path applies it once
 * spans have built the trajectory. A storage failure is NOT swallowed here —
 * the runners' outer catch already records persistence failures honestly.
 *
 * Retry judgement's copy carries retry-only concerns (the re-judgement stamp,
 * keeping a prior verdict when the retry is not evaluable); a first judgement
 * has no prior verdict, so the two stay separate on purpose.
 */

import type { Evaluator, EvaluationReport, PassFailStatus, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { isDeterministicEvaluator } from '@/lib/evaluators/deterministic';
import { scoreDeterministic } from '@/lib/scoring/deterministicScoring';
import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { isSystemEvaluatorId, getSystemEvaluatorById } from '@/server/prompts/evaluatorTemplates';

export interface DeterministicJudgementOutcome {
  passFailStatus: PassFailStatus | null;
  /** Set when the report could not be scored (not evaluable, or the scorer threw). */
  error?: string;
}

export interface DeterministicFirstJudgement extends DeterministicJudgementOutcome {
  /** Report fields to persist (merge into the report doc). */
  patch: Record<string, unknown>;
}

/**
 * Resolve `evaluatorId` to its document and return it ONLY when it is a
 * deterministic evaluator; `null` for unset / unknown / LLM evaluators.
 * A storage failure propagates — the run cannot proceed without storage
 * anyway, and falling back to the LLM path would re-open the exact failure
 * this module exists to close.
 */
export async function resolveDeterministicEvaluator(
  evaluatorId: string | undefined,
  storage: IStorageModule
): Promise<Evaluator | null> {
  if (!evaluatorId) return null;
  const evaluator = isSystemEvaluatorId(evaluatorId)
    ? getSystemEvaluatorById(evaluatorId) ?? null
    : (await storage.evaluators?.getById(evaluatorId)) ?? null;
  return evaluator && isDeterministicEvaluator(evaluator) ? evaluator : null;
}

/**
 * Score `report` (its trajectory as given — the connector's, or the
 * span-built one for trace-mode agents) with a deterministic evaluator and
 * build the FIRST-judgement patch. Pure: never calls an LLM, never writes.
 */
export function buildDeterministicFirstJudgement(
  report: Pick<EvaluationReport, 'trajectory'> & { rawEvents?: unknown[] },
  testCase: TestCase,
  evaluator: Evaluator
): DeterministicFirstJudgement {
  try {
    const result = scoreDeterministic(evaluator, testCase, report as EvaluationReport);
    const common = {
      evaluatorId: evaluator.id,
      // No judge model was involved — never name one on the report.
      judgeModelId: null,
      judgeMode: 'deterministic' as const,
      scoringSnapshot: result.snapshot,
      matcherResults: result.matcherResults,
      improvementStrategies: [],
      llmJudgeReasoning: '',
      llmJudgeResponse: null,
      // Verdict-engine fields (lib/scoring/verdictEngine.ts): no LLM verdict
      // exists next to code-computed metrics.
      llmVerdict: null,
      verdictConflict: null,
      score: result.score,
    };
    if (!result.evaluable) {
      return {
        passFailStatus: null,
        error: result.summary,
        patch: {
          ...common,
          ...buildEvaluatorErrorPatch('judge_failed', `Not evaluable by ${evaluator.name}: ${result.summary}`),
          // The generic patch clears the snapshot (an LLM judge that failed
          // produced nothing); the deterministic scorer DID run and its
          // snapshot records which metrics were unevaluable and why.
          scoringSnapshot: result.snapshot,
          // No metrics on a not-evaluable report — never the legacy zeroed keys.
          metrics: {},
        },
      };
    }
    return {
      passFailStatus: result.passFailStatus,
      patch: {
        ...common,
        passFailStatus: result.passFailStatus,
        metrics: result.metrics,
        metricsStatus: 'completed',
        traceError: undefined,
      },
    };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return {
      passFailStatus: null,
      error: message,
      patch: {
        ...buildEvaluatorErrorPatch('judge_failed', `Deterministic scoring: ${message}`),
        judgeMode: 'deterministic' as const,
        matcherResults: [],
        improvementStrategies: [],
      },
    };
  }
}

/**
 * Build the first judgement and persist it onto an already-saved report
 * (trace-mode and benchmark paths). Storage errors propagate.
 */
export async function applyDeterministicFirstJudgement(
  report: EvaluationReport,
  testCase: TestCase,
  evaluator: Evaluator,
  storage: IStorageModule
): Promise<DeterministicJudgementOutcome> {
  const { patch, ...outcome } = buildDeterministicFirstJudgement(report, testCase, evaluator);
  await storage.runs.update(report.id, patch as any);
  return outcome;
}
