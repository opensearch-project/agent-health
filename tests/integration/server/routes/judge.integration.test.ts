/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the /api/judge endpoint
 *
 * Tests the POST /api/judge endpoint which evaluates agent trajectories
 * against expected outcomes using an LLM judge.
 *
 * These tests use the built-in 'demo-model' (demo provider) so that no real
 * AWS Bedrock credentials or external services are required.
 *
 * Requirements:
 *   - Backend server running: npm run dev:server
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=judge.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Build a sample trajectory with tool calls and a response step.
 */
function buildSampleTrajectory() {
  return [
    {
      type: 'thinking',
      content: 'I need to investigate the cluster health to identify the root cause.',
    },
    {
      type: 'action',
      toolName: 'get_cluster_health',
      toolArgs: { cluster: 'production' },
      content: 'Calling get_cluster_health tool',
    },
    {
      type: 'tool_result',
      toolName: 'get_cluster_health',
      content: '{"status": "yellow", "active_shards": 150, "unassigned_shards": 3}',
      status: 'SUCCESS',
    },
    {
      type: 'response',
      content: 'The root cause of the issue is 3 unassigned shards causing the cluster to be in yellow state.',
    },
  ];
}

/**
 * Build a minimal trajectory (single step).
 */
function buildMinimalTrajectory() {
  return [
    {
      type: 'response',
      content: 'The cluster is healthy.',
    },
  ];
}

describe('Judge Route Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(
        'Backend not available at',
        BASE_URL,
        '- skipping judge route integration tests'
      );
    }
  }, TEST_TIMEOUT);

  // ---------------------------------------------------------------------------
  // Request Validation
  // ---------------------------------------------------------------------------

  describe('POST /api/judge - request validation', () => {
    it(
      'should return 400 when trajectory is missing',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toMatch(/[Tt]rajectory/);
        expect(data.error).toMatch(/required/i);
      },
      TEST_TIMEOUT
    );

    it(
      'should return 400 when trajectory is an empty array',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: [],
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toMatch(/[Tt]rajectory/);
        expect(data.error).toMatch(/non-empty/i);
      },
      TEST_TIMEOUT
    );

    it(
      'should return 400 when trajectory is not an array',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: 'not-an-array',
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toMatch(/[Tt]rajectory/);
      },
      TEST_TIMEOUT
    );

    it(
      'should return 400 when both expectedOutcomes and expectedTrajectory are missing',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toMatch(/expectedOutcomes|expectedTrajectory/);
      },
      TEST_TIMEOUT
    );

    it(
      'should return 400 when expectedOutcomes is an empty array and expectedTrajectory is missing',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: [],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toMatch(/expectedOutcomes|expectedTrajectory/);
      },
      TEST_TIMEOUT
    );

    it(
      'should return 400 when evaluatorId refers to a non-existent evaluator',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'demo-model',
            evaluatorId: 'nonexistent-evaluator-xyz-999',
          }),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toMatch(/[Ee]valuator.*not found/);
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Successful Evaluation (demo provider - no external calls)
  // ---------------------------------------------------------------------------

  describe('POST /api/judge - successful evaluation with demo provider', () => {
    it(
      'should return 200 with evaluation result containing passFailStatus',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify unassigned shards as root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.passFailStatus).toBeDefined();
        expect(['passed', 'failed']).toContain(data.passFailStatus);
      },
      TEST_TIMEOUT
    );

    it(
      'should return metrics including accuracy',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify unassigned shards as root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.metrics).toBeDefined();
        expect(typeof data.metrics.accuracy).toBe('number');
        expect(data.metrics.accuracy).toBeGreaterThanOrEqual(0);
        expect(data.metrics.accuracy).toBeLessThanOrEqual(100);
      },
      TEST_TIMEOUT
    );

    it(
      'should return llmJudgeReasoning as a string',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify unassigned shards as root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        expect(typeof data.llmJudgeReasoning).toBe('string');
        expect(data.llmJudgeReasoning.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT
    );

    it(
      'should return improvementStrategies as an array',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify unassigned shards as root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        expect(Array.isArray(data.improvementStrategies)).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      'should return metrics with faithfulness, latency_score, and trajectory_alignment_score',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify unassigned shards as root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        expect(typeof data.metrics.faithfulness).toBe('number');
        expect(typeof data.metrics.latency_score).toBe('number');
        expect(typeof data.metrics.trajectory_alignment_score).toBe('number');
      },
      TEST_TIMEOUT
    );

    it(
      'should accept expectedTrajectory instead of expectedOutcomes',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedTrajectory: [
              { type: 'action', toolName: 'get_cluster_health' },
              { type: 'response', content: 'unassigned shards' },
            ],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.passFailStatus).toBeDefined();
        expect(['passed', 'failed']).toContain(data.passFailStatus);
        expect(data.metrics).toBeDefined();
      },
      TEST_TIMEOUT
    );

    it(
      'should work with minimal trajectory (single step)',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildMinimalTrajectory(),
            expectedOutcomes: ['Agent should check cluster health'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.passFailStatus).toBeDefined();
        expect(data.metrics).toBeDefined();
        expect(data.llmJudgeReasoning).toBeDefined();
      },
      TEST_TIMEOUT
    );

    it(
      'should include mock evaluation note in reasoning for demo provider',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        // Demo provider includes a note about mock/simulated evaluation
        expect(data.llmJudgeReasoning).toMatch(/[Mm]ock|simulated|demo/);
      },
      TEST_TIMEOUT
    );

    it(
      'should loudly flag the mock judge: structured warning field + banner at the TOP of reasoning',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        // 1) A structured, machine-readable warning a real judge never sets.
        expect(typeof data.warning).toBe('string');
        expect(data.warning).toMatch(/MOCK_JUDGE/);

        // 2) The banner is at the TOP of the reasoning (not a footnote that's
        //    easy to miss) — this is the regression guard for the WebIR
        //    "100% pass" confusion.
        expect(data.llmJudgeReasoning).toMatch(/^\s*⚠\uFE0F?\s*\*\*MOCK JUDGE/);
        expect(data.llmJudgeReasoning.indexOf('MOCK JUDGE')).toBeLessThan(
          data.llmJudgeReasoning.indexOf('Mock Evaluation Result')
        );
      },
      TEST_TIMEOUT
    );

    it(
      'should accept optional logs field without error',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'demo-model',
            logs: [
              { timestamp: '2024-01-01T00:00:00Z', message: 'Error: connection timeout' },
            ],
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.passFailStatus).toBeDefined();
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Response format validation
  // ---------------------------------------------------------------------------

  describe('POST /api/judge - response format', () => {
    it(
      'should return a complete evaluation result with all expected fields',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: [
              'Agent should use diagnostic tools',
              'Agent should identify unassigned shards',
            ],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        // Top-level fields
        expect(data).toHaveProperty('passFailStatus');
        expect(data).toHaveProperty('metrics');
        expect(data).toHaveProperty('llmJudgeReasoning');
        expect(data).toHaveProperty('improvementStrategies');

        // passFailStatus is a valid value
        expect(['passed', 'failed']).toContain(data.passFailStatus);

        // metrics is an object with numeric values
        expect(typeof data.metrics).toBe('object');
        expect(typeof data.metrics.accuracy).toBe('number');

        // llmJudgeReasoning is a non-empty string
        expect(typeof data.llmJudgeReasoning).toBe('string');
        expect(data.llmJudgeReasoning.length).toBeGreaterThan(0);

        // improvementStrategies is an array
        expect(Array.isArray(data.improvementStrategies)).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      'should return improvement strategies with correct structure when evaluation fails',
      async () => {
        if (!backendAvailable) return;

        // Use a trajectory without tool calls to increase chance of "failed" result
        const weakTrajectory = [
          {
            type: 'response',
            content: 'I think the issue might be something.',
          },
        ];

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: weakTrajectory,
            expectedOutcomes: [
              'Agent should use multiple diagnostic tools',
              'Agent should identify specific root cause with evidence',
              'Agent should provide detailed remediation steps',
            ],
            modelId: 'demo-model',
          }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();

        // Whether passed or failed, improvementStrategies should be a valid array
        expect(Array.isArray(data.improvementStrategies)).toBe(true);

        // If there are strategies, verify their structure
        if (data.improvementStrategies.length > 0) {
          const strategy = data.improvementStrategies[0];
          expect(strategy).toHaveProperty('category');
          expect(strategy).toHaveProperty('issue');
          expect(strategy).toHaveProperty('recommendation');
          expect(strategy).toHaveProperty('priority');
          expect(['high', 'medium', 'low']).toContain(strategy.priority);
        }
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('POST /api/judge - error handling', () => {
    it(
      'should return 500 when an unknown modelId with bedrock provider is used (no credentials)',
      async () => {
        if (!backendAvailable) return;

        // This will try to call Bedrock with an unknown model, which should fail
        // unless the test environment has AWS credentials configured
        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: buildSampleTrajectory(),
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'nonexistent-model-id-xyz',
          }),
        });

        // Should either be 500 (bedrock failure) or 200 (if somehow it resolves to demo)
        // The key is it doesn't crash the server
        expect([200, 500]).toContain(response.status);

        if (response.status === 500) {
          const data = await response.json();
          expect(data.error).toBeDefined();
          expect(typeof data.error).toBe('string');
          expect(data.error).toMatch(/[Jj]udge evaluation failed/);
        }
      },
      TEST_TIMEOUT
    );

    it(
      'should handle malformed JSON body gracefully',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/judge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json {{{',
        });

        // Express JSON parser returns 400 for malformed JSON
        expect(response.status).toBe(400);
      },
      TEST_TIMEOUT
    );
  });
});
