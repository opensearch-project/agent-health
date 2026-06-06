/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK demo eval — three test cases that show the spectrum of evaluation
 * methods the code-based SDK supports:
 *
 *   1. mock-says-hello       (deterministic)  — agent invoked, only chai matchers
 *   2. mock-rca-judged       (agentic)        — agent invoked + LLM judge matcher
 *   3. data-only-no-prompt   (deterministic)  — no agent call at all
 *
 * Run with:
 *   AH_PORT=4002 npx @opensearch-project/agent-health benchmark \
 *     -f evals/sdk-demo.eval.js -a demo
 */

const { test, expect } = require('@opensearch-project/agent-health');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Deterministic — agent runs, all assertions are local chai matchers
// ─────────────────────────────────────────────────────────────────────────────

test('mock-says-hello', {
  prompt: 'Say hello in one short sentence.',
  description: 'Mock agent must produce a non-empty response within 30s',
  labels: ['category:Smoke', 'difficulty:Easy', 'method:deterministic'],
}, async function ({ agent }) {
  const result = await agent.run();
  expect(result.trajectory).to.have.length.greaterThan(0);
  expect(result.agentOutput.trim()).to.have.length.greaterThan(0);
  expect(result).to.haveCompletedWithin(30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Agentic (hybrid) — deterministic preflight + LLM judge for semantic claim
// ─────────────────────────────────────────────────────────────────────────────

test('mock-rca-judged', {
  prompt: 'Diagnose why the payment service is failing and explain the root cause.',
  description: 'Hybrid: structural checks first, then LLM judge for semantic correctness',
  context: [
    {
      description: 'Error log',
      value: 'ERROR 2026-05-20 10:31:22 [payment-service] Connection refused to db-primary:5432',
    },
  ],
  labels: ['category:RCA', 'difficulty:Medium', 'method:agentic'],
}, async function ({ agent, judge }) {
  const result = await agent.run();

  // Cheap deterministic preflight — fail fast before spending $ on the judge
  expect(result.trajectory).to.have.length.greaterThan(0);
  expect(result).to.haveCompletedWithin(60_000);

  // LLM judge — produces a structured matcher verdict with score + reasoning
  await judge(result, 'Mentions the payment service or its database connection failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Deterministic, no prompt — agent never invoked, $0 / 0ms agent step
// ─────────────────────────────────────────────────────────────────────────────

test('data-only-no-prompt', {
  description: 'Pure data check; agent invocation skipped entirely',
  labels: ['category:Data Quality', 'difficulty:Easy', 'method:deterministic'],
}, function ({ result }) {
  expect(result.durationMs).to.equal(0);
  expect(result.trajectory).to.have.length(0);
  expect(2 + 2).to.equal(4);
});
