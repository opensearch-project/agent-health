/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `/api/judge` response contract as a plain function.
 *
 * `runJudge` (./runJudge.ts) throws typed errors; the HTTP route maps them to
 * the status codes `callBedrockJudge` (services/evaluation/bedrockJudge.ts)
 * keys its retry policy on: 4xx = do not retry, 422 `JUDGE_UNPARSEABLE` = one
 * more attempt, 5xx = transient. An executor that judges IN-PROCESS (the CLI,
 * #612) must present the same statuses, or its retry behaviour would differ
 * from a server-executed run's. So the mapping lives here, once, and both the
 * route (`server/routes/judge.ts`) and the in-process transport
 * (`createInProcessJudgeTransport`) call it.
 */

import { isJudgeParseError } from '@/server/services/judgeResponseParser';
import type { JudgeRequestBody, JudgeTransport, JudgeTransportResponse } from '@/lib/judge/transport';
import { runJudge, JudgeRequestError, describeJudgeFailure, isProviderRequestRejection, type RunJudgeDeps } from './runJudge';

export interface JudgeHttpOutcome {
  status: number;
  body: unknown;
  /** The underlying failure for a non-2xx outcome that the caller may want to log. */
  error?: unknown;
}

/** Run the judge and express the result as the `/api/judge` HTTP contract. Never throws. */
export async function runJudgeAsHttp(body: JudgeRequestBody, deps: RunJudgeDeps): Promise<JudgeHttpOutcome> {
  try {
    return { status: 200, body: await runJudge(body, deps) };
  } catch (error: any) {
    if (error instanceof JudgeRequestError) {
      return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}) }, error };
    }
    // A judge reply with no parseable verdict (empty final turn, malformed
    // JSON) is NOT a transient provider error — retrying the same prompt ten
    // times with exponential backoff just burns ~8 minutes per case (owner
    // incident). A distinct 422 + code lets the client cap retries and keep
    // the raw text for the report.
    if (isJudgeParseError(error)) {
      return {
        status: 422,
        body: { error: `Judge evaluation failed: ${error.message}`, code: error.code, rawResponse: error.rawResponse, details: error.message },
        error,
      };
    }
    // The model provider REJECTED the request (AWS SDK `ValidationException`,
    // `$fault: 'client'` with HTTP 400). The same request will be rejected
    // again, so answer 400 and let `callBedrockJudge` fail fast. Throttling
    // (429) and server faults keep the retryable 500 below.
    if (isProviderRequestRejection(error)) {
      return {
        status: 400,
        body: {
          error: `Judge evaluation failed: the judge model provider rejected the request (${error.name}): ${error.message}`,
          code: 'JUDGE_REQUEST_REJECTED',
          details: error.message,
        },
        error,
      };
    }
    return {
      status: 500,
      body: { error: `Judge evaluation failed: ${describeJudgeFailure(error, body?.modelId, deps.config)}`, details: error?.message },
      error,
    };
  }
}

/**
 * A `JudgeTransport` that runs the judge in THIS process — the caller's
 * credentials, the caller's `pi` / `claude` / `agent` CLIs on PATH — and
 * answers with the exact `/api/judge` contract, so every judge consumer
 * (`callBedrockJudge`, the SDK `judge()` fixture) behaves as it does against
 * the HTTP route. There is deliberately no fallback to a remote judge: if
 * the local provider cannot run, the case is recorded with the provider's
 * message, exactly as a server-side judge failure is (design #612 §1).
 */
export function createInProcessJudgeTransport(deps: RunJudgeDeps, log: (message: string) => void = (m) => console.error(m)): JudgeTransport {
  return async (body): Promise<JudgeTransportResponse> => {
    const outcome = await runJudgeAsHttp(body, deps);
    if (outcome.error && outcome.status >= 500) {
      log(`[Judge] in-process judge failed: ${(outcome.error as Error)?.message ?? String(outcome.error)}`);
    }
    const text = JSON.stringify(outcome.body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
}
