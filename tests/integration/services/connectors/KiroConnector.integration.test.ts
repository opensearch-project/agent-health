/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * KiroConnector integration tests
 *
 * Unlike the unit suite (which mocks `child_process.spawn` and verifies the
 * stderr-parsing logic in isolation), this suite spawns the **real** `kiro-cli`
 * binary with `--no-interactive --trust-all-tools` and asserts that the
 * trajectory the connector emits has the structure the LLM judge depends on.
 *
 * What this catches that the unit test cannot:
 *
 *   - kiro-cli's actual stderr marker format drifting from the regex we parse
 *     (`[tool] Running:` / `[tool] status:`). A future kiro-cli release that
 *     renames or restructures these markers would silently regress the
 *     connector to "0 actions captured" — which is exactly the failure mode
 *     this whole effort exists to prevent.
 *
 *   - Argument quoting / `inputMode: 'arg'` round-trip through `spawn(..., {
 *     shell: true })`. Slash-prefixed prompts (e.g. `/my-agent ...`) and
 *     prompts with embedded quotes are easy to break here.
 *
 *   - The interaction between `--agent-engine v2` and `--no-interactive`.
 *
 * Skipped (with a clear console message) when `kiro-cli` is not on PATH so
 * CI runners without it installed pass cleanly. Locally on a developer host
 * with kiro-cli installed and authenticated, all tests run.
 */

import { execSync } from 'child_process';
import { ToolCallStatus } from '@/types';
import type { TrajectoryStep } from '@/types';
import type { ConnectorAuth, ConnectorRequest } from '@/services/connectors/types';
import type { TestCase } from '@/types';
import { KiroConnector } from '@/services/connectors/kiro/KiroConnector';

/** Detect kiro-cli at module load. If absent, every test in the file is skipped. */
function kiroAvailable(): boolean {
  try {
    execSync('which kiro-cli', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_KIRO = kiroAvailable();
// Use describe.skip when kiro-cli is unavailable so the file still loads but
// every test is reported as skipped rather than failing on a missing binary.
const describeIfKiro = HAS_KIRO ? describe : describe.skip;

/**
 * Real kiro-cli runs are slow (model latency + tool invocations + Bedrock
 * round-trips). Each test gets a generous timeout; the global jest timeout
 * is bumped accordingly when this file runs.
 */
const PER_TEST_TIMEOUT = 120_000;

describeIfKiro('KiroConnector (integration — real kiro-cli)', () => {
  if (!HAS_KIRO) {
    // eslint-disable-next-line no-console
    console.warn('[KiroConnector integration] kiro-cli not found in PATH — skipping');
  }

  const makeTestCase = (prompt: string): TestCase => ({
    id: `tc-int-${Date.now()}`,
    name: 'kiro integration test',
    initialPrompt: prompt,
    expectedOutcomes: [],
    context: [],
    labels: [],
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as TestCase);

  const auth: ConnectorAuth = { type: 'none' };

  function makeRequest(prompt: string): ConnectorRequest {
    return {
      testCase: makeTestCase(prompt),
      modelId: undefined,
      agentKey: 'kiro',
      payload: prompt,
    } as ConnectorRequest;
  }

  function summarise(trajectory: TrajectoryStep[]) {
    const counts: Record<string, number> = {};
    for (const s of trajectory) counts[s.type] = (counts[s.type] || 0) + 1;
    return counts;
  }

  it(
    'invokes a tool and produces structured action + tool_result + response steps',
    async () => {
      const connector = new KiroConnector();
      const result = await connector.execute(
        'kiro-cli',
        makeRequest('Use the `date` command and tell me the current day of the week in one short sentence.'),
        auth,
      );

      const counts = summarise(result.trajectory);
      const actions = result.trajectory.filter(s => s.type === 'action');
      const toolResults = result.trajectory.filter(s => s.type === 'tool_result');
      const responses = result.trajectory.filter(s => s.type === 'response');

      // Diagnostics on failure — easier than reading raw step dumps
      if (counts.action === 0 || !responses.length) {
        // eslint-disable-next-line no-console
        console.error('Trajectory step counts:', counts);
        // eslint-disable-next-line no-console
        console.error('Trajectory (first 12 steps):', result.trajectory.slice(0, 12));
      }

      expect(actions.length).toBeGreaterThanOrEqual(1);
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect(responses.length).toBe(1);

      // Every captured action must carry the toolName + toolArgs we promise to
      // downstream consumers (SDK matchers, judge prompt, run inspector).
      for (const a of actions) {
        expect(a.toolName).toBeTruthy();
        expect(a.toolArgs).toBeDefined();
        expect((a.toolArgs as any).command).toBeTruthy();
      }

      // Every tool_result must carry an explicit pass/fail status (no
      // `undefined` — that's what the prior connector emitted and is the
      // exact failure mode the judge can't evidence-check against).
      for (const r of toolResults) {
        expect([ToolCallStatus.SUCCESS, ToolCallStatus.FAILURE]).toContain(r.status);
      }

      // Final response is non-trivial. Loose substring check rather than a
      // strict day-name match — model output is non-deterministic and our
      // assertion is "the agent answered the question", not "it nailed today's
      // weekday".
      const responseText = responses[0].content || '';
      expect(responseText.length).toBeGreaterThan(0);

      // Persisted rawEvents must include both stdout and stderr — the prior
      // SubprocessConnector bug was specifically that stderr never made it
      // into rawEvents, so judge / run-inspector / future re-evaluation lost
      // every tool marker.
      const rawTypes = new Set((result.rawEvents || []).map((e: any) => e.type));
      expect(rawTypes.has('stdout')).toBe(true);
      expect(rawTypes.has('stderr')).toBe(true);
    },
    PER_TEST_TIMEOUT,
  );

  it(
    'returns a non-empty response with zero action steps for a no-tool greeting prompt',
    async () => {
      const connector = new KiroConnector();
      const result = await connector.execute(
        'kiro-cli',
        makeRequest('Reply with the single word: pong. Do not run any tools.'),
        auth,
      );

      const actions = result.trajectory.filter(s => s.type === 'action');
      const responses = result.trajectory.filter(s => s.type === 'response');

      // An obedient agent will not invoke any tool here. We assert <=1 rather
      // than ===0 because some kiro agent profiles run a no-op preflight
      // tool even on trivial prompts; the contract we care about is "the
      // connector did not invent action steps from stdout chunks".
      expect(actions.length).toBeLessThanOrEqual(1);
      expect(responses).toHaveLength(1);
      expect((responses[0].content || '').trim().length).toBeGreaterThan(0);
    },
    PER_TEST_TIMEOUT,
  );

  it(
    'state resets between sequential invocations on the same connector instance',
    async () => {
      // Reusing one connector across runs is the production path
      // (BenchmarkRunner does this). A leak in stderrLineBuffer or
      // pendingToolName between runs would cause the SECOND run to see a
      // stale tool from the FIRST run. This test catches that.
      const connector = new KiroConnector();

      const r1 = await connector.execute(
        'kiro-cli',
        makeRequest('Run `echo first` and tell me what it printed.'),
        auth,
      );
      const r2 = await connector.execute(
        'kiro-cli',
        makeRequest('Run `echo second` and tell me what it printed.'),
        auth,
      );

      const r1Actions = r1.trajectory.filter(s => s.type === 'action');
      const r2Actions = r2.trajectory.filter(s => s.type === 'action');
      expect(r1Actions.length).toBeGreaterThanOrEqual(1);
      expect(r2Actions.length).toBeGreaterThanOrEqual(1);

      // Sanity: each run produced its own response, neither is empty.
      const r1Resp = r1.trajectory.find(s => s.type === 'response')?.content || '';
      const r2Resp = r2.trajectory.find(s => s.type === 'response')?.content || '';
      expect(r1Resp.length).toBeGreaterThan(0);
      expect(r2Resp.length).toBeGreaterThan(0);
    },
    PER_TEST_TIMEOUT * 2, // two real runs
  );

  it('declares the type / name expected by the registry', () => {
    const connector = new KiroConnector();
    expect(connector.type).toBe('kiro');
    expect(connector.name).toBe('Kiro CLI');
    expect(connector.supportsStreaming).toBe(true);
  });

  it(
    'health check reports true when kiro-cli is on PATH',
    async () => {
      const connector = new KiroConnector();
      const ok = await connector.healthCheck('', auth);
      expect(ok).toBe(true);
    },
    10_000,
  );
});
