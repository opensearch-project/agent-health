/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import type { AgentConfig, TestCase } from '@/types';
import type { ConnectorAuth } from '@/services/connectors';

// Mock dependencies before importing the module under test
jest.mock('@/services/agent', () => ({
  AGUIToTrajectoryConverter: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockReturnValue([]),
    getRunId: jest.fn().mockReturnValue(null),
  })),
  consumeSSEStream: jest.fn().mockResolvedValue(undefined),
  buildAgentPayload: jest.fn().mockReturnValue({ prompt: 'test' }),
}));

jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn().mockResolvedValue({
    passFailStatus: 'passed',
    metrics: {
      accuracy: 0.9,
      faithfulness: 0.85,
      latency_score: 0.8,
      trajectory_alignment_score: 0.75,
    },
    llmJudgeReasoning: 'Test reasoning',
    improvementStrategies: [],
  }),
}));

jest.mock('@/services/opensearch', () => ({
  openSearchClient: {
    fetchLogsForRun: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-auth'),
}));

jest.mock('@/lib/hooks', () => ({
  executeBeforeRequestHook: jest.fn().mockImplementation(async (_hooks, context) => context),
}));

/**
 * Tests for the private `buildConnectorAuth()` function inside
 * `services/evaluation/index.ts`.
 *
 * Since the function is not exported, we exercise it indirectly through
 * `runEvaluationWithConnector()` and capture what auth object is passed
 * to `connector.execute()`.
 */
describe('buildConnectorAuth (via runEvaluationWithConnector)', () => {
  const baseAgent: AgentConfig = {
    key: 'test-agent',
    name: 'Test Agent',
    endpoint: 'http://localhost:3000/agent',
    protocol: 'agui' as const,
    models: ['claude-3-sonnet'],
    type: 'langgraph',
    useTraces: true, // Use trace mode to skip the judge call
  };

  const mockTestCase: TestCase = {
    id: 'tc-auth-test',
    name: 'Auth Test Case',
    prompt: 'Test prompt',
    context: 'Test context',
    expectedOutcomes: ['Outcome 1'],
    currentVersion: 1,
    labels: [],
    versions: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  /** Creates a mock connector that captures the auth argument from execute(). */
  function createCapturingConnector() {
    let capturedAuth: ConnectorAuth | undefined;

    const connector = {
      type: 'mock',
      name: 'Mock Connector',
      supportsStreaming: false,
      buildPayload: jest.fn().mockReturnValue({ prompt: 'test' }),
      execute: jest.fn().mockImplementation(
        async (_endpoint: string, _request: any, auth: ConnectorAuth) => {
          capturedAuth = auth;
          return {
            trajectory: [{ type: 'response', content: 'Done', timestamp: new Date().toISOString() }],
            runId: 'auth-test-run',
            rawEvents: [],
          };
        }
      ),
      parseResponse: jest.fn().mockReturnValue([]),
    };

    const registry = {
      getForAgent: jest.fn().mockReturnValue(connector),
      get: jest.fn(),
      getAll: jest.fn().mockReturnValue([connector]),
      has: jest.fn().mockReturnValue(true),
      register: jest.fn(),
      getRegisteredTypes: jest.fn().mockReturnValue(['mock']),
      clear: jest.fn(),
    };

    return {
      connector,
      registry,
      getCapturedAuth: () => capturedAuth,
    };
  }

  let runEvaluationWithConnector: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Re-import to get a fresh module with cleared mocks
    jest.resetModules();
    const module = await import('@/services/evaluation');
    runEvaluationWithConnector = module.runEvaluationWithConnector;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── Test 1: Explicit bearer auth ─────────────────────────────────────────

  it('should pass explicit bearer auth to the connector', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      auth: { type: 'bearer', token: 'my-token' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('bearer');
    expect(auth!.token).toBe('my-token');
  });

  // ─── Test 2: Explicit api-key auth ────────────────────────────────────────

  it('should pass explicit api-key auth to the connector', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      auth: { type: 'api-key', token: 'my-api-key' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('api-key');
    expect(auth!.token).toBe('my-api-key');
  });

  // ─── Test 3: Explicit basic auth ──────────────────────────────────────────

  it('should pass explicit basic auth to the connector', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      auth: { type: 'basic', username: 'admin', password: 'secret' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('basic');
    expect(auth!.username).toBe('admin');
    expect(auth!.password).toBe('secret');
  });

  // ─── Test 4: auth.type 'none' falls through to header inference ───────────

  it('should fall through to header inference when auth.type is none', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      auth: { type: 'none' },
      headers: { Authorization: 'Bearer fallback-token' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    // Should infer bearer from headers, not use the 'none' auth
    expect(auth!.type).toBe('bearer');
    expect(auth!.token).toBe('fallback-token');
  });

  // ─── Test 5: No auth field + Bearer header => infers bearer ───────────────

  it('should infer bearer auth from Authorization header when no auth field', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      headers: { Authorization: 'Bearer inferred-bearer-token' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('bearer');
    expect(auth!.token).toBe('inferred-bearer-token');
  });

  // ─── Test 6: No auth field + Basic header => infers basic ─────────────────

  it('should infer basic auth from Authorization header when no auth field', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('basic');
    expect(auth!.token).toBe('dXNlcjpwYXNz');
  });

  // ─── Test 7: No auth field + x-api-key header => infers api-key ───────────

  it('should infer api-key auth from x-api-key header when no auth field', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      headers: { 'x-api-key': 'header-api-key-789' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('api-key');
    expect(auth!.token).toBe('header-api-key-789');
  });

  // ─── Test 8: No auth field + no headers => type 'none' ────────────────────

  it('should return type none when no auth field and no headers', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      // No auth, no headers
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('none');
    expect(auth!.headers).toEqual({});
  });

  // ─── Test 9: auth.headers merges with agent.headers ───────────────────────

  it('should merge auth.headers on top of agent.headers', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      headers: { 'X-Agent-Header': 'agent-value', 'X-Shared': 'from-agent' },
      auth: {
        type: 'bearer',
        token: 'merge-test-token',
        headers: { 'X-Auth-Header': 'auth-value', 'X-Shared': 'from-auth' },
      },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('bearer');
    expect(auth!.token).toBe('merge-test-token');
    // agent.headers merged with auth.headers; auth.headers wins on conflict
    expect(auth!.headers).toEqual({
      'X-Agent-Header': 'agent-value',
      'X-Auth-Header': 'auth-value',
      'X-Shared': 'from-auth',
    });
  });

  // ─── Test 10: No auth + custom headers => passes headers through as none ──

  it('should pass custom headers through with type none when no auth pattern matches', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      headers: { 'X-Custom': 'custom-value', 'X-Another': 'another-value' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('none');
    expect(auth!.headers).toEqual({
      'X-Custom': 'custom-value',
      'X-Another': 'another-value',
    });
  });

  // ─── Test 11: Explicit auth with no headers field ─────────────────────────

  it('should handle explicit auth when agent has no headers field', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      auth: { type: 'bearer', token: 'standalone-token' },
      // No headers property at all
    };
    delete agent.headers;

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('bearer');
    expect(auth!.token).toBe('standalone-token');
    // headers should be agent.headers (undefined) spread with auth.headers (undefined)
    // resulting in an empty-ish object
    expect(auth!.headers).toBeDefined();
  });

  // ─── Test 12: AWS SigV4 explicit auth ─────────────────────────────────────

  it('should pass explicit aws-sigv4 auth to the connector', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      auth: {
        type: 'aws-sigv4',
        awsRegion: 'us-east-1',
        awsService: 'execute-api',
      },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth).toBeDefined();
    expect(auth!.type).toBe('aws-sigv4');
    expect(auth!.awsRegion).toBe('us-east-1');
    expect(auth!.awsService).toBe('execute-api');
  });

  // ─── Test 13: Authorization header priority (Bearer over Basic) ───────────

  it('should check Bearer before Basic when inferring from Authorization header', async () => {
    // This tests the order of checks in the legacy path:
    // Bearer is checked first, so a "Bearer Basic..." would be bearer
    const agent: AgentConfig = {
      ...baseAgent,
      headers: { Authorization: 'Bearer some-token' },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth!.type).toBe('bearer');
    expect(auth!.token).toBe('some-token');
  });

  // ─── Test 14: Authorization + x-api-key headers (Authorization wins) ──────

  it('should prefer Authorization header over x-api-key when both present', async () => {
    const agent: AgentConfig = {
      ...baseAgent,
      headers: {
        Authorization: 'Bearer auth-wins',
        'x-api-key': 'ignored-key',
      },
    };

    const { registry, getCapturedAuth } = createCapturingConnector();

    await runEvaluationWithConnector(agent, 'claude-3-sonnet', mockTestCase, jest.fn(), {
      registry,
    });

    const auth = getCapturedAuth();
    expect(auth!.type).toBe('bearer');
    expect(auth!.token).toBe('auth-wins');
  });
});
