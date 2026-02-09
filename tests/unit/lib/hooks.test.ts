/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeBeforeRequestHook } from '@/lib/hooks';
import type { AgentHooks, BeforeRequestContext } from '@/types';

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
