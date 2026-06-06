/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the offline pieces of failureClusterService — fingerprinting,
 * cache hit, marker extraction, schema rejection. The Bedrock call itself
 * is mocked so these tests don't require AWS credentials.
 */

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => sendMock(...args),
  })),
  ConverseCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import {
  clusterFailures,
  getClusterById,
  clusterId,
  _resetClusterCache,
} from '@/server/services/failureClusterService';

const buildResponse = (text: string) => ({
  output: { message: { content: [{ text }] } },
  $metadata: { attempts: 1 },
});

const validJson = `CLUSTERS_JSON_START
{
  "clusters": [
    {
      "name": "Wrong region shortcode",
      "summary": "Agent uses full region instead of airport code.",
      "caseIds": ["cp-1", "cp-2"],
      "exampleEvidence": "called with us-east-1 not iad",
      "clusterType": "knowledge"
    }
  ]
}
CLUSTERS_JSON_END`;

describe('failureClusterService', () => {
  beforeEach(() => {
    sendMock.mockReset();
    _resetClusterCache();
  });

  it('parses a valid clustered response and filters case IDs to the input set', async () => {
    sendMock.mockResolvedValue(buildResponse(validJson));

    const result = await clusterFailures({
      loserLabel: 'Claude',
      winnerLabel: 'Kiro',
      cases: [
        { caseId: 'cp-1', judgeReasoning: 'wrong region' },
        { caseId: 'cp-2', judgeReasoning: 'wrong region' },
      ],
    });

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].name).toBe('Wrong region shortcode');
    expect(result.clusters[0].caseIds).toEqual(['cp-1', 'cp-2']);
    expect(result.totalFailures).toBe(2);
  });

  it('drops case IDs that were not in the input', async () => {
    sendMock.mockResolvedValue(
      buildResponse(`CLUSTERS_JSON_START
{ "clusters": [{
  "name": "x", "summary": "y",
  "caseIds": ["cp-1", "made-up-id"],
  "clusterType": "other"
}] }
CLUSTERS_JSON_END`)
    );

    const result = await clusterFailures({
      loserLabel: 'a',
      winnerLabel: 'b',
      cases: [{ caseId: 'cp-1' }],
    });

    expect(result.clusters[0].caseIds).toEqual(['cp-1']);
  });

  it('returns empty clusters when input has no cases without calling the model', async () => {
    const result = await clusterFailures({
      loserLabel: 'a',
      winnerLabel: 'b',
      cases: [],
    });
    expect(result).toEqual({ clusters: [], totalFailures: 0, modelId: expect.any(String) });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('caches identical inputs — second call does not hit Bedrock', async () => {
    sendMock.mockResolvedValue(buildResponse(validJson));

    const input = {
      loserLabel: 'Claude',
      winnerLabel: 'Kiro',
      cases: [
        { caseId: 'cp-1', judgeReasoning: 'wrong region' },
        { caseId: 'cp-2', judgeReasoning: 'wrong region' },
      ],
    };

    await clusterFailures(input);
    await clusterFailures(input);

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('force=true bypasses cache', async () => {
    sendMock.mockResolvedValue(buildResponse(validJson));

    const input = {
      loserLabel: 'Claude',
      winnerLabel: 'Kiro',
      cases: [{ caseId: 'cp-1', judgeReasoning: 'foo' }],
    };

    await clusterFailures(input);
    await clusterFailures(input, { force: true });

    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('throws when LLM omits the JSON markers', async () => {
    sendMock.mockResolvedValue(buildResponse('here are the clusters but no markers'));

    await expect(
      clusterFailures({
        loserLabel: 'a',
        winnerLabel: 'b',
        cases: [{ caseId: 'cp-1' }],
      })
    ).rejects.toThrow(/CLUSTERS_JSON_START/);
  });

  it('throws when JSON between markers is malformed', async () => {
    sendMock.mockResolvedValue(
      buildResponse('CLUSTERS_JSON_START\n{ not json\nCLUSTERS_JSON_END')
    );

    await expect(
      clusterFailures({
        loserLabel: 'a',
        winnerLabel: 'b',
        cases: [{ caseId: 'cp-1' }],
      })
    ).rejects.toThrow(/invalid JSON/);
  });

  it('coerces unknown clusterType values to "other"', async () => {
    sendMock.mockResolvedValue(
      buildResponse(`CLUSTERS_JSON_START
{ "clusters": [{
  "name": "x", "summary": "y",
  "caseIds": ["cp-1"],
  "clusterType": "totally-made-up"
}] }
CLUSTERS_JSON_END`)
    );

    const result = await clusterFailures({
      loserLabel: 'a',
      winnerLabel: 'b',
      cases: [{ caseId: 'cp-1' }],
    });

    expect(result.clusters[0].clusterType).toBe('other');
  });

  it('exposes returned clusters via getClusterById and assigns stable ids', async () => {
    sendMock.mockResolvedValue(buildResponse(validJson));

    const result = await clusterFailures({
      loserLabel: 'Claude',
      winnerLabel: 'Kiro',
      cases: [
        { caseId: 'cp-1', judgeReasoning: 'wrong region' },
        { caseId: 'cp-2', judgeReasoning: 'wrong region' },
      ],
    });

    expect(result.clusters[0].id).toBeTruthy();
    const expectedId = clusterId(result.clusters[0]);
    expect(result.clusters[0].id).toBe(expectedId);

    const fetched = getClusterById(result.clusters[0].id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('Wrong region shortcode');
    expect(fetched!.caseIds).toEqual(['cp-1', 'cp-2']);
    expect(fetched!.loserLabel).toBe('Claude');
    expect(fetched!.winnerLabel).toBe('Kiro');
  });

  it('returns undefined from getClusterById for unknown ids', () => {
    expect(getClusterById('c-doesnotexist')).toBeUndefined();
  });

  it('skips clusters that reference no valid case IDs', async () => {
    sendMock.mockResolvedValue(
      buildResponse(`CLUSTERS_JSON_START
{ "clusters": [
  { "name": "good", "summary": "ok", "caseIds": ["cp-1"], "clusterType": "knowledge" },
  { "name": "ghost", "summary": "x", "caseIds": ["nope"], "clusterType": "knowledge" }
] }
CLUSTERS_JSON_END`)
    );

    const result = await clusterFailures({
      loserLabel: 'a',
      winnerLabel: 'b',
      cases: [{ caseId: 'cp-1' }],
    });

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].name).toBe('good');
  });
});
