/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Routes — agentic deep-dive over two runs.
 *
 * ASYNC JOB PATTERN (iteration 5): the deep-dive generation takes ~50-180s
 * for a wide, comparison-wide analysis. The public tunnel proxy enforces a
 * gateway timeout SHORTER than that, so holding the generation inside one
 * long-lived POST (round-4's approach — an in-request deadline, still
 * present as a per-generation ceiling) dies with a 524 for tunnel users even
 * though localhost works. Fix: the POST kicks off generation in-process and
 * returns immediately; the client polls a job-status endpoint.
 *
 * POST /api/comparison/deep-dive
 *   body: { reportIds: [defaultReportIdA, defaultReportIdB], modelId?, systemPrompt?, rows? }
 *   Validates synchronously (400s) and resolves the two default reports
 *   synchronously (404 if either is missing) — exactly as before. On success,
 *   starts (or dedupes onto) a background job and returns immediately:
 *   resp: { jobId } (202 Accepted)
 *   A second POST for the SAME (reportIds, systemPrompt, rows) while a job
 *   for it is still `running` returns that SAME jobId rather than starting a
 *   second generation (see comparisonDeepDiveJobStore.computeDeepDiveDedupeKey).
 *   429 when already at the concurrency cap and there's no running job to
 *   dedupe onto (comparisonDeepDiveJobStore.DeepDiveJobCapacityError).
 *
 * GET /api/comparison/deep-dive/jobs/:jobId
 *   resp: { status: 'running'|'done'|'error', elapsedMs, result?, error? }
 *   `result` (only present when status === 'done') has the EXACT SAME shape
 *   the old synchronous POST used to return directly: { markdown, modelId,
 *   durationMs, chart?, experiments?, runs: [...] } — so the client's render
 *   path is unchanged, it just now reads `result` off a poll response
 *   instead of the POST response body.
 *   404 when jobId is unknown (never existed, or TTL-evicted after 30min).
 */

import { Router, Request, Response } from 'express';
import { getStorageModule } from '@/server/adapters';
import {
  generateComparisonDeepDive,
  type ComparisonRunInput,
  type ComparisonRowSummary,
  type ComparisonDeepDiveResult,
} from '@/server/services/comparisonDeepDiveService';
import { SYSTEM_PROMPT } from '@/server/services/comparisonDeepDiveService';
import type { CaseReportRef } from '@/server/services/comparisonTraceTools';
import { resolveReportTraceContext, extractToolNames, extractFinalOutput } from '@/server/services/comparisonCaseResolver';
import {
  DeepDiveJobStore,
  DeepDiveJobCapacityError,
  computeDeepDiveDedupeKey,
} from '@/server/services/comparisonDeepDiveJobStore';
import { debug } from '@/lib/debug';

const router = Router();

/** Owner-editable system-prompt cap: generous for a full rewrite, but bounded
 *  against pathological/abusive payloads (browser-cache-only feature — never
 *  persisted server-side). */
const SYSTEM_PROMPT_MAX_LEN = 20000;

/** Full-results-table cap — a benchmark-wide comparison could have hundreds
 *  of rows; the client already caps at this size (ComparisonDeepDive.tsx),
 *  this is the server-side backstop against a malformed/oversized payload. */
const MAX_ROWS_SUMMARY = 500;
const MAX_ROW_NAME_LEN = 200;
/** Server-side defense-in-depth cap on id-shaped fields within a row
 *  (testCaseId, and each side's reportId) — real ids from this app are far
 *  shorter; anything past this is either malformed or a deliberately
 *  oversized payload. A row failing this check is dropped silently, same as
 *  any other malformed row (see sanitizeRow) — the results table is a
 *  best-effort hint, not the core reportIds contract. */
const MAX_ROW_ID_LEN = 128;
/** Hard cap on the TOTAL serialized size of the raw `rows` payload (before
 *  any per-entry sanitization) — the per-entry count cap above bounds the
 *  number of rows, but not how large each one could be crafted to be (e.g.
 *  very long testCaseName/testCaseId/reportId strings). 256KB is generous
 *  for even a full 500-row table of realistic names, but bounds worst-case
 *  request body size a client could otherwise inflate arbitrarily. */
const MAX_ROWS_PAYLOAD_BYTES = 256 * 1024;

/** One (case, side) window-agent hint the trace tools actually resolved during a generation — same shape the client has always rendered. */
interface DeepDiveRunMeta {
  key: string;
  caseId?: string;
  reportId?: string;
  runId?: string;
  serviceName?: string;
  startedAt?: number;
  endedAt?: number;
}

/** The full response body shape — identical to what the (pre-iteration-5) synchronous POST used to return, and what GET .../jobs/:jobId now returns under `result` once `status === 'done'`. */
type DeepDiveJobResult = ComparisonDeepDiveResult & { runs: DeepDiveRunMeta[] };

/** Module-level singleton — one job store per server process, matching the pre-existing in-memory-only, no-persistence-needed nature of the deep-dive cache (client-side localStorage is the durable cache; this is purely in-flight bookkeeping). */
const deepDiveJobStore = new DeepDiveJobStore<DeepDiveJobResult>();

/** One side of a raw client-supplied results-table row, loosely typed pre-validation. */
interface RawRowSide {
  passFailStatus?: unknown;
  score?: unknown;
  reportId?: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** Validate + sanitize one client-supplied results-table row. Returns undefined (drop) for a malformed row — including one whose testCaseId or either side's reportId exceeds {@link MAX_ROW_ID_LEN} — rather than 400ing the whole request, since the results table is a best-effort comparison-wide hint, not the core reportIds contract. */
function sanitizeRow(raw: unknown): ComparisonRowSummary | undefined {
  if (!isPlainObject(raw) || typeof raw.testCaseId !== 'string' || !raw.testCaseId) return undefined;
  if (raw.testCaseId.length > MAX_ROW_ID_LEN) return undefined;
  let sideExceedsIdCap = false;
  const sanitizeSide = (side: unknown): { passFailStatus?: string; score?: number; reportId?: string } | undefined => {
    if (!isPlainObject(side)) return undefined;
    const s = side as RawRowSide;
    const out: { passFailStatus?: string; score?: number; reportId?: string } = {};
    if (typeof s.passFailStatus === 'string') out.passFailStatus = s.passFailStatus;
    if (typeof s.score === 'number' && Number.isFinite(s.score)) out.score = s.score;
    if (typeof s.reportId === 'string' && s.reportId) {
      if (s.reportId.length > MAX_ROW_ID_LEN) {
        sideExceedsIdCap = true;
      } else {
        out.reportId = s.reportId;
      }
    }
    return out;
  };
  const a = sanitizeSide(raw.a);
  const b = sanitizeSide(raw.b);
  // Either side's reportId being oversized drops the WHOLE row (same
  // treatment as an oversized testCaseId) rather than silently continuing
  // with a truncated/partial reportId that could resolve to the WRONG report.
  if (sideExceedsIdCap) return undefined;
  return {
    testCaseId: raw.testCaseId,
    testCaseName: typeof raw.testCaseName === 'string' && raw.testCaseName
      ? raw.testCaseName.slice(0, MAX_ROW_NAME_LEN)
      : raw.testCaseId,
    a,
    b,
  };
}

/**
 * GET /api/comparison/deep-dive/system-prompt
 *   resp: { systemPrompt: string }
 *
 * Serves the built-in SYSTEM_PROMPT so the client's editable disclosure can
 * prefill with the real default (rather than duplicating it in frontend
 * source) and offer an accurate "Reset to default".
 */
router.get('/api/comparison/deep-dive/system-prompt', (_req: Request, res: Response) => {
  return res.json({ systemPrompt: SYSTEM_PROMPT });
});

router.post('/api/comparison/deep-dive', async (req: Request, res: Response) => {
  const { reportIds, modelId, systemPrompt, rows } = (req.body || {}) as {
    reportIds?: unknown;
    modelId?: string;
    systemPrompt?: unknown;
    rows?: unknown;
  };
  if (!Array.isArray(reportIds) || reportIds.length !== 2 || !reportIds.every((x) => typeof x === 'string')) {
    return res.status(400).json({ error: 'reportIds must be an array of exactly 2 report id strings' });
  }
  let trimmedSystemPrompt: string | undefined;
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string') {
      return res.status(400).json({ error: 'systemPrompt must be a string' });
    }
    trimmedSystemPrompt = systemPrompt.trim();
    if (trimmedSystemPrompt.length === 0) {
      return res.status(400).json({ error: 'systemPrompt must not be empty' });
    }
    if (trimmedSystemPrompt.length > SYSTEM_PROMPT_MAX_LEN) {
      return res.status(400).json({ error: `systemPrompt must be at most ${SYSTEM_PROMPT_MAX_LEN} characters` });
    }
  }
  let rowsSummary: ComparisonRowSummary[] | undefined;
  if (rows !== undefined) {
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows must be an array' });
    }
    if (rows.length > MAX_ROWS_SUMMARY) {
      return res.status(400).json({ error: `rows must contain at most ${MAX_ROWS_SUMMARY} entries` });
    }
    const rowsPayloadBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    if (rowsPayloadBytes > MAX_ROWS_PAYLOAD_BYTES) {
      return res.status(400).json({ error: `rows payload too large (${rowsPayloadBytes} bytes, max ${MAX_ROWS_PAYLOAD_BYTES})` });
    }
    rowsSummary = rows.map(sanitizeRow).filter((r): r is ComparisonRowSummary => r !== undefined);
  }

  try {
    const storage = getStorageModule();

    // Lazy, memoized report fetch shared by the default-case resolution below
    // AND the trace tools' per-case resolution (comparisonTraceTools.ts) — a
    // case the agent never asks about never triggers a fetch.
    const reportCache = new Map<string, any | null>();
    const getReport = async (id: string): Promise<any | null> => {
      if (reportCache.has(id)) return reportCache.get(id);
      const r = await storage.runs.getById(id);
      reportCache.set(id, r ?? null);
      return r ?? null;
    };

    const defaultReports = await Promise.all((reportIds as string[]).map((id) => getReport(id)));
    const missing = reportIds.filter((_, i) => !defaultReports[i]);
    if (missing.length) {
      return res.status(404).json({ error: `report(s) not found: ${missing.join(', ')}` });
    }

    const keys = ['A', 'B'] as const;
    const runInputs: ComparisonRunInput[] = defaultReports.map((report: any, i) => {
      const ctx = resolveReportTraceContext(report);
      return {
        key: keys[i],
        label: report.agentName || report.agentKey || `Run ${keys[i]}`,
        reportId: reportIds[i] as string,
        runId: ctx.runId,
        agents: ctx.agents,
        passFailStatus: report.passFailStatus,
        accuracy: report?.metrics?.accuracy,
        toolNames: extractToolNames(report),
        durationMs: report?.performanceMetrics?.durationMs,
        finalOutput: extractFinalOutput(report),
      };
    });

    // testCaseId of the default case — read straight off either report
    // (both sides evaluated the same case for this pair) rather than trusting
    // the client to send it separately.
    const defaultCaseId: string =
      defaultReports[0]?.testCaseId || defaultReports[1]?.testCaseId || (reportIds[0] as string);

    // Comparison-wide tracing: testCaseId -> per-side reportId, for EVERY
    // case in the results table — lets the trace tools resolve any row's
    // trace identity on demand (see comparisonTraceTools.ts). Seeded with the
    // default pair so query_spans({caseId: defaultCaseId}) always resolves,
    // even if `rows` was omitted or the default case fell outside the cap.
    const caseReports = new Map<string, CaseReportRef>();
    for (const row of rowsSummary || []) {
      caseReports.set(row.testCaseId, { a: row.a?.reportId, b: row.b?.reportId });
    }
    const existingDefault = caseReports.get(defaultCaseId) || {};
    caseReports.set(defaultCaseId, {
      a: existingDefault.a ?? (reportIds[0] as string),
      b: existingDefault.b ?? (reportIds[1] as string),
    });

    debug(
      'CompareDeepDiveAPI',
      'default reports:',
      reportIds.join(','),
      'defaultCaseId:',
      defaultCaseId,
      'cases available for wide tracing:',
      caseReports.size
    );

    const dedupeKey = computeDeepDiveDedupeKey(reportIds as string[], trimmedSystemPrompt, rowsSummary);

    let jobId: string;
    let deduped: boolean;
    try {
      const started = deepDiveJobStore.start(dedupeKey, async (): Promise<DeepDiveJobResult> => {
        const result = await generateComparisonDeepDive({
          runs: runInputs,
          defaultCaseId,
          caseReports,
          getReport,
          modelId,
          systemPrompt: trimmedSystemPrompt,
          rows: rowsSummary,
        });
        // runs[] meta: only the (case, side) pairs the agent actually
        // queried — each already carries the window-agent hints the Traces
        // tab needs (keyed by reportId, which the client maps generically
        // regardless of how many entries there are). Same shape the old
        // synchronous response returned.
        const runMeta: DeepDiveRunMeta[] = result.visitedCases.map((v) => ({
          key: v.key,
          caseId: v.caseId,
          reportId: v.reportId,
          runId: v.runId,
          serviceName: v.serviceName,
          startedAt: v.startedAt,
          endedAt: v.endedAt,
        }));
        return { ...result, runs: runMeta };
      });
      jobId = started.jobId;
      deduped = started.deduped;
    } catch (capacityErr) {
      if (capacityErr instanceof DeepDiveJobCapacityError) {
        return res.status(429).json({ error: capacityErr.message });
      }
      throw capacityErr;
    }

    debug('CompareDeepDiveAPI', 'job', jobId, deduped ? '(deduped onto existing running job)' : '(new)');
    return res.status(202).json({ jobId });
  } catch (err: any) {
    console.error('[CompareDeepDiveAPI] error:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * GET /api/comparison/deep-dive/jobs/:jobId
 * See module doc comment above for the response contract.
 */
router.get('/api/comparison/deep-dive/jobs/:jobId', (req: Request, res: Response) => {
  const job = deepDiveJobStore.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: `job not found: ${req.params.jobId}` });
  }
  const elapsedMs = (job.completedAt ?? Date.now()) - job.startedAt;
  if (job.status === 'running') {
    return res.json({ status: 'running', elapsedMs });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', elapsedMs, error: job.error });
  }
  return res.json({ status: 'done', elapsedMs, result: job.result });
});

export default router;
