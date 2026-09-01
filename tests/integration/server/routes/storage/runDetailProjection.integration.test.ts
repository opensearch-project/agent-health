/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const reportId = `report-detail-projection-${Date.now()}`;

async function backendAvailable(): Promise<boolean> {
  try {
    return (await fetch(`${BASE_URL}/api/storage/health`)).ok;
  } catch {
    return false;
  }
}

describe('run detail projections', () => {
  let available = false;

  beforeAll(async () => {
    available = await backendAvailable();
    if (!available) return;
    const response = await fetch(`${BASE_URL}/api/storage/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: reportId,
        testCaseId: 'projection-test-case',
        testCaseVersionId: 'projection-test-case-v1',
        agentId: 'projection-agent',
        modelId: 'projection-model',
        iteration: 1,
        status: 'completed',
        passFailStatus: 'passed',
        trajectory: [{ type: 'response', content: 'targeted trajectory' }],
        rawEvents: [{ type: 'stdout', data: 'targeted raw event' }],
        llmJudgeReasoning: 'core reasoning',
        llmJudgeResponse: {
          modelId: 'projection-judge',
          timestamp: new Date().toISOString(),
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          rawResponse: 'targeted raw judge response',
        },
      }),
    });
    expect(response.status).toBe(201);
  });

  afterAll(async () => {
    if (available) {
      await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  it('defaults to core while full and targeted includes preserve capabilities', async () => {
    if (!available) return;

    const core = await (await fetch(`${BASE_URL}/api/storage/runs/${reportId}`)).json();
    expect(core.llmJudgeReasoning).toBe('core reasoning');
    expect(core.trajectory).toBeUndefined();
    expect(core.rawEvents).toBeUndefined();
    expect(core.llmJudgeResponse.modelId).toBe('projection-judge');
    expect(core.llmJudgeResponse.rawResponse).toBeUndefined();

    const full = await (await fetch(`${BASE_URL}/api/storage/runs/${reportId}?include=full`)).json();
    expect(full.trajectory).toHaveLength(1);
    expect(full.rawEvents).toHaveLength(1);
    expect(full.llmJudgeResponse.rawResponse).toBe('targeted raw judge response');

    const trajectory = await (await fetch(`${BASE_URL}/api/storage/runs/${reportId}?include=trajectory`)).json();
    expect(Object.keys(trajectory).sort()).toEqual(['id', 'trajectory']);

    const rawEvents = await (await fetch(`${BASE_URL}/api/storage/runs/${reportId}?include=rawEvents`)).json();
    expect(Object.keys(rawEvents).sort()).toEqual(['id', 'rawEvents']);

    const judgeRaw = await (await fetch(`${BASE_URL}/api/storage/runs/${reportId}?include=judgeRawResponse`)).json();
    expect(judgeRaw).toEqual({
      id: reportId,
      llmJudgeResponse: { rawResponse: 'targeted raw judge response' },
    });
  });
});
