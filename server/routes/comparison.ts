/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Routes — agentic deep-dive over two runs.
 *
 * POST /api/comparison/deep-dive
 *   body: { reportIds: [defaultReportIdA, defaultReportIdB], modelId?, systemPrompt?, rows? }
 *   resp: { markdown, modelId, durationMs,
 *           chart?: { title, series: [{ label, a, b, unit? }] },
 *           experiments?: [{ title, rationale }],
 *           runs: [{ key, caseId, reportId, runId, serviceName, startedAt, endedAt }] }
 *
 * `reportIds` names the DEFAULT case (used by the trace tools when the agent
 * omits `caseId`) — resolved eagerly, same as before. `rows[]` (optional, see
 * comparisonDeepDiveService.ComparisonRowSummary) now also carries each side's
 * reportId per case, which THIS round's comparison-wide tracing uses to
 * resolve any OTHER case's trace identity lazily, one report at a time, only
 * when the agent actually asks for it (never prefetched for every row).
 *
 * The returned `runs[]` are only the (case, side) pairs the agent actually
 * queried during this generation — exactly the window-agent hints the
 * frontend needs to deep-link each span citation into the Traces tab of the
 * RIGHT case row.
 */

import { Router, Request, Response } from 'express';
import { getStorageModule } from '@/server/adapters';
import {
  generateComparisonDeepDive,
  type ComparisonRunInput,
  type ComparisonRowSummary,
} from '@/server/services/comparisonDeepDiveService';
import { SYSTEM_PROMPT } from '@/server/services/comparisonDeepDiveService';
import type { CaseReportRef } from '@/server/services/comparisonTraceTools';
import { resolveReportTraceContext, extractToolNames, extractFinalOutput } from '@/server/services/comparisonCaseResolver';
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

/** One side of a raw client-supplied results-table row, loosely typed pre-validation. */
interface RawRowSide {
  passFailStatus?: unknown;
  score?: unknown;
  reportId?: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** Validate + sanitize one client-supplied results-table row. Returns undefined (drop) for a malformed row rather than 400ing the whole request — the table is a best-effort comparison-wide hint, not the core reportIds contract. */
function sanitizeRow(raw: unknown): ComparisonRowSummary | undefined {
  if (!isPlainObject(raw) || typeof raw.testCaseId !== 'string' || !raw.testCaseId) return undefined;
  const sanitizeSide = (side: unknown): { passFailStatus?: string; score?: number; reportId?: string } | undefined => {
    if (!isPlainObject(side)) return undefined;
    const s = side as RawRowSide;
    const out: { passFailStatus?: string; score?: number; reportId?: string } = {};
    if (typeof s.passFailStatus === 'string') out.passFailStatus = s.passFailStatus;
    if (typeof s.score === 'number' && Number.isFinite(s.score)) out.score = s.score;
    if (typeof s.reportId === 'string' && s.reportId) out.reportId = s.reportId;
    return out;
  };
  return {
    testCaseId: raw.testCaseId,
    testCaseName: typeof raw.testCaseName === 'string' && raw.testCaseName
      ? raw.testCaseName.slice(0, MAX_ROW_NAME_LEN)
      : raw.testCaseId,
    a: sanitizeSide(raw.a),
    b: sanitizeSide(raw.b),
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

    const result = await generateComparisonDeepDive({
      runs: runInputs,
      defaultCaseId,
      caseReports,
      getReport,
      modelId,
      systemPrompt: trimmedSystemPrompt,
      rows: rowsSummary,
    });

    // runs[] meta: only the (case, side) pairs the agent actually queried —
    // each already carries the window-agent hints the Traces tab needs
    // (keyed by reportId, which the client maps generically regardless of
    // how many entries there are).
    const runMeta = result.visitedCases.map((v) => ({
      key: v.key,
      caseId: v.caseId,
      reportId: v.reportId,
      runId: v.runId,
      serviceName: v.serviceName,
      startedAt: v.startedAt,
      endedAt: v.endedAt,
    }));

    return res.json({ ...result, runs: runMeta });
  } catch (err: any) {
    console.error('[CompareDeepDiveAPI] error:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
