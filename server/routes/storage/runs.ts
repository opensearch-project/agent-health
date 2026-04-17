/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs Routes - Test case execution results with search, annotations, and lookups
 *
 * Storage-backend agnostic: uses IStorageModule adapter (file or OpenSearch).
 * Sample data (demo-*) is always included in responses.
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { getStorageModule } from '../../adapters/index.js';
import {
  SAMPLE_RUNS,
  getSampleRun,
  getSampleRunsByTestCase,
  getSampleRunsByBenchmark,
  getSampleRunsByBenchmarkRun,
} from '../../../cli/demo/sampleRuns.js';
import type { TestCaseRun } from '../../../types/index.js';

const router = Router();

/**
 * Check if an ID belongs to sample data (read-only)
 */
function isSampleId(id: string): boolean {
  return id.startsWith('demo-');
}

/**
 * Get timestamp in milliseconds for sorting, using createdAt as fallback
 * Fixes bug where missing timestamps defaulted to epoch (1970)
 */
function getTimestampMs(run: { timestamp?: string; createdAt?: string }): number {
  const ts = run.timestamp || run.createdAt;
  return ts ? new Date(ts).getTime() : 0;
}

// GET /api/storage/runs - List all (paginated)
router.get('/api/storage/runs', async (req: Request, res: Response) => {
  try {
    const { size = '100', from = '0', fields } = req.query;
    let realData: TestCaseRun[] = [];

    // Parse fields query param for _source projection
    const fieldList = typeof fields === 'string'
      ? fields.split(',').map(f => f.trim()).filter(Boolean)
      : undefined;

    // Fetch from storage backend
    const storage = getStorageModule();
    try {
      const result = await storage.runs.getAll({
        size: parseInt(size as string),
        from: parseInt(from as string),
        _source: fieldList,
      });
      realData = result.items;
    } catch (e: any) {
      console.warn('[StorageAPI] Storage unavailable, returning sample data only:', e.message);
    }

    // Sort sample data by timestamp descending (newest first)
    const sortedSampleData = [...SAMPLE_RUNS].sort((a, b) =>
      getTimestampMs(b) - getTimestampMs(a)
    );

    // User data first, then sample data
    const allData = [...realData, ...sortedSampleData];
    const total = allData.length;

    res.json({ runs: allData, total, size: parseInt(size as string), from: parseInt(from as string) });
  } catch (error: any) {
    console.error('[StorageAPI] List runs failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/runs/counts-by-test-case - Bulk run counts per test case
// NOTE: This route MUST be registered before /api/storage/runs/:id to avoid Express matching
// "counts-by-test-case" as a :id parameter.
router.get('/api/storage/runs/counts-by-test-case', async (req: Request, res: Response) => {
  try {
    // Build sample counts
    const sampleCounts: Record<string, number> = {};
    for (const run of SAMPLE_RUNS) {
      sampleCounts[run.testCaseId] = (sampleCounts[run.testCaseId] || 0) + 1;
    }

    let realCounts: Record<string, number> = {};

    // Count runs from storage backend
    const storage = getStorageModule();
    try {
      realCounts = await storage.runs.countsByTestCase();
    } catch (e: any) {
      console.warn('[StorageAPI] Storage unavailable for count aggregation:', e.message);
    }

    // Merge counts (real + sample)
    const counts: Record<string, number> = { ...sampleCounts };
    for (const [testCaseId, count] of Object.entries(realCounts)) {
      counts[testCaseId] = (counts[testCaseId] || 0) + count;
    }

    res.json({ counts });
  } catch (error: any) {
    console.error('[StorageAPI] Counts by test case failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/runs/:id - Get by ID
router.get('/api/storage/runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check sample data first
    if (isSampleId(id)) {
      const sample = getSampleRun(id);
      if (sample) {
        return res.json(sample);
      }
      return res.status(404).json({ error: 'Run not found' });
    }

    // Fetch from storage
    const storage = getStorageModule();
    const run = await storage.runs.getById(id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  } catch (error: any) {
    console.error('[StorageAPI] Get run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/runs - Create
router.post('/api/storage/runs', async (req: Request, res: Response) => {
  try {
    const runData = { ...req.body };

    // Reject creating with demo- prefix
    if (runData.id && isSampleId(runData.id)) {
      return res.status(400).json({ error: 'Cannot create run with demo- prefix (reserved for sample data)' });
    }

    const storage = getStorageModule();
    const run = await storage.runs.create(runData);
    debug('StorageAPI', `Created run: ${run.id}`);
    res.status(201).json(run);
  } catch (error: any) {
    console.error('[StorageAPI] Create run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/storage/runs/:id - Partial update
router.patch('/api/storage/runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot modify sample data. Sample runs are read-only.' });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const storage = getStorageModule();

    // Check if metricsStatus is being updated (trace-mode completion)
    const isMetricsStatusUpdate = updates.metricsStatus !== undefined &&
                                   updates.metricsStatus !== 'pending';

    // If this is a trace-mode completion, fetch the report to get experimentId
    let experimentId: string | undefined;
    if (isMetricsStatusUpdate) {
      debug('StorageAPI', `[StatsUpdate] Detected metricsStatus update to '${updates.metricsStatus}' for report ${id}`);
      try {
        const report = await storage.runs.getById(id);
        experimentId = report?.experimentId;
        if (experimentId) {
          debug('StorageAPI', `[StatsUpdate] Report ${id} belongs to benchmark ${experimentId}`);
        } else {
          debug('StorageAPI', `[StatsUpdate] Report ${id} has no experimentId, skipping stats refresh`);
        }
      } catch (err) {
        console.warn(`[StorageAPI] Failed to fetch report for benchmark stats update:`, err);
      }
    }

    const updated = await storage.runs.update(id, updates);
    debug('StorageAPI', `Updated run: ${id}`);

    // Update parent benchmark run stats if this was a trace-mode completion
    if (isMetricsStatusUpdate && experimentId) {
      debug('StorageAPI', `[StatsUpdate] Triggering stats refresh for benchmark ${experimentId} after report ${id} completion`);
      // Fire-and-forget stats refresh
      refreshBenchmarkRunStats(storage, experimentId, id).catch(err => {
        console.warn(`[StorageAPI] Failed to update benchmark stats after report update:`, err);
      }).then(() => {
        debug('StorageAPI', `[StatsUpdate] Successfully refreshed stats for benchmark ${experimentId}`);
      });
    }

    res.json(updated);
  } catch (error: any) {
    if (error.message?.includes('not found')) {
      return res.status(404).json({ error: 'Run not found' });
    }
    console.error('[StorageAPI] Patch run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/runs/:id - Delete
router.delete('/api/storage/runs/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Reject deleting sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot delete sample data. Sample runs are read-only.' });
    }

    const storage = getStorageModule();
    const result = await storage.runs.delete(id);
    if (!result.deleted) {
      return res.status(404).json({ error: 'Run not found' });
    }

    debug('StorageAPI', `Deleted run: ${id}`);
    res.json({ deleted: true });
  } catch (error: any) {
    console.error('[StorageAPI] Delete run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/runs/search - Advanced search
router.post('/api/storage/runs/search', async (req: Request, res: Response) => {
  try {
    const {
      experimentId, testCaseId, experimentRunId, agentId, modelId,
      status, passFailStatus, tags, dateRange, size = 100, from = 0
    } = req.body;

    // Filter sample data
    let sampleResults = [...SAMPLE_RUNS];
    if (experimentId) sampleResults = sampleResults.filter(r => r.experimentId === experimentId);
    if (testCaseId) sampleResults = sampleResults.filter(r => r.testCaseId === testCaseId);
    if (experimentRunId) sampleResults = sampleResults.filter(r => r.experimentRunId === experimentRunId);
    if (status) sampleResults = sampleResults.filter(r => r.status === status);
    if (passFailStatus) sampleResults = sampleResults.filter(r => r.passFailStatus === passFailStatus);

    let realData: TestCaseRun[] = [];

    // Search via storage adapter
    const storage = getStorageModule();
    try {
      const result = await storage.runs.search(
        { experimentId, experimentRunId, testCaseId, agentId, modelId, status, passFailStatus, tags, dateRange },
        { size, from },
      );
      realData = result.items;
    } catch (e: any) {
      console.warn('[StorageAPI] Storage unavailable for search:', e.message);
    }

    // Sort sample results by timestamp descending (newest first)
    const sortedSampleResults = sampleResults.sort((a, b) =>
      getTimestampMs(b) - getTimestampMs(a)
    );

    // User data first, then sample data
    const allData = [...realData, ...sortedSampleResults];
    res.json({ runs: allData, total: allData.length });
  } catch (error: any) {
    console.error('[StorageAPI] Search runs failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/runs/by-test-case/:testCaseId
router.get('/api/storage/runs/by-test-case/:testCaseId', async (req: Request, res: Response) => {
  try {
    const { testCaseId } = req.params;
    const { size = '100', from = '0' } = req.query;

    // Get sample runs for this test case
    const sampleResults = getSampleRunsByTestCase(testCaseId);

    let realData: TestCaseRun[] = [];
    let realTotal = 0;

    // Fetch from storage
    const storage = getStorageModule();
    try {
      const result = await storage.runs.getByTestCase(
        testCaseId,
        parseInt(size as string),
        parseInt(from as string),
      );
      realData = result.items;
      realTotal = result.total;
    } catch (e: any) {
      console.warn('[StorageAPI] Storage unavailable:', e.message);
    }

    // Sort sample results by timestamp descending (newest first)
    const sortedSampleResults = sampleResults.sort((a, b) =>
      getTimestampMs(b) - getTimestampMs(a)
    );

    // Only append sample data on the first page (from === 0)
    const fromInt = parseInt(from as string);
    const allData = fromInt === 0 ? [...realData, ...sortedSampleResults] : realData;
    const total = realTotal + sampleResults.length;

    res.json({ runs: allData, total, size: parseInt(size as string), from: fromInt });
  } catch (error: any) {
    console.error('[StorageAPI] Get runs by test case failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/runs/by-benchmark/:benchmarkId
router.get('/api/storage/runs/by-benchmark/:benchmarkId', async (req: Request, res: Response) => {
  try {
    const { benchmarkId } = req.params;
    const { size = '1000' } = req.query;

    // Get sample runs for this benchmark
    const sampleResults = getSampleRunsByBenchmark(benchmarkId);

    let realData: TestCaseRun[] = [];

    // Fetch from storage
    const storage = getStorageModule();
    try {
      realData = await storage.runs.getByExperiment(benchmarkId, parseInt(size as string));
    } catch (e: any) {
      console.warn('[StorageAPI] Storage unavailable:', e.message);
    }

    // Sort sample results by timestamp descending (newest first)
    const sortedSampleResults = sampleResults.sort((a, b) =>
      getTimestampMs(b) - getTimestampMs(a)
    );

    // User data first, then sample data
    const allData = [...realData, ...sortedSampleResults];
    res.json({ runs: allData, total: allData.length });
  } catch (error: any) {
    console.error('[StorageAPI] Get runs by benchmark failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/runs/by-benchmark-run/:benchmarkId/:runId
router.get('/api/storage/runs/by-benchmark-run/:benchmarkId/:runId', async (req: Request, res: Response) => {
  try {
    const { benchmarkId, runId } = req.params;
    const { size = '1000' } = req.query;

    // Get sample runs for this benchmark run
    const sampleResults = getSampleRunsByBenchmarkRun(benchmarkId, runId);

    let realData: TestCaseRun[] = [];

    // Fetch from storage
    const storage = getStorageModule();
    try {
      realData = await storage.runs.getByExperimentRun(
        benchmarkId, runId, parseInt(size as string),
      );
    } catch (e: any) {
      console.warn('[StorageAPI] Storage unavailable:', e.message);
    }

    // Sort sample results by timestamp descending (newest first)
    const sortedSampleResults = sampleResults.sort((a, b) =>
      getTimestampMs(b) - getTimestampMs(a)
    );

    // User data first, then sample data
    const allData = [...realData, ...sortedSampleResults];
    res.json({ runs: allData, total: allData.length });
  } catch (error: any) {
    console.error('[StorageAPI] Get runs by benchmark run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/runs/iterations/:benchmarkId/:testCaseId
router.get('/api/storage/runs/iterations/:benchmarkId/:testCaseId', async (req: Request, res: Response) => {
  try {
    const { benchmarkId, testCaseId } = req.params;
    const { benchmarkRunId } = req.query;

    // Filter sample data
    let sampleResults = SAMPLE_RUNS.filter(
      r => r.experimentId === benchmarkId && r.testCaseId === testCaseId
    );
    if (benchmarkRunId) {
      sampleResults = sampleResults.filter(r => r.experimentRunId === benchmarkRunId);
    }

    let realData: TestCaseRun[] = [];
    let maxIteration = 0;

    // Fetch from storage
    const storage = getStorageModule();
    try {
      const result = await storage.runs.getIterations(
        benchmarkId,
        testCaseId,
        benchmarkRunId as string | undefined,
      );
      realData = result.items;
      maxIteration = result.maxIteration;
    } catch (e: any) {
      console.warn('[StorageAPI] Storage unavailable:', e.message);
    }

    // Sort sample results by iteration ascending
    const sortedSampleResults = sampleResults.sort((a, b) =>
      ((a as any).iteration || 1) - ((b as any).iteration || 1)
    );

    // User data first, then sample data
    const allData = [...realData, ...sortedSampleResults];
    const combinedMaxIteration = allData.length > 0
      ? Math.max(maxIteration, ...allData.map((r: any) => r.iteration || 1))
      : 0;

    res.json({
      runs: allData,
      total: allData.length,
      maxIteration: combinedMaxIteration,
    });
  } catch (error: any) {
    console.error('[StorageAPI] Get iterations failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/runs/:id/annotations - Add annotation
router.post('/api/storage/runs/:id/annotations', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot add annotations to sample data. Sample runs are read-only.' });
    }

    const storage = getStorageModule();
    const annotation = await storage.runs.addAnnotation(id, req.body);

    debug('StorageAPI', `Added annotation to run: ${id}`);
    res.status(201).json(annotation);
  } catch (error: any) {
    console.error('[StorageAPI] Add annotation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/storage/runs/:id/annotations/:annotationId - Update annotation
router.put('/api/storage/runs/:id/annotations/:annotationId', async (req: Request, res: Response) => {
  try {
    const { id, annotationId } = req.params;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot modify annotations on sample data. Sample runs are read-only.' });
    }

    const storage = getStorageModule();
    const updated = await storage.runs.updateAnnotation(id, annotationId, req.body);

    debug('StorageAPI', `Updated annotation ${annotationId} on run: ${id}`);
    res.json(updated);
  } catch (error: any) {
    console.error('[StorageAPI] Update annotation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/runs/:id/annotations/:annotationId - Delete annotation
router.delete('/api/storage/runs/:id/annotations/:annotationId', async (req: Request, res: Response) => {
  try {
    const { id, annotationId } = req.params;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot delete annotations from sample data. Sample runs are read-only.' });
    }

    const storage = getStorageModule();
    const result = await storage.runs.deleteAnnotation(id, annotationId);
    if (!result.deleted) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    debug('StorageAPI', `Deleted annotation ${annotationId} from run: ${id}`);
    res.json({ deleted: true });
  } catch (error: any) {
    console.error('[StorageAPI] Delete annotation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/runs/bulk - Bulk create
router.post('/api/storage/runs/bulk', async (req: Request, res: Response) => {
  try {
    const { runs } = req.body;
    if (!Array.isArray(runs)) {
      return res.status(400).json({ error: 'runs must be an array' });
    }

    // Check for demo- prefixes
    const hasDemoIds = runs.some(run => run.id && isSampleId(run.id));
    if (hasDemoIds) {
      return res.status(400).json({ error: 'Cannot create runs with demo- prefix (reserved for sample data)' });
    }

    const storage = getStorageModule();
    const result = await storage.runs.bulkCreate(runs);

    debug('StorageAPI', `Bulk created ${result.created} runs`);
    res.json({ created: result.created, errors: result.errors });
  } catch (error: any) {
    console.error('[StorageAPI] Bulk create runs failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Refresh benchmark run stats after a report status change.
 * Adapter-agnostic version of updateBenchmarkRunStatsForReport.
 */
async function refreshBenchmarkRunStats(
  storage: ReturnType<typeof getStorageModule>,
  benchmarkId: string,
  reportId: string,
): Promise<void> {
  const benchmark = await storage.benchmarks.getById(benchmarkId);
  if (!benchmark) return;

  const targetRun = benchmark.runs?.find((run: any) =>
    Object.values(run.results || {}).some((result: any) => result.reportId === reportId)
  );
  if (!targetRun) return;

  // Recompute stats from reports
  const reportIds = Object.values(targetRun.results || {})
    .map((r: any) => r.reportId)
    .filter(Boolean);

  let passed = 0, failed = 0, pending = 0;
  const total = Object.keys(targetRun.results || {}).length;

  for (const rid of reportIds) {
    try {
      const report = await storage.runs.getById(rid);
      if (!report) { pending++; continue; }
      if ((report as any).metricsStatus === 'pending' || (report as any).metricsStatus === 'calculating') {
        pending++;
      } else if (report.passFailStatus === 'passed') {
        passed++;
      } else {
        failed++;
      }
    } catch {
      pending++;
    }
  }

  // Count results without reports as pending
  pending += total - reportIds.length;

  await storage.benchmarks.updateRun(benchmarkId, targetRun.id, {
    stats: { passed, failed, pending, total },
  } as any);
}

export default router;
