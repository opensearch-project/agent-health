/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge invocation verification — confirms that calls to `judge()` from
 * inside an SDK test body actually invoke the Bedrock judge end-to-end
 * and surface the reasoning back to the user.
 *
 * Background
 * ----------
 * The agent-health data model has TWO separate "judge" surfaces:
 *
 *   1. report.llmJudgeReasoning  (legacy / trajectory path)
 *      The framework auto-runs `callBedrockJudge(trajectory, expectedOutcomes)`
 *      after the agent finishes. The single reasoning string lands in the
 *      report-level `llmJudgeReasoning` field and renders in the
 *      "Judge Reasoning" card on the run-details page.
 *
 *   2. report.matcherResults[*]  with method: 'llm-judge'  (SDK code path)
 *      Each `await judge(result, claim)` call inside a test body produces
 *      one MatcherResult — captured by the matcher session. These render
 *      in the "Matcher Results" panel as `[llm-judge]` entries with their
 *      own reasoning. Multiple judge() calls per test → multiple entries.
 *
 * SDK tests pass `skipJudge: true` to `runEvaluationWithConnector`, so the
 * legacy path is intentionally bypassed; the user's explicit `judge()` calls
 * are the canonical signal.
 *
 * This eval makes two judge() calls — one expected to PASS and one
 * expected to FAIL — so we can verify both branches end up in
 * matcherResults with full reasoning.
 *
 * Run:
 *   curl -sN -X POST http://127.0.0.1:4001/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"Issue 230 Judge Invocation",
 *       "sources":[{"type":"code-import","filenames":["evals/issue-230-judge-invocation.eval.js"],"testCaseIds":[]}],
 *       "agentKey":"observio",
 *       "modelId":"claude-sonnet"
 *     }'
 */

const { test, expect } = require('@opensearch-project/agent-health');

test(
  'issue-230-judge-invocation-passing-claim',
  {
    prompt: 'In one short paragraph, explain what observability is.',
    description:
      'A judge() call with a claim the agent is expected to satisfy — the [llm-judge] matcher entry must record pass:true with reasoning.',
    labels: ['issue:230', 'category:Verification', 'judge:invocation'],
  },
  async function ({ result, judge }) {
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

    // Single judge call against an on-topic claim. Expected: passing
    // [llm-judge] entry in matcherResults with the judge's reasoning.
    await judge(
      result,
      'the response talks about observability, monitoring, or visibility'
    );
  }
);

test(
  'issue-230-judge-invocation-failing-claim',
  {
    prompt: 'In one short paragraph, explain what observability is.',
    description:
      'A judge() call with a deliberately off-topic claim — the [llm-judge] matcher entry must record pass:false with reasoning explaining the mismatch.',
    labels: ['issue:230', 'category:Verification', 'judge:invocation'],
  },
  async function ({ result, judge }) {
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

    // The agent answers about observability; we ask the judge to verify
    // a claim that has nothing to do with that. Expected: failing
    // [llm-judge] entry whose errorMessage explains why the trajectory
    // does not satisfy the claim.
    await judge(
      result,
      'the response provides a recipe for chocolate chip cookies'
    );
  }
);
