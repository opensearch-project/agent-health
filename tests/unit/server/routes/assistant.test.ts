/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';

// Mock assistant service
jest.mock('@/server/services/assistantService', () => ({
  streamAssistantResponse: jest.fn().mockReturnValue({ abort: jest.fn() }),
  clearSession: jest.fn(),
  isClaudeAvailable: jest.fn().mockReturnValue(true),
  getSessionMessages: jest.fn().mockReturnValue([]),
}));

// Mock debug
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

// Mock config loader (used by health endpoint)
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({
    judge: { provider: 'bedrock' },
  }),
}));

import assistantRoutes from '@/server/routes/assistant';
import {
  streamAssistantResponse,
  clearSession,
  isClaudeAvailable,
} from '@/server/services/assistantService';

const mockStreamAssistantResponse = streamAssistantResponse as jest.MockedFunction<typeof streamAssistantResponse>;
const mockClearSession = clearSession as jest.MockedFunction<typeof clearSession>;
const mockIsClaudeAvailable = isClaudeAvailable as jest.MockedFunction<typeof isClaudeAvailable>;

// Helper to get route handler
function getRouteHandler(router: any, method: string, path: string) {
  const routes = router.stack;
  const route = routes.find(
    (layer: any) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

function createMockRes() {
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  } as unknown as Response;
  return res;
}

describe('Assistant Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/assistant/chat', () => {
    it('returns 400 when sessionId is missing', () => {
      const req = { body: { message: 'Hello' } } as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'post', '/api/assistant/chat');

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sessionId'),
        })
      );
    });

    it('returns 400 when message is missing', () => {
      const req = { body: { sessionId: 'test-session' } } as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'post', '/api/assistant/chat');

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('message'),
        })
      );
    });

    it('returns 400 when body is empty', () => {
      const req = { body: {} } as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'post', '/api/assistant/chat');

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('sets SSE headers correctly', () => {
      mockStreamAssistantResponse.mockImplementation(
        (_sid, _msg, _ctx, _onDelta, onDone) => {
          onDone('Response');
          return { abort: jest.fn() };
        }
      );

      const req = {
        body: { sessionId: 'test', message: 'Hello', context: {} },
        on: jest.fn(),
      } as unknown as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'post', '/api/assistant/chat');

      handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.flushHeaders).toHaveBeenCalled();
    });

    it('streams delta events', () => {
      mockStreamAssistantResponse.mockImplementation(
        (_sid, _msg, _ctx, onDelta, onDone) => {
          onDelta('Hello');
          onDelta(' world');
          onDone('Hello world');
          return { abort: jest.fn() };
        }
      );

      const req = {
        body: { sessionId: 'test', message: 'Hi', context: {} },
        on: jest.fn(),
      } as unknown as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'post', '/api/assistant/chat');

      handler(req, res);

      const writeCalls = (res.write as jest.Mock).mock.calls.map(c => c[0]);
      const deltaEvents = writeCalls.filter((c: string) => c.includes('"type":"delta"'));
      expect(deltaEvents.length).toBe(2);

      const doneEvents = writeCalls.filter((c: string) => c.includes('"type":"done"'));
      expect(doneEvents.length).toBe(1);
    });

    it('streams error event on failure', () => {
      mockStreamAssistantResponse.mockImplementation(
        (_sid, _msg, _ctx, _onDelta, _onDone, onError) => {
          onError('Something went wrong');
          return { abort: jest.fn() };
        }
      );

      const req = {
        body: { sessionId: 'test', message: 'Hi', context: {} },
        on: jest.fn(),
      } as unknown as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'post', '/api/assistant/chat');

      handler(req, res);

      const writeCalls = (res.write as jest.Mock).mock.calls.map(c => c[0]);
      const errorEvents = writeCalls.filter((c: string) => c.includes('"type":"error"'));
      expect(errorEvents.length).toBe(1);
    });

    it('passes context to streamAssistantResponse', () => {
      mockStreamAssistantResponse.mockImplementation(
        (_sid, _msg, _ctx, _onDelta, onDone) => {
          onDone('ok');
          return { abort: jest.fn() };
        }
      );

      const context = { currentUrl: '/benchmarks/bench-1', benchmarkId: 'bench-1' };
      const req = {
        body: { sessionId: 'test', message: 'Hi', context },
        on: jest.fn(),
      } as unknown as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'post', '/api/assistant/chat');

      handler(req, res);

      expect(mockStreamAssistantResponse).toHaveBeenCalledWith(
        'test',
        'Hi',
        context,
        expect.any(Function),
        expect.any(Function),
        expect.any(Function)
      );
    });
  });

  describe('DELETE /api/assistant/session/:sessionId', () => {
    it('clears session and returns success', () => {
      const req = { params: { sessionId: 'test-session' } } as unknown as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'delete', '/api/assistant/session/:sessionId');

      handler(req, res);

      expect(mockClearSession).toHaveBeenCalledWith('test-session');
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('GET /api/assistant/health', () => {
    it('returns available with claude-code provider when claude is available', () => {
      mockIsClaudeAvailable.mockReturnValue(true);

      const req = {} as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'get', '/api/assistant/health');

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          available: true,
          provider: 'claude-code',
        })
      );
    });

    it('returns fallback provider when claude unavailable', () => {
      mockIsClaudeAvailable.mockReturnValue(false);

      const req = {} as Request;
      const res = createMockRes();
      const handler = getRouteHandler(assistantRoutes, 'get', '/api/assistant/health');

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          available: true,
          provider: expect.any(String),
        })
      );
    });
  });
});
