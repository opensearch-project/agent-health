/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client for the "highlight & ask" API (`/api/ask`). SSE parsing mirrors
 * assistantApi.ts; the event set is richer (meta / tool / done carry timings).
 */

export interface AskSelection {
  text: string;
  nearbyText?: string;
}

export interface AskPageContext {
  route: string;
  params?: Record<string, string | string[] | undefined>;
  title?: string;
}

export interface AskRequestBody {
  question: string;
  selections?: AskSelection[];
  pageContext: AskPageContext;
  /** Continue an existing ask session (follow-up) or one returned by prepareAsk(). */
  sessionId?: string;
}

export interface AskMetaEvent {
  type: 'meta';
  sessionId: string;
  turnId: string;
  agent: { key: string; name: string; model: string };
  refs: Record<string, string | string[] | undefined>;
  loaded: string[];
  prepared: boolean;
}
export interface AskToolEvent { type: 'tool'; name: string; status: 'start' | 'end'; isError?: boolean }
export interface AskDoneEvent { type: 'done'; answer: string; durationMs: number; firstTokenMs?: number; toolCalls: string[] }

export interface AskStreamHandlers {
  onMeta?(meta: AskMetaEvent): void;
  onDelta?(text: string): void;
  onTool?(tool: AskToolEvent): void;
}

export interface AskPrepared {
  sessionId: string;
  refs: Record<string, string | string[] | undefined>;
  loaded: string[];
  model: string;
}

export interface AskSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  page: AskPageContext;
  firstQuestion: string;
  firstSelection?: string;
  turnCount: number;
  lastAnswerPreview: string;
  model?: string;
}

export interface AskTurn {
  id: string;
  question: string;
  answer: string;
  selections: AskSelection[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstTokenMs?: number;
  toolCalls: string[];
  error?: string;
}

export interface AskSession extends Omit<AskSessionSummary, 'firstQuestion' | 'firstSelection' | 'turnCount' | 'lastAnswerPreview'> {
  selections: AskSelection[];
  turns: AskTurn[];
}

/** POST /api/ask and stream the answer. Resolves with the `done` event. */
export async function streamAsk(
  body: AskRequestBody,
  handlers: AskStreamHandlers,
  signal?: AbortSignal
): Promise<AskDoneEvent> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errorBody.error || `Ask request failed: ${response.statusText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let done: AskDoneEvent | null = null;

  const handleEvent = (raw: string) => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let data: any;
      try { data = JSON.parse(line.slice(6)); } catch { continue; }
      switch (data.type) {
        case 'meta': handlers.onMeta?.(data); break;
        case 'delta': handlers.onDelta?.(data.content ?? ''); break;
        case 'tool': handlers.onTool?.(data); break;
        case 'done': done = data; break;
        case 'error': throw new Error(data.error || 'Ask failed');
      }
    }
  };

  for (;;) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const ev of events) handleEvent(ev);
  }
  if (buffer.trim()) handleEvent(buffer);
  if (!done) throw new Error('Ask stream ended without an answer');
  return done;
}

export interface AskStatus {
  enabled: boolean;
  agent: { key: string; name: string };
  model: string | null;
  sessionsDir: string;
  maxConcurrent: number;
  inFlight: number;
  /** Threads are pi session files on this server only (not in the shared cluster). */
  local: boolean;
}

export async function getAskStatus(): Promise<AskStatus> {
  const res = await fetch('/api/ask/status');
  if (!res.ok) throw new Error(`Assistant status failed: ${res.statusText}`);
  return res.json();
}

/** Build the page snapshot + create the pi session before the user finishes typing. */
export async function prepareAsk(body: { pageContext: AskPageContext; selections?: AskSelection[] }, signal?: AbortSignal): Promise<AskPrepared> {
  const res = await fetch('/api/ask/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errorBody.error || `Ask prepare failed: ${res.statusText}`);
  }
  return res.json();
}

export async function listAskSessions(opts: { route?: string; limit?: number } = {}): Promise<AskSessionSummary[]> {
  const q = new URLSearchParams();
  if (opts.route) q.set('route', opts.route);
  if (opts.limit) q.set('limit', String(opts.limit));
  const res = await fetch(`/api/ask/sessions${q.toString() ? `?${q}` : ''}`);
  if (!res.ok) throw new Error(`Failed to list ask sessions: ${res.statusText}`);
  const data = await res.json();
  return data.sessions ?? [];
}

export async function getAskSession(id: string): Promise<AskSession | null> {
  const res = await fetch(`/api/ask/sessions/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load ask session: ${res.statusText}`);
  const data = await res.json();
  return data.session ?? null;
}
