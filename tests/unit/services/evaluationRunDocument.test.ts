/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** The one run-document builder shared by the UI route and the CLI executor (#612). */

import { buildEvaluationRunDocument, resolveRunModelId, snapshotTestCases } from '@/services/evaluationRunDocument';

const agents = [
  { key: 'declares', name: 'A', connectorType: 'rest', endpoint: 'http://x', connectorConfig: { model: 'agent-declared-model' } },
  { key: 'plain', name: 'B', connectorType: 'rest', endpoint: 'http://y' },
] as any[];
const testCases = [{ id: 'tc-1', name: 'one', version: 3 }, { id: 'tc-2', name: 'two' }] as any[];

describe('buildEvaluationRunDocument', () => {
  it('mints the document the UI route always wrote: defaults, snapshots with versions, resolved agent model, judge id only when a non-empty string', () => {
    const run = buildEvaluationRunDocument({
      sources: [{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }], agentKey: 'declares', modelId: 'legacy', judgeModelId: 'demo-model',
      evaluatorId: 'ev', concurrency: 2, benchmarkId: 'b', trigger: 'cli', testCases, agents,
      provenance: { agentFingerprint: 'fp', agentFingerprintShort: 'fp-short' }, now: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(run.id).toMatch(/^eval-run-\d+-[a-z0-9]+$/);
    expect(run).toMatchObject({
      status: 'running', trigger: 'cli', agentKey: 'declares', modelId: 'agent-declared-model', judgeModelId: 'demo-model', evaluatorId: 'ev',
      concurrency: 2, benchmarkId: 'b', results: {}, createdAt: '2026-03-01T00:00:00.000Z', agentFingerprint: 'fp', agentFingerprintShort: 'fp-short',
      testCaseSnapshots: [{ id: 'tc-1', version: 3, name: 'one' }, { id: 'tc-2', version: 1, name: 'two' }],
    });
    expect(run.name).toMatch(/^Evaluation Run /);
  });

  it('trigger defaults to manual; a blank / non-string judge id is dropped; the legacy model id is the fallback, then absent (never \'\')', () => {
    const run = buildEvaluationRunDocument({ name: 'N', sources: [], agentKey: 'plain', modelId: 'legacy', judgeModelId: '', testCases: [], agents });
    expect(run).toMatchObject({ name: 'N', trigger: 'manual', modelId: 'legacy', testCaseSnapshots: [] });
    expect(run.judgeModelId).toBeUndefined();
    expect(buildEvaluationRunDocument({ sources: [], agentKey: 'plain', judgeModelId: 42, testCases: [], agents }).judgeModelId).toBeUndefined();
    expect(resolveRunModelId(agents, 'plain')).toBeUndefined();
    expect(resolveRunModelId(agents, 'unknown-agent', 'legacy')).toBe('legacy');
    expect(snapshotTestCases(testCases)[1]).toEqual({ id: 'tc-2', version: 1, name: 'two' });
  });

  it('an agent that owns its model (hook-built rest payload / agentOwnsModel) drops a caller-sent catalog fallback — the same chokepoint for the UI route and the CLI executor', () => {
    const owning = [
      ...agents,
      { key: 'hooked', name: 'H', connectorType: 'rest', endpoint: 'http://h', hooks: { beforeRequest: async (c: any) => c } },
      { key: 'flagged', name: 'F', connectorType: 'rest', endpoint: 'http://f', connectorConfig: { agentOwnsModel: true } },
    ] as any[];
    expect(resolveRunModelId(owning, 'hooked', 'demo-model')).toBeUndefined();
    expect(resolveRunModelId(owning, 'flagged', 'demo-model')).toBeUndefined();
    expect(buildEvaluationRunDocument({ sources: [], agentKey: 'hooked', modelId: 'demo-model', testCases: [], agents: owning }).modelId).toBeUndefined();
    // Catalog agent: the caller's value is kept as before.
    expect(resolveRunModelId(owning, 'plain', 'demo-model')).toBe('demo-model');
  });
});
