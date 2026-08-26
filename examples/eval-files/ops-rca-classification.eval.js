/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worked example — evaluating an ops / RCA agent that triages a ticket.
 *
 * The agent under test reads a ticket and emits a structured classification:
 *   - ticketType:  "latency" | "fault"        (deterministic — exact match)
 *   - rootCause:   one of a fixed category set (deterministic — exact match)
 *   - sop:         a recommended runbook        (non-deterministic — LLM judge)
 *
 * This shows the two check styles side by side:
 *   • deterministic  → expect(...).to.equal(...) on the parsed output
 *   • non-deterministic → judge(result, '<natural-language claim>')
 *
 * WEIGHTED SCORING (root-cause 60%, SOP, metrics, latency 10%):
 * per-matcher pass/fail lives here, but the *single weighted aggregate score*
 * across criteria is defined once in a custom EVALUATOR, not in the test body.
 * Attach it at run time with `evaluatorId` — see ops-rca-evaluator.json next to
 * this file. Run:
 *
 *   npx @opensearch-project/agent-health benchmark \
 *     -f ./examples/eval-files/ops-rca-classification.eval.js -a my-ops-agent
 *
 * Docs: ../../docs/SDK.md   Instrumentation: ../../docs/INSTRUMENT_WITH_OTEL.md
 */

const { test, expect } = require('@opensearch-project/agent-health');

// The agent's allowed root-cause categories — deterministic ground truth.
const ROOT_CAUSE_CATEGORIES = [
  'dependency_outage',
  'resource_exhaustion',
  'config_error',
  'code_regression',
  'network',
];

test('ticket-123-db-outage', {
  prompt: 'Triage ticket TICKET-123 and return your classification table.',
  description: 'DB dependency outage — must classify as fault + dependency_outage',
  context: [
    {
      description: 'Ticket body',
      value:
        'TICKET-123: payment-service returning 500s since 10:30. ' +
        'Logs: "Connection refused to database-primary:5432". p99 latency normal until errors began.',
    },
  ],
  labels: ['category:RCA', 'difficulty:Medium', 'agent:ops', 'type:fault'],
}, async function ({ agent, judge }) {
  const result = await agent.run();

  // ── Deterministic checks — exact classification, no LLM, $0 ──────────────
  const out = result.parsedOutput() || {}; // agent emits JSON classification
  expect(out.ticketType).to.equal('fault');
  expect(ROOT_CAUSE_CATEGORIES).to.include(out.rootCause);
  expect(out.rootCause).to.equal('dependency_outage');

  // Prove it actually investigated rather than guessing.
  expect(result.trajectory).to.haveStepsOfType('action');

  // ── Non-deterministic checks — LLM judge on the free-text SOP ────────────
  await judge(result, 'Recommends a runbook appropriate for a database dependency outage');
  await judge(result, 'Explains that payment-service cannot reach database-primary as the root cause');

  // ── Budget guard (feeds the "latency 10%" weight via the evaluator) ──────
  expect(result).to.haveCompletedWithin(120_000);
});
