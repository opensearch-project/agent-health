/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workflow SDK — 5-ticket loop test.
 *
 * Exercises the full Step-A + consolidation path with an injected mock agent
 * (no server / no claude needed): bounded-concurrency fan-out, the cumulative
 * feedback ledger, staging, and consolidation into one cluster per fix-class.
 */

import { source, workflow, clearSources, FeedbackLedger } from '@/lib/workflow/index.js';
import type { AgentRunResult, WorkItem } from '@/lib/workflow/index.js';

function fakeRun(item: WorkItem): AgentRunResult {
  const cti = String(item.meta?.cti ?? 'unknown');
  return {
    item,
    trajectory: [
      { type: 'action', toolName: 'cs-domain-manager-status', content: 'diagnose' } as any,
      { type: 'response', content: `Diagnosis for ${item.id}: ${cti}` } as any,
    ],
    output: `Diagnosis for ${item.id}: ${cti}`,
    runId: `run-${item.id}`,
    signature: cti,
    traceIds: [`trace-${item.id}`],
  };
}

describe('workflow SDK — 5-ticket loop', () => {
  beforeEach(() => clearSources());

  function fiveTicketSource() {
    return source('queue-5', async () => {
      const ctis = ['red-cluster', 'jvm-heap', 'red-cluster', 'ebs-disk', 'jvm-heap'];
      return ctis.map((cti, i) => ({
        id: `TT-${1000 + i}`,
        prompt: `https://tickets.example/TT-${1000 + i}`,
        meta: { cti, severity: '2' },
      }));
    });
  }

  it('runs the queue with bounded concurrency, ledger, staging, consolidation', async () => {
    const queue = fiveTicketSource();

    // Track real in-flight concurrency through the injected invoke.
    let active = 0;
    let peak = 0;
    const invoke = async (item: WorkItem): Promise<AgentRunResult> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10)); // force overlap
      active--;
      return fakeRun(item);
    };

    const prs: { title: string; body?: string }[] = [];

    const wf = workflow('test-queue', { agent: 'aos-oncall', concurrency: 2, repo: 'AESOncallClaudeCode' })
      .step('fix-the-queue', async (ctx) => {
        const ledger = ctx.ledger();
        await ctx.forEach(queue, { since: '24h' }, async (ticket) => {
          const run = await ctx.runAgent(ticket, { feedback: ledger, writes: 'shadow' });
          ctx.stage({ item: ticket, run });
        });
      })
      .step('consolidate-and-pr', async (ctx) => {
        for (const cluster of await ctx.consolidate(ctx.staged())) {
          await ctx.raisePR(cluster.fix, { title: `fix: ${cluster.label}`, body: ctx.ledger().render() });
        }
      });

    const result = await wf.run({
      invoke,
      onPR: async (pr) => { prs.push({ title: pr.title, body: pr.body }); },
      // Append per-item feedback so the ledger accumulates across the loop.
      steer: (run) => `reviewed ${run.item.id}: signature ${run.signature} looks right`,
    });

    // Looped over all 5 tickets.
    expect(result.staged.length).toBe(5);

    // Concurrency was bounded at 2 and actually reached 2.
    expect(result.peakConcurrency).toBe(2);

    // Cumulative feedback accumulated one entry per ticket.
    expect(result.ledgerSize).toBe(5);

    // 5 tickets across 3 fix-classes (red-cluster ×2, jvm-heap ×2, ebs-disk ×1)
    // → 3 consolidated PRs, not 5.
    expect(result.clusters.length).toBe(3);
    expect(prs.length).toBe(3);

    // Largest cluster first; each cluster's tickets share a signature.
    const byLabel = Object.fromEntries(result.clusters.map((c) => [c.label, c.tickets.length]));
    expect(byLabel['red-cluster']).toBe(2);
    expect(byLabel['jvm-heap']).toBe(2);
    expect(byLabel['ebs-disk']).toBe(1);

    // The consolidated PR body carries the cumulative feedback.
    expect(prs[0].body).toContain('Cumulative feedback');
  });

  it('dedups repeated ticket ids and honors --limit', async () => {
    const queue = source('dupes', async () => ([
      { id: 'A', prompt: 'p', meta: { cti: 'x' } },
      { id: 'A', prompt: 'p', meta: { cti: 'x' } },
      { id: 'B', prompt: 'p', meta: { cti: 'y' } },
      { id: 'C', prompt: 'p', meta: { cti: 'z' } },
    ]));

    const wf = workflow('dedup', { agent: 'aos-oncall', concurrency: 4 })
      .step('go', async (ctx) => {
        await ctx.forEach(queue, {}, async (ticket) => {
          const run = await ctx.runAgent(ticket);
          ctx.stage({ item: ticket, run });
        });
      });

    const result = await wf.run({ invoke: async (item) => fakeRun(item), limit: 2 });
    // 4 raw → 3 after dedup on id → 2 after limit.
    expect(result.staged.length).toBe(2);
  });

  it('ledger renders cumulative feedback in order', () => {
    const l = new FeedbackLedger();
    l.append('first', { ticketId: 'TT-1' });
    l.append('second', { ticketId: 'TT-2' });
    expect(l.size).toBe(2);
    const rendered = l.render();
    expect(rendered).toContain('[TT-1] first');
    expect(rendered).toContain('[TT-2] second');
    expect(rendered.indexOf('first')).toBeLessThan(rendered.indexOf('second'));
  });
});
