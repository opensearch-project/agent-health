/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trace polling recovery on server boot.
 *
 * The `tracePollingManager` (services/traces/tracePoller.ts) keeps poll
 * state in an in-memory `Map`. When the server restarts mid-poll (deploy,
 * crash, OOM, kill), every report that was waiting for traces is left in
 * `metricsStatus: 'pending'` forever \u2014 nothing on the backend will move
 * it.
 *
 * This module is invoked once after `app.listen()` succeeds. It:
 *   1. Pages through every run.
 *   2. For each run with `metricsStatus === 'pending' | 'calculating'`:
 *        a. If it is younger than `TRACE_RECOVERY_MIN_AGE_MS`, skip it — it is
 *           presumed in-flight (possibly on a sibling server sharing the
 *           storage cluster).
 *        b. If it is recent (within `TRACE_RECOVERY_MAX_AGE_MS`), re-start
 *           trace polling — with or without a `runId`; the poller falls back
 *           to sessionId/service-window correlation hints. Once traces land,
 *           the existing poller callback runs the judge and writes
 *           `ready`/`error`.
 *        c. Otherwise (too old), mark it `error` so the UI no longer shows
 *           PENDING and the parent benchmark stats are updated.
 *
 * The function is fire-and-forget and never throws \u2014 a recovery failure
 * must not prevent the server from serving requests.
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationReport, TestCase } from '../../types/index.js';
import { startTracePollingForReportWithModule } from '../../services/benchmarkRunner.js';

/** Maximum age (ms since report.timestamp) for which we will re-attempt polling. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Minimum age below which a pending report is presumed in-flight and skipped. */
const DEFAULT_MIN_AGE_MS = 15 * 60 * 1000; // 15 minutes

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface RecoveryStat {
  scanned: number;
  pendingFound: number;
  resumed: number;
  failedOut: number;
  errors: number;
  durationMs: number;
}

/**
 * Scan storage for orphan pending/calculating reports and either resume
 * polling or mark them as error. Idempotent and safe to run on every boot.
 *
 * Behaviour can be tuned via env vars:
 *   - `TRACE_RECOVERY_MAX_AGE_MS` (default 24h): reports older than this
 *     since their `timestamp` are marked error rather than re-polled.
 *   - `TRACE_RECOVERY_PAGE_SIZE` (default 200): page size for scanning.
 *   - `TRACE_RECOVERY_DISABLED=1`: skip recovery entirely (for tests / CI).
 */
export async function resumePendingTracePolls(storage: IStorageModule): Promise<RecoveryStat> {
  const startedAt = Date.now();
  const stat: RecoveryStat = {
    scanned: 0,
    pendingFound: 0,
    resumed: 0,
    failedOut: 0,
    errors: 0,
    durationMs: 0,
  };

  if (process.env.TRACE_RECOVERY_DISABLED === '1') {
    stat.durationMs = Date.now() - startedAt;
    return stat;
  }

  const maxAgeMs = envInt('TRACE_RECOVERY_MAX_AGE_MS', DEFAULT_MAX_AGE_MS);
  // Reports younger than this are skipped entirely (likely in-flight; see
  // grace-window comment below). Default 15 min ~= the poll budget + slack.
  const minAgeMs = envInt('TRACE_RECOVERY_MIN_AGE_MS', DEFAULT_MIN_AGE_MS);
  const pageSize = envInt('TRACE_RECOVERY_PAGE_SIZE', 200);
  // Hard-cap pagination so a misconfigured store doesn't loop forever.
  const maxPages = envInt('TRACE_RECOVERY_MAX_PAGES', 50);

  const now = Date.now();

  // Cache test cases we've already loaded \u2014 several reports usually share
  // the same test case in benchmarks.
  const testCaseCache = new Map<string, TestCase | null>();

  let from = 0;
  for (let page = 0; page < maxPages; page++) {
    let items: EvaluationReport[];
    try {
      const result = await storage.runs.getAll({ from, size: pageSize });
      items = result.items as EvaluationReport[];
    } catch (err: any) {
      stat.errors++;
      console.warn(`[traceRecovery] getAll failed at from=${from}: ${err?.message || err}`);
      break;
    }

    if (!items || items.length === 0) break;
    stat.scanned += items.length;

    for (const report of items) {
      const ms = report.metricsStatus;
      if (ms !== 'pending' && ms !== 'calculating') continue;
      stat.pendingFound++;

      const reportTs = new Date(report.timestamp || 0).getTime();
      // If the timestamp is missing or invalid, treat the report as freshly
      // created (ageMs = 0) rather than infinitely old. The previous
      // `Infinity` default flipped `tooOld` to true unconditionally for any
      // report with a missing/zero timestamp, marking even just-created
      // reports as error during boot recovery. Treating missing timestamps
      // as recent is the safe direction — a real orphaned report will fail
      // its judge call on retry and end up in error anyway, but a healthy
      // newly-created report won't be falsely tombstoned.
      const ageMs = Number.isFinite(reportTs) && reportTs > 0 ? now - reportTs : 0;
      const tooOld = ageMs > maxAgeMs;

      // Grace window: a *young* pending report is very likely in-flight --
      // either on this server (created while this very scan pages through the
      // index) or on a SIBLING agent-health server pointed at the same shared
      // storage cluster. Tombstoning it kills a healthy run's report
      // (2026-08-25: a boot recovery marked in-flight placeholders of a
      // running benchmark as error mid-run). Leave young reports alone -- if
      // genuinely orphaned they are settled on a later boot, once aged past
      // the grace window.
      if (ageMs < minAgeMs) {
        continue;
      }

      // Branch 1: too old -- mark error and update parent stats. A missing
      // runId is NO LONGER disqualifying: the trace poller now correlates via
      // sessionId/service-window hints derived from the report itself
      // (REST-connector reports never carry a runId), so no-runId reports
      // flow into Branch 2 and have their polling resumed.
      if (tooOld) {
        const reason = `Report older than ${Math.round(maxAgeMs / 60000)}m; trace ingestion window has elapsed`;
        try {
          await storage.runs.update(report.id, {
            metricsStatus: 'error',
            traceError: `${reason} \u2014 marked error during boot recovery`,
          } as Partial<EvaluationReport>);
          stat.failedOut++;
          console.log(`[traceRecovery] Marked report ${report.id} as error (${reason})`);
        } catch (err: any) {
          stat.errors++;
          console.warn(`[traceRecovery] Failed to mark report ${report.id} as error: ${err?.message || err}`);
        }
        continue;
      }

      // Branch 2: resume polling. Need the test case for the judge callback.
      let testCase: TestCase | null | undefined = testCaseCache.get(report.testCaseId);
      if (testCase === undefined) {
        try {
          testCase = (await storage.testCases.getById(report.testCaseId)) || null;
        } catch (err: any) {
          stat.errors++;
          console.warn(`[traceRecovery] Failed to load test case ${report.testCaseId} for report ${report.id}: ${err?.message || err}`);
          testCase = null;
        }
        testCaseCache.set(report.testCaseId, testCase);
      }

      if (!testCase) {
        // No test case to judge against \u2014 cannot recover
        try {
          await storage.runs.update(report.id, {
            metricsStatus: 'error',
            traceError: `Test case ${report.testCaseId} no longer exists \u2014 cannot resume polling after restart`,
          } as Partial<EvaluationReport>);
          stat.failedOut++;
        } catch (err: any) {
          stat.errors++;
          console.warn(`[traceRecovery] Failed to mark report ${report.id} as error: ${err?.message || err}`);
        }
        continue;
      }

      // Re-attach polling. Fire-and-forget \u2014 startPollingAsync's promise
      // is consumed inside benchmarkRunner; here we don't need to await.
      try {
        startTracePollingForReportWithModule(report, testCase, storage).catch(err => {
          // The poller already writes metricsStatus=error on terminal
          // failures; this catch only swallows the rejection so an
          // unhandled-rejection warning isn't logged.
          console.warn(`[traceRecovery] Polling for report ${report.id} ended with error: ${err?.message || err}`);
        });
        stat.resumed++;
        console.log(`[traceRecovery] Resumed polling for report ${report.id} (runId=${report.runId})`);
      } catch (err: any) {
        stat.errors++;
        console.warn(`[traceRecovery] Failed to start polling for report ${report.id}: ${err?.message || err}`);
      }
    }

    if (items.length < pageSize) break;
    from += pageSize;
  }

  stat.durationMs = Date.now() - startedAt;
  return stat;
}

/**
 * Wrapper that logs a single summary line and never throws.
 * Suitable for fire-and-forget invocation from `startServer()`.
 */
export async function resumePendingTracePollsSafely(storage: IStorageModule): Promise<void> {
  try {
    const stat = await resumePendingTracePolls(storage);
    if (stat.pendingFound === 0 && stat.errors === 0) {
      console.log(
        `[traceRecovery] scanned=${stat.scanned} no orphan pending reports [${stat.durationMs}ms]`
      );
    } else {
      console.log(
        `[traceRecovery] scanned=${stat.scanned} pending=${stat.pendingFound} ` +
        `resumed=${stat.resumed} failedOut=${stat.failedOut} errors=${stat.errors} [${stat.durationMs}ms]`
      );
    }
  } catch (err: any) {
    console.warn(`[traceRecovery] Unhandled failure: ${err?.message || err}`);
  }
}
