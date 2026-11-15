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
 *   POST  /api/runs/ingest                                  createRun       → { runId, executorToken, lease }
 *         (also links the run's cases into `run.benchmarkId` and stamps the
 *         benchmark image — server/services/runBookkeeping.ts)
 *   PUT   /api/runs/ingest/:runId/cases/:caseId/report      upsertCaseReport → { reportId, report }
 *   PATCH /api/runs/ingest/:runId/reports/:reportId         patchCaseReport → { ok: true }
 *   PATCH /api/runs/ingest/:runId/cases/:caseId/result      setCaseResult   → LeaseEcho
 *   POST  /api/runs/ingest/:runId/heartbeat                 heartbeat       → LeaseEcho
 *   POST  /api/runs/ingest/:runId/finalize                  finalize        → EvaluationRun
 *
 * Every mutation after `createRun` carries the executor token in
 * `X-AH-Executor` (and the lease generation it holds in
 * `X-AH-Lease-Generation`, default 1). The token is minted by the server on
 * `createRun` unless the executor sends its own (32-hex) in the same header:
 * then a retried create with that token is answered with the existing lease
 * (200), and a create for a run id that already exists under another token
 * — or with no token — is refused with 409 `run-exists`. Each write is FENCED on them
 * (lib/runLease.ts): the sink's compare-and-swap refuses a write whose
 * token/generation no longer match the run, or whose run is no longer
 * `running`, with `409 { error: 'lease-lost', generation, at, status }`.
 * `createRun` is refused with 503 while the server is draining.
 *
 * All writes are idempotent: a retried request after a lost response is a
 * no-op merge, never a duplicate (`reportId` is client-minted; `finalize`
 * recomputes from the persisted document; a retried finalize by the same
 * executor returns the terminal state it already wrote).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getStorageModule } from '../adapters/index.js';
import { LocalRunSink, EXECUTOR_TOKEN_HEADER, LEASE_GENERATION_HEADER, type CreatedRun, type FinalizeInput } from '../../services/runSink.js';
import { isLeaseLostError } from '../../lib/runLease.js';
import { refuseWhenDraining } from '../services/serverDrain.js';
import { performIngestedRunBookkeeping } from '../services/runBookkeeping.js';

const router = Router();

/** One sink per storage module instance (its report-id memo is per process). */
let cached: { storage: unknown; sink: LocalRunSink } | undefined;
function baseSink(storage: ReturnType<typeof getStorageModule>): LocalRunSink {
  // Runs ingested here are executed by another process (the CLI); its version
  // travels in the create body.
  if (!cached || cached.storage !== storage) cached = { storage, sink: new LocalRunSink(storage, { executorKind: 'cli' }) };
  return cached.sink;
}

/** The sink bound to the executor THIS request speaks for. */
function sinkFor(req: Request): LocalRunSink {
  const token = req.header(EXECUTOR_TOKEN_HEADER)!;
  const generation = Number.parseInt(req.header(LEASE_GENERATION_HEADER) ?? '1', 10);
  return baseSink(getStorageModule()).forExecutor({ executorId: token, generation });
}

function requireExecutorToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.header(EXECUTOR_TOKEN_HEADER);
  if (!token) {
    res.status(400).json({ error: `Missing ${EXECUTOR_TOKEN_HEADER} header (the executor token returned by POST /api/runs/ingest)` });
    return;
  }
  const generation = req.header(LEASE_GENERATION_HEADER);
  if (generation !== undefined && !(/^[1-9]\d*$/.test(generation) && Number.isSafeInteger(Number(generation)))) {
    res.status(400).json({ error: `${LEASE_GENERATION_HEADER} must be a positive safe integer when given` });
    return;
  }
  res.setHeader(EXECUTOR_TOKEN_HEADER, token);
  next();
}

function fail(res: Response, error: any): void {
  if (isLeaseLostError(error)) {
    // The run no longer belongs to this executor: swept as lost, finished,
    // or cancelled by a fallback path. Nothing was written.
    res.status(409).json(error.info);
    return;
  }
  const message = error?.message ?? String(error);
  const status = /not found/i.test(message) ? 404 : 500;
  console.error('[RunsIngest]', message);
  res.status(status).json({ error: message });
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/** `EvaluationRun.results[*].status` values (types/index.ts `RunResultStatus`). */
const CASE_RESULT_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

/** Executor tokens are 128-bit hex (`mintExecutorToken`); anything else is refused. */
const EXECUTOR_TOKEN_RE = /^[0-9a-f]{32}$/;

router.post('/api/runs/ingest', refuseWhenDraining, async (req: Request, res: Response) => {
  const run = req.body?.run;
  if (!isObject(run) || typeof run.id !== 'string' || !run.id) {
    return res.status(400).json({ error: 'body.run must be an evaluation run document with a string id' });
  }
  const executorVersion = req.body?.executor?.version;
  if (executorVersion !== undefined && !(typeof executorVersion === 'string' && /^[\x21-\x7e]{1,64}$/.test(executorVersion))) {
    return res.status(400).json({ error: 'body.executor.version must be a printable string of at most 64 characters when given' });
  }
  // An executor may mint its own token and send it on create. That is what
  // makes a RETRIED create (the answer to the first one was lost) safe: the
  // same token on an existing document is the same executor asking again
  // and gets its lease back; any other token — or none — on an existing
  // document is a different caller and is refused, so a create can never
  // take over a run that is executing, nor reset one that has finished.
  const token = req.header(EXECUTOR_TOKEN_HEADER);
  if (token !== undefined && !EXECUTOR_TOKEN_RE.test(token)) {
    return res.status(400).json({ error: `${EXECUTOR_TOKEN_HEADER} must be a 32-character lowercase hex token when given on create` });
  }
  try {
    const storage = getStorageModule();
    const existing = await storage.evaluationRuns.getById(run.id);
    if (existing) {
      if (token && existing.executor?.id === token && existing.lease) {
        res.setHeader(EXECUTOR_TOKEN_HEADER, token);
        return res.status(200).json({ runId: existing.id, executorToken: token, lease: existing.lease } satisfies CreatedRun);
      }
      return res.status(409).json({ error: 'run-exists', runId: existing.id, status: existing.status });
    }
    // Same storage-side bookkeeping a server-executed run gets at creation:
    // the parent benchmark stays linked to the run's cases and the run's
    // judge conditions are stamped as a benchmark image. The executor only
    // ever ships the run document; the links are the server's job.
    const { imageDigest } = await performIngestedRunBookkeeping(storage, run as any);
    if (imageDigest) run.imageDigest = imageDigest;
    const sink = new LocalRunSink(storage, { executorKind: 'cli', executorVersion, executorToken: token });
    const created = await sink.createRun(run as any);
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
  // A report may only name the run / case of the URL it is written under.
  if (report.experimentRunId !== undefined && report.experimentRunId !== req.params.runId) {
    return res.status(400).json({ error: `body.report.experimentRunId (${report.experimentRunId}) does not match the run in the URL` });
  }
  if (report.testCaseId !== undefined && report.testCaseId !== req.params.caseId) {
    return res.status(400).json({ error: `body.report.testCaseId (${report.testCaseId}) does not match the case in the URL` });
  }
  if (attempt !== undefined && !(Number.isInteger(attempt) && attempt > 0)) {
    return res.status(400).json({ error: 'body.attempt must be a positive integer when given' });
  }
  try {
    const saved = await sinkFor(req).upsertCaseReport({
      runId: req.params.runId,
      testCaseId: req.params.caseId,
      attempt: attempt ?? 1,
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
    await sinkFor(req).patchCaseReport(req.params.runId, req.params.reportId, patch);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error);
  }
});

router.patch('/api/runs/ingest/:runId/cases/:caseId/result', requireExecutorToken, async (req: Request, res: Response) => {
  const result = req.body?.result;
  if (!isObject(result) || !CASE_RESULT_STATUSES.has(result.status)) {
    return res.status(400).json({ error: `body.result.status must be one of ${[...CASE_RESULT_STATUSES].join(', ')}` });
  }
  try {
    res.json(await sinkFor(req).setCaseResult(req.params.runId, req.params.caseId, result as any));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/runs/ingest/:runId/heartbeat', requireExecutorToken, async (req: Request, res: Response) => {
  try {
    res.json(await sinkFor(req).heartbeat(req.params.runId, req.body ?? {}));
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
    res.json(await sinkFor(req).finalize(req.params.runId, input!));
  } catch (error) {
    fail(res, error);
  }
});

export default router;
