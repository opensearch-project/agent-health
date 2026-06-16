/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * oncall-queue.workflow.ts — runnable example.
 *
 * Step A (fix-the-queue): fan out over a ticket source at bounded concurrency,
 * investigate each with the agent (shadow writes), append human steering to
 * the cumulative ledger, and stage candidate fixes.
 *
 * Step B (consolidate-and-pr): cluster staged fixes by signature and raise ONE
 * PR per fix-class, embedding the cumulative feedback as rationale.
 *
 * Run (smoke loop of 5, dry-run PRs):
 *   agent-health workflow run -f examples/eval-files/oncall-queue.workflow.ts \
 *     --since 24h --concurrency 2 --limit 5
 */

import { source, workflow } from '@opensearch-project/agent-health';

// SOURCE — plain function, no interface. Swap the body for a real SIM/pager/
// email query; it just has to return { id, prompt, meta } objects.
const oncallQueue = source('dp-oncall-queue', async ({ since }) => {
  void since;
  // Demo data so the example is runnable without live ticket access.
  const ctis = ['red-cluster', 'jvm-heap', 'red-cluster', 'ebs-disk', 'jvm-heap'];
  return ctis.map((cti, i) => ({
    id: `TT-${1000 + i}`,
    prompt: `https://tickets.example/TT-${1000 + i}`,
    meta: { cti, severity: '2' },
  }));
});

export default workflow('oncall-queue-and-improve', {
  agent: 'aos-oncall',
  concurrency: 4,
  evaluator: 'system-tool-usage',
  repo: 'AESOncallClaudeCode',
})
  .step('fix-the-queue', async (wf) => {
    const ledger = wf.ledger();
    await wf.forEach(oncallQueue, { since: '24h' }, async (ticket) => {
      const run = await wf.runAgent(ticket, { feedback: ledger, writes: 'shadow' });
      wf.stage({ item: ticket, run });
    });
  })
  .step('consolidate-and-pr', async (wf) => {
    const clusters = await wf.consolidate(wf.staged());
    for (const cluster of clusters) {
      await wf.raisePR(cluster.fix, {
        title: `fix: ${cluster.label} (${cluster.tickets.length} tickets)`,
        body: wf.ledger().render(),
        repo: wf.config.repo,
        evidence: cluster.traceIds,
      });
    }
  });
