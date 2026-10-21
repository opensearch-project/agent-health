/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry judgement — salvage a TERMINAL evaluation run whose AGENT
 * executions completed fine but whose JUDGE phase failed per test case
 * (trace_timeout, judge 400s, "evaluator could not run", etc.).
 *
 * Re-runs ONLY the judge pipeline (a bounded trace re-fetch for trace-mode
 * agents, then the judge call) against the STORED trajectory/output — it
 * never re-invokes the agent. Owner ask: "retry judgement on failed kinda
 * functionality at a run level ... so that we retry once the tests are
 * run" (a run can have 40+ completed cases with errored judgements, e.g.
 * trace timeouts or judge 400s, and re-running the whole agent side is
 * wasteful).
 *
 * Selection predicate mirrors what the run-report UI already labels
 * "ERRORED" (`getResultStatus()` in components/evals3/ResultStatus.tsx):
 * `report.metricsStatus === 'error'` on an agent execution that completed.
 * That status is written exclusively by
 * `buildEvaluatorErrorPatch()` (services/evaluation/evaluatorError.ts) for
 * both `judge_failed`/`trace_*` kinds AND `agent_failed` (a genuine agent
 * crash) — the two are told apart here by whether the report actually has
 * a trajectory to re-judge: an `agent_failed` report has none, so it is
 * excluded (nothing stored to salvage).
 */

import type {
  EvaluationRun,
  EvaluationReport,
  Evaluator,
  TestCase,
  AgentConfig,
  PassFailStatus,
  RetryAttemptRecord,
  ScoringDiagnostics,
} from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { callBedrockJudge } from '@/services/evaluation';
import { buildJudgeAgentsHints } from '@/services/traces/judgeAgentsHints';
import { buildJudgeMatcherEntry, formatExpectedOutcomesAsClaim } from '@/lib/matchers/index';
import { buildJudgeIdentityPatch, buildLlmJudgeResponseIdentity, JUDGE_PROVIDER_NONE } from '@/lib/judgeIdentity';
import { CLEARED_REPORT_FAILURE_FIELDS } from '@/lib/reportFailureFields';
import { isRejudgeableResult } from '@/lib/runActions';
import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { scoringFieldsFromJudgment } from '@/lib/scoring/verdictEngine';
import { spansToTrajectory } from '@/services/traces/spansToTrajectory';
import { fetchSpansForRun } from '@/services/traces/fetchSpansForRun';
import { computeRunStats } from '@/lib/runStats';
import { extractJudgeFailureReason, computeJudgeFailureSummary } from '@/lib/judgeFailureSummary';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { getDefaultEvaluator } from '@/server/prompts/evaluatorTemplates';
import { debug } from '@/lib/debug';
import { readEnv } from '@/lib/envCompat';
import { isSystemEvaluatorId, getSystemEvaluatorById } from '@/server/prompts/evaluatorTemplates';
import { isDeterministicEvaluator } from '@/lib/evaluators/deterministic';
import { scoreDeterministic } from '@/lib/scoring/deterministicScoring';

export type RetryJudgementScope = 'errored' | 'all';

/**
 * Judge configuration the caller picks for THIS retry (the "Retry judgement"
 * dialog's evaluator / judge-model selects). Owner requirement (follow-up to
 * #468): "the judgement should allow for evaluator type and prompt evaluator
 * when retrying; defaults will be the last selected ones."
 *
 *   - key absent  → inherit the run's value (`run.evaluatorId` /
 *                   `run.judgeModelId`), i.e. the pre-existing behaviour.
 *   - `evaluatorId: string` → judge with that evaluator (validated to exist
 *                   by the route). When it is a `kind: 'deterministic'`
 *                   evaluator NO LLM is called: every selected report is
 *                   re-scored in code from its stored trajectory (see
 *                   lib/scoring/deterministicScoring.ts).
 *   - `judgeModelId: string` → judge with that model.
 *   - `judgeModelId: null` → the dialog's "Use evaluator default": skip the
 *                   run's/report's pinned model and let the server-default
 *                   judge model apply (`BEDROCK_MODEL_ID`, then the
 *                   evaluator's own `inferenceConfig` in /api/judge).
 */
export interface RetryJudgementOverrides {
  evaluatorId?: string;
  judgeModelId?: string | null;
}

/** Error text for a deterministic evaluator requested with `scope: 'errored'` (route → 400). */
export const DETERMINISTIC_SCOPE_ERROR =
  "a deterministic evaluator re-scores the whole run; use scope 'all' (re-scoring only the errored cases would mix two scoring snapshots in one run)";

/**
 * Per-case outcome of a retry:
 *   - `succeeded`     — a verdict was produced (passed OR failed — "succeeded"
 *                       is about the judgement happening, not the agent).
 *   - `not-evaluable` — a deterministic evaluator ran but its gold /
 *                       extraction rules do not apply to this case (no gold
 *                       ids on the test case, no candidate ids in the stored
 *                       tool results, …). NOT a failure and NOT a judge error.
 *                       The report's EXISTING judgement is preserved and the
 *                       attempt recorded as `report.lastRetryAttempt` with
 *                       `reason` + `diagnostics`. Owner incident: a 5-case run
 *                       re-scored with an evaluator whose rules fit none of
 *                       the cases read "0 succeeded · 3 still failed".
 *   - `failed`        — the judgement itself could not be made (judge call
 *                       threw, report / test case missing, scorer crashed).
 *                       Likewise preserved + recorded.
 *
 * Owner rule (write semantics): ONLY a successful re-judgement replaces a
 * report's judgement (verdict, scores, snapshot, judge response, evaluator
 * stamp) — and, keeping the no-history rule, it replaces it wholesale and
 * clears `lastRetryAttempt`. Anything else leaves every judgement field
 * byte-identical and writes exactly `lastRetryAttempt`.
 */
export type RetryJudgementOutcome = 'succeeded' | 'not-evaluable' | 'failed';

export interface RetryJudgementCaseResult {
  testCaseId: string;
  reportId: string;
  outcome: RetryJudgementOutcome;
  passFailStatus?: PassFailStatus | null;
  /** Why the judgement failed (`outcome: 'failed'`). */
  error?: string;
  /** Why the case is not evaluable (`outcome: 'not-evaluable'`) — stable wording, groupable. */
  reason?: string;
  /** Deterministic only: the case is an ABSTAIN case (gold explicitly empty) and was judged by abstention. */
  abstain?: boolean;
  /** Deterministic only: gold source + every candidate source tried (rendered by the dialog / Judge tab). */
  diagnostics?: ScoringDiagnostics;
}

export interface RetryJudgementSummary {
  retried: number;
  succeeded: number;
  /** Judgement could not be made (see {@link RetryJudgementOutcome}). */
  failed: number;
  /** Deterministic evaluator ran, rules did not apply — not failures. */
  notEvaluable: number;
  /** Of `succeeded`: cases judged by abstention (gold explicitly empty). */
  abstain: number;
  results: RetryJudgementCaseResult[];
}

/** Outcome of {@link retryJudgementForCase}. */
export interface RetryJudgementCaseOutcome {
  passFailStatus: PassFailStatus | null;
  error?: string;
  /** Set (with `reason`) when a deterministic evaluator could not score the case at all. */
  notEvaluable?: boolean;
  reason?: string;
  abstain?: boolean;
  diagnostics?: ScoringDiagnostics;
}

/**
 * Result of {@link preflightRetryJudgement}: what a retry with this
 * evaluator WOULD do, computed read-only.
 */
export interface RetryJudgementPreflight {
  /** The evaluator the retry would use (override or the run's own); `null` when the run has none. */
  evaluatorId: string | null;
  evaluatorName: string | null;
  /** True when that evaluator is `kind: 'deterministic'` — the only kind whose evaluability can be known up front. */
  deterministic: boolean;
  /** Scope the retry would run with (a deterministic evaluator always re-scores the whole run). */
  scope: RetryJudgementScope;
  /** Cases the retry would select. */
  total: number;
  /** Deterministic only: cases that would produce a verdict / that the rules do not apply to. Equal `total` / 0 otherwise. */
  evaluable: number;
  notEvaluable: number;
  /** Deterministic only: of `evaluable`, abstain cases (gold explicitly empty). */
  abstain: number;
  /** Deterministic only: not-evaluable reason → number of cases. */
  reasons: Record<string, number>;
  /** Deterministic only: per-case breakdown (`abstain` = gold explicitly empty, judged by abstention). */
  cases: Array<{ testCaseId: string; evaluable: boolean; abstain?: boolean; reason?: string; diagnostics?: ScoringDiagnostics }>;
}

/**
 * Minimal shape retry-judgement needs from a run result. Wider than the
 * strict `EvaluationRun['results'][string]` type declares — the runner
 * persists `passFailStatus` on this map at runtime (see
 * services/evaluationRunner.ts) even though the type predates that field.
 */
export interface RunResultLike {
  reportId?: string;
  status?: string;
  passFailStatus?: PassFailStatus | null;
  error?: string;
}

/** Bounded — a salvage attempt, not a full poll cycle (never blocks the HTTP request for minutes). */
const RETRY_TRACE_FETCH_MAX_ATTEMPTS = 3;
const RETRY_TRACE_FETCH_INTERVAL_MS = 1500;
/** Cap on retry concurrency regardless of what the caller requests. */
const MAX_RETRY_CONCURRENCY = 3;

/**
 * True when `report` represents a judge failure that retry-judgement can
 * salvage: the agent execution completed (produced a report) but the
 * evaluator could not produce a verdict (`metricsStatus: 'error'`) — the
 * same condition the run-report UI already renders as "ERRORED" (amber) —
 * AND the report actually has a trajectory stored to re-judge (excludes
 * `agent_failed`: a genuine agent crash with nothing to salvage).
 */
export function isJudgeFailedCase(
  report: EvaluationReport | null | undefined,
  result: RunResultLike | undefined
): boolean {
  if (!report || !result) return false;
  // Explicit stage marker (post agent-error-surfacing): an agent-request
  // failure has nothing to judge — never offer it for retry-judgement,
  // regardless of what the rest of the report looks like.
  if (report.failureStage === 'agent') return false;
  if (result.status !== 'completed') return false;
  const hasTrajectory = Array.isArray(report.trajectory) && report.trajectory.length > 0;
  if (!hasTrajectory) return false;
  if (report.metricsStatus === 'error') return true;
  // Legacy pre-fix shape: before services/evaluation/index.ts split the judge
  // call into its own catch, a judge-step failure after a SUCCESSFUL agent run
  // landed as `status: 'failed'` with no `metricsStatus` and a generic
  // "Evaluation failed: <judge error>" reasoning -- indistinguishable from an
  // agent crash except that the trajectory exists (agent completed) and the
  // message names the judge. Runs persisted before the fix (e.g. a 62-case run
  // against a non-instrumented REST agent whose every case hit the
  // agent-trace-judge's old "needs a runId or trace correlation hint" 400)
  // must remain salvageable at judge cost only -- that is exactly this
  // feature's purpose. `extractJudgeFailureReason` (lib/judgeFailureSummary.ts)
  // is the single definition of that legacy shape.
  return report.status === 'failed' && !report.passFailStatus && !!extractJudgeFailureReason(report);
}

/**
 * True when `report` has agent output worth re-judging at all, regardless
 * of its current verdict. Used for `scope=all` (force a full re-judge pass).
 */
export function hasRejudgeableOutput(report: EvaluationReport | null | undefined): boolean {
  if (!report) return false;
  if (report.failureStage === 'agent') return false;
  return Array.isArray(report.trajectory) && report.trajectory.length > 0;
}

/**
 * Select the test-case ids eligible for retry-judgement.
 *
 * @param scope 'errored' (default) — judge-failed cases (see
 *              {@link isJudgeFailedCase}) PLUS cases whose last retry
 *              attempt produced no judgement (`report.lastRetryAttempt`):
 *              their previous judgement was preserved, so they are not
 *              errored, but "retry the ones that failed" must still reach
 *              them (codex_review) — that is what the banner's "Retry
 *              again" does.
 *              'all' — every case with rejudgeable agent output, regardless
 *              of its current verdict. That INCLUDES cases the judge FAILED
 *              (the runner mirrors a failed verdict as `results[tc].status:
 *              'failed'` + `passFailStatus: 'failed'`): they have stored
 *              output and are exactly the cases a second opinion is wanted
 *              on. The same predicate (`isRejudgeableResult`, lib/runActions)
 *              drives the inspector's count/enablement so both agree.
 */
export function selectRetryableCases(
  run: Pick<EvaluationRun, 'results'>,
  reportsById: Record<string, EvaluationReport | null | undefined>,
  scope: RetryJudgementScope = 'errored'
): string[] {
  const ids: string[] = [];
  for (const [testCaseId, resultRaw] of Object.entries(run.results || {})) {
    const result = resultRaw as RunResultLike;
    if (!result?.reportId) continue;
    const report = reportsById[result.reportId];
    const eligible = scope === 'all'
      ? isRejudgeableResult(result, report) && hasRejudgeableOutput(report)
      : isJudgeFailedCase(report, result) || (!!report?.lastRetryAttempt && result.status === 'completed' && hasRejudgeableOutput(report));
    if (eligible) ids.push(testCaseId);
  }
  return ids;
}

function resolveAgentConfig(agentKey: string | undefined): AgentConfig | undefined {
  if (!agentKey) return undefined;
  try {
    const cfg = loadConfigSync();
    const allAgents = [...cfg.agents, ...getCustomAgents()];
    return allAgents.find(a => a.key === agentKey);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the judge model + evaluator for one retried case. Precedence:
 * explicit per-retry {@link RetryJudgementOverrides} > the run's values >
 * the report's own value (judge model only) > server default. Exported for
 * unit tests.
 *
 * The evaluator always resolves to a CONCRETE id: an unset evaluator means
 * the built-in default (`getDefaultEvaluator()` — exactly what /api/judge
 * falls back to when no `evaluatorId` is sent), so the retried report is
 * stamped with the evaluator that actually judged it instead of keeping a
 * possibly stale `evaluatorId` from before (codex_review finding).
 */
export function resolveRetryJudgeConfig(
  report: Pick<EvaluationReport, 'judgeModelId' | 'modelId'>,
  run: Pick<EvaluationRun, 'judgeModelId' | 'evaluatorId'>,
  overrides: RetryJudgementOverrides = {}
): { judgeModelId: string; evaluatorId: string } {
  const serverDefault = readEnv('BEDROCK_MODEL_ID', 'AGENT_HEALTH_BEDROCK_MODEL_ID') || report.modelId || '';
  let judgeModelId: string;
  if (overrides.judgeModelId === null) {
    judgeModelId = serverDefault;
  } else {
    judgeModelId = overrides.judgeModelId || run.judgeModelId || report.judgeModelId || serverDefault;
  }
  const evaluatorId = overrides.evaluatorId || run.evaluatorId || getDefaultEvaluator().id;
  return { judgeModelId, evaluatorId };
}

/**
 * Re-run ONLY the judge pipeline for one already-completed test case,
 * against the report's stored trajectory. Never re-invokes the agent.
 *
 * For trace-mode agents (`agentConfig.useTraces`), attempts a bounded
 * fresh trace fetch first — a `trace_timeout` retry can succeed if spans
 * have since landed in the backing OpenSearch cluster — and rebuilds the
 * trajectory from spans on success (falling back to the stored trajectory
 * when the re-fetch comes up empty, same as the original run would have
 * left on the report). Persists the verdict (or the canonical
 * evaluator-error patch on failure) onto the report doc.
 */
export async function retryJudgementForCase(
  report: EvaluationReport,
  testCase: TestCase,
  run: Pick<EvaluationRun, 'judgeModelId' | 'evaluatorId' | 'agentKey'>,
  storage: IStorageModule,
  agentConfig: AgentConfig | undefined,
  overrides: RetryJudgementOverrides = {},
  resolvedEvaluator?: Evaluator | null,
  scope: RetryJudgementScope = 'errored'
): Promise<RetryJudgementCaseOutcome> {
  // Deterministic evaluator: score the STORED trajectory in code. No trace
  // re-fetch (the extractor reads the persisted tool results the agent
  // actually returned), no judge model, no LLM call of any kind.
  const evaluator = resolvedEvaluator === undefined ? await resolveEvaluatorDoc(overrides.evaluatorId || run.evaluatorId, storage) : resolvedEvaluator;
  if (evaluator && isDeterministicEvaluator(evaluator)) {
    return applyDeterministicJudgement(report, testCase, evaluator, storage, scope);
  }

  let trajectory = report.trajectory || [];

  if (agentConfig?.useTraces) {
    try {
      const windowAgents = buildJudgeAgentsHints(report, agentConfig.traceServiceName);
      const fetchResult = await fetchSpansForRun(report.runId, {
        maxAttempts: RETRY_TRACE_FETCH_MAX_ATTEMPTS,
        intervalMs: RETRY_TRACE_FETCH_INTERVAL_MS,
        windowAgents,
      });
      if (fetchResult.spans.length > 0) {
        const converted = spansToTrajectory(fetchResult.spans, agentConfig.traceServiceName);
        if (converted.length > 0) trajectory = converted;
      } else {
        debug('RetryJudgement', `[${report.id}] Trace re-fetch found no spans — re-judging stored trajectory`);
      }
    } catch (err) {
      debug('RetryJudgement', `[${report.id}] Trace re-fetch failed, falling back to stored trajectory: ${err}`);
    }
  }

  const { judgeModelId, evaluatorId } = resolveRetryJudgeConfig(report, run, overrides);
  try {
    const judgment = await callBedrockJudge(
      trajectory,
      {
        expectedOutcomes: testCase.expectedOutcomes,
        expectedTrajectory: testCase.expectedTrajectory,
      },
      undefined,
      () => {},
      judgeModelId,
      evaluatorId,
      report.runId,
      buildJudgeAgentsHints(report, agentConfig?.traceServiceName)
    );

    // Only the LATEST judgement is kept on the report (owner's choice — no
    // history array), so every judgement field is overwritten together and
    // the retry is stamped (`judgementRetriedAt` / `judgementRetryCount`)
    // so the report is truthful about having been re-judged. The agent
    // output (trajectory/rawEvents/spans/...) is never touched beyond the
    // trace-refresh above.
    await storage.runs.update(report.id, {
      trajectory,
      // Re-judge REPLACES the scoring snapshot + verdict (no history kept —
      // owner decision; #509 stays narrow). Same shared shape as first-judge.
      ...scoringFieldsFromJudgment(judgment),
      llmJudgeReasoning: judgment.llmJudgeReasoning,
      // The judge config that produced THIS verdict — may differ from the
      // run's when the caller overrode them for the retry.
      judgeModelId,
      evaluatorId,
      // Set only by the agent (trace) judge provider -- see
      // JudgeResponse.judgeMode / TestCaseRun.judgeMode. `null` (not
      // omitted) when this judge didn't set it, so a prior trace-judge
      // verdict's mode can't outlive the verdict it described.
      judgeMode: judgment.judgeMode ?? null,
      // Underlying LLM that judged (TestCaseRun.judgeModel) -- see lib/judgeIdentity.
      ...buildJudgeIdentityPatch(judgment, judgeModelId),
      // Keep the judge sidecar's identity in step with the re-judged verdict.
      llmJudgeResponse: {
        ...buildLlmJudgeResponseIdentity(judgment, judgeModelId),
        timestamp: new Date().toISOString(),
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: judgment.judgeDurationMs ?? 0,
        rawResponse: judgment.rawResponse ?? judgment.llmJudgeReasoning,
        parsedMetrics: judgment.metrics as any,
        improvementStrategies: judgment.improvementStrategies,
        ...(judgment.extraFields ? { extraFields: judgment.extraFields } : {}),
        ...(judgment.judgeDebug ? { judgeDebug: judgment.judgeDebug } : {}),
      },
      judgementRetriedAt: new Date().toISOString(),
      judgementRetryCount: (report.judgementRetryCount ?? 0) + 1,
      matcherResults: [
        buildJudgeMatcherEntry(judgment, {
          claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
          model: judgeModelId,
        }),
      ],
      improvementStrategies: judgment.improvementStrategies,
      metricsStatus: 'completed',
      // Explicit clear now that a verdict exists. `undefined` (rather than
      // omitting the key) is dropped by both storage backends' full
      // read-modify-write serialization — same idiom noted on
      // EvaluatorErrorPatch.passFailStatus's `null` (that field uses `null`
      // because it must survive an object-spread merge; `traceError` here
      // is a plain top-level key on the SAME update call, so `undefined`
      // is enough to drop it from the JSON body).
      traceError: undefined,
      // A verdict now exists, so the stage-failure detail the original judge
      // step recorded (`failureStage` / `error` / `judgeError`, agent-error
      // surfacing) is cleared with it — otherwise the run-detail failure card
      // ("Judge could not produce a verdict", keyed on `failureStage`) would
      // outlive the failure it described and sit next to the new verdict.
      ...CLEARED_REPORT_FAILURE_FIELDS,
      // A successful re-judgement supersedes any recorded failed attempt.
      lastRetryAttempt: null,
    } as any);

    return { passFailStatus: judgment.passFailStatus };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    // PRESERVE the previous judgement (owner rule): a failed retry must not
    // replace the report's verdict / scores / judge response with an error
    // state. Record the attempt instead — the Judge tab shows it as a
    // dismissible banner with the reason. (This used to write the
    // `judge_failed` error patch and clear the matcher rows, which turned a
    // previously-passed case into an errored one because a judge call hiccuped.)
    await recordFailedAttempt(report, storage, {
      evaluatorId: evaluatorId ?? null,
      evaluatorName: evaluator?.name,
      judgeModelId,
      scope,
      outcome: 'judge-error',
      reason: message,
    });
    return { passFailStatus: null, error: message };
  }
}

/**
 * Persist a failed retry attempt WITHOUT touching the judgement fields.
 * `storage.runs.update` merges, so this writes exactly one key.
 */
async function recordFailedAttempt(
  report: Pick<EvaluationReport, 'id'>,
  storage: IStorageModule,
  attempt: Omit<RetryAttemptRecord, 'at'>
): Promise<RetryAttemptRecord> {
  const record: RetryAttemptRecord = { at: new Date().toISOString(), ...attempt };
  await storage.runs.update(report.id, { lastRetryAttempt: record } as any).catch(() => {});
  return record;
}

/** Resolve an evaluator id to its document (system template or stored). `null` when unset/unknown. */
export async function resolveEvaluatorDoc(evaluatorId: string | undefined, storage: IStorageModule): Promise<Evaluator | null> {
  if (!evaluatorId) return null;
  if (isSystemEvaluatorId(evaluatorId)) {
    const sys = getSystemEvaluatorById(evaluatorId);
    return sys ?? null;
  }
  try {
    return (await storage.evaluators.getById(evaluatorId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist a deterministic judgement onto the report. Only the LATEST
 * judgement is kept (same policy as the LLM path): every judge-derived field
 * is overwritten together, and the LLM-only fields are cleared so a report
 * re-scored deterministically never shows a stale judge reasoning or
 * response next to code-computed metrics. The agent output is untouched.
 *
 * Not-evaluable results (no gold / no candidates ⇒ EVERY metric unevaluable)
 * and scorer exceptions PRESERVE the report's existing judgement (owner
 * rule: only a successful re-judgement replaces it) and are recorded as
 * `report.lastRetryAttempt` with the reason + diagnostics; the Judge tab
 * shows them as a dismissible banner. They are never the `judge_failed`
 * error patch, so a previously judged case keeps its verdict and the
 * run-level judge-failure banner (lib/judgeFailureSummary.ts) stays quiet.
 * See the module comment in lib/scoring/deterministicScoring.ts.
 */
async function applyDeterministicJudgement(
  report: EvaluationReport,
  testCase: TestCase,
  evaluator: Evaluator,
  storage: IStorageModule,
  scope: RetryJudgementScope
): Promise<RetryJudgementCaseOutcome> {
  try {
    const result = scoreDeterministic(evaluator, testCase, report);
    const common = {
      evaluatorId: evaluator.id,
      // No judge model was involved — clear the one a previous LLM judgement
      // may have stamped so the report never names a judge it did not use.
      // That includes the RESOLVED identity (`judgeModel` / `judgeProvider`,
      // lib/judgeIdentity): the compare page's judge caption prefers
      // `report.judgeModel`, so leaving it would keep naming the previous
      // LLM as the judge of code-computed metrics. `judgeProvider: 'none'`
      // is the existing "no LLM judge call was made" marker (the code-SDK
      // path persists the same one) — the UI renders it as "No LLM judge".
      judgeModelId: null,
      judgeModel: null,
      judgeProvider: JUDGE_PROVIDER_NONE,
      judgeMode: 'deterministic' as const,
      scoringSnapshot: result.snapshot,
      matcherResults: result.matcherResults,
      improvementStrategies: [],
      llmJudgeReasoning: '',
      llmJudgeResponse: null,
      // Verdict-engine fields (lib/scoring/verdictEngine.ts) are ALWAYS
      // written: no LLM was involved, so an earlier LLM judgement's verdict /
      // conflict flag must not survive next to code-computed metrics.
      llmVerdict: null,
      verdictConflict: null,
      score: result.score,
    };
    if (!result.evaluable) {
      const reason = result.notEvaluableReason ?? result.summary;
      await recordFailedAttempt(report, storage, {
        evaluatorId: evaluator.id, evaluatorName: evaluator.name, scope,
        outcome: 'not-evaluable', reason, diagnostics: result.diagnostics,
      });
      return { passFailStatus: null, notEvaluable: true, reason, diagnostics: result.diagnostics };
    }
    await storage.runs.update(report.id, {
      ...common,
      passFailStatus: result.passFailStatus,
      metrics: result.metrics,
      metricsStatus: 'completed',
      traceError: undefined,
      // See the LLM path: a verdict supersedes the recorded stage failure.
      ...CLEARED_REPORT_FAILURE_FIELDS,
      // Same re-judgement stamp the LLM path writes (#509) — the Judge tab's
      // "Re-judged <when> with <evaluator>" line reads it.
      judgementRetriedAt: new Date().toISOString(),
      judgementRetryCount: (report.judgementRetryCount ?? 0) + 1,
      lastRetryAttempt: null,
    } as any);
    return { passFailStatus: result.passFailStatus, ...(result.kind === 'abstain' ? { abstain: true } : {}), diagnostics: result.diagnostics };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    await recordFailedAttempt(report, storage, {
      evaluatorId: evaluator.id, evaluatorName: evaluator.name, scope,
      outcome: 'error', reason: `Deterministic scoring: ${message}`,
    });
    return { passFailStatus: null, error: message };
  }
}

/** Small bounded-concurrency runner (mirrors evaluationRunner's own helper). */
async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Fetch every report doc referenced by `run.results` once, keyed by report
 * id. Shared by {@link countRetryableCases} (a cheap pre-flight count so
 * the HTTP route can respond with a total before kicking off the — often
 * long-running — judge pipeline below) and {@link retryJudgementForRun}
 * itself, so both agree on exactly the same selection.
 */
async function fetchReportsById(
  run: Pick<EvaluationRun, 'results'>,
  storage: IStorageModule
): Promise<Record<string, EvaluationReport | null>> {
  const reportIds = Array.from(
    new Set(
      Object.values(run.results || {})
        .map((r: any) => r?.reportId)
        .filter((id: unknown): id is string => Boolean(id))
    )
  );
  const fetchedReports = await Promise.all(
    reportIds.map(id => storage.runs.getById(id).catch(() => null))
  );
  const reportsById: Record<string, EvaluationReport | null> = {};
  reportIds.forEach((id, i) => { reportsById[id] = fetchedReports[i]; });
  return reportsById;
}

/**
 * How many cases `retryJudgementForRun(run, storage, { scope })` would
 * retry, without doing any of the (potentially minutes-long) judge work.
 * Used by the route to report a `total` in its immediate 202 response —
 * see the module comment on `retryJudgementForRun` for why the route
 * doesn't await the full pipeline inline anymore.
 */
export async function countRetryableCases(
  run: Pick<EvaluationRun, 'results'>,
  storage: IStorageModule,
  scope: RetryJudgementScope = 'errored'
): Promise<number> {
  const reportsById = await fetchReportsById(run, storage);
  return selectRetryableCases(run, reportsById, scope).length;
}

/**
 * Retry judgement for a run: salvage judge-failed cases (or, with
 * `scope: 'all'`, every rejudgeable case) at JUDGE COST ONLY — the agent is
 * never re-invoked. Updates each report doc, the run's `results` map, and
 * recomputes `run.stats` (`lib/runStats` `computeRunStats`) before
 * persisting the run doc.
 *
 * Caller is responsible for the running/terminal-status gate (this
 * function does not re-check `run.status`).
 *
 * This can run for a long time on a large run (real incident: 62 cases at
 * ~40-90s per Bedrock judge call / concurrency 3 ≈ 20-30+ minutes) — the
 * caller (the HTTP route) MUST NOT hold the response open for the whole
 * duration; see server/routes/storage/evaluationRuns.ts's POST handler,
 * which fires this and returns immediately, polling status separately.
 * `options.onProgress(completed, total)` lets the caller track progress
 * for that polling without waiting on the returned promise.
 */
export async function retryJudgementForRun(
  run: EvaluationRun,
  storage: IStorageModule,
  options?: {
    scope?: RetryJudgementScope;
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
    /** Per-retry judge config; see {@link RetryJudgementOverrides}. */
    overrides?: RetryJudgementOverrides;
  }
): Promise<RetryJudgementSummary> {
  const scope = options?.scope ?? 'errored';
  const overrides = options?.overrides ?? {};
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? MAX_RETRY_CONCURRENCY, MAX_RETRY_CONCURRENCY));

  const reportsById = await fetchReportsById(run, storage);

  const testCaseIds = selectRetryableCases(run, reportsById, scope);
  const agentConfig = resolveAgentConfig(run.agentKey);
  // Resolve the evaluator ONCE per run (not per case) so every report in this
  // retry is scored against the same document.
  const resolvedEvaluator = await resolveEvaluatorDoc(overrides.evaluatorId || run.evaluatorId, storage);
  if (isDeterministicEvaluator(resolvedEvaluator) && scope !== 'all') {
    // codex_review: re-scoring only the errored subset with a different
    // (deterministic) scorer would leave a run whose reports carry two
    // scoring snapshots while the run doc claims one evaluator — a
    // mixed-truth run. A deterministic evaluator is cheap; always re-score
    // the whole run. The route surfaces this as a 400 before starting a job.
    throw new Error(DETERMINISTIC_SCOPE_ERROR);
  }

  // "Defaults will be the last selected ones": remember what THIS retry was
  // launched with so the next Retry-judgement dialog can preselect it.
  // Written up front (before any judge call) so it's visible even if the
  // job is still running / gets interrupted. Not the per-case judge model
  // fallback chain — the user's selection as made (`null` = "evaluator
  // default").
  const lastJudgementRetry: NonNullable<EvaluationRun['lastJudgementRetry']> = {
    scope,
    evaluatorId: overrides.evaluatorId || run.evaluatorId || null,
    judgeModelId: overrides.judgeModelId === undefined ? (run.judgeModelId || null) : (overrides.judgeModelId || null),
    at: new Date().toISOString(),
  };
  await storage.evaluationRuns.update(run.id, { lastJudgementRetry });

  const results: RetryJudgementCaseResult[] = [];
  const updatedResults: Record<string, any> = { ...run.results };
  const total = testCaseIds.length;
  let completedCount = 0;
  // Reports progress AFTER each case finishes (success or failure) rather
  // than as cases start, so `completed` never exceeds what's actually been
  // persisted — a poller reading `onProgress`'s last value always sees a
  // consistent lower bound. See the module comment above for why callers
  // need this at all (long-running pipeline, HTTP route can't await it).
  const reportProgress = () => options?.onProgress?.(completedCount, total);
  reportProgress();

  await runWithConcurrencyLimit(testCaseIds, concurrency, async (testCaseId) => {
    try {
      const result = updatedResults[testCaseId] as RunResultLike;
      const report = result?.reportId ? reportsById[result.reportId] : null;
      if (!report) {
        results.push({ testCaseId, reportId: result?.reportId || '', outcome: 'failed', error: 'report not found' });
        return;
      }
      // Judge against the test-case version the run actually SNAPSHOTTED
      // (testCaseSnapshots[].version), not today's possibly-edited
      // definition — otherwise "retry" silently becomes "re-grade against
      // different criteria" and the run's verdicts stop being comparable
      // with each other. Falls back to the current doc only for legacy runs
      // that recorded no snapshot version.
      const { testCase, snapshotVersion } = await resolveSnapshottedTestCase(run, testCaseId, storage);
      if (!testCase) {
        results.push({
          testCaseId, reportId: report.id, outcome: 'failed',
          error: snapshotVersion != null ? `test case version ${snapshotVersion} not found` : 'test case not found',
        });
        return;
      }

      const { passFailStatus, error, notEvaluable, reason, abstain, diagnostics } = await retryJudgementForCase(
        report, testCase, run, storage, agentConfig, overrides, resolvedEvaluator, scope
      );

      // Only a SUCCESSFUL re-judgement changes the run's results map; a
      // failed attempt left the report's judgement untouched, so the case's
      // previous verdict (or previous errored state) stands.
      if (passFailStatus) {
        updatedResults[testCaseId] = { ...result, status: 'completed', passFailStatus };
      }

      results.push({
        testCaseId,
        reportId: report.id,
        outcome: passFailStatus ? 'succeeded' : notEvaluable ? 'not-evaluable' : 'failed',
        passFailStatus,
        ...(error ? { error } : {}),
        ...(reason ? { reason } : {}),
        ...(abstain ? { abstain: true } : {}),
        // Diagnostics ride along only where they explain something (not a
        // plain scored case) — the summary stays small for large runs.
        ...(diagnostics && (!passFailStatus || abstain) ? { diagnostics } : {}),
      });
    } finally {
      completedCount += 1;
      reportProgress();
    }
  });

  const updatedRun = { ...run, results: updatedResults };
  const stats = computeRunStats(updatedRun);
  // Recompute the run-level judge-failure summary from the FRESH report docs
  // so it clears (`null`, not omitted -- storage merges updates) once the
  // salvage resolves the cases, instead of a stale banner outliving the
  // failure it described (codex_review finding on this PR).
  const freshReports = await fetchReportsById(updatedRun, storage);
  const reasons = Object.values(updatedResults)
    .map((r: any) => (r?.reportId ? freshReports[r.reportId] : null))
    .filter(Boolean)
    .map((rep) => extractJudgeFailureReason(rep as any));
  const judgeFailureSummary = computeJudgeFailureSummary(reasons, stats.total) ?? null;
  // Run-level record of a retry in which ≥1 case produced no judgement (the
  // runs list / inspector header show a "re-judge failed" pill off it);
  // cleared when every retried case was judged.
  const unjudged = results.filter(r => r.outcome !== 'succeeded');
  const lastRetryAttempt = unjudged.length > 0
    ? {
        at: new Date().toISOString(),
        evaluatorId: overrides.evaluatorId || run.evaluatorId || null,
        ...(resolvedEvaluator?.name ? { evaluatorName: resolvedEvaluator.name } : {}),
        scope,
        retried: testCaseIds.length,
        succeeded: results.filter(r => r.outcome === 'succeeded').length,
        notEvaluable: results.filter(r => r.outcome === 'not-evaluable').length,
        failed: results.filter(r => r.outcome === 'failed').length,
        reasons: unjudged.reduce<Record<string, number>>((acc, r) => {
          const key = r.reason ?? r.error ?? 'reason not recorded';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      }
    : null;
  await storage.evaluationRuns.update(run.id, {
    results: updatedResults,
    stats: { ...(run.stats || {}), ...stats } as any,
    judgeFailureSummary,
    lastRetryAttempt,
    // The run's ORIGINAL evaluatorId / judgeModelId are NOT rewritten (#509
    // contract): what the latest retry used lives in `lastJudgementRetry`
    // (written up front) and on each report's own evaluator stamp.
  } as any);

  // Deterministic order (not insertion/completion order, which varies with
  // the concurrency fan-out) so callers/tests can rely on a stable summary.
  results.sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));

  return {
    retried: testCaseIds.length,
    succeeded: results.filter(r => r.outcome === 'succeeded').length,
    failed: results.filter(r => r.outcome === 'failed').length,
    notEvaluable: results.filter(r => r.outcome === 'not-evaluable').length,
    abstain: results.filter(r => r.outcome === 'succeeded' && r.abstain).length,
    results,
  };
}

/**
 * Judge against the test-case version the run actually SNAPSHOTTED
 * (`testCaseSnapshots[].version`), not today's possibly-edited definition —
 * otherwise "retry" silently becomes "re-grade against different criteria"
 * and the run's verdicts stop being comparable with each other. Falls back
 * to the current doc only for legacy runs that recorded no snapshot version.
 */
async function resolveSnapshottedTestCase(
  run: Pick<EvaluationRun, 'testCaseSnapshots'>,
  testCaseId: string,
  storage: IStorageModule
): Promise<{ testCase: TestCase | null; snapshotVersion: number | undefined }> {
  const snapshotVersion = run.testCaseSnapshots?.find(s => s.id === testCaseId)?.version;
  let testCase: TestCase | null = null;
  try {
    testCase = snapshotVersion != null
      ? await storage.testCases.getVersion(testCaseId, snapshotVersion)
      : await storage.testCases.getById(testCaseId);
  } catch { /* caller handles null */ }
  return { testCase, snapshotVersion };
}

/**
 * Read-only pre-flight for the retry-judgement dialog: which cases a retry
 * with `overrides.evaluatorId ?? run.evaluatorId` would select and — for a
 * `kind: 'deterministic'` evaluator, whose rules are pure functions of the
 * stored test case + report — how many of them the evaluator can actually
 * score, grouped by not-evaluable reason. Runs the same extractor
 * (`scoreDeterministic`) the retry would, WITHOUT persisting anything, so the
 * dialog can say "n of N cases evaluable by this evaluator" and refuse to
 * start a retry that would score nothing. An LLM evaluator's evaluability
 * cannot be known up front: `deterministic: false`, counts = the selection.
 */
export async function preflightRetryJudgement(
  run: EvaluationRun,
  storage: IStorageModule,
  options?: { scope?: RetryJudgementScope; overrides?: RetryJudgementOverrides }
): Promise<RetryJudgementPreflight> {
  const overrides = options?.overrides ?? {};
  const evaluatorId = overrides.evaluatorId || run.evaluatorId || null;
  const evaluator = await resolveEvaluatorDoc(evaluatorId ?? undefined, storage);
  const deterministic = isDeterministicEvaluator(evaluator);
  // A deterministic evaluator always re-scores the whole run (DETERMINISTIC_SCOPE_ERROR).
  const scope: RetryJudgementScope = deterministic ? 'all' : (options?.scope ?? 'errored');
  const reportsById = await fetchReportsById(run, storage);
  const testCaseIds = selectRetryableCases(run, reportsById, scope);

  const base = {
    evaluatorId,
    evaluatorName: evaluator?.name ?? null,
    deterministic,
    scope,
    total: testCaseIds.length,
  };
  if (!deterministic || !evaluator) {
    return { ...base, evaluable: testCaseIds.length, notEvaluable: 0, abstain: 0, reasons: {}, cases: [] };
  }

  const cases: RetryJudgementPreflight['cases'] = [];
  const reasons: Record<string, number> = {};
  for (const testCaseId of testCaseIds) {
    const result = run.results?.[testCaseId] as RunResultLike | undefined;
    const report = result?.reportId ? reportsById[result.reportId] : null;
    const { testCase, snapshotVersion } = await resolveSnapshottedTestCase(run, testCaseId, storage);
    let reason: string | undefined;
    let abstain = false;
    let diagnostics: ScoringDiagnostics | undefined;
    if (!report) reason = 'report not found';
    else if (!testCase) reason = snapshotVersion != null ? `test case version ${snapshotVersion} not found` : 'test case not found';
    else {
      try {
        const scored = scoreDeterministic(evaluator, testCase, report);
        diagnostics = scored.diagnostics;
        abstain = scored.kind === 'abstain';
        if (!scored.evaluable) reason = scored.notEvaluableReason ?? scored.summary;
      } catch (error: any) {
        reason = `deterministic scoring: ${error?.message ?? String(error)}`;
      }
    }
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
    cases.push({ testCaseId, evaluable: !reason, ...(abstain ? { abstain: true } : {}), ...(reason ? { reason } : {}), ...(diagnostics ? { diagnostics } : {}) });
  }
  cases.sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));
  const notEvaluable = cases.filter(c => !c.evaluable).length;
  return { ...base, evaluable: cases.length - notEvaluable, notEvaluable, abstain: cases.filter(c => c.evaluable && c.abstain).length, reasons, cases };
}
