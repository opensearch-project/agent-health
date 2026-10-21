/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Explicit, per-request HTTP timeouts for connector `fetch()` calls.
 *
 * Why this exists: Node's built-in `fetch` (undici) applies a silent default
 * `headersTimeout` of 300 000 ms. When an agent takes longer than that to
 * answer, the request fails with the opaque `TypeError: fetch failed` whose
 * only useful information (`HeadersTimeoutError`, `UND_ERR_HEADERS_TIMEOUT`)
 * is buried on `error.cause`. Nothing in this codebase set a dispatcher, so
 * connectors had a 5-minute ceiling nobody had chosen or documented (owner
 * incident: a REST agent answered every request with 200 — in its own log —
 * but 5 of 62 answers arrived after agent-health had already given up).
 *
 * `fetchWithTimeout` makes the ceiling explicit and configurable per agent
 * (`connectorConfig.timeoutMs`), applies it to the WHOLE request — from the
 * call until the response body has been fully consumed (or cancelled) — logs
 * one clear line when it fires, and throws an {@link AgentRequestError} whose
 * message names the timeout and endpoint and whose `cause` keeps the original
 * undici error for classification. Body-read failures (the deadline firing
 * mid-body, the agent closing the connection half-way) surface through the
 * returned `Response`'s body (`text()` / `json()` / `clone()` …) as the same
 * `AgentRequestError`, so the report records kind / elapsed / endpoint
 * instead of a bare stream error. Before this the deadline and the caller's
 * abort wiring were dropped as soon as the HEADERS arrived (an adversarial
 * review probed it: `timeoutMs: 50` returned 200 after 221 ms while the body
 * trickled in 20 ms chunks), so a slow body was uncapped and its errors
 * unwrapped.
 *
 * Scope: this is a TOTAL deadline for request/response exchanges whose body
 * is read to completion — the REST connector (`response.json()`). It is NOT
 * used by the streaming (AG-UI / SSE) connectors, which own their idle-timeout
 * semantics in `services/agent/sseStream.ts`; do not route a long-lived
 * stream through this helper, the total deadline would cut it off.
 *
 * Mechanism: undici honours per-request `headersTimeout` / `bodyTimeout`
 * dispatch options. We wrap the process-global dispatcher (looked up via the
 * documented `Symbol.for('undici.globalDispatcher.1')`) so the override is
 * scoped to this one request and never raises the limit for anything else
 * in the process. Verified on Node 20/22/24. When no global dispatcher is
 * available (non-Node runtimes, browser), the `AbortSignal` fallback still
 * enforces the same wall-clock limit.
 */

import { AgentRequestError } from '@/services/evaluation/agentFailure';

/**
 * Default request timeout for HTTP connectors (ms). Matches undici's silent
 * default so existing agents see no behaviour change — the difference is
 * that the limit is now visible, configurable, and reported when it fires.
 */
export const DEFAULT_HTTP_CONNECTOR_TIMEOUT_MS = 300_000;

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Wall-clock limit for the whole request (headers AND the full body read), in ms. */
  timeoutMs?: number;
  /** Connector type, for the log line. */
  connectorType?: string;
}

/**
 * Resolve `connectorConfig.timeoutMs` (or legacy `connectorConfig.timeout`,
 * the subprocess connectors' key) into a positive finite number, else the
 * default.
 */
export function resolveConnectorTimeoutMs(connectorConfig: Record<string, any> | undefined, fallback = DEFAULT_HTTP_CONNECTOR_TIMEOUT_MS): number {
  const raw = connectorConfig?.timeoutMs ?? connectorConfig?.timeout;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Node/undici global dispatcher (undefined outside Node). */
function getGlobalDispatcher(): { dispatch: (opts: any, handler: any) => any } | undefined {
  const g = (globalThis as any)[Symbol.for('undici.globalDispatcher.1')];
  return g && typeof g.dispatch === 'function' ? g : undefined;
}

/**
 * Build a request-scoped dispatcher that forwards to the global one with
 * `headersTimeout`/`bodyTimeout` overridden. Returns undefined when there is
 * no global dispatcher (the AbortSignal fallback still applies).
 */
function buildTimeoutDispatcher(timeoutMs: number): any | undefined {
  const base = getGlobalDispatcher();
  if (!base) return undefined;
  return {
    dispatch(opts: any, handler: any) {
      return base.dispatch({ ...opts, headersTimeout: timeoutMs, bodyTimeout: timeoutMs }, handler);
    },
  };
}

/** True when `err` (or its cause chain) is a timeout/abort. */
function isTimeoutLike(err: unknown): boolean {
  let cur: any = err;
  for (let i = 0; i < 5 && cur; i++) {
    const code = cur.code;
    const name = cur.name;
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR') return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * `fetch()` with an explicit request timeout covering headers AND body.
 * Rejects with {@link AgentRequestError} (cause = original error) on ANY
 * transport failure before the headers arrive; a non-2xx response is returned
 * as-is (callers decide what to do with it). The returned `Response` keeps
 * the deadline running until its body is fully read or cancelled, and any
 * body-read failure rejects with the same {@link AgentRequestError} shape
 * (timeout vs transport, elapsed, endpoint). A response with no body (204,
 * 304, HEAD) settles the deadline immediately.
 */
export async function fetchWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_HTTP_CONNECTOR_TIMEOUT_MS, connectorType = 'http', signal: callerSignal, ...init } = options;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort((callerSignal as AbortSignal).reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`request timeout of ${timeoutMs}ms exceeded`));
  }, timeoutMs);
  // Belt-and-braces: never let the timer keep the event loop alive.
  (timer as any).unref?.();
  // Runs exactly once, on whichever path settles the exchange: a pre-headers
  // failure, a body-less response, the body's last chunk, a body-read error,
  // or the consumer cancelling the body.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  };
  const method = (init.method || 'GET').toUpperCase();
  const wrapError = (err: any, phase: 'headers' | 'body'): AgentRequestError => {
    const elapsedMs = Date.now() - startedAt;
    if (timedOut || isTimeoutLike(err)) {
      const what = phase === 'headers'
        ? 'no response headers/body from'
        : 'response headers arrived but the body did not complete, from';
      const message = `Agent request timed out after ${elapsedMs}ms (timeout ${timeoutMs}ms) — ${what} ${method} ${url}`;
      console.error(`[${connectorType}] ${message}. Raise connectorConfig.timeoutMs if the agent legitimately needs longer.`);
      return new AgentRequestError(message, { cause: err, endpoint: url, elapsedMs, timeoutMs });
    }
    const causeText = err?.cause?.code || err?.cause?.message || err?.code || err?.message || String(err);
    const message = phase === 'headers'
      ? `Agent request to ${method} ${url} failed after ${elapsedMs}ms: ${causeText}`
      : `Agent response body from ${method} ${url} failed after ${elapsedMs}ms (headers had arrived): ${causeText}`;
    console.error(`[${connectorType}] ${message}`);
    return new AgentRequestError(message, { cause: err, endpoint: url, elapsedMs, timeoutMs });
  };

  const dispatcher = buildTimeoutDispatcher(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      ...(dispatcher ? ({ dispatcher } as any) : {}),
    });
  } catch (err: any) {
    settle();
    throw wrapError(err, 'headers');
  }
  if (!response.body) {
    settle();
    return response;
  }

  // Headers are in; the deadline is NOT done. Hand the caller a Response whose
  // body is read through the same deadline + abort wiring: the timer firing
  // (or the caller aborting) aborts the underlying read, and every body-read
  // failure is wrapped exactly like a pre-headers one.
  const reader = response.body.getReader();
  const guardedBody = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        settle();
        ctrl.error(wrapError(err, 'body'));
        return;
      }
      if (chunk.done) {
        settle();
        ctrl.close();
        return;
      }
      ctrl.enqueue(chunk.value);
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(guardedBody, { status: response.status, statusText: response.statusText, headers: response.headers });
}
