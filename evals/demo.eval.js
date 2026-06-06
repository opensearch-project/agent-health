/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Demo eval — five test cases that show off the SDK end-to-end against
 * the live Observio agent.
 *
 *   1. observio-says-hello          Pure deterministic, no LLM (free, fast)
 *   2. observio-uses-a-tool         Trajectory inspection — must invoke at least one tool
 *   3. observio-rca-is-coherent     Hybrid — deterministic + LLM judge
 *   4. labels-only-no-prompt        No agent invocation at all (data-only test)
 *   5. budget-aware                 Uses traces fixture for token-budget assertion
 *
 * The test body owns invocation: call `const result = await agent.run()` to
 * drive the agent (the test's `prompt` is the default), then assert against
 * the returned result. Exactly one `agent.run()` per test.
 *
 * Run with:
 *   curl -sN -X POST http://localhost:4002/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"SDK Demo",
 *       "sources":[{"type":"code-import","filenames":["evals/demo.eval.js"],"testCaseIds":[]}],
 *       "agentKey":"observio",
 *       "modelId":"claude-sonnet"
 *     }'
 */

const { test, expect } = require('@opensearch-project/agent-health');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Pure deterministic — no LLM, $0, fully reproducible
// ─────────────────────────────────────────────────────────────────────────────

test('observio-says-hello', {
  prompt: 'Say hello to me in one short sentence.',
  description: 'Smoke test: agent produces a non-trivial response',
  labels: ['category:Smoke', 'difficulty:Easy', 'demo', 'agent:observio'],
}, async function ({ agent }) {
  const result = await agent.run();

  // Trajectory must exist
  expect(result.trajectory).to.have.length.greaterThan(0);

  // Final output is non-empty
  expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

  // Reasonable timing budget
  expect(result).to.haveCompletedWithin(60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Trajectory inspection — proves the agent actually investigates
// ─────────────────────────────────────────────────────────────────────────────

test('observio-uses-a-tool', {
  prompt: 'Find the source of the most recent error log entry.',
  description: 'Agent must call at least one tool, not just answer from memory',
  labels: ['category:Tool Use', 'difficulty:Medium', 'demo', 'agent:observio'],
}, async function ({ agent }) {
  const result = await agent.run();

  // At least one action step (tool invocation)
  expect(result.trajectory).to.haveStepsOfType('action');

  // The trajectory accessor sugar makes the assertion read like prose
  const tools = result.trajectory.toolCalls();
  expect(tools).to.have.length.greaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Hybrid — deterministic preflight + targeted LLM judge
// ─────────────────────────────────────────────────────────────────────────────

test('observio-rca-is-coherent', {
  prompt: 'Diagnose why the payment service is failing and explain the root cause.',
  description: 'Hybrid: cheap structural checks first, then LLM judge for semantic correctness',
  context: [
    {
      description: 'Error log',
      value: 'ERROR 2024-01-15 10:31:22 [payment-service] Connection refused to database-primary:5432',
    },
  ],
  labels: ['category:RCA', 'difficulty:Hard', 'demo', 'agent:observio', 'hybrid'],
}, async function ({ agent, judge }) {
  const result = await agent.run();

  // Cheap deterministic preflight — fail fast, never spend $ on the judge
  expect(result.trajectory).to.have.length.greaterThan(0);
  expect(result).to.haveCompletedWithin(120_000);
  expect(result.agentOutput).to.haveOutputMatching(/payment[- ]service/i);

  // Now invoke the LLM judge for the semantic claim. This produces a
  // 'hybrid' evaluation method on the resulting report.
  await judge(result, 'Correctly identifies that the payment-service cannot connect to its database');
  await judge(result, 'Provides a plausible root-cause hypothesis (e.g. database down, network issue)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: No prompt at all — pure data-only test, agent never invoked
// ─────────────────────────────────────────────────────────────────────────────
//
// Useful for tests that assert against external state, fixtures, or static
// data without needing any agent involvement. The body simply never calls
// agent.run(), so `result` stays the empty placeholder.

test('labels-only-no-prompt', {
  description: 'Verify a fixture file matches a baseline (no agent involvement)',
  labels: ['category:Data Quality', 'difficulty:Easy', 'demo'],
}, function ({ result }) {
  // No agent ran — durationMs is 0, trajectory empty
  expect(result.durationMs).to.equal(0);
  expect(result.trajectory).to.have.length(0);

  // The actual deterministic check (could load a JSON file, compute, etc.)
  const baseline = { name: 'demo', version: 1 };
  expect(baseline.version).to.equal(1);
  expect(baseline.name).to.equal('demo');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Budget-aware — uses the traces fixture for token / span timing checks
// ─────────────────────────────────────────────────────────────────────────────
//
// `traces` reflects the agent's OTel spans once `agent.run()` resolves. When
// no traces are available the accessor returns 0 / empty for all helpers,
// so this test still passes (vacuously) on agents without instrumentation.

test('budget-aware', {
  prompt: 'Summarize the system in one paragraph.',
  description: 'Token budget + span-timing assertions via the traces fixture',
  labels: ['category:Budget', 'difficulty:Easy', 'demo', 'agent:observio'],
}, async function ({ agent, traces }) {
  const result = await agent.run();

  expect(result.agentOutput.length).to.be.greaterThan(0);
  // Cheap budget cap — fails if the agent burned more than 50k tokens
  expect(traces.totalTokens).to.be.lessThan(50_000);
});
