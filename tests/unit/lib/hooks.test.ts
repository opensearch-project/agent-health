/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeBeforeRequestHook, executeAfterResponseHook, executeBuildTrajectoryHook } from '@/lib/hooks';
import type { AgentHooks, BeforeRequestContext, AfterResponseContext, BuildTrajectoryContext, TrajectoryStep } from '@/types';

describe('executeBeforeRequestHook', () => {
  const baseContext: BeforeRequestContext = {
    endpoint: 'http://localhost:3000/agent',
    payload: { threadId: 'thread-1', messages: [{ content: 'test' }] },
    headers: { 'Content-Type': 'application/json' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return original context when hooks is undefined', async () => {
    const result = await executeBeforeRequestHook(undefined, baseContext, 'test-agent');
    expect(result).toBe(baseContext);
  });

  it('should return original context when hooks has no beforeRequest', async () => {
    const hooks: AgentHooks = {};
    const result = await executeBeforeRequestHook(hooks, baseContext, 'test-agent');
    expect(result).toBe(baseContext);
  });

  it('should pass context to the hook and return modified context', async () => {
    const modifiedContext: BeforeRequestContext = {
      endpoint: 'http://localhost:3000/agent/v2',
      payload: { ...baseContext.payload, extra: true },
      headers: { ...baseContext.headers, 'X-Custom': 'value' },
    };

    const hooks: AgentHooks = {
      beforeRequest: jest.fn().mockResolvedValue(modifiedContext),
    };

    const result = await executeBeforeRequestHook(hooks, baseContext, 'test-agent');

    expect(hooks.beforeRequest).toHaveBeenCalledWith(baseContext);
    expect(result).toEqual(modifiedContext);
  });

  it('should allow hook to perform side effects and return context unchanged', async () => {
    const sideEffectFn = jest.fn();
    const hooks: AgentHooks = {
      beforeRequest: async (ctx) => {
        sideEffectFn(ctx.payload.threadId);
        return ctx;
      },
    };

    const result = await executeBeforeRequestHook(hooks, baseContext, 'test-agent');

    expect(sideEffectFn).toHaveBeenCalledWith('thread-1');
    expect(result).toEqual(baseContext);
  });

  it('should throw with descriptive message when hook returns null', async () => {
    const hooks: AgentHooks = {
      beforeRequest: jest.fn().mockResolvedValue(null),
    };

    await expect(
      executeBeforeRequestHook(hooks, baseContext, 'pulsar')
    ).rejects.toThrow('beforeRequest hook failed for agent "pulsar"');
  });

  it('should throw when hook returns object without endpoint', async () => {
    const hooks: AgentHooks = {
      beforeRequest: jest.fn().mockResolvedValue({
        payload: {},
        headers: {},
      }),
    };

    await expect(
      executeBeforeRequestHook(hooks, baseContext, 'test-agent')
    ).rejects.toThrow('beforeRequest hook must return an object with a string "endpoint" field');
  });

  it('should throw when hook returns object without payload', async () => {
    const hooks: AgentHooks = {
      beforeRequest: jest.fn().mockResolvedValue({
        endpoint: 'http://example.com',
        headers: {},
      }),
    };

    await expect(
      executeBeforeRequestHook(hooks, baseContext, 'test-agent')
    ).rejects.toThrow('beforeRequest hook must return an object with a "payload" field');
  });

  it('should throw when hook returns object without headers', async () => {
    const hooks: AgentHooks = {
      beforeRequest: jest.fn().mockResolvedValue({
        endpoint: 'http://example.com',
        payload: {},
      }),
    };

    await expect(
      executeBeforeRequestHook(hooks, baseContext, 'test-agent')
    ).rejects.toThrow('beforeRequest hook must return an object with an object "headers" field');
  });

  it('should wrap hook errors with agent key', async () => {
    const hooks: AgentHooks = {
      beforeRequest: jest.fn().mockRejectedValue(new Error('Network error')),
    };

    await expect(
      executeBeforeRequestHook(hooks, baseContext, 'my-agent')
    ).rejects.toThrow('beforeRequest hook failed for agent "my-agent": Network error');
  });

  it('should handle non-Error throws from hooks', async () => {
    const hooks: AgentHooks = {
      beforeRequest: jest.fn().mockRejectedValue('string error'),
    };

    await expect(
      executeBeforeRequestHook(hooks, baseContext, 'my-agent')
    ).rejects.toThrow('beforeRequest hook failed for agent "my-agent": string error');
  });
});

describe('executeAfterResponseHook', () => {
  const baseContext: AfterResponseContext = {
    response: { data: 'test response' },
    trajectory: [{ id: '1', timestamp: Date.now(), type: 'response', content: 'test' }],
    runId: 'run-123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return original context when hooks is undefined', async () => {
    const result = await executeAfterResponseHook(undefined, baseContext, 'test-agent');
    expect(result).toBe(baseContext);
  });

  it('should return original context when hooks has no afterResponse', async () => {
    const hooks: AgentHooks = {};
    const result = await executeAfterResponseHook(hooks, baseContext, 'test-agent');
    expect(result).toBe(baseContext);
  });

  it('should pass context to the hook and return modified context', async () => {
    const modifiedContext: AfterResponseContext = {
      ...baseContext,
      runId: 'extracted-run-id',
    };

    const hooks: AgentHooks = {
      afterResponse: jest.fn().mockResolvedValue(modifiedContext),
    };

    const result = await executeAfterResponseHook(hooks, baseContext, 'test-agent');

    expect(hooks.afterResponse).toHaveBeenCalledWith(baseContext);
    expect(result).toEqual(modifiedContext);
  });

  it('should wrap hook errors with agent key', async () => {
    const hooks: AgentHooks = {
      afterResponse: jest.fn().mockRejectedValue(new Error('Extraction failed')),
    };

    await expect(
      executeAfterResponseHook(hooks, baseContext, 'my-agent')
    ).rejects.toThrow('afterResponse hook failed for agent "my-agent": Extraction failed');
  });
});

describe('executeBuildTrajectoryHook', () => {
  const mockSpans = [
    { spanId: 'span-1', name: 'agent.run', traceId: 'trace-1', startTime: '2023-01-01T00:00:00Z', endTime: '2023-01-01T00:01:00Z' },
    { spanId: 'span-2', name: 'tool.execute', traceId: 'trace-1', startTime: '2023-01-01T00:00:30Z', endTime: '2023-01-01T00:00:45Z' },
  ];

  const baseContext: BuildTrajectoryContext = {
    spans: mockSpans,
    runId: 'run-123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return null when hooks is undefined', async () => {
    const result = await executeBuildTrajectoryHook(undefined, baseContext, 'test-agent');
    expect(result).toBeNull();
  });

  it('should return null when hooks has no buildTrajectory', async () => {
    const hooks: AgentHooks = {};
    const result = await executeBuildTrajectoryHook(hooks, baseContext, 'test-agent');
    expect(result).toBeNull();
  });

  it('should pass context to the hook and return trajectory steps', async () => {
    const mockTrajectory: TrajectoryStep[] = [
      { id: 'step-1', timestamp: Date.now(), type: 'thinking', content: 'Processing request' },
      { id: 'step-2', timestamp: Date.now(), type: 'action', content: 'Executing tool', toolName: 'search' },
    ];

    const hooks: AgentHooks = {
      buildTrajectory: jest.fn().mockResolvedValue(mockTrajectory),
    };

    const result = await executeBuildTrajectoryHook(hooks, baseContext, 'test-agent');

    expect(hooks.buildTrajectory).toHaveBeenCalledWith(baseContext);
    expect(result).toEqual(mockTrajectory);
  });

  it('should return null when hook returns null (trace not ready)', async () => {
    const hooks: AgentHooks = {
      buildTrajectory: jest.fn().mockResolvedValue(null),
    };

    const result = await executeBuildTrajectoryHook(hooks, baseContext, 'test-agent');

    expect(result).toBeNull();
  });

  it('should wrap hook errors with agent key', async () => {
    const hooks: AgentHooks = {
      buildTrajectory: jest.fn().mockRejectedValue(new Error('Span parsing failed')),
    };

    await expect(
      executeBuildTrajectoryHook(hooks, baseContext, 'my-agent')
    ).rejects.toThrow('buildTrajectory hook failed for agent "my-agent": Span parsing failed');
  });
});
