/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Issue #230 — judge + opt-out verification.
 *
 * Companion to `issue-230-verification.eval.js`. That file uses the
 * observio agent (useTraces: true) to prove the *loud-failure* path —
 * which is what the bug-fix made visible. This file proves the
 * complementary behaviours:
 *
 *   1. With useTraces: false the opt-out path still returns silent zeros
 *      (so existing matchers in non-trace tests are not disturbed).
 *   2. The LLM judge runs end-to-end against the same agent and
 *      produces a verdict — confirming `judge()` is wired correctly
 *      regardless of trace availability.
 *
 * Run against the demo (mock) agent — fast, free, no external deps:
 *
 *   curl -sN -X POST http://127.0.0.1:4001/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"Issue 230 Opt-Out + Judge",
 *       "sources":[{"type":"code-import","filenames":["evals/issue-230-judge-verify.eval.js"],"testCaseIds":[]}],
 *       "agentKey":"demo",
 *       "modelId":"claude-sonnet"
 *     }'
 */

const { test, expect } = require('@opensearch-project/agent-health');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — Opt-out path (useTraces: false) returns silent zeros.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'issue-230-optout-traces-fixture-returns-zeros',
  {
    prompt: 'Say hello in one short sentence.',
    description:
      'Agents with useTraces:false get a silent-zero traces fixture so existing non-trace matchers still work.',
    labels: ['issue:230', 'category:Verification', 'agent:opt-out'],
  },
  async function ({ agent, traces }) {
    const result = await agent.run();
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

    // useTraces:false → fixture is silent zeros.
    expect(traces.totalTokens).to.equal(0);
    expect(traces.totalCost).to.equal(0);
    expect(traces.spans).to.have.length(0);
    expect(traces.toolCalls).to.have.length(0);
    expect(traces.spanDuration('anything')).to.equal(0);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — judge() works end-to-end.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'issue-230-judge-runs-and-records-verdict',
  {
    prompt:
      'Briefly explain what an LLM judge is in agent evaluation, in one paragraph.',
    description:
      'The judge fixture must invoke the Bedrock judge against a deterministic body and record a verdict.',
    labels: ['issue:230', 'category:Verification', 'judge'],
  },
  async function ({ agent, judge }) {
    const result = await agent.run();
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

    // The judge must run, not throw. A passing judge call records a
    // MatcherResult with method='llm-judge' that we can introspect via
    // the run's matcherResults later.
    await judge(result, 'the response talks about evaluation or judging');
  }
);
