/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask routes — the Agent Health assistant ("highlight & ask").
 *
 *   GET  /api/ask/status          { enabled, model?, sessionsDir, maxConcurrent, local: true }
 *   POST /api/ask                 SSE: meta → delta* / tool* → done | error
 *   POST /api/ask/prepare         build the page snapshot + create the pi session early → { sessionId }
 *   GET  /api/ask/sessions        list ask sessions (pi sessions; ?route= filters to one page)
 *   GET  /api/ask/sessions/:id    one session with all turns
 *
 * Guards: `assistant.enabled: false` → every route but /status answers 404;
 * a per-client token bucket (see ASK_RATE_LIMIT) → 429; the concurrency cap
 * lives in the service (AskBusyError → 429 before the stream opens).
 *
 * History is per SERVER, not per user: every client of this server can list,
 * read and continue every thread (questions and highlights included). It is
 * not a privacy boundary — see docs/CONFIGURATION.md.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { debug } from '@/lib/debug';
import {
  streamAsk, prepareAsk, getAskSessionStore, resolveAskSettings, askInFlight, AskBusyError, ASK_AGENT,
  type AskRequest,
} from '@/server/services/ask/askService';

const router = Router();

// ----------------------------------------------------------------------------
// Rate limit: fixed window per client (ip), separate buckets for prepares
// (cheap, fired on every chip click), asks (an LLM call each) and history
// reads (synchronous JSONL parsing on the event loop).
// ----------------------------------------------------------------------------

export const ASK_RATE_LIMIT = { windowMs: 60_000, asks: 20, prepares: 60, reads: 120 } as const;
type RateKind = 'asks' | 'prepares' | 'reads';
const buckets = new Map<string, { windowStart: number } & Record<RateKind, number>>();

export function checkRateLimit(client: string, kind: RateKind, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  let b = buckets.get(client);
  if (!b || now - b.windowStart >= ASK_RATE_LIMIT.windowMs) {
    b = { windowStart: now, asks: 0, prepares: 0, reads: 0 };
    buckets.set(client, b);
  }
  if (b[kind] >= ASK_RATE_LIMIT[kind]) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.windowStart + ASK_RATE_LIMIT.windowMs - now) / 1000)) };
  }
  b[kind] += 1;
  if (buckets.size > 10_000) buckets.clear(); // never let the map grow unbounded
  return { ok: true, retryAfterSec: 0 };
}
/** Test hook. @internal */
export function resetRateLimit(): void { buckets.clear(); }

function rateLimited(kind: RateKind) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = checkRateLimit(req.ip || 'unknown', kind);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: `Too many assistant requests; retry in ${r.retryAfterSec}s.` });
    }
    next();
  };
}

function requireEnabled(req: Request, res: Response, next: NextFunction) {
  if (!resolveAskSettings().enabled) return res.status(404).json({ error: 'The assistant is disabled (assistant.enabled: false in agent-health.config.ts).' });
  next();
}

router.get('/api/ask/status', (_req: Request, res: Response) => {
  const s = resolveAskSettings();
  res.json({
    enabled: s.enabled,
    agent: ASK_AGENT,
    model: s.model ?? null,
    sessionsDir: s.sessionsDir,
    maxConcurrent: s.maxConcurrent,
    inFlight: askInFlight(),
    // Threads are pi session files on THIS server, not in the shared storage cluster.
    local: true,
  });
});

function validatePage(body: any): string | null {
  if (!body || typeof body !== 'object') return 'Request body must be an object';
  if (!body.pageContext || typeof body.pageContext.route !== 'string') return 'pageContext.route is required';
  if (body.selections !== undefined) {
    if (!Array.isArray(body.selections)) return 'selections must be an array';
    if (body.selections.length > 20) return 'too many selections (max 20)';
    for (const s of body.selections) {
      if (!s || typeof s.text !== 'string') return 'each selection needs a text string';
      if (s.text.length > 20_000) return 'a selection is too long (max 20000 chars)';
    }
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') return 'sessionId must be a string';
  return null;
}

function validateAsk(body: any): string | null {
  const base = validatePage(body);
  if (base) return base;
  if (typeof body.question !== 'string' || !body.question.trim()) return 'question is required';
  if (body.question.length > 8_000) return 'question is too long (max 8000 chars)';
  return null;
}

router.post('/api/ask', requireEnabled, rateLimited('asks'), (req: Request, res: Response) => {
  const err = validateAsk(req.body);
  if (err) return res.status(400).json({ error: err });
  const body = req.body as AskRequest;
  if (askInFlight() >= resolveAskSettings().maxConcurrent) {
    res.setHeader('Retry-After', '15');
    return res.status(429).json({ error: new AskBusyError(resolveAskSettings().maxConcurrent).message });
  }
  // Never log the question itself (it can carry pasted secrets / investigation details).
  debug('AskAPI', 'ask', body.sessionId ? 'follow-up' : 'new', 'session:', body.sessionId ?? '(new)', 'route:', body.pageContext.route, 'question chars:', body.question.length, 'selections:', body.selections?.length ?? 0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let ended = false;
  const send = (ev: Record<string, unknown>) => { if (!ended) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const keepalive = setInterval(() => { if (!ended) res.write(': ping\n\n'); }, 15_000);
  if (keepalive.unref) keepalive.unref();
  const finish = () => { if (ended) return; ended = true; clearInterval(keepalive); res.end(); };

  const handle = streamAsk(body, {
    onMeta: (meta) => send({ type: 'meta', ...meta }),
    onDelta: (content) => send({ type: 'delta', content }),
    onTool: (tool) => send({ type: 'tool', ...tool }),
    onDone: (result) => { send({ type: 'done', ...result }); finish(); },
    onError: (error) => { send({ type: 'error', error }); finish(); },
  });

  // Client went away before we finished → stop the pi turn. Listen on the
  // RESPONSE: on modern Node the request stream's own 'close' fires as soon as
  // its body has been consumed, which would abort every ask right after it
  // started (and leave the response open forever).
  res.on('close', () => {
    if (!ended) { ended = true; clearInterval(keepalive); handle.abort(); }
  });
});

router.post('/api/ask/prepare', requireEnabled, rateLimited('prepares'), async (req: Request, res: Response) => {
  const err = validatePage(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await prepareAsk({ pageContext: req.body.pageContext, selections: req.body.selections });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

router.get('/api/ask/sessions', requireEnabled, rateLimited('reads'), async (req: Request, res: Response) => {
  try {
    const route = typeof req.query.route === 'string' ? req.query.route : undefined;
    const limit = typeof req.query.limit === 'string' ? Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200)) : undefined;
    const store = await getAskSessionStore();
    res.json({ sessions: store.list({ route, limit }), dir: store.dir, local: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

router.get('/api/ask/sessions/:id', requireEnabled, rateLimited('reads'), async (req: Request, res: Response) => {
  try {
    const session = (await getAskSessionStore()).get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Ask session not found' });
    res.json({ session });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;
