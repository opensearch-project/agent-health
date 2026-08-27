/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response } from 'express';
import { BenchmarkRun, EvaluationRun, TestCaseSource, TestCaseSnapshot } from '../../../types/index.js';
import { getStorageModule } from '../../adapters/index.js';
import type { IStorageModule } from '../../adapters/types.js';
import { resolveTestCaseSources } from '../../../services/sourceResolver.js';
import {
  executeEvaluationRun,
  createCancellationToken,
  CancellationToken,
} from '../../../services/evaluationRunner.js';
import { promoteRunToBenchmark } from '../../../services/benchmarkPromotion.js';
import { loadConfigSync } from '../../../lib/config/index.js';
import { getCustomAgents } from '../../services/customAgentStore.js';
import { resolveAgentModel } from '../../../lib/resolveAgentModel.js';

const router = Router();

// Registry of active cancellation tokens for in-progress runs
const activeCancellationTokens = new Map<string, CancellationToken>();

/**
 * Compute which test cases of a run are resumable: every snapshot test case
 * whose result has no persisted report. Covers `pending` (never started),
 * `running` (interrupted mid-flight), and `failed`-without-report (crash /
 * cancellation) entries — anything WITH a reportId is preserved as-is.
 *
 * RedKite-style checkpoint semantics: the per-test-case reports persisted in
 * storage ARE the checkpoint; resume skips whatever already checkpointed.
 */
export function computeResumableTestCaseIds(run: Pick<EvaluationRun, 'testCaseSnapshots' | 'results'>): string[] {
  const results = run.results || {};
  return (run.testCaseSnapshots || [])
    .map((s) => s.id)
    .filter((id) => !results[id]?.reportId);
}

/**
 * Is this evaluation run actively executing in the current server process?
 * Used by boot recovery to avoid failing runs owned by this process.
 */
export function isEvaluationRunActiveInThisProcess(runId: string): boolean {
  return activeCancellationTokens.has(runId);
}

/**
 * Project a finished EvaluationRun into the embedded BenchmarkRun shape that
 * `benchmark.runs` stores. Used today by the resume completion path only —
 * the create route's success path has its own separate (not yet unified)
 * copy of this projection, added by the still-open, unmerged PR #399. Once
 * that lands, the create route should switch to this helper so both paths
 * can't drift again; until then this is NOT a single source of truth, just
 * the resume path's own copy kept honest by tests.
 */
export function buildBenchmarkRunProjection(run: EvaluationRun, completedAt: string): BenchmarkRun {
  return {
    id: run.id,
    name: run.name,
    createdAt: run.createdAt,
    completedAt,
    status: run.status,
    agentKey: run.agentKey,
    modelId: run.modelId,
    judgeModelId: run.judgeModelId,
    results: run.results,
    stats: run.stats,
    // Explicit `!= null` (not truthy) checks: a truthy check would silently
    // drop legitimately-meaningful falsy values, e.g. `concurrency: 0`
    // (sequential execution, a real configured value) or an intentionally
    // empty `description`/`evaluatorId` string (codex_review finding).
    ...(run.description != null ? { description: run.description } : {}),
    ...(run.evaluatorId != null ? { evaluatorId: run.evaluatorId } : {}),
    ...(run.headers != null ? { headers: run.headers } : {}),
    ...(run.concurrency != null ? { concurrency: run.concurrency } : {}),
    testCaseSnapshots: run.testCaseSnapshots,
  } as BenchmarkRun;
}

/**
 * Keep `benchmark.runs` (the embedded projection both the benchmark detail
 * page and the scoped comparison pool read) in sync with a just-completed
 * evaluation run, without ever producing two entries for the same run id in
 * the common case.
 *
 * Bug this guards against (found in production, hit twice): the create
 * route's success path calls its own equivalent of this on every completion,
 * but until this fix the resume route's completion path never did — so a run
 * whose *original* create-route execution crashed before reaching its
 * success branch (no `addRun` ever happened) stayed invisible in
 * `benchmark.runs` forever, even after a later `POST .../resume` finished it
 * successfully. `GET /api/storage/evaluation-runs/:id` and the Evaluation
 * Runs page read the evaluation-run document directly, so they looked fine —
 * only the benchmark-scoped views were missing the run.
 *
 * Idempotent by run id in the common case: if `benchmark.runs` already has
 * an entry for this run (e.g. the create route's `addRun` DID land, and the
 * run was resumed again later for some other reason — cancellation, a second
 * interruption, etc.), this REPLACES that entry via `updateRun` instead of
 * appending a duplicate via `addRun`.
 *
 * KNOWN LIMITATION (codex_review, not fixed here — see PR discussion): this
 * is read-then-branch-then-write, not an atomic storage-level upsert. Two
 * TRULY concurrent completions of the *same* run id (e.g. this resume path
 * racing the create route's own linking of the same id) could both observe
 * "not yet linked" and both call `addRun`, producing a duplicate that a
 * later `updateRun` call can't repair (it only replaces ONE matching entry).
 * In practice this window is narrow: same-process double resume is already
 * blocked by `activeCancellationTokens`, and cross-process double resume of
 * the same run is already blocked by the `resumeToken` claim above — so the
 * only way to hit this is the *original* create-route execution finishing
 * its OWN linking at the exact moment another server independently decides
 * the run is stale enough to resume, which requires a live heartbeat gap
 * bigger than `EVALUATION_RUN_STALE_AFTER_MS` (default 1h) while the process
 * is actually still alive and about to succeed — pathological, not
 * impossible. Closing this fully requires an atomic upsert-by-id primitive
 * in the storage adapters (OpenSearch + file), which is a bigger, separate
 * change touching both the create and resume paths uniformly; tracked as a
 * follow-up rather than bundled into this bug fix.
 */
export async function linkCompletedRunToBenchmark(
  storage: IStorageModule,
  benchmarkId: string,
  benchmarkRun: BenchmarkRun
): Promise<void> {
  const benchmark = await storage.benchmarks.getById(benchmarkId);
  if (!benchmark) {
    throw new Error(`Benchmark not found while linking completed run: ${benchmarkId}`);
  }
  const alreadyLinked = (benchmark.runs || []).some((r) => r.id === benchmarkRun.id);
  const linked = alreadyLinked
    ? await storage.benchmarks.updateRun(benchmarkId, benchmarkRun.id, benchmarkRun)
    : await storage.benchmarks.addRun(benchmarkId, benchmarkRun);
  if (!linked) {
    throw new Error(`Failed to link completed run to benchmark: ${benchmarkId}`);
  }
}

/** Heartbeat cadence while a run executes (liveness signal on shared storage). */
const RUN_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How long a `running` run may go without a heartbeat before another server
 * may treat it as orphaned (resume it / recover it). Shared-cluster safety:
 * multiple agent-health servers point at the same storage, and "active" is
 * only known per-process — the heartbeat is the cross-server liveness signal.
 */
export function runStaleAfterMs(): number {
  const raw = process.env.EVALUATION_RUN_STALE_AFTER_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 1000; // 1h
}

/**
 * Age of the run's most recent liveness signal. Uses the MOST RECENT of
 * heartbeat/resumed/created (not a priority order): after a resume claims an
 * orphan, `resumedAt` is newer than the dead server's last `heartbeatAt`, and
 * the claim must count as liveness immediately.
 */
export function runLivenessAgeMs(run: Pick<EvaluationRun, 'createdAt' | 'resumedAt' | 'heartbeatAt'>, now = Date.now()): number {
  const last = Math.max(
    ...[run.heartbeatAt, run.resumedAt, run.createdAt]
      .map((t) => (t ? new Date(t).getTime() : NaN))
      .filter((t) => Number.isFinite(t) && t > 0)
  );
  return Number.isFinite(last) && last > 0 ? now - last : Infinity;
}

/**
 * Stamp `heartbeatAt` on the run doc every RUN_HEARTBEAT_INTERVAL_MS until the
 * returned stop function is called. Failures are non-fatal (next beat retries).
 */
function startRunHeartbeat(storage: ReturnType<typeof getStorageModule>, runId: string): () => void {
  const timer = setInterval(() => {
    storage.evaluationRuns.update(runId, { heartbeatAt: new Date().toISOString() })
      .catch((err: any) => console.warn(`[StorageAPI] Run heartbeat failed for ${runId}: ${err?.message || err}`));
  }, RUN_HEARTBEAT_INTERVAL_MS);
  // Don't hold the process open for a heartbeat timer.
  (timer as any).unref?.();
  return () => clearInterval(timer);
}

/**
 * Send an SSE event to the client.
 */
function sendSSE(res: Response, event: string, data: any): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// GET /api/storage/evaluation-runs - List evaluation runs
router.get('/api/storage/evaluation-runs', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const { benchmarkId, agentKey, status, testCaseId, trigger, from, size, sort, order } = req.query;

    const filters: any = {};
    if (benchmarkId) filters.benchmarkId = benchmarkId;
    if (agentKey) filters.agentKey = agentKey;
    if (status) filters.status = status;
    if (testCaseId) filters.testCaseId = testCaseId;
    if (trigger) filters.trigger = trigger;

    const pagination = {
      from: from ? parseInt(from as string, 10) : 0,
      size: size ? parseInt(size as string, 10) : 50,
    };

    const sorting: any = {};
    if (sort) sorting.sort = sort as string;
    if (order) sorting.order = order as string;

    const result = await storage.evaluationRuns.list({ ...filters, ...pagination, ...sorting });

    res.json({ evaluationRuns: result.items, total: result.total });
  } catch (error: any) {
    console.error('[StorageAPI] List evaluation runs failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/evaluation-runs/:id - Get by ID
router.get('/api/storage/evaluation-runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const storage = getStorageModule();

    const run = await storage.evaluationRuns.getById(id);
    if (!run) {
      return res.status(404).json({ error: 'Evaluation run not found' });
    }

    res.json(run);
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Evaluation run not found' });
    }
    console.error('[StorageAPI] Get evaluation run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/evaluation-runs - Create and execute an evaluation run (SSE streaming)
router.post('/api/storage/evaluation-runs', async (req: Request, res: Response) => {
  try {
    const { sources, agentKey, modelId, judgeModelId, name, evaluatorId, concurrency, benchmarkId, trigger } = req.body;

    // Validate required fields
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({ error: 'sources is required and must be a non-empty array' });
    }
    if (!agentKey) {
      return res.status(400).json({ error: 'agentKey is required' });
    }
    // NOTE: no `modelId` validation — the agent's LLM is owned by the agent's
    // own config (connectorConfig), resolved server-side by the runner. Any
    // client-supplied modelId is only kept as a legacy backward-compat fallback.

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const storage = getStorageModule();

    // Resolve test case sources. This can throw (e.g. file not found for code-import)
    // AFTER flushHeaders has already opened the SSE stream, in which case the outer
    // catch can't fall back to res.status(500).json(...) — we'd hang the client.
    // We catch source-resolution errors specifically here and emit an SSE error.
    let resolved;
    try {
      resolved = await resolveTestCaseSources(sources, storage);
    } catch (resolveError: any) {
      console.error('[StorageAPI] Source resolution failed:', resolveError.message);
      sendSSE(res, 'error', { error: resolveError.message });
      res.end();
      return;
    }
    const testCases = resolved.testCases;
    const evaluateFnMap = resolved.evaluateFnMap;
    const hooksByFile = resolved.hooksByFile;
    const testHookScopes = resolved.testHookScopes;

    // Create test case snapshots
    const snapshots: TestCaseSnapshot[] = testCases.map(tc => ({
      id: tc.id,
      version: (tc as any).version || 1,
      name: tc.name,
    }));

    // Create the evaluation run document
    const runId = `eval-run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const now = new Date().toISOString();

    // Resolve the agent's model from its own config (connectorConfig) so the
    // run document records which model the agent ran on — there is no
    // user-selected agent model. Falls back to any client-supplied modelId
    // (legacy) then empty. The runner re-resolves the same way at execution.
    let resolvedModelId: string = modelId || '';
    try {
      const cfg = loadConfigSync();
      const allAgents = [...cfg.agents, ...getCustomAgents()];
      resolvedModelId = resolveAgentModel(allAgents.find(a => a.key === agentKey), modelId);
    } catch { /* loadConfigSync or anything else — keep fallback */ }

    const run: any = {
      id: runId,
      name: name || `Evaluation Run ${new Date().toLocaleDateString()}`,
      sources,
      agentKey,
      modelId: resolvedModelId,
      // Customer-supplied judge model id (separate from agent's `modelId`).
      // Forwarded onto the run document so the runner reads it and the UI
      // can show which judge model graded each test case in this run.
      judgeModelId: typeof judgeModelId === 'string' && judgeModelId ? judgeModelId : undefined,
      evaluatorId,
      concurrency,
      benchmarkId,
      trigger: trigger || 'manual',
      status: 'running',
      testCaseSnapshots: snapshots,
      results: {},
      createdAt: now,
    };

    await storage.evaluationRuns.create(run);

    // Send started event
    sendSSE(res, 'started', { runId, testCases: snapshots });

    // Store cancellation token
    const cancellationToken = createCancellationToken();
    activeCancellationTokens.set(runId, cancellationToken);
    const stopHeartbeat = startRunHeartbeat(storage, runId);

    try {
      // Execute the evaluation run
      const completedRun = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        cancellationToken,
        evaluateFnMap,
        hooksByFile,
        testHookScopes,
        onProgress: (progress: any) => {
          sendSSE(res, 'progress', progress);
        },
        onTestCaseComplete: async (testCaseId: string, result: any) => {
          await storage.evaluationRuns.updateResult(runId, testCaseId, result);
          sendSSE(res, 'testCaseComplete', { testCaseId, result });
        },
      });

      // Update run with final status
      const finalStatus = cancellationToken.isCancelled ? 'cancelled' : 'completed';
      const updatedRun = await storage.evaluationRuns.update(runId, {
        status: finalStatus,
        stats: completedRun.stats,
        completedAt: new Date().toISOString(),
        results: completedRun.results,
      });

      sendSSE(res, 'completed', updatedRun);
    } catch (error: any) {
      console.error(`[StorageAPI] Evaluation run failed: ${runId}`, error.message);

      // Update run status to failed
      try {
        await storage.evaluationRuns.update(runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: error.message,
        });
      } catch (updateError: any) {
        console.error(`[StorageAPI] Failed to update run status: ${updateError.message}`);
      }

      sendSSE(res, 'error', { error: error.message, runId });
    } finally {
      // Clean up cancellation token
      stopHeartbeat();
      activeCancellationTokens.delete(runId);
      res.end();
    }
  } catch (error: any) {
    console.error('[StorageAPI] Create evaluation run failed:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      // Headers already sent (SSE stream is open) — emit an error event
      // and close the stream so the client doesn't hang waiting for completion.
      try {
        sendSSE(res, 'error', { error: error.message });
      } catch {
        // Stream may already be in a bad state; ignore
      }
      try {
        res.end();
      } catch {
        // Already ended
      }
    }
  }
});

// POST /api/storage/evaluation-runs/:id/cancel - Cancel a running evaluation run
router.post('/api/storage/evaluation-runs/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const cancellationToken = activeCancellationTokens.get(id);
    if (!cancellationToken) {
      return res.status(404).json({ error: 'Run not found or not currently executing' });
    }

    cancellationToken.cancel();

    const storage = getStorageModule();
    await storage.evaluationRuns.update(id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[StorageAPI] Cancel evaluation run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/evaluation-runs/:id/resume - Resume an interrupted run (SSE streaming)
//
// RedKite-inspired checkpoint resume: re-executes ONLY the test cases that
// have no persisted report (pending / interrupted / failed-without-report).
// Completed test cases keep their existing reports and verdicts. The run
// document is reused — no new run id — so history and stats stay coherent.
router.post('/api/storage/evaluation-runs/:id/resume', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const storage = getStorageModule();

    const run = await storage.evaluationRuns.getById(id);
    if (!run) {
      return res.status(404).json({ error: 'Evaluation run not found' });
    }
    if (activeCancellationTokens.has(id)) {
      return res.status(409).json({ error: 'Run is currently executing — cannot resume an active run' });
    }
    // Shared-cluster guard: a `running` run may be executing on ANOTHER
    // agent-health server pointed at the same storage. Only treat it as an
    // orphan (resumable) once its liveness heartbeat has gone stale.
    if (run.status === 'running') {
      const ageMs = runLivenessAgeMs(run);
      const staleMs = runStaleAfterMs();
      if (ageMs < staleMs) {
        return res.status(409).json({
          error: `Run appears to be executing (last liveness signal ${Math.round(ageMs / 1000)}s ago, stale threshold ${Math.round(staleMs / 1000)}s). ` +
            'If the owning server died, retry after the threshold or wait for boot recovery to mark it resumable.',
        });
      }
    }

    const resumableIds = computeResumableTestCaseIds(run);
    if (resumableIds.length === 0) {
      return res.status(400).json({ error: 'Nothing to resume — every test case already has a persisted report' });
    }

    // Set SSE headers (mirrors the create route)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Re-resolve test cases from the run's stored sources, then narrow to the
    // resumable subset. Code-import (.eval.ts) fn maps are re-materialized by
    // the same resolution path the create route uses.
    let resolved;
    try {
      resolved = await resolveTestCaseSources(run.sources, storage);
    } catch (resolveError: any) {
      console.error('[StorageAPI] Resume source resolution failed:', resolveError.message);
      sendSSE(res, 'error', { error: resolveError.message, runId: id });
      res.end();
      return;
    }
    const resumableSet = new Set(resumableIds);
    const testCases = resolved.testCases.filter((tc) => resumableSet.has(tc.id));
    if (testCases.length === 0) {
      sendSSE(res, 'error', {
        error: 'The run sources no longer contain the pending test cases — nothing to resume',
        runId: id,
      });
      res.end();
      return;
    }

    // Reset ONLY the test cases we will actually execute. Resumable ids the
    // sources no longer resolve (test case deleted, benchmark membership
    // changed) keep their existing failed-with-note entry instead of being
    // flipped to an eternally-pending state on a "completed" run.
    const executableIds = new Set(testCases.map((tc) => tc.id));
    const missingIds = resumableIds.filter((tcId) => !executableIds.has(tcId));

    // Claim the run. There is no cross-server CAS primitive in the storage
    // interface, so we use a claim token: write it, re-read, and abort if
    // another claimer overwrote ours in the window. Same-process double
    // resumes are already excluded by activeCancellationTokens above.
    const now = new Date().toISOString();
    const resumeToken = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const results = { ...(run.results || {}) };
    for (const tcId of resumableIds) {
      if (executableIds.has(tcId)) {
        results[tcId] = { reportId: '', status: 'pending' };
      }
    }
    await storage.evaluationRuns.update(id, {
      status: 'running',
      error: '',
      results,
      resumedAt: now,
      // The claim itself is a liveness signal — without this, the dead
      // server's stale heartbeatAt would leave the freshly-resumed run
      // looking orphaned until the first 60s heartbeat tick.
      heartbeatAt: now,
      resumeToken,
    } as Partial<EvaluationRun>);
    const claimed = await storage.evaluationRuns.getById(id);
    if ((claimed as any)?.resumeToken !== resumeToken) {
      sendSSE(res, 'error', {
        error: 'Another server claimed this run for resume at the same time — aborting this attempt',
        runId: id,
      });
      res.end();
      return;
    }
    run.status = 'running';
    run.results = results;
    run.resumedAt = now;
    run.heartbeatAt = now;
    delete run.error;

    sendSSE(res, 'started', {
      runId: id,
      resumed: true,
      testCases: run.testCaseSnapshots,
      pendingCount: testCases.length,
      skippedCount: (run.testCaseSnapshots?.length || 0) - resumableIds.length,
      // Resumable ids the run's sources no longer resolve — left as failed,
      // not re-executed. Surfaced so callers can warn instead of silently
      // "completing" past them.
      missingCount: missingIds.length,
      ...(missingIds.length > 0 ? { missingTestCaseIds: missingIds } : {}),
    });

    const cancellationToken = createCancellationToken();
    activeCancellationTokens.set(id, cancellationToken);
    const stopHeartbeat = startRunHeartbeat(storage, id);

    try {
      const completedRun = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        cancellationToken,
        evaluateFnMap: resolved.evaluateFnMap,
        hooksByFile: resolved.hooksByFile,
        testHookScopes: resolved.testHookScopes,
        onProgress: (progress: any) => {
          sendSSE(res, 'progress', progress);
        },
        onTestCaseComplete: async (testCaseId: string, result: any) => {
          await storage.evaluationRuns.updateResult(id, testCaseId, result);
          sendSSE(res, 'testCaseComplete', { testCaseId, result });
        },
      });

      const finalStatus = cancellationToken.isCancelled ? 'cancelled' : 'completed';
      // executeEvaluationRun computed stats.total from the resumed SUBSET —
      // correct it to the full run size (preserved + resumed results).
      const stats = completedRun.stats
        ? { ...completedRun.stats, total: run.testCaseSnapshots?.length || Object.keys(completedRun.results || {}).length }
        : undefined;
      const completedAt = new Date().toISOString();
      const updatedRun = await storage.evaluationRuns.update(id, {
        status: finalStatus,
        stats,
        completedAt,
        results: completedRun.results,
      });

      // Keep the benchmark's embedded run history in sync, same as the
      // create route's success path — otherwise a run whose original create
      // execution crashed before ever linking (no benchmarkId success path
      // reached) stays permanently invisible on the benchmark detail page /
      // scoped comparison pool even after a later resume completes it.
      //
      // Deliberately its OWN try/catch, NOT allowed to bubble into the outer
      // catch below: the evaluation run itself (test cases executed, reports
      // persisted, `updatedRun` already written as completed above) is the
      // source of truth and has already genuinely succeeded at this point.
      // Letting a secondary bookkeeping failure (e.g. the benchmark was
      // deleted mid-resume) rewrite `status` to 'failed' would corrupt that
      // canonical record and falsely report a real, successful evaluation as
      // failed — strictly worse than the bug this fix addresses (codex_review
      // finding: don't let denormalized-view bookkeeping lie about the
      // primary record). Best-effort: log loudly and keep going; the run
      // stays 'completed' with results intact even if this link failed, and
      // the benchmark-linkage gap it leaves behind is exactly the same,
      // already-visible-and-tracked symptom this PR fixes (re-resuming later,
      // if the benchmark comes back, repairs it — see idempotent upsert
      // above).
      if (run.benchmarkId) {
        try {
          const benchmarkRun = buildBenchmarkRunProjection(updatedRun, completedAt);
          await linkCompletedRunToBenchmark(storage, run.benchmarkId, benchmarkRun);
        } catch (linkError: any) {
          console.error(
            `[StorageAPI] Resumed run ${id} completed successfully but failed to link into benchmark ${run.benchmarkId}: ${linkError.message}`
          );
        }
      }

      sendSSE(res, 'completed', updatedRun);
    } catch (error: any) {
      console.error(`[StorageAPI] Evaluation run resume failed: ${id}`, error.message);
      try {
        await storage.evaluationRuns.update(id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: error.message,
        });
      } catch (updateError: any) {
        console.error(`[StorageAPI] Failed to update run status: ${updateError.message}`);
      }
      sendSSE(res, 'error', { error: error.message, runId: id });
    } finally {
      stopHeartbeat();
      activeCancellationTokens.delete(id);
      res.end();
    }
  } catch (error: any) {
    console.error('[StorageAPI] Resume evaluation run failed:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      try { sendSSE(res, 'error', { error: error.message, runId: id }); } catch { /* stream broken */ }
      try { res.end(); } catch { /* already ended */ }
    }
  }
});

// PUT /api/storage/evaluation-runs/:id - Create or update a run without execution (for migration/import)
router.put('/api/storage/evaluation-runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const storage = getStorageModule();

    const run = { ...req.body, id, docType: 'evaluation-run' as const };
    const existing = await storage.evaluationRuns.getById(id);
    if (existing) {
      // Full-document REPLACE, not merge: `update()` doc-merges partial
      // updates (so omitted nested keys — e.g. removed results entries —
      // would survive). This route's contract is upsert-with-replace, so
      // re-create the doc wholesale.
      await storage.evaluationRuns.create(run);
      res.json(run);
    } else {
      await storage.evaluationRuns.create(run);
      res.status(201).json(run);
    }
  } catch (error: any) {
    console.error('[StorageAPI] Upsert evaluation run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/evaluation-runs/:id - Delete an evaluation run
router.delete('/api/storage/evaluation-runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const storage = getStorageModule();

    const existing = await storage.evaluationRuns.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Evaluation run not found' });
    }

    await storage.evaluationRuns.delete(id);
    res.json({ success: true });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Evaluation run not found' });
    }
    console.error('[StorageAPI] Delete evaluation run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/evaluation-runs/:id/promote - Promote an ad-hoc run to a benchmark
router.post('/api/storage/evaluation-runs/:id/promote', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { benchmarkName } = req.body;

    if (!benchmarkName) {
      return res.status(400).json({ error: 'benchmarkName is required' });
    }

    const storage = getStorageModule();
    const result = await promoteRunToBenchmark(id, benchmarkName, storage);

    res.json({ benchmark: result.benchmark, run: result.run });
  } catch (error: any) {
    if (error.message?.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message?.includes('already has benchmark') || error.message?.includes('already associated')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[StorageAPI] Promote evaluation run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/storage/evaluation-runs/:id - Partial update of a run
router.patch('/api/storage/evaluation-runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const storage = getStorageModule();

    const existing = await storage.evaluationRuns.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Evaluation run not found' });
    }

    const { name, description, benchmarkId } = req.body;
    const allowedFields: Record<string, any> = {};
    if (name !== undefined) allowedFields.name = name;
    if (description !== undefined) allowedFields.description = description;
    if (benchmarkId !== undefined) allowedFields.benchmarkId = benchmarkId;

    const updated = await storage.evaluationRuns.update(id, allowedFields);
    res.json(updated);
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Evaluation run not found' });
    }
    console.error('[StorageAPI] Update evaluation run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
