/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight polling helper used by the SDK runner to pre-load OTel
 * spans into the `traces` fixture for deterministic test bodies (#230).
 *
 * This is a thinner cousin of `tracePollingManager.startPolling`:
 *   - no judge wiring, no report storage updates, no trajectory rebuild
 *   - returns a result object that includes the **last error message**
 *     when polling never produced spans, so the caller can build a
 *     specific `unavailableTracesAccessor("fetch failed: …")` reason
 *     instead of a generic "no spans found"
 *
 * **Defaults are deliberately faster than the judge poller** in
 * `services/traces/tracePoller.ts`. The judge runs as a background
 * task while the user already sees a "pending" badge; ten minutes of
 * polling there is fine. The SDK fixture pre-load, however, is
 * synchronous inside the test body — every test waits on it before
 * its first assertion can run, so we cap the default budget at
 * ~10 seconds (10 × 1s). Users can still bump this via `tracePolling`
 * on the agent config or via `TRACE_POLL_INTERVAL_MS` /
 * `TRACE_POLL_MAX_ATTEMPTS` env vars (the same vars the judge poller
 * honours), and a hard `MAX_POLL_CEILING` mirrors the one in
 * `tracePoller.ts` so a misconfigured agent can't block a test for
 * an unbounded time.
 */
import type { Span } from '@/types';
import { debug } from '@/lib/debug';
import { fetchTracesByRunIds } from './index';

/**
 * Hard ceiling on `maxAttempts`, mirroring the constant in
 * `services/traces/tracePoller.ts`. Prevents a misconfigured agent
 * (e.g. `tracePolling.maxAttempts: 10_000`) from blocking a test body
 * indefinitely.
 */
export const SDK_TRACE_POLL_CEILING = 60;

const envInt = (name: string, fallback: number): number => {
  const raw = process.env?.[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Default interval between polling attempts. ~1s for SDK interactivity. */
export const SDK_DEFAULT_POLL_INTERVAL_MS = envInt('TRACE_POLL_INTERVAL_MS', 1000);
/** Default attempt budget. 10 attempts × ~1s ≈ 10s total for SDK pre-load. */
export const SDK_DEFAULT_MAX_ATTEMPTS = envInt('TRACE_POLL_MAX_ATTEMPTS', 10);

export interface FetchSpansForRunOptions {
  /** Total number of attempts. Capped at {@link SDK_TRACE_POLL_CEILING}. */
  maxAttempts?: number;
  /** Delay between attempts in ms. */
  intervalMs?: number;
}

export interface FetchSpansForRunResult {
  /** Spans returned on the first non-empty attempt, or `[]` on timeout / error. */
  spans: Span[];
  /**
   * If `spans` is empty, the message of the last error thrown by
   * `fetchTracesByRunIds` (auth failure, 5xx, network down, etc.).
   * `undefined` when polling completed without errors but the trace
   * backend simply had no spans for this `runId` yet — in that case the
   * caller should report a "no spans found" reason rather than a "fetch
   * failed" reason.
   */
  lastError?: string;
}

/**
 * Poll for spans associated with a single agent runId. Resolves with
 * the spans on the first non-empty fetch, or with `{ spans: [],
 * lastError? }` after `maxAttempts` of empty / failing responses.
 * Never throws.
 */
export async function fetchSpansForRun(
  runId: string,
  options: FetchSpansForRunOptions = {}
): Promise<FetchSpansForRunResult> {
  const requestedMax = options.maxAttempts ?? SDK_DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Math.max(1, Math.min(requestedMax, SDK_TRACE_POLL_CEILING));
  const intervalMs = Math.max(0, options.intervalMs ?? SDK_DEFAULT_POLL_INTERVAL_MS);

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fetchTracesByRunIds([runId]);
      if (result?.spans && result.spans.length > 0) {
        debug('FetchSpansForRun', `runId=${runId} attempt=${attempt} found ${result.spans.length} spans`);
        return { spans: result.spans };
      }
      // Successful fetch but no spans yet — clear any previous transient
      // error so the caller doesn't blame a long-since-recovered hiccup.
      lastError = undefined;
      debug('FetchSpansForRun', `runId=${runId} attempt=${attempt}/${maxAttempts} empty`);
    } catch (err) {
      // Capture the message but keep retrying — the caller decides
      // whether to surface it as `unavailableTracesAccessor` reason.
      lastError = err instanceof Error ? err.message : String(err);
      debug('FetchSpansForRun', `runId=${runId} attempt=${attempt} fetch error: ${lastError}`);
    }

    if (attempt < maxAttempts && intervalMs > 0) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  return { spans: [], lastError };
}
