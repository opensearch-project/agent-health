/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for config endpoints (/api/agents, /api/models)
 *
 * These tests verify that:
 * 1. The server loads config so /api/agents returns populated data (not empty defaults)
 * 2. /api/agents returns at least the default agents
 * 3. /api/models returns at least the default models
 * 4. The response structure matches the expected contract
 *
 * Run tests:
 *   npm run test:integration -- --testPathPattern=config.integration
 *
 * Prerequisites:
 *   - Backend server running: npm run dev:server
 */

const TEST_TIMEOUT = 30000;

/**
 * Number of agents in DEFAULT_CONFIG (lib/constants.ts).
 * If the defaults change, update this constant.
 */
const DEFAULT_AGENT_COUNT = 5;

/**
 * Minimum number of models in DEFAULT_CONFIG.
 */
const MIN_DEFAULT_MODEL_COUNT = 3;

// Test configuration
const getTestConfig = () => ({
  backendUrl: process.env.TEST_BACKEND_URL || 'http://localhost:4001',
});

// Helper to check if backend is available
const checkBackend = async (backendUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${backendUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('Config Endpoints Integration Tests', () => {
  let backendAvailable = false;
  let config: ReturnType<typeof getTestConfig>;

  beforeAll(async () => {
    config = getTestConfig();
    backendAvailable = await checkBackend(config.backendUrl);
    if (!backendAvailable) {
      console.warn(
        'Backend not available at',
        config.backendUrl,
        '- skipping integration tests'
      );
    }
  }, TEST_TIMEOUT);

  describe('GET /api/agents', () => {
    it(
      'should return 200 with agents array',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/agents`);

        expect(response.ok).toBe(true);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data).toHaveProperty('agents');
        expect(data).toHaveProperty('total');
        expect(Array.isArray(data.agents)).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      'should return at least the default agents (config was loaded by createApp)',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/agents`);
        const data = await response.json();

        // The critical assertion: createApp() must have called loadConfig()
        // so that route handlers have access to the full config, not empty defaults.
        // With the module cache isolation bug, loadConfigSync() in routes would
        // return defaults because loadConfig() was called in a different bundle.
        expect(data.total).toBeGreaterThanOrEqual(DEFAULT_AGENT_COUNT);
        expect(data.agents.length).toBe(data.total);
      },
      TEST_TIMEOUT
    );

    it(
      'should include expected agent fields',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/agents`);
        const data = await response.json();

        for (const agent of data.agents) {
          expect(agent).toHaveProperty('key');
          expect(agent).toHaveProperty('name');
          expect(agent).toHaveProperty('endpoint');
          expect(typeof agent.key).toBe('string');
          expect(typeof agent.name).toBe('string');
        }
      },
      TEST_TIMEOUT
    );

    it(
      'should include the demo agent from defaults',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/agents`);
        const data = await response.json();

        const demoAgent = data.agents.find(
          (a: { key: string }) => a.key === 'demo'
        );
        expect(demoAgent).toBeDefined();
        expect(demoAgent.name).toBe('Demo Agent');
      },
      TEST_TIMEOUT
    );

    it(
      'should include meta.source field',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/agents`);
        const data = await response.json();

        expect(data.meta).toBeDefined();
        expect(data.meta.source).toBe('config');
      },
      TEST_TIMEOUT
    );

    it(
      'should not expose hooks in agent response (functions are not serializable)',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/agents`);
        const data = await response.json();

        for (const agent of data.agents) {
          expect(agent).not.toHaveProperty('hooks');
        }
      },
      TEST_TIMEOUT
    );

    it(
      'should be idempotent across multiple requests',
      async () => {
        if (!backendAvailable) return;

        const [r1, r2] = await Promise.all([
          fetch(`${config.backendUrl}/api/agents`).then((r) => r.json()),
          fetch(`${config.backendUrl}/api/agents`).then((r) => r.json()),
        ]);

        expect(r1.total).toBe(r2.total);
        expect(r1.agents.map((a: { key: string }) => a.key).sort()).toEqual(
          r2.agents.map((a: { key: string }) => a.key).sort()
        );
      },
      TEST_TIMEOUT
    );
  });

  describe('GET /api/models', () => {
    it(
      'should return 200 with models array',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/models`);

        expect(response.ok).toBe(true);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data).toHaveProperty('models');
        expect(data).toHaveProperty('total');
        expect(Array.isArray(data.models)).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      'should return at least the default models (config was loaded by createApp)',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/models`);
        const data = await response.json();

        expect(data.total).toBeGreaterThanOrEqual(MIN_DEFAULT_MODEL_COUNT);
        expect(data.models.length).toBe(data.total);
      },
      TEST_TIMEOUT
    );

    it(
      'should include expected model fields',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/api/models`);
        const data = await response.json();

        for (const model of data.models) {
          expect(model).toHaveProperty('key');
          expect(model).toHaveProperty('model_id');
          expect(model).toHaveProperty('display_name');
          expect(typeof model.key).toBe('string');
        }
      },
      TEST_TIMEOUT
    );
  });
});
