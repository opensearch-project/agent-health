/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A SigV4 signing/credential failure must surface as a failed agent step with
 * a clear message — never as an unsigned request (and thus an opaque 403).
 */

jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn(),
}));
jest.mock('@/services/opensearch', () => ({
  openSearchClient: { fetchLogsForRun: jest.fn().mockResolvedValue([]) },
}));

const mockFromNodeProviderChain = jest.fn();
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: (...args: unknown[]) => mockFromNodeProviderChain(...args),
}));

import { runEvaluationWithConnector } from '@/services/evaluation';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import { clearSigV4ProviderCache } from '@/services/connectors/base/awsSigV4';
import type { AgentConfig, TestCase } from '@/types';

const testCase = {
  id: 'tc-sigv4-fail',
  name: 'sigv4 failure',
  initialPrompt: 'search products',
  context: 'ctx',
  expectedOutcomes: ['ok'],
  currentVersion: 1,
  labels: [],
  versions: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as TestCase;

describe('aws-sigv4 credential failure → failed report', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    clearSigV4ProviderCache();
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({}), headers: new Map() } as unknown as Response);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFromNodeProviderChain.mockReturnValue(
      jest.fn().mockRejectedValue(new Error('Could not load credentials from any providers'))
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports status=failed with the SigV4 reason and never sends the request', async () => {
    const connector = new RESTConnector();
    const registry = {
      getForAgent: jest.fn().mockReturnValue(connector),
      get: jest.fn(),
      getAll: jest.fn().mockReturnValue([connector]),
      has: jest.fn().mockReturnValue(true),
      register: jest.fn(),
    } as any;
    const agent = {
      key: 'sigv4-agent',
      name: 'SigV4 agent',
      endpoint: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke',
      connectorType: 'rest',
      auth: { type: 'aws-sigv4', awsRegion: 'us-west-2', awsService: 'execute-api', awsProfile: 'nonexistent-profile' },
    } as unknown as AgentConfig;

    const report = await runEvaluationWithConnector(agent, 'm', testCase, jest.fn(), { registry });

    expect(report.status).toBe('failed');
    expect(report.llmJudgeReasoning).toBe(
      'Evaluation failed: SigV4 signing failed: Could not load credentials from any providers (profile nonexistent-profile / region us-west-2 / service execute-api)'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
