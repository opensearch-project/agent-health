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
const DEFAULT_AGENT_COUNT = 4;

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

  describe('Custom Agent Persistence', () => {
    const TEST_AGENT = {
      name: 'Integration Test Agent',
      endpoint: 'http://integration-test.example.com:9999',
    };

    const createdKeys: string[] = [];

    // Clean up after tests regardless of pass/fail
    afterAll(async () => {
      if (!backendAvailable) return;
      // Best-effort cleanup: delete all agents created during this suite
      for (const key of createdKeys) {
        try {
          await fetch(`${config.backendUrl}/api/agents/custom/${key}`, { method: 'DELETE' });
        } catch {
          // Ignore cleanup errors
        }
      }
      // Also delete by name in case key tracking missed one
      try {
        const response = await fetch(`${config.backendUrl}/api/agents`);
        const data = await response.json();
        const testAgent = data.agents.find(
          (a: { name: string }) => a.name === TEST_AGENT.name,
        );
        if (testAgent) {
          await fetch(`${config.backendUrl}/api/agents/custom/${testAgent.key}`, {
            method: 'DELETE',
          });
        }
      } catch {
        // Ignore cleanup errors
      }
    }, TEST_TIMEOUT);

    it(
      'should persist a custom agent through the full lifecycle',
      async () => {
        if (!backendAvailable) return;

        // 1. Create custom agent
        const createResponse = await fetch(`${config.backendUrl}/api/agents/custom`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(TEST_AGENT),
        });
        expect(createResponse.status).toBe(201);
        const createData = await createResponse.json();
        const created = createData.agent;
        expect(created).toHaveProperty('key');
        expect(created.name).toBe(TEST_AGENT.name);
        expect(created.endpoint).toBe(TEST_AGENT.endpoint);
        expect(created.isCustom).toBe(true);
        createdKeys.push(created.key);

        // 2. Verify it appears in the agents list
        const listResponse = await fetch(`${config.backendUrl}/api/agents`);
        const listData = await listResponse.json();
        const found = listData.agents.find(
          (a: { key: string }) => a.key === created.key,
        );
        expect(found).toBeDefined();
        expect(found.name).toBe(TEST_AGENT.name);

        // 3. Delete the agent
        const deleteResponse = await fetch(
          `${config.backendUrl}/api/agents/custom/${created.key}`,
          { method: 'DELETE' },
        );
        expect(deleteResponse.status).toBe(204);

        // 4. Verify it no longer appears
        const listAfterDelete = await fetch(`${config.backendUrl}/api/agents`);
        const dataAfterDelete = await listAfterDelete.json();
        const notFound = dataAfterDelete.agents.find(
          (a: { key: string }) => a.key === created.key,
        );
        expect(notFound).toBeUndefined();
      },
      TEST_TIMEOUT,
    );

    it(
      'should persist connectorType and useTraces fields',
      async () => {
        if (!backendAvailable) return;

        const createResponse = await fetch(`${config.backendUrl}/api/agents/custom`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Traced REST Agent (integration)',
            endpoint: 'http://integration-traced.example.com:9999',
            connectorType: 'rest',
            useTraces: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const createData = await createResponse.json();
        const created = createData.agent;
        expect(created.connectorType).toBe('rest');
        expect(created.useTraces).toBe(true);
        createdKeys.push(created.key);

        // Verify the fields are returned in the agents list
        const listResponse = await fetch(`${config.backendUrl}/api/agents`);
        const listData = await listResponse.json();
        const found = listData.agents.find((a: { key: string }) => a.key === created.key);
        expect(found).toBeDefined();
        expect(found.connectorType).toBe('rest');
        expect(found.useTraces).toBe(true);

        // Cleanup
        await fetch(`${config.backendUrl}/api/agents/custom/${created.key}`, { method: 'DELETE' });
      },
      TEST_TIMEOUT,
    );

    it(
      'should default connectorType to agui-streaming and useTraces to false',
      async () => {
        if (!backendAvailable) return;

        const createResponse = await fetch(`${config.backendUrl}/api/agents/custom`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Default Connector Agent (integration)',
            endpoint: 'http://integration-default.example.com:9999',
          }),
        });
        expect(createResponse.status).toBe(201);
        const createData = await createResponse.json();
        const created = createData.agent;
        expect(created.connectorType).toBe('agui-streaming');
        expect(created.useTraces).toBe(false);
        createdKeys.push(created.key);

        // Cleanup
        await fetch(`${config.backendUrl}/api/agents/custom/${created.key}`, { method: 'DELETE' });
      },
      TEST_TIMEOUT,
    );

    it(
      'should return 400 for an invalid connectorType',
      async () => {
        if (!backendAvailable) return;

        const createResponse = await fetch(`${config.backendUrl}/api/agents/custom`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Bad Connector Agent',
            endpoint: 'http://integration-bad.example.com:9999',
            connectorType: 'not-a-real-connector',
          }),
        });
        expect(createResponse.status).toBe(400);
        const data = await createResponse.json();
        expect(data.error).toMatch(/connectorType must be one of/);
      },
      TEST_TIMEOUT,
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
