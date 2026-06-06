/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-surface parity regression test (PR #258).
 *
 * Pins the four customer-feedback parity properties between
 * POST /api/storage/evaluation-runs (HTTP API + CLI) and
 * POST /api/evaluate (UI "Run Test" / QuickRunModal):
 *
 *   1. The persisted TestCaseRun carries the run-level `evaluatorId`,
 *      so the run-details page can resolve the right evaluator + rubric.
 *   2. The run-card score tooltip can resolve evaluator-specified rubric
 *      metrics (depends on #1 reaching the UI).
 *   3. An in-progress `status: running` row is visible in the runs list
 *      AFTER the SSE `started`/`progress` events but BEFORE `completed` —
 *      matching what /api/evaluate already does for the UI path.
 *   4. Test cases without `expectedOutcomes` / `expectedTrajectory` are
 *      accepted by the storage API.
 *
 * This test is hermetic — no `prompt` set, so the runner skips agent
 * invocation and runs the body against a synthesized empty result. The
 * body drives the live HTTP server via `fetch` calls, so a regression
 * in the runner / storage / SDK contract breaks the test at code-review
 * time.
 *
 * Run with the demo agent + demo model so the inner runs return quickly:
 *
 *   curl -sN -X POST http://localhost:4001/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"parity",
 *       "sources":[{"type":"code-import",
 *                  "filenames":["evals/cross-surface-parity.eval.js"],
 *                  "testCaseIds":[]}],
 *       "agentKey":"demo",
 *       "modelId":"demo-model",
 *       "trigger":"sdk-test"
 *     }'
 *
 * Or via the bundled probe script that drives all three surfaces in one
 * pass:
 *
 *   bash scripts/cross-surface-parity-probe.sh
 *
 * Tracking: PR #258 (https://github.com/opensearch-project/agent-health/pull/258).
 */

const { test, expect } = require('@opensearch-project/agent-health');

test('cross-surface-parity-evaluatorId-and-running-placeholder', {
  description:
    'Cross-surface parity (UI ↔ HTTP API ↔ CLI): a run launched via ' +
    'POST /api/storage/evaluation-runs must (1) persist evaluatorId on ' +
    'the per-test-case TestCaseRun so run-details + score tooltip resolve ' +
    'the right evaluator + rubric, (2) pre-persist a `status: running` ' +
    'placeholder so the runs list shows an in-progress row before the ' +
    'agent finishes (matching /api/evaluate), and (3) accept test cases ' +
    'with no expectedOutcomes / expectedTrajectory (SDK code-only tests).',
  context: [
    { description: 'tracking', value: 'https://github.com/opensearch-project/agent-health/pull/258' },
    { description: 'phase', value: 'cross-surface-parity' },
    { description: 'parity-baseline', value: '/api/evaluate (UI/QuickRunModal path)' },
  ],
  labels: [
    'category:Regression',
    'difficulty:Easy',
    'kind:cross-surface-parity',
    'feature:run-evaluator-and-placeholder',
    'parity:ui-http-cli',
    'pr:258',
  ],
  timeout: 60_000,
  // No `expectedOutcomes` here on purpose — itself doubles as proof
  // that an SDK test case can be persisted without them.
}, async function ({ expect }) {
  const port = process.env.AGENT_HEALTH_PORT || '4001';
  const base = `http://localhost:${port}`;

  // ── Fixture: a tiny demo test case with NO expectedOutcomes ───────────────
  // Hits property #4 directly: the API must accept test cases with no
  // `expectedOutcomes` / `expectedTrajectory`. The UI form-validation
  // gate (TestCaseEditor's `hasValidOutcome`) is asserted separately
  // below by importing the validator.
  const tcCreate = await fetch(`${base}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `parity-smoke-${Date.now()}`,
      description: 'cross-surface parity probe — no expectedOutcomes on purpose',
      category: 'Smoke',
      difficulty: 'Easy',
      initialPrompt: 'Say hello.',
      context: [],
      // Deliberately omitting both fields:
      //   expectedOutcomes: [],
      //   expectedTrajectory: [],
    }),
  });
  expect(
    tcCreate.ok,
    '[property 4] POST /api/storage/test-cases must accept a test case ' +
      'with no expectedOutcomes and no expectedTrajectory — the SDK code-only path ' +
      'has no such fields and a UI-created test case must be allowed to mirror that.',
  ).to.equal(true);
  const tc = await tcCreate.json();
  expect(tc.id, 'persisted test case must come back with an id').to.be.a('string');

  // Pick a multi-metric system evaluator so the rubric assertion has
  // something distinguishable to look up. `system-tool-usage` emits
  // `tool_selection_accuracy` / `redundant_calls` / `tool_ordering` —
  // none of which the RCA-Default `accuracy` field would ever produce.
  const EVALUATOR_ID = 'system-tool-usage';
  const evRes = await fetch(`${base}/api/storage/evaluators/${EVALUATOR_ID}`);
  expect(evRes.ok, `evaluator ${EVALUATOR_ID} must exist on the server`).to.equal(true);
  const evaluator = await evRes.json();
  const rubricMetricNames = (evaluator.scoringConfig?.metrics || []).map(m => m.name);
  expect(rubricMetricNames, 'evaluator must define at least one metric').to.have.length.greaterThan(0);

  let evalRunId = null;
  let testCaseRunId = null;
  let sawRunningRow = false;
  let runningRowEvaluatorId = null;

  try {
    // ── Launch the run via the HTTP API path (also the CLI path) ─────────────
    // SSE stream starts immediately and emits `started` before the agent
    // begins. We poll the runs list during streaming to assert the
    // running-placeholder row is visible (property #3).
    const runResp = await fetch(`${base}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `parity-smoke-${Date.now()}`,
        sources: [{ type: 'test-case-ids', ids: [tc.id] }],
        agentKey: 'demo',
        modelId: 'demo-model',
        evaluatorId: EVALUATOR_ID,
        trigger: 'sdk-test',
      }),
    });
    expect(runResp.ok, '/api/storage/evaluation-runs must accept the parity probe request')
      .to.equal(true);

    const reader = runResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completedSeen = false;

    // Helper: scan the by-test-case runs list for a `status: running` row.
    // We use the dedicated /api/storage/runs/by-test-case/:id endpoint —
    // the generic /api/storage/runs?testCaseId= query param is intentionally
    // ignored by the server (returns ALL runs irrespective of filter, see
    // server/routes/storage/runs.ts:45). Using `by-test-case` guarantees
    // we only see rows for the inner parity-smoke test case the test
    // created, never the outer parity test's own running placeholder
    // (which would have evaluatorId=undefined and mask the assertion).
    const probeRunsList = async () => {
      const r = await fetch(`${base}/api/storage/runs/by-test-case/${encodeURIComponent(tc.id)}?size=10`);
      if (!r.ok) return;
      const data = await r.json();
      const items = Array.isArray(data) ? data : (data.items || data.runs || []);
      const running = items.find(it => it.status === 'running');
      if (running) {
        sawRunningRow = true;
        runningRowEvaluatorId = runningRowEvaluatorId || running.evaluatorId || null;
      }
    };

    while (!completedSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const ev of events) {
        if (!ev.trim()) continue;
        const eventLine = (ev.match(/^event:\s*(\S+)/m) || [])[1];
        const dataLine = (ev.match(/^data:\s*(.+)$/m) || [])[1];
        if (!dataLine) continue;
        let data;
        try { data = JSON.parse(dataLine); } catch { continue; }
        if (eventLine === 'started') {
          evalRunId = data.runId;
          // Poll a few times right after `started` — once the placeholder
          // exists, sawRunningRow flips and we stop polling.
          for (let i = 0; i < 5 && !sawRunningRow; i++) {
            await probeRunsList();
            if (!sawRunningRow) await new Promise(r => setTimeout(r, 100));
          }
        } else if (eventLine === 'progress') {
          if (!sawRunningRow) await probeRunsList();
        } else if (eventLine === 'testCaseComplete') {
          testCaseRunId = data?.result?.reportId || testCaseRunId;
        } else if (eventLine === 'completed') {
          completedSeen = true;
          if (data?.results && data.results[tc.id]?.reportId) {
            testCaseRunId = data.results[tc.id].reportId;
          }
        } else if (eventLine === 'error') {
          completedSeen = true;
        }
      }
    }
    try { await reader.cancel(); } catch { /* ignore */ }

    // Each property is its own assertion. We record-without-throwing so a
    // partial regression still surfaces all the gaps. The runner's
    // matcher-session-driven verdict still fails the whole test when ANY
    // assertion records pass:false.
    const pin = (label, assertFn) => {
      try { assertFn(); }
      catch (err) {
        // recordVerdict already captured pass:false on the matcher
        // session; swallow the throw to keep the body running.
        // eslint-disable-next-line no-console
        console.warn(`[parity] ${label}: ${err.message?.split('\n')[0]}`);
      }
    };

    // ── Property #3: in-progress row must be visible on the HTTP API path ─
    pin('property-3-running-placeholder', () => {
      expect(
        sawRunningRow,
        '[property 3] /api/storage/evaluation-runs must pre-persist a per-test-case ' +
          'TestCaseRun with status="running" so the runs list shows an in-progress row ' +
          'BEFORE the run completes — matching what /api/evaluate does for the UI path.',
      ).to.equal(true);
    });

    // ── Property #1+#2: the persisted report must carry evaluatorId ──────
    let finalReport = null;
    if (testCaseRunId) {
      const finalRes = await fetch(`${base}/api/storage/runs/${encodeURIComponent(testCaseRunId)}`);
      if (finalRes.ok) finalReport = await finalRes.json();
    }
    pin('property-1+2-final-report-evaluatorId', () => {
      expect(testCaseRunId, 'completed event must include the per-test-case reportId').to.be.a('string');
      expect(finalReport, 'GET /api/storage/runs/:id must return the persisted report').to.be.an('object');
      expect(
        finalReport && finalReport.evaluatorId,
        '[property 1+2] persisted TestCaseRun must carry evaluatorId so ' +
          'the run-details page resolves the right evaluator and the score tooltip ' +
          'shows evaluator-specified rubric metrics. /api/evaluate already does this; ' +
          '/api/storage/evaluation-runs must too.',
      ).to.equal(EVALUATOR_ID);
    });

    // The running placeholder we observed mid-stream must ALSO have
    // already had evaluatorId set (otherwise hover-on-running-run would
    // still show the wrong rubric).
    pin('property-1+2-running-placeholder-evaluatorId', () => {
      if (!sawRunningRow) return; // gated by property-3 — no row to inspect
      expect(
        runningRowEvaluatorId,
        '[property 1+2] the running placeholder must already carry evaluatorId — ' +
          'otherwise the score tooltip on an in-progress run still resolves the wrong rubric.',
      ).to.equal(EVALUATOR_ID);
    });

    // ── Property #4: validateTestCaseJson accepts no expectedOutcomes ────
    // The API path is already permissive (asserted above by `tcCreate.ok`).
    // The UI form gate lives in `lib/testCaseValidation.ts → testCaseSchema`
    // and `components/TestCaseEditor.tsx → hasValidOutcome`. We import the
    // validator dynamically (same pattern as the issue-242 test elsewhere)
    // and assert the schema accepts a test case with no `expectedOutcomes`.
    const path = require('path');
    const { validateTestCaseJson } = await import(
      path.resolve(process.cwd(), 'lib/testCaseValidation.ts')
    );
    const v = validateTestCaseJson({
      name: 'no-outcomes',
      category: 'Smoke',
      difficulty: 'Easy',
      initialPrompt: 'Say hello.',
      // intentionally no expectedOutcomes
    });
    pin('property-4-test-case-validator-no-outcomes', () => {
      expect(
        v.valid,
        '[property 4] validateTestCaseJson must accept a test case with no ' +
          'expectedOutcomes (SDK code-only tests have none). The schema previously ' +
          'required "At least one non-empty expected outcome is required", which blocked ' +
          'the UI form and the JSON editor from saving cross-surface-equivalent test cases.',
      ).to.equal(true);
    });
  } finally {
    // ── Cleanup — always remove the fixtures we created ──────────────────────
    if (testCaseRunId) {
      await fetch(`${base}/api/storage/runs/${encodeURIComponent(testCaseRunId)}`, { method: 'DELETE' }).catch(() => {});
    }
    if (evalRunId) {
      await fetch(`${base}/api/storage/evaluation-runs/${encodeURIComponent(evalRunId)}`, { method: 'DELETE' }).catch(() => {});
    }
    if (tc?.id) {
      await fetch(`${base}/api/storage/test-cases/${encodeURIComponent(tc.id)}`, { method: 'DELETE' }).catch(() => {});
    }
  }
});
