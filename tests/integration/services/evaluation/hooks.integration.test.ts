/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for agent lifecycle hooks (beforeRequest, afterResponse)
 *
 * Tests the hooks end-to-end through the connector evaluation pipeline.
 * Uses the MockConnector with injected hooks to verify:
 *   - afterResponse hook is called with correct context (rawEvents, metadata)
 *   - afterResponse hook can modify trajectory and runId
 *   - afterResponse hook errors are surfaced (not silently swallowed)
 *   - beforeRequest + afterResponse work together in a full flow
 *
 * These tests do NOT require a running server or OpenSearch — they test the
 * evaluation service directly with mocked connectors.
 */

import { runEvaluationWithConnector } from '@/services/evaluation';
import type { AgentConfig, TestCase, TrajectoryStep, AfterResponseContext, BeforeRequestContext } from '@/types';
import type { ConnectorRegistry } from '@/connectors/types';

// Mock the Bedrock judge to avoid real API calls and retries
jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn().mockResolvedValue({
    passFailStatus: 'passed',
    metrics: { accuracy: 1, faithfulness: 1, latency_score: 1, trajectory_alignment_score: 1 },
    llmJudgeReasoning: 'Mock judge: passed',
    improvementStrategies: [],
  }),
}));

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function createMockTestCase(id = 'test-hook-tc'): TestCase {
  const now = new Date().toISOString();
  return {
    id,
    name: 'Hook Test Case',
    description: 'Tests lifecycle hooks',
    labels: ['category:Test'],
    currentVersion: 1,
    versions: [{
      version: 1,
      createdAt: now,
      initialPrompt: 'Test prompt for hooks',
      context: [],
      expectedOutcomes: ['Agent responds'],
    }],
    isPromoted: false,
    createdAt: now,
    updatedAt: now,
    initialPrompt: 'Test prompt for hooks',
    context: [],
    expectedOutcomes: ['Agent responds'],
  };
}

function createMockConnector(overrides: Partial<{
  trajectory: TrajectoryStep[];
  runId: string | null;
  rawEvents: any[];
  metadata: Record<string, any>;
}> = {}) {
  const defaultTrajectory: TrajectoryStep[] = [
    { id: 'step-1', timestamp: Date.now(), type: 'thinking', content: 'Processing...' },
    { id: 'step-2', timestamp: Date.now(), type: 'response', content: 'Done.' },
  ];

  return {
    type: 'mock',
    name: 'Mock Connector',
    supportsStreaming: false,
    buildPayload: jest.fn().mockReturnValue({ prompt: 'test' }),
    execute: jest.fn().mockResolvedValue({
      trajectory: overrides.trajectory ?? defaultTrajectory,
      runId: overrides.runId ?? 'mock-run-123',
      rawEvents: overrides.rawEvents ?? [{ type: 'response', body: { memory_id: 'mem-456' } }],
      metadata: overrides.metadata ?? { threadId: 'thread-789', sessionId: 'sess-abc' },
    }),
    parseResponse: jest.fn().mockReturnValue([]),
  };
}

function createMockRegistry(connector: any): ConnectorRegistry {
  return {
    register: jest.fn(),
    get: jest.fn().mockReturnValue(connector),
    getAll: jest.fn().mockReturnValue([connector]),
    has: jest.fn().mockReturnValue(true),
    getForAgent: jest.fn().mockReturnValue(connector),
    getRegisteredTypes: jest.fn().mockReturnValue(['mock']),
    clear: jest.fn(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Agent Lifecycle Hooks - Integration', () => {
  // Suppress console.error noise from expected errors in tests
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('afterResponse hook', () => {
    it('should receive full context including rawEvents and metadata', async () => {
      const hookFn = jest.fn(async (ctx: AfterResponseContext) => ctx);

      const agent: AgentConfig = {
        key: 'hook-test-agent',
        name: 'Hook Test Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const rawEvents = [
        { type: 'start', id: 'evt-1' },
        { type: 'response', body: { memory_id: 'mem-999' } },
      ];
      const metadata = { threadId: 'thr-123', customField: 'hello' };
      const connector = createMockConnector({ rawEvents, metadata });
      const registry = createMockRegistry(connector);

      await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(hookFn).toHaveBeenCalledTimes(1);
      const ctx = hookFn.mock.calls[0][0] as AfterResponseContext;

      // Should receive the LAST raw event (most likely to contain response data)
      expect(ctx.response).toEqual({ type: 'response', body: { memory_id: 'mem-999' } });

      // Should receive full rawEvents array
      expect(ctx.rawEvents).toEqual(rawEvents);
      expect(ctx.rawEvents).toHaveLength(2);

      // Should receive metadata from connector
      expect(ctx.metadata).toEqual(metadata);

      // Should have trajectory and runId
      expect(ctx.trajectory).toHaveLength(2);
      expect(ctx.runId).toBe('mock-run-123');
    });

    it('should receive metadata as response fallback when rawEvents is empty', async () => {
      const hookFn = jest.fn(async (ctx: AfterResponseContext) => ctx);

      const agent: AgentConfig = {
        key: 'no-events-agent',
        name: 'No Events Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const metadata = { sessionId: 'sess-fallback', agentId: 'ag-1' };
      const connector = createMockConnector({ rawEvents: [], metadata });
      const registry = createMockRegistry(connector);

      await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      const ctx = hookFn.mock.calls[0][0] as AfterResponseContext;

      // Should fall back to metadata when rawEvents is empty
      expect(ctx.response).toEqual(metadata);
      expect(ctx.rawEvents).toEqual([]);
      expect(ctx.metadata).toEqual(metadata);
    });

    it('should allow hook to modify runId', async () => {
      const hookFn = jest.fn(async (ctx: AfterResponseContext) => ({
        ...ctx,
        runId: 'custom-extracted-id',
      }));

      const agent: AgentConfig = {
        key: 'runid-hook-agent',
        name: 'RunId Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const connector = createMockConnector({ runId: 'original-id' });
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      // The hook-modified runId should be used
      expect(result.runId).toBe('custom-extracted-id');
    });

    it('should allow hook to modify trajectory', async () => {
      const customTrajectory: TrajectoryStep[] = [
        { id: 'custom-1', timestamp: Date.now(), type: 'response', content: 'Modified by hook' },
      ];

      const hookFn = jest.fn(async (ctx: AfterResponseContext) => ({
        ...ctx,
        trajectory: customTrajectory,
      }));

      const agent: AgentConfig = {
        key: 'traj-hook-agent',
        name: 'Trajectory Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(result.trajectory).toEqual(customTrajectory);
    });

    it('should surface hook errors instead of silently swallowing them', async () => {
      const hookFn = jest.fn(async () => {
        throw new Error('Cannot extract memory_id: field is missing');
      });

      const agent: AgentConfig = {
        key: 'error-hook-agent',
        name: 'Error Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      // Error should be surfaced in the report
      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('Cannot extract memory_id');
    });

    it('should log error details when hook fails', async () => {
      const hookFn = jest.fn(async () => {
        throw new Error('Connection refused');
      });

      const agent: AgentConfig = {
        key: 'logged-error-agent',
        name: 'Logged Error Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('afterResponse hook failed for agent "logged-error-agent"'),
        expect.stringContaining('Connection refused')
      );
    });

    it('should not call afterResponse hook when hooks is undefined', async () => {
      const agent: AgentConfig = {
        key: 'no-hook-agent',
        name: 'No Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        // No hooks defined
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      // Should succeed without hooks
      expect(result.status).toBe('completed');
      expect(result.trajectory).toHaveLength(2);
    });

    it('should not call afterResponse when only beforeRequest is defined', async () => {
      const beforeHook = jest.fn(async (ctx: BeforeRequestContext) => ctx);

      const agent: AgentConfig = {
        key: 'before-only-agent',
        name: 'Before Only Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { beforeRequest: beforeHook },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(beforeHook).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('completed');
    });
  });

  describe('beforeRequest + afterResponse combined', () => {
    it('should execute both hooks in sequence', async () => {
      const callOrder: string[] = [];

      const beforeHook = jest.fn(async (ctx: BeforeRequestContext) => {
        callOrder.push('before');
        return { ...ctx, endpoint: 'http://modified.endpoint/agent' };
      });

      const afterHook = jest.fn(async (ctx: AfterResponseContext) => {
        callOrder.push('after');
        return { ...ctx, runId: 'hook-extracted-id' };
      });

      const agent: AgentConfig = {
        key: 'combined-hook-agent',
        name: 'Combined Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: {
          beforeRequest: beforeHook,
          afterResponse: afterHook,
        },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      // Both hooks called in order
      expect(callOrder).toEqual(['before', 'after']);
      expect(beforeHook).toHaveBeenCalledTimes(1);
      expect(afterHook).toHaveBeenCalledTimes(1);

      // afterResponse modifications applied
      expect(result.runId).toBe('hook-extracted-id');

      // beforeRequest endpoint modification was passed to connector
      expect(connector.execute).toHaveBeenCalledWith(
        'http://modified.endpoint/agent',
        expect.any(Object),
        expect.any(Object),
        expect.any(Function),
        undefined
      );
    });

    it('should not call afterResponse if beforeRequest throws', async () => {
      const afterHook = jest.fn(async (ctx: AfterResponseContext) => ctx);

      const agent: AgentConfig = {
        key: 'before-fails-agent',
        name: 'Before Fails Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: {
          beforeRequest: async () => { throw new Error('Auth token expired'); },
          afterResponse: afterHook,
        },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      // beforeRequest failure should prevent afterResponse from running
      expect(afterHook).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('Auth token expired');
    });
  });

  describe('afterResponse hook validation', () => {
    it('should fail when hook returns null', async () => {
      const agent: AgentConfig = {
        key: 'null-return-agent',
        name: 'Null Return Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: jest.fn().mockResolvedValue(null) },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('afterResponse hook');
    });

    it('should fail when hook returns object without trajectory array', async () => {
      const agent: AgentConfig = {
        key: 'bad-return-agent',
        name: 'Bad Return Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: {
          afterResponse: jest.fn().mockResolvedValue({
            response: {},
            trajectory: 'not-an-array',
            runId: 'id',
          }),
        },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('trajectory');
    });

    it('should fail when hook returns object without response field', async () => {
      const agent: AgentConfig = {
        key: 'no-response-agent',
        name: 'No Response Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: {
          afterResponse: jest.fn().mockResolvedValue({
            trajectory: [],
            runId: 'id',
          }),
        },
      };

      const connector = createMockConnector();
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('response');
    });
  });

  describe('connector-specific afterResponse scenarios', () => {
    it('should work with AG-UI streaming connector (many rawEvents)', async () => {
      // AG-UI streaming produces many SSE events, last one has the useful data
      const rawEvents = [
        { type: 'RUN_STARTED', runId: 'agui-run-1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'msg-1' },
        { type: 'TEXT_MESSAGE_CONTENT', content: 'Hello' },
        { type: 'TEXT_MESSAGE_END' },
        { type: 'RUN_FINISHED', runId: 'agui-run-1', threadId: 'thread-final' },
      ];

      const hookFn = jest.fn(async (ctx: AfterResponseContext) => {
        // Extract threadId from the last event
        const lastEvent = ctx.rawEvents?.[ctx.rawEvents.length - 1];
        return {
          ...ctx,
          runId: lastEvent?.threadId || ctx.runId,
        };
      });

      const agent: AgentConfig = {
        key: 'agui-hook-agent',
        name: 'AG-UI Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const connector = createMockConnector({ rawEvents });
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(result.runId).toBe('thread-final');
    });

    it('should work with connectors that return no rawEvents (Strands-like)', async () => {
      const metadata = { agentId: 'strands-123', sessionId: 'sess-strands' };

      const hookFn = jest.fn(async (ctx: AfterResponseContext) => {
        // Use metadata when rawEvents is empty
        return {
          ...ctx,
          runId: ctx.metadata?.sessionId || ctx.runId,
        };
      });

      const agent: AgentConfig = {
        key: 'strands-hook-agent',
        name: 'Strands Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      // Simulate Strands connector: no rawEvents, only metadata
      // Build the connector manually to avoid createMockConnector defaults
      const connector = {
        type: 'mock',
        name: 'Mock Strands',
        supportsStreaming: false,
        buildPayload: jest.fn().mockReturnValue({ prompt: 'test' }),
        execute: jest.fn().mockResolvedValue({
          trajectory: [
            { id: 'step-1', timestamp: Date.now(), type: 'response', content: 'Done.' },
          ],
          runId: 'strands-run',
          // No rawEvents field — simulates Strands connector
          metadata,
        }),
        parseResponse: jest.fn().mockReturnValue([]),
      };
      const registry = createMockRegistry(connector);

      await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      const ctx = hookFn.mock.calls[0][0] as AfterResponseContext;
      // response should fall back to metadata when rawEvents is undefined
      expect(ctx.response).toEqual(metadata);
      expect(ctx.rawEvents).toEqual([]);
      expect(ctx.metadata).toEqual(metadata);
    });

    it('should work with REST connector (single rawEvent with full response)', async () => {
      const rawEvents = [{
        status: 'success',
        run_id: 'rest-run-456',
        data: { answer: 'The cluster is healthy', memory_id: 'mem-789' },
      }];

      const hookFn = jest.fn(async (ctx: AfterResponseContext) => {
        // Extract memory_id from REST response
        const resp = ctx.response;
        return {
          ...ctx,
          runId: resp?.data?.memory_id || ctx.runId,
        };
      });

      const agent: AgentConfig = {
        key: 'rest-hook-agent',
        name: 'REST Hook Agent',
        endpoint: 'mock://test',
        connectorType: 'mock',
        hooks: { afterResponse: hookFn },
      };

      const connector = createMockConnector({ rawEvents });
      const registry = createMockRegistry(connector);

      const result = await runEvaluationWithConnector(
        agent,
        'test-model',
        createMockTestCase(),
        () => {},
        { registry }
      );

      expect(result.runId).toBe('mem-789');
    });
  });
});
