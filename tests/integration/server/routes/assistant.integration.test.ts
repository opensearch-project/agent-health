/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for /api/assistant/* SSE flow.
 *
 * Verifies the route → service contract end-to-end inside the express app,
 * with the underlying claude CLI / Bedrock / LiteLLM dispatch mocked at the
 * assistantService boundary. These tests do NOT require:
 *   - claude CLI installed
 *   - AWS credentials
 *   - the dev server running
 *
 * Run:
 *   npm test -- --testPathPattern=assistant.integration
 */

import express from 'express';
import request from 'supertest';

// Mock the assistantService so the route exercises the SSE wiring without
// spawning claude / hitting Bedrock. We import the real route afterwards.
const mockStreamAssistantResponse = jest.fn();
const mockClearSession = jest.fn();
const mockIsClaudeAvailable = jest.fn().mockReturnValue(true);

jest.mock('@/server/services/assistantService', () => ({
  streamAssistantResponse: (...args: any[]) => mockStreamAssistantResponse(...args),
  clearSession: (...args: any[]) => mockClearSession(...args),
  isClaudeAvailable: () => mockIsClaudeAvailable(),
  getSessionMessages: jest.fn().mockReturnValue([]),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({ judge: { provider: 'bedrock' } }),
}));

import assistantRoutes from '@/server/routes/assistant';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(assistantRoutes);
  return app;
}

/** Parse an SSE response body into a sequence of `{type, ...}` event objects. */
function parseSSE(body: string): Array<Record<string, any>> {
  const events: Array<Record<string, any>> = [];
  for (const block of body.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
      }
    }
  }
  return events;
}

describe('Assistant API (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsClaudeAvailable.mockReturnValue(true);
  });

  describe('POST /api/assistant/chat', () => {
    it('streams delta events then a done event for a successful turn', async () => {
      mockStreamAssistantResponse.mockImplementation(
        (_sid: string, _msg: string, _ctx: any, onDelta: any, onDone: any) => {
          process.nextTick(() => {
            onDelta('Hello');
            onDelta(' world');
            onDone('Hello world');
          });
          return { abort: jest.fn() };
        }
      );

      const res = await request(buildApp())
        .post('/api/assistant/chat')
        .send({ sessionId: 'sess-1', message: 'hi', context: { runId: 'run-1' } })
        .buffer(true)
        .parse((response, callback) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk.toString(); });
          response.on('end', () => callback(null, data));
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = parseSSE(res.body || res.text);
      expect(events).toEqual([
        { type: 'delta', content: 'Hello' },
        { type: 'delta', content: ' world' },
        { type: 'done', fullResponse: 'Hello world' },
      ]);

      // Service was called with the right arguments.
      const args = mockStreamAssistantResponse.mock.calls[0];
      expect(args[0]).toBe('sess-1');
      expect(args[1]).toBe('hi');
      expect(args[2]).toEqual({ runId: 'run-1' });
    });

    it('streams an error event when the service reports a failure', async () => {
      mockStreamAssistantResponse.mockImplementation(
        (_sid: string, _msg: string, _ctx: any, _onDelta: any, _onDone: any, onError: any) => {
          // Defer just enough to let the route register its req.on('close') handler.
          process.nextTick(() => onError('Claude CLI exited with code 1'));
          return { abort: jest.fn() };
        }
      );

      const res = await request(buildApp())
        .post('/api/assistant/chat')
        .send({ sessionId: 'sess-2', message: 'hi' })
        .buffer(true)
        .parse((response, callback) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk.toString(); });
          response.on('end', () => callback(null, data));
        })
        .expect(200);

      const events = parseSSE(res.body || res.text);
      expect(events).toEqual([
        { type: 'error', error: 'Claude CLI exited with code 1' },
      ]);
    });

    it('passes context (runId/benchmarkId/testCaseId) through to the service', async () => {
      mockStreamAssistantResponse.mockImplementation(
        (_sid: string, _msg: string, _ctx: any, _onDelta: any, onDone: any) => {
          process.nextTick(() => onDone('ok'));
          return { abort: jest.fn() };
        }
      );

      const ctx = { runId: 'r-1', benchmarkId: 'b-1', testCaseId: 'tc-1', currentUrl: '/runs/r-1' };
      await request(buildApp())
        .post('/api/assistant/chat')
        .send({ sessionId: 's', message: 'hi', context: ctx })
        .buffer(true)
        .parse((response, callback) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk.toString(); });
          response.on('end', () => callback(null, data));
        })
        .expect(200);

      expect(mockStreamAssistantResponse).toHaveBeenCalled();
      expect(mockStreamAssistantResponse.mock.calls[0][2]).toEqual(ctx);
    });

    it('forwards comparisonRunIds in the context (compare-page payload)', async () => {
      // Regression guard: when the user is on /compare/<bench>?runs=a,b the
      // frontend hook puts the run IDs under context.comparisonRunIds. Verify
      // they reach the service unchanged so the snapshot loader can fetch each
      // run and answer cross-agent questions like "which tests passed for which
      // agent?".
      mockStreamAssistantResponse.mockImplementation(
        (_sid: string, _msg: string, _ctx: any, _onDelta: any, onDone: any) => {
          process.nextTick(() => onDone('ok'));
          return { abort: jest.fn() };
        }
      );

      const ctx = {
        currentUrl: '/compare/bench-X?runs=run-A,run-B',
        benchmarkId: 'bench-X',
        comparisonRunIds: ['run-A', 'run-B'],
      };
      await request(buildApp())
        .post('/api/assistant/chat')
        .send({ sessionId: 'cmp', message: 'which tests passed for which agent?', context: ctx })
        .buffer(true)
        .parse((response, callback) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk.toString(); });
          response.on('end', () => callback(null, data));
        })
        .expect(200);

      const passedCtx = mockStreamAssistantResponse.mock.calls[0][2];
      expect(passedCtx.benchmarkId).toBe('bench-X');
      expect(passedCtx.comparisonRunIds).toEqual(['run-A', 'run-B']);
      // currentUrl now includes the query string (used to be path-only).
      expect(passedCtx.currentUrl).toBe('/compare/bench-X?runs=run-A,run-B');
    });

    it('returns 400 when sessionId is missing', async () => {
      const res = await request(buildApp())
        .post('/api/assistant/chat')
        .send({ message: 'hi' })
        .expect(400);
      expect(res.body.error).toMatch(/sessionId/);
      expect(mockStreamAssistantResponse).not.toHaveBeenCalled();
    });

    it('returns 400 when message is missing', async () => {
      const res = await request(buildApp())
        .post('/api/assistant/chat')
        .send({ sessionId: 's' })
        .expect(400);
      expect(res.body.error).toMatch(/message/);
      expect(mockStreamAssistantResponse).not.toHaveBeenCalled();
    });

    it('returns 400 when body is empty', async () => {
      const res = await request(buildApp())
        .post('/api/assistant/chat')
        .send({})
        .expect(400);
      expect(res.body.error).toBeTruthy();
    });
  });

  describe('DELETE /api/assistant/session/:sessionId', () => {
    it('clears the session and returns success', async () => {
      const res = await request(buildApp())
        .delete('/api/assistant/session/abc%20123')
        .expect(200);
      expect(res.body).toEqual({ success: true });
      // Express decodes the path param.
      expect(mockClearSession).toHaveBeenCalledWith('abc 123');
    });
  });

  describe('GET /api/assistant/health', () => {
    it('reports claude-code provider when CLI is available', async () => {
      mockIsClaudeAvailable.mockReturnValue(true);
      const res = await request(buildApp()).get('/api/assistant/health').expect(200);
      expect(res.body).toEqual({ available: true, provider: 'claude-code' });
    });

    it('falls back to configured judge provider when CLI is unavailable', async () => {
      mockIsClaudeAvailable.mockReturnValue(false);
      const res = await request(buildApp()).get('/api/assistant/health').expect(200);
      expect(res.body.provider).toBe('bedrock');
    });
  });
});
