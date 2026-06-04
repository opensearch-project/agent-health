/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Issue #230 — final end-to-end proof that the judge + traces fixture
 * work together against an OTel-instrumented agent.
 *
 * Pre-fix any `traces.*` access against `useTraces: true` returned 0 / [].
 * This file asserts only the SDK pipeline invariants that are independent
 * of an agent's OTel attribute completeness:
 *
 *   - `traces.spans` is populated (proves fetch + buildTracesAccessor wiring)
 *   - `traces.spans` is a real array of OTel span objects with names
 *   - The judge runs and records a verdict alongside the traces fixture
 *
 * Run:
 *   curl -sN -X POST http://127.0.0.1:4001/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"Issue 230 Pipeline E2E",
 *       "sources":[{"type":"code-import","filenames":["evals/issue-230-pipeline-e2e.eval.js"],"testCaseIds":[]}],
 *       "agentKey":"observio",
 *       "modelId":"claude-sonnet"
 *     }'
 */

const { test, expect } = require('@opensearch-project/agent-health');

test(
  'issue-230-pipeline-e2e-spans-fetched-and-judge-runs',
  {
    prompt: 'In one short sentence, what is observability?',
    description:
      'Proves the full SDK pipeline: useTraces=true agent → spans fetched → fixture populated → judge runs.',
    labels: ['issue:230', 'category:Verification', 'pipeline'],
  },
  async function ({ result, traces, judge }) {
    // (1) The agent ran and produced output.
    expect(result.agentOutput.trim()).to.have.length.greaterThan(0);

    // (2) Spans were fetched and the fixture is populated.
    //
    // Pre-fix this was always [] — silent zero. Post-fix it reflects
    // what the OTel pipeline actually has for this run.
    expect(traces.spans).to.have.length.greaterThan(0);

    // (3) Fixture exposes well-typed span objects.
    const span = traces.spans[0];
    expect(span).to.have.property('name');
    expect(span.name).to.be.a('string');
    expect(span.name.length).to.be.greaterThan(0);

    // (4) Power-user invariants — even when token attrs are missing,
    // numeric accessors must be numbers (not undefined / NaN).
    expect(traces.totalTokens).to.be.a('number');
    expect(traces.totalCost).to.be.a('number');
    expect(traces.toolCalls).to.be.an('array');

    // (5) The judge runs end-to-end against the same trajectory.
    await judge(result, 'the response defines or describes observability');
  }
);
