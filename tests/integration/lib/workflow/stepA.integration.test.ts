/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Step A (#277) — INTEGRATION.
 *
 * Unlike the unit test (which injects a fake `invoke`), this drives the
 * *default* path end-to-end with NO injected seam:
 *
 *   run() → ctx.runAgent() → connectorInvoke() → loadConfig() (a real authored
 *   agent-health.config.mjs) → connector registry → MockConnector.execute()
 *
 * i.e. the same wiring the CLI uses, exercised against the real connector
 * registry via a `mock://` agent (no `claude`, no server). This is the path
 * that silently no-ops if the connector can't be resolved.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { source, workflow, clearSources } from '@/lib/workflow/index.js';

describe('workflow Step A — integration (real config + connector registry)', () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'wf-stepA-'));
    // A real authored config whose agent uses the mock connector, so the
    // default connectorInvoke resolves a real connector with no claude/server.
    writeFileSync(
      join(tmp, 'agent-health.config.js'),
      "module.exports = { agents: [{ key: 'wf-mock', name: 'WF Mock', endpoint: 'mock://wf', connectorType: 'mock' }] };\n"
    );
    process.chdir(tmp);
    clearSources();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drives config → registry → MockConnector.execute → stage → consolidate (no injected invoke)', async () => {
    const queue = source('q', async () => [
      { id: 'T1', prompt: 'investigate red cluster', meta: { cti: 'red-cluster' } },
      { id: 'T2', prompt: 'investigate jvm heap pressure', meta: { cti: 'jvm-heap' } },
      { id: 'T3', prompt: 'another red cluster', meta: { cti: 'red-cluster' } },
    ]);

    const prs: string[] = [];

    const wf = workflow('integ-A', { agent: 'wf-mock', concurrency: 2, repo: 'AESOncallClaudeCode' })
      .step('fix-the-queue', async (ctx) => {
        const ledger = ctx.ledger();
        await ctx.forEach(queue, { since: '24h' }, async (t) => {
          // No injected invoke → exercises the REAL default connectorInvoke.
          const run = await ctx.runAgent(t, { feedback: ledger, writes: 'shadow' });
          ctx.stage({ item: t, run, signature: String(t.meta?.cti ?? run.signature) });
        });
      })
      .step('consolidate-and-pr', async (ctx) => {
        for (const c of await ctx.consolidate(ctx.staged())) {
          await ctx.raisePR(c.fix, { title: `fix: ${c.label}` });
        }
      });

    const result = await wf.run({ onPR: async (pr) => prs.push(pr.title) });

    // Looped all 3 tickets through the real connector path.
    expect(result.staged.length).toBe(3);

    // Each staged result came from the REAL MockConnector — it has a runId and a
    // non-empty trajectory (proving runAgent actually invoked a connector, not a stub).
    expect(result.staged.every((s) => !!s.run.runId && s.run.trajectory.length > 0)).toBe(true);

    // 3 tickets → 2 fix-classes (red-cluster ×2, jvm-heap ×1) → 2 consolidated PRs.
    expect(result.clusters.length).toBe(2);
    expect(prs.length).toBe(2);
    expect(result.peakConcurrency).toBeLessThanOrEqual(2);
  });

  it('throws a clear error when the workflow agent is not in config', async () => {
    const queue = source('q-missing', async () => [{ id: 'X', prompt: 'p', meta: {} }]);
    const wf = workflow('integ-A-missing', { agent: 'no-such-agent' }).step('go', async (ctx) => {
      await ctx.forEach(queue, {}, async (t) => {
        await ctx.runAgent(t);
      });
    });
    await expect(wf.run({})).rejects.toThrow(/not found in config/);
  });
});
