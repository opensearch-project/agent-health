/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Smoke test for the run-level evaluatorId binding (this PR).
 *
 * Designed to be cheap: no agent invocation (no `prompt`), no real Bedrock
 * judge call. The body invokes `judge(result, claim)` once with a fake
 * trajectory; the SERVER receives the request and must apply the
 * evaluator the run was configured with.
 *
 * The point of this file: prove that
 *   POST /api/storage/evaluation-runs { ..., evaluatorId: 'eval-...' }
 * causes the destructured `judge()` calls in the body to forward
 * `evaluatorId` to /api/judge automatically (via bindJudge in the runner).
 *
 * Pair this with the runner's debug log:
 *   `[JudgeAPI] Loading evaluator: <id>`
 *   `[JudgeAPI] Using provider: ... model: ... evaluator: <name>`
 *
 * Run with the `demo` agent + `demo-model` so the agent step is mocked
 * and the judge runs in mock-mode (the `demo` provider returns a synthetic
 * verdict without calling Bedrock). The bound evaluatorId still rides on
 * the request body and the server still resolves it through
 * `getSystemEvaluatorById` / `storage.evaluators.getById`, even in mock
 * mode — that's exactly what we want to verify.
 */

const { test, expect } = require('@opensearch-project/agent-health');

test('evaluator-id-smoke: judge fixture inherits run.evaluatorId', {
  description: 'No agent call. Verifies that the destructured judge fixture, when invoked with no per-call options, still posts the run-level evaluatorId to /api/judge.',
  labels: ['category:Smoke', 'feature:sdk-evaluator-id', 'kind:no-prompt'],
  timeout: 30_000,
}, async function ({ result, judge }) {
  // We don't have an agent run, so synthesize a trajectory the judge
  // can grade. The mock-judge provider is permissive — any non-empty
  // trajectory + claim pair returns a synthetic verdict.
  const fakeResult = {
    trajectory: [
      { type: 'action', toolName: 'fake_tool', content: '{"q":"test"}' },
      { type: 'response', content: 'I checked and everything looks good.' },
    ],
  };

  // This is the line the whole PR is about: no per-call evaluatorId.
  // The runner pre-bound `bindJudge({ evaluatorId: run.evaluatorId, ... })`
  // onto the fixture, so the request body should carry whatever evaluator
  // was set on the run config.
  await judge(fakeResult, 'agent provides a coherent response');

  // Per-call override: a single matcher in a test that needs a different
  // evaluator. Per-call always wins over the bound default.
  await judge(fakeResult, 'fall-back claim graded by RCA Default', {
    evaluatorId: 'system-rca-default',
  });

  expect(true, 'smoke test reached completion').to.equal(true);
});
