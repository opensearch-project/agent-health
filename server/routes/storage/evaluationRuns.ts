/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response } from 'express';
import { BenchmarkRun, EvaluationRun, TestCaseSource, TestCaseSnapshot } from '../../../types/index.js';
import { getStorageModule } from '../../adapters/index.js';
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
import { computeImageDigest, buildImageDoc } from '../../../lib/benchmarkImage.js';
import { toEvaluationRunSummary } from '../../adapters/runSummary.js';

const router = Router();

// Registry of active cancellation tokens for in-progress runs
const activeCancellationTokens = new Map<string, CancellationToken>();

/**
 * Send an SSE event to the client.
 */
function sendSSE(res: Response, event: string, data: any): void {
  // The HTTP stream is only an observer of the durable run. A browser close,
  // proxy timeout, or failed socket write must never reject runner callbacks
  // (which would prematurely finalize the run and remove its cancel token).
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Execution continues and persists progress/results for polling clients.
  }
}

// GET /api/storage/evaluation-runs - List evaluation runs
router.get('/api/storage/evaluation-runs', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const { benchmarkId, agentKey, status, testCaseId, trigger, imageDigest, from, size, sort, order } = req.query;

    const filters: any = {};
    if (benchmarkId) filters.benchmarkId = benchmarkId;
    if (agentKey) filters.agentKey = agentKey;
    if (status) filters.status = status;
    if (testCaseId) filters.testCaseId = testCaseId;
    if (trigger) filters.trigger = trigger;
    if (imageDigest) filters.imageDigest = imageDigest;

    const pagination = {
      from: from ? parseInt(from as string, 10) : 0,
      size: size ? parseInt(size as string, 10) : 50,
    };

    const sorting: any = {};
    if (sort) sorting.sort = sort as string;
    if (order) sorting.order = order as string;

    const result = await storage.evaluationRuns.list({ ...filters, ...pagination, ...sorting });

    res.json({
      evaluationRuns: result.items.map(toEvaluationRunSummary),
      total: result.total,
    });
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
    const { sources, agentKey, modelId, judgeModelId, name, description, evaluatorId, concurrency, benchmarkId, trigger, agentEndpoint, headers } = req.body;

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
    const resolvedTestCaseIds = testCases.map(tc => tc.id);
    const evaluateFnMap = resolved.evaluateFnMap;
    const hooksByFile = resolved.hooksByFile;
    const testHookScopes = resolved.testHookScopes;

    // Keep an explicitly associated benchmark linked to the canonical test
    // case documents resolved above. Repeated CLI imports therefore reuse one
    // benchmark and one stable set of testCaseIds instead of creating rows
    // whose definitions and runs live only in evaluation-run documents.
    if (benchmarkId) {
      const benchmark = await storage.benchmarks.getById(benchmarkId);
      if (!benchmark) {
        sendSSE(res, 'error', { error: `Benchmark not found: ${benchmarkId}` });
        res.end();
        return;
      }
      const idsChanged = JSON.stringify(benchmark.testCaseIds || []) !== JSON.stringify(resolvedTestCaseIds);
      if (idsChanged) {
        await storage.benchmarks.update(benchmarkId, { testCaseIds: resolvedTestCaseIds });
      }
    }

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
      description,
      sources: resolved.sources,
      agentKey,
      modelId: resolvedModelId,
      agentEndpoint,
      headers,
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

    // Stamp the content digest of this run's evaluation conditions and
    // find-or-create the corresponding benchmark image. Content-addressed
    // identity is the inherent dedup: re-running the same command yields the
    // same digest → the same image doc — never a duplicate entity. Runs with
    // equal digests are comparable by construction (same test-case contents,
    // same evaluator/judge conditions; only the agent varies).
    // Failure-safe: image bookkeeping must never block run execution.
    try {
      const evalConditions = {
        evaluatorId: evaluatorId || undefined,
        judgeModelId: run.judgeModelId || undefined,
      };
      const digest = computeImageDigest({ testCases, evalConditions });
      run.imageDigest = digest;
      await storage.images.create(buildImageDoc({ testCases, evalConditions }));
      await storage.images.update(digest, { lastRunAt: now }).catch(() => {});
    } catch (imageErr: any) {
      console.warn('[StorageAPI] Image digest stamping failed (run continues):', imageErr?.message);
    }

    await storage.evaluationRuns.create(run);

    // Send started event
    sendSSE(res, 'started', { runId, testCases: snapshots });

    // Store cancellation token
    const cancellationToken = createCancellationToken();
    activeCancellationTokens.set(runId, cancellationToken);

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

      const finalStatus = cancellationToken.isCancelled ? 'cancelled' : 'completed';
      const completedAt = new Date().toISOString();

      // Link the terminal projection before finalizing the first-class run.
      // If finalization crashes, retrying is safe because addRun is idempotent;
      // a terminal evaluation-run can therefore never be orphaned from its benchmark.
      if (benchmarkId) {
        const benchmarkRun: BenchmarkRun = {
          id: run.id, name: run.name, createdAt: run.createdAt, completedAt,
          status: finalStatus, agentKey: run.agentKey, modelId: run.modelId,
          judgeModelId: run.judgeModelId, results: completedRun.results, stats: completedRun.stats,
          ...(run.description ? { description: run.description } : {}),
          ...(run.evaluatorId ? { evaluatorId: run.evaluatorId } : {}),
          ...(run.headers ? { headers: run.headers } : {}),
          ...(run.concurrency ? { concurrency: run.concurrency } : {}),
          testCaseSnapshots: run.testCaseSnapshots,
        };
        const linked = await storage.benchmarks.addRun(benchmarkId, benchmarkRun);
        if (!linked) throw new Error(`Benchmark not found while linking completed run: ${benchmarkId}`);
      }

      const updatedRun = await storage.evaluationRuns.update(runId, {
        status: finalStatus, stats: completedRun.stats, completedAt, results: completedRun.results,
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

// PUT /api/storage/evaluation-runs/:id - Create or update a run without execution (for migration/import)
router.put('/api/storage/evaluation-runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const storage = getStorageModule();

    const run = { ...req.body, id, docType: 'evaluation-run' as const };
    const existing = await storage.evaluationRuns.getById(id);
    if (existing) {
      const updated = await storage.evaluationRuns.update(id, run);
      res.json(updated);
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
