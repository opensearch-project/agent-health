/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run-ingestion API — `RunSink` over HTTP (#612).
 *
 * An executor running outside this process (the CLI) persists its run through
 * these routes; each one is a thin wrapper over the server's `LocalRunSink`,
 * so a run ingested here is stored exactly like a run executed in-process.
 *
 *   POST  /api/runs/ingest                                  createRun       → { runId, executorToken }
 *   PUT   /api/runs/ingest/:runId/cases/:caseId/report      upsertCaseReport → { reportId, report }
 *   PATCH /api/runs/ingest/:runId/reports/:reportId         patchCaseReport → { ok: true }
 *   PATCH /api/runs/ingest/:runId/cases/:caseId/result      setCaseResult   → LeaseEcho
 *   POST  /api/runs/ingest/:runId/heartbeat                 heartbeat       → LeaseEcho
 *   POST  /api/runs/ingest/:runId/finalize                  finalize        → EvaluationRun
 *
 * Every mutation after `createRun` carries the executor token minted by
 * `createRun` in `X-AH-Executor`; it is required and echoed back, but not yet
 * checked against the run (lease fencing is the next step of #612).
 *
 * All writes are idempotent: a retried request after a lost response is a
 * no-op merge, never a duplicate (`reportId` is client-minted; `finalize`
 * recomputes from the persisted document).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getStorageModule } from '../adapters/index.js';
import { LocalRunSink, EXECUTOR_TOKEN_HEADER, type FinalizeInput, type RunSink } from '../../services/runSink.js';

const router = Router();

/** One sink per storage module instance (its report-id memo is per process). */
let cached: { storage: unknown; sink: RunSink } | undefined;
function sinkFor(storage: ReturnType<typeof getStorageModule>): RunSink {
  if (!cached || cached.storage !== storage) cached = { storage, sink: new LocalRunSink(storage) };
  return cached.sink;
}

function requireExecutorToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header(EXECUTOR_TOKEN_HEADER);
  if (!token) {
    res.status(400).json({ error: `Missing ${EXECUTOR_TOKEN_HEADER} header (the executor token returned by POST /api/runs/ingest)` });
    return;
  }
  res.setHeader(EXECUTOR_TOKEN_HEADER, token);
  next();
}

function fail(res: Response, error: any): void {
  const message = error?.message ?? String(error);
  const status = /not found/i.test(message) ? 404 : 500;
  console.error('[RunsIngest]', message);
  res.status(status).json({ error: message });
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

router.post('/api/runs/ingest', async (req: Request, res: Response) => {
  const run = req.body?.run;
  if (!isObject(run) || typeof run.id !== 'string' || !run.id) {
    return res.status(400).json({ error: 'body.run must be an evaluation run document with a string id' });
  }
  try {
    const created = await sinkFor(getStorageModule()).createRun(run as any);
    res.setHeader(EXECUTOR_TOKEN_HEADER, created.executorToken);
    res.status(201).json(created);
  } catch (error) {
    fail(res, error);
  }
});

router.put('/api/runs/ingest/:runId/cases/:caseId/report', requireExecutorToken, async (req: Request, res: Response) => {
  const { attempt, reportId, report } = req.body ?? {};
  if (typeof reportId !== 'string' || !reportId || !isObject(report)) {
    return res.status(400).json({ error: 'body.reportId (string) and body.report (object) are required' });
  }
  try {
    const saved = await sinkFor(getStorageModule()).upsertCaseReport({
      runId: req.params.runId,
      testCaseId: req.params.caseId,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
      reportId,
      report,
    });
    res.json(saved);
  } catch (error) {
    fail(res, error);
  }
});

router.patch('/api/runs/ingest/:runId/reports/:reportId', requireExecutorToken, async (req: Request, res: Response) => {
  const patch = req.body?.patch;
  if (!isObject(patch)) return res.status(400).json({ error: 'body.patch (object) is required' });
  try {
    await sinkFor(getStorageModule()).patchCaseReport(req.params.runId, req.params.reportId, patch);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error);
  }
});

router.patch('/api/runs/ingest/:runId/cases/:caseId/result', requireExecutorToken, async (req: Request, res: Response) => {
  const result = req.body?.result;
  if (!isObject(result) || typeof result.status !== 'string') {
    return res.status(400).json({ error: 'body.result (object with a status) is required' });
  }
  try {
    res.json(await sinkFor(getStorageModule()).setCaseResult(req.params.runId, req.params.caseId, result as any));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/runs/ingest/:runId/heartbeat', requireExecutorToken, async (req: Request, res: Response) => {
  try {
    res.json(await sinkFor(getStorageModule()).heartbeat(req.params.runId, req.body ?? {}));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/runs/ingest/:runId/finalize', requireExecutorToken, async (req: Request, res: Response) => {
  const input = req.body as FinalizeInput | undefined;
  const status = input?.status;
  if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
    return res.status(400).json({ error: "body.status must be 'completed', 'cancelled' or 'failed'" });
  }
  if (status === 'failed' && typeof (input as any).error !== 'string') {
    return res.status(400).json({ error: 'body.error (string) is required for status failed' });
  }
  if (status !== 'failed' && !isObject((input as any).completedRun)) {
    return res.status(400).json({ error: 'body.completedRun (object) is required for status completed/cancelled' });
  }
  try {
    res.json(await sinkFor(getStorageModule()).finalize(req.params.runId, input!));
  } catch (error) {
    fail(res, error);
  }
});

export default router;
