/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge transport — how a caller reaches the judge, decoupled from WHERE the
 * judge runs.
 *
 * Every judge consumer (the classic runner path, the trace-judged path, the
 * SDK `judge()` fixture) builds the same `/api/judge` request body and reads
 * the same response contract. Historically each of them also hard-coded the
 * transport: a `fetch` to `http://localhost:${AH_PORT}/api/judge`, i.e. the
 * process-global backend URL. A `JudgeTransport` makes that an explicit
 * dependency: the server passes an HTTP self-call bound to its own URL; a
 * CLI executor can pass an in-process function that runs the judge directly
 * and still returns the same response shape.
 *
 * The transport returns a minimal `Response`-like object so the callers'
 * existing status/retry handling (`ok`, `status`, `json()`, `text()`) is
 * untouched — an in-process transport wraps its result in a real `Response`.
 */

import { ENV_CONFIG } from '@/lib/config';
import { getBackendUrl } from '@/lib/portConfig';

/** The `/api/judge` request body (see server/routes/judge.ts, services/judge/runJudge.ts). */
export interface JudgeRequestBody {
  trajectory: unknown[];
  expectedOutcomes?: string[];
  expectedTrajectory?: unknown[];
  logs?: unknown[];
  modelId?: string;
  evaluatorId?: string;
  runId?: string;
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number; sessionId?: string }>;
}

/** The subset of the Fetch `Response` the judge callers read. */
export type JudgeTransportResponse = Pick<Response, 'ok' | 'status' | 'json' | 'text'>;

export type JudgeTransport = (body: JudgeRequestBody) => Promise<JudgeTransportResponse>;

/** Transport that POSTs the body to `<judgeApiUrl>` (an `/api/judge` endpoint). */
export function createHttpJudgeTransport(judgeApiUrl: string): JudgeTransport {
  return (body) =>
    fetch(judgeApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
}

/** This process's own `/api/judge` URL (`http://localhost:<AH_PORT>/api/judge`). */
export function defaultJudgeApiUrl(): string {
  return ENV_CONFIG.judgeApiUrl || `${getBackendUrl()}/api/judge`;
}

/** The process-default judge transport: HTTP to this server's own `/api/judge`. */
export function defaultJudgeTransport(): JudgeTransport {
  return createHttpJudgeTransport(defaultJudgeApiUrl());
}
