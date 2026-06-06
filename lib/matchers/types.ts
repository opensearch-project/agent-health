/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-matcher result types.
 *
 * Each call into `expect(...).to.X(...)`, `judge(...)`, or a traces helper
 * produces one MatcherResult. The runner collects them per test case and
 * persists them on TestCaseRun so the UI can show a breakdown like
 *
 *   ✅ to contain 'root cause'           [code-assertion]
 *   ❌ to be lessThan 30000               [code-assertion]   actual: 47320
 *   ✅ identifies failing dependency     [llm-judge]   score: 0.85
 *   ✅ traces.totalTokens < 10000        [traces]
 */

export type MatcherMethod =
  | 'code-assertion'   // expect(...).to.X(...) — chai-driven, fast, free
  | 'llm-judge'        // judge(result, claim) — Bedrock call, costs money
  | 'traces'           // traces.X — derived from OTel data
  | 'evaluator';       // defineEvaluator() — user-supplied programmatic check

export interface MatcherResult {
  /** Human-readable description, e.g. "to contain 'root cause'". */
  description: string;
  /** Whether this matcher passed. */
  pass: boolean;
  /** Family the matcher belongs to. */
  method: MatcherMethod;
  /**
   * Whether this signal gates the test verdict. `gate` (default) means a
   * failing result fails the test; `observe` means the result is recorded
   * for score/insights only and never fails the test (RFC 004 §4.8).
   * `code-assertion` and `traces` matchers are always gates; `llm-judge`
   * entries are `gate` for `judge()` and `observe` for `judge.observe()`.
   */
  role?: 'gate' | 'observe';
  /**
   * True when the matcher could not be evaluated at all (e.g. the judge
   * endpoint errored) — distinct from a clean `pass: false`. Errored
   * signals are excluded from pass-rate aggregation (status `errored`).
   */
  errored?: boolean;
  /** Wall-clock time spent evaluating this matcher (ms). */
  durationMs?: number;

  // ─── Code-assertion specifics ───
  /** The actual value as seen by the matcher (best-effort). */
  actual?: unknown;
  /** The expected value as configured by the user (best-effort). */
  expected?: unknown;
  /** Failure message from the chai assertion when pass is false. */
  errorMessage?: string;

  // ─── LLM-judge specifics ───
  /** Confidence score on the [0, 1] interval, when available. */
  score?: number;
  /** Free-form judge reasoning, when available. */
  reasoning?: string;
  /** Model used by the judge for this matcher. */
  model?: string;

  // ─── llm-judge enriched fields ───
  // Optional fields populated for `method: 'llm-judge'` entries when the
  // backing judge endpoint returns the data. They preserve information
  // that the legacy auto-judge path used to put on report-level fields
  // (`report.improvementStrategies`, `report.metrics.faithfulness`, etc.)
  // so SDK `judge()` calls don't truncate it. See lib/matchers/judgeAccessor.

  /**
   * Actionable suggestions produced by the judge when the verdict is
   * `pass: false` (or, for the auto-judge path, when accuracy < 100).
   * Same shape as the report-level field; carried per-call here so
   * SDK multi-judge runs preserve per-claim feedback.
   */
  improvementStrategies?: Array<{
    category: string;
    issue: string;
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
  }>;

  /**
   * Full judge metric breakdown when the judge produces multiple
   * dimensions. `score` (above) is the headline value (typically
   * `accuracy / 100`); this object exposes the rest. All keys are
   * optional because the judge only emits them when applicable.
   */
  judgeMetrics?: {
    accuracy?: number;
    faithfulness?: number;
    latency_score?: number;
    trajectory_alignment_score?: number;
    [k: string]: number | undefined;
  };
}
