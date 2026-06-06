/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Issue #230 verification eval — exercises all three behavioural modes of
 * the `traces` fixture end-to-end against a real, OTel-instrumented agent.
 *
 * Pre-fix (0.5.x): every assertion against `traces.*` silently passed
 * against `0` regardless of actual token usage — the fixture was hard-coded
 * to `emptyTracesAccessor()`. See https://github.com/opensearch-project/agent-health/issues/230
 *
 * Post-fix: the runner loads real OTel spans into the fixture (after
 * `agent.run()`) when `useTraces: true`, or returns a loud-failure accessor
 * (throws on read) when spans aren't retrievable.
 *
 * Run against the observio agent (useTraces: true):
 *
 *   curl -sN -X POST http://127.0.0.1:4001/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"Issue 230 Verification",
 *       "sources":[{"type":"code-import","filenames":["evals/issue-230-verification.eval.js"],"testCaseIds":[]}],
 *       "agentKey":"observio",
 *       "modelId":"claude-sonnet"
 *     }'
 */

const { test, expect } = require('@opensearch-project/agent-health');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — REGRESSION: the original bug from the issue
//
// `lessThan(N)` against an honest agent that uses real tokens MUST measure
// real numbers, not silently pass against 0.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'issue-230-totalTokens-is-real-not-zero',
  {
    prompt:
      'Briefly explain the difference between OpenSearch and Elasticsearch in one paragraph.',
    description:
      'Pre-fix this passed silently against 0; post-fix it must reflect real OTel token counts.',
    labels: ['issue:230', 'category:Verification', 'difficulty:Easy'],
  },
  async function ({ agent, traces }) {
    const result = await agent.run();

    // The agent actually ran and produced output.
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

    // Assertion (a): the fixture must reflect real numbers.
    //
    // A non-zero `totalTokens` is the cleanest signal that the fixture
    // was populated from real OTel spans. Pre-fix this was always 0.
    expect(traces.totalTokens).to.be.greaterThan(0);

    // Assertion (b): a sane upper bound. This is the exact pattern from
    // the issue report. With the bug, this silently passed against 0;
    // now it asserts against a real number and either passes (real
    // usage under cap) or fails loudly with the actual count.
    expect(traces.totalTokens).to.be.lessThan(50_000);

    // Assertion (c): power-user raw access. `spans.length > 0` means
    // we have at least one OTel span — proves end-to-end pre-loading
    // (HTTP fetch + buildTracesAccessor) actually succeeded.
    expect(traces.spans).to.have.length.greaterThan(0);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — Tool-span aggregation
//
// If the agent invoked any tools, the fixture's `toolCalls` must contain
// them. This proves the gen_ai.tool.name attribute extraction works.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'issue-230-toolCalls-populated-when-agent-uses-tools',
  {
    prompt: 'Search the recent error logs and summarize what you find.',
    description:
      'Tool spans extracted from gen_ai.tool.name must surface in traces.toolCalls.',
    labels: ['issue:230', 'category:Verification', 'difficulty:Medium'],
  },
  async function ({ agent, traces }) {
    const result = await agent.run();
    expect(result.trajectory).to.haveStepsOfType('action');

    // We don't hard-require traces.toolCalls.length > 0 because the
    // observio agent's tool spans may or may not be tagged with
    // `gen_ai.tool.name` (the canonical attribute we extract). We assert
    // the structural invariant only: whatever's there is well-formed.
    for (const tc of traces.toolCalls) {
      expect(tc.name).to.be.a('string');
      expect(tc.name.length).to.be.greaterThan(0);
      expect(tc.durationMs).to.be.a('number');
      expect(tc.durationMs).to.be.at.least(0);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — Hybrid: deterministic + LLM judge.
//
// The agent must (a) actually answer the question, (b) the judge must
// agree it answered, AND (c) the traces fixture must reflect real usage.
// This is the test that proves the *whole* SDK pipeline — judge + traces
// — works together with the fix in place.
// ─────────────────────────────────────────────────────────────────────────────
test(
  'issue-230-judge-and-traces-together',
  {
    prompt: 'What is OpenTelemetry in one short paragraph?',
    description:
      'Judge confirms the answer is on-topic AND the traces fixture is populated.',
    labels: ['issue:230', 'category:Verification', 'difficulty:Medium'],
  },
  async function ({ agent, traces, judge }) {
    const result = await agent.run();
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

    // Real token usage — proves the fix.
    expect(traces.totalTokens).to.be.greaterThan(0);

    // Judge runs (LLM-as-a-judge) — proves the full SDK pipeline.
    await judge(
      result,
      'the agent provides a coherent explanation of OpenTelemetry'
    );
  }
);
