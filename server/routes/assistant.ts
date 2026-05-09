/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Assistant Routes - AI assistant chat with SSE streaming
 *
 * Provides conversational AI endpoints powered by Claude CLI or fallback LLM provider.
 * Follows the SSE streaming pattern from evaluation.ts.
 */

import { Router, Request, Response } from 'express';
import {
  streamAssistantResponse,
  clearSession,
  isClaudeAvailable,
} from '@/server/services/assistantService';
import { debug } from '@/lib/debug';
import type { AssistantContext } from '@/types';

const router = Router();

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate chat request body
 * @returns Error message or null if valid
 */
function validateChatRequest(body: any): string | null {
  if (!body || typeof body !== 'object') {
    return 'Request body must be a valid object';
  }
  if (!body.sessionId || typeof body.sessionId !== 'string') {
    return 'sessionId is required and must be a string';
  }
  if (!body.message || typeof body.message !== 'string') {
    return 'message is required and must be a string';
  }
  return null;
}

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/assistant/chat - Stream assistant response via SSE
 *
 * Request body:
 * {
 *   sessionId: string;
 *   message: string;
 *   context?: AssistantContext;
 * }
 *
 * SSE events:
 * - { type: "delta", content: "..." }
 * - { type: "done", fullResponse: "..." }
 * - { type: "error", error: "..." }
 */
router.post('/api/assistant/chat', (req: Request, res: Response) => {
  debug('AssistantAPI', 'Received chat request');

  const validationError = validateChatRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { sessionId, message, context } = req.body as {
    sessionId: string;
    message: string;
    context?: AssistantContext;
  };

  debug('AssistantAPI', 'sessionId:', sessionId, 'message length:', message.length);

  // Set up SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let ended = false;

  const handle = streamAssistantResponse(
    sessionId,
    message,
    context,
    // onDelta
    (content: string) => {
      if (!ended) res.write(`data: ${JSON.stringify({ type: 'delta', content })}\n\n`);
    },
    // onDone
    (fullResponse: string) => {
      if (!ended) {
        res.write(`data: ${JSON.stringify({ type: 'done', fullResponse })}\n\n`);
        res.end();
      }
    },
    // onError
    (error: string) => {
      if (!ended) {
        res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.end();
      }
    }
  );

  // Kill the subprocess if the client disconnects
  req.on('close', () => {
    ended = true;
    handle.abort();
  });
});

/**
 * DELETE /api/assistant/session/:sessionId - Clear session history
 */
router.delete('/api/assistant/session/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  debug('AssistantAPI', 'Clearing session:', sessionId);

  clearSession(sessionId);
  res.json({ success: true });
});

/**
 * GET /api/assistant/health - Health check
 */
router.get('/api/assistant/health', (_req: Request, res: Response) => {
  const claudeAvailable = isClaudeAvailable();
  let provider: string;

  if (claudeAvailable) {
    provider = 'claude-code';
  } else {
    try {
      const { loadConfigSync } = require('@/lib/config/index');
      const appConfig = loadConfigSync();
      provider = appConfig.judge?.provider || 'bedrock';
    } catch {
      provider = 'bedrock';
    }
  }

  res.json({ available: true, provider });
});

export default router;
