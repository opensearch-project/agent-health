/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmarks Routes - Immutable benchmarks, only runs can be updated
 *
 * Sample data (demo-*) is always included in responses.
 * Real data from OpenSearch is merged when configured.
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { getStorageModule } from '../../adapters/index.js';
import { SAMPLE_BENCHMARKS, isSampleBenchmarkId } from '../../../cli/demo/sampleBenchmarks.js';
import { SAMPLE_TEST_CASES } from '../../../cli/demo/sampleTestCases.js';
import { Benchmark, BenchmarkRun, TestCase, BenchmarkVersion, StorageMetadata, RunStats, EvaluationReport } from '../../../types/index.js';
import { linkTestCaseIdsToBenchmark } from '../../../services/benchmarkPromotion.js';
import { isOldEnoughForZombieCancel, ZOMBIE_CANCEL_MIN_AGE_MS } from '../../../lib/runActions.js';
import { convertTestCasesToExportFormat, generateExportFilename } from '../../../lib/benchmarkExport.js';
import { extractJudgeFailureReason, computeJudgeFailureSummary } from '../../../lib/judgeFailureSummary.js';
import { deleteRunEverywhere } from '../../services/runDelete.js';
import { cancelActiveRun } from '../../services/runCancellation.js';
import { LEGACY_EXECUTE_REMOVED } from '../../../lib/legacyExecuteRemoved.js';

/**
 * Normalize benchmark data for legacy documents without version fields.
 * Ensures backwards compatibility when reading older benchmarks.
 */
function normalizeBenchmark(doc: any): Benchmark {
  const version = doc.currentVersion ?? doc.version ?? 1;
  // Normalize and sort runs by createdAt descending (newest first)
  const normalizedRuns = (doc.runs || [])
    .map(normalizeBenchmarkRun)
    .sort((a: BenchmarkRun, b: BenchmarkRun) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  return {
    ...doc,
    updatedAt: doc.updatedAt ?? doc.createdAt,
    currentVersion: version,
    versions: doc.versions ?? [{
      version: 1,
      createdAt: doc.createdAt,
      testCaseIds: doc.testCaseIds || [],
    }],
    runs: normalizedRuns,
  };
}

/**
 * Normalize benchmark run for legacy documents without version tracking fields.
 */
function normalizeBenchmarkRun(run: any): BenchmarkRun {
  return {
    ...run,
    benchmarkVersion: run.benchmarkVersion ?? 1,
    testCaseSnapshots: run.testCaseSnapshots ?? [],
  };
}

const router = Router();

/**
 * Lazy backfill stats for completed runs that are missing them or have stale stats.
 * Computes stats from reports and mutates the runs in place.
 * Persists updated stats back to OpenSearch (fire-and-forget).
 */
async function backfillRunStats(
  benchmarkId: string,
  runs: BenchmarkRun[]
): Promise<void> {
  const runsNeedingStats = runs.filter((r) => {
    // Case 1: No stats at all
    if (!r.stats && (r.status === 'completed' || r.status === 'cancelled')) {
      debug('StorageAPI', `[Backfill] Run ${r.id} has no stats, will backfill`);
      return true;
    }

    // Case 2: Has stats but they appear stale (pending > 0 when all results are completed)
    if (r.stats && r.stats.pending > 0 && r.status === 'completed') {
      const allResultsCompleted = Object.values(r.results || {})
        .every((result: any) => result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled');

      if (allResultsCompleted) {
        debug('StorageAPI', `[Backfill] Run ${r.id} has stale stats (pending: ${r.stats.pending}), will recompute`);
        return true;
      }
    }

    return false;
  });

  if (runsNeedingStats.length === 0) return;

  debug('StorageAPI', `[Backfill] Backfilling stats for ${runsNeedingStats.length} runs in benchmark ${benchmarkId}`);

  const storage = getStorageModule();
  await Promise.all(runsNeedingStats.map(async (run) => {
    try {
      const { judgeFailureSummary, ...stats } = await computeStatsForRun(run);
      run.stats = stats;
      if (judgeFailureSummary) run.judgeFailureSummary = judgeFailureSummary;

      debug('StorageAPI', `[Backfill] Computed stats for run ${run.id}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}, total=${stats.total}`);

      // Persist via adapter (fire-and-forget)
      storage.benchmarks.updateRun(benchmarkId, run.id, { stats, judgeFailureSummary: judgeFailureSummary ?? null } as any)
        .catch((e: any) => {
          console.warn('[StorageAPI] Failed to persist backfilled stats for run', run.id, ':', e.message);
        })
        .then(() => {
          debug('StorageAPI', `[Backfill] Successfully persisted stats for run ${run.id}`);
        });
    } catch (e: any) {
      console.warn('[StorageAPI] Failed to compute stats for run:', run.id, e.message);
    }
  }));
}

/**
 * Compute stats for a benchmark run by fetching its reports through the
 * storage adapter (works for both file and OpenSearch backends).
 */
async function computeStatsForRun(
  run: BenchmarkRun
): Promise<RunStats & { judgeFailureSummary?: string }> {
  // Collect report IDs from run results
  const reportIds = Object.values(run.results || {})
    .map(r => r.reportId)
    .filter(Boolean);

  let passed = 0;
  let failed = 0;
  let pending = 0;
  let errored = 0;
  const total = Object.keys(run.results || {}).length;
  // One entry per case that reached a report -- undefined for
  // pass/fail/pending cases, a human-readable reason for judge failures
  // (see lib/judgeFailureSummary.ts). Aggregated into `judgeFailureSummary`
  // below so the runs list/inspector isn't silent about *why* a run's
  // cases errored (the reported incident: a bare "⚠ 62" with no reason).
  const judgeFailureReasons: Array<string | undefined> = [];

  // Fetch reports to get passFailStatus
  if (reportIds.length > 0) {
    try {
      const reportsMap = new Map<string, any>();

      const storage = getStorageModule();
      for (const reportId of reportIds) {
        try {
          const report = await storage.runs.getById(reportId);
          if (report) reportsMap.set(report.id, report);
        } catch { /* skip */ }
      }

      // Count stats based on result status and report passFailStatus
      Object.values(run.results || {}).forEach((result) => {
        if (result.status === 'pending' || result.status === 'running') {
          pending++;
          return;
        }

        if (result.status === 'failed' || result.status === 'cancelled') {
          failed++;
          return;
        }

        // For completed results, check the report
        if (result.status === 'completed' && result.reportId) {
          const report = reportsMap.get(result.reportId);
          if (!report) {
            pending++;
            return;
          }

          // Check if evaluation is still pending (trace mode)
          if (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating') {
            pending++;
            return;
          }

          // Evaluator could not produce a verdict (issue #242). Excluded
          // from passed/failed so misconfigured evaluators don't poison
          // aggregate pass rates.
          if (report.metricsStatus === 'error') {
            errored++;
            judgeFailureReasons.push(extractJudgeFailureReason(report));
            return;
          }

          if (report.passFailStatus === 'passed') {
            passed++;
          } else {
            failed++;
            judgeFailureReasons.push(extractJudgeFailureReason(report));
          }
        } else {
          pending++;
        }
      });
    } catch (e: any) {
      console.warn('[StorageAPI] Failed to fetch reports for stats computation:', e.message);
      // Fall back to counting by result status only
      Object.values(run.results || {}).forEach((result) => {
        if (result.status === 'completed') {
          pending++;
        } else if (result.status === 'failed' || result.status === 'cancelled') {
          failed++;
        } else {
          pending++;
        }
      });
    }
  } else {
    // No reports yet, count by result status
    Object.values(run.results || {}).forEach((result) => {
      if (result.status === 'failed' || result.status === 'cancelled') {
        failed++;
      } else {
        pending++;
      }
    });
  }

  const judgeFailureSummary = computeJudgeFailureSummary(judgeFailureReasons, total);
  return { passed, failed, pending, errored, total, ...(judgeFailureSummary ? { judgeFailureSummary } : {}) };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Check if an ID belongs to sample data (read-only)
 */
function isSampleId(id: string): boolean {
  return id.startsWith('demo-');
}

/**
 * Validate a benchmark create body.
 *
 * Minimal required contract: `name` is a non-empty string, and `testCaseIds`
 * (when present) is an array of strings. Guards the create route itself —
 * previously an empty `{}` body silently persisted a nameless benchmark to
 * the shared cluster.
 */
function validateBenchmarkCreate(body: any): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a valid benchmark object';
  }
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return 'name is required and must be a non-empty string';
  }
  if (body.testCaseIds !== undefined) {
    if (!Array.isArray(body.testCaseIds) || !body.testCaseIds.every((id: any) => typeof id === 'string' && id.trim().length > 0)) {
      return 'testCaseIds must be an array of non-empty strings when provided';
    }
  }
  return null;
}

// GET /api/storage/benchmarks - List all
router.get('/api/storage/benchmarks', async (req: Request, res: Response) => {
  try {
    let realData: Benchmark[] = [];
    const warnings: string[] = [];
    let storageReachable = false;
    const storage = getStorageModule();
    const storageConfigured = storage.isConfigured();

    // Fetch from storage backend
    if (storageConfigured) {
      try {
        const result = await storage.benchmarks.getAll({ size: 1000 });
        // Evaluation runs share the benchmark index/directory. Keep this route
        // pure even if an adapter or older deployment returns mixed docs.
        realData = result.items
          .filter((doc: Benchmark & { docType?: string }) => doc.docType !== 'evaluation-run')
          .map(normalizeBenchmark);
        storageReachable = true;
      } catch (e: any) {
        console.warn('[StorageAPI] Storage unavailable, returning sample data only:', e.message);
        warnings.push(`Storage unavailable: ${e.message}`);
      }
    }

    // Determine whether to include sample data
    const includeSampleParam = req.query.includeSample as string | undefined;
    const shouldIncludeSample = includeSampleParam === 'true' ? true
      : includeSampleParam === 'false' ? false
      : realData.length === 0;

    // Sort real data by updatedAt descending (most recently modified first)
    // Falls back to createdAt if updatedAt is missing
    const sortedRealData = realData.sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTime - aTime;
    });

    // Sort and normalize sample data by updatedAt descending
    const sortedSampleData = shouldIncludeSample
      ? [...SAMPLE_BENCHMARKS].map(normalizeBenchmark).sort((a, b) => {
          const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
          const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
          return bTime - aTime;
        })
      : [];

    // User data first, then sample data
    const allData = [...sortedRealData, ...sortedSampleData];

    // Build metadata
    const meta: StorageMetadata = {
      storageConfigured,
      storageReachable,
      realDataCount: realData.length,
      sampleDataCount: sortedSampleData.length,
      sampleDataIncluded: shouldIncludeSample,
      ...(warnings.length > 0 && { warnings }),
    };

    res.json({ benchmarks: allData, total: allData.length, meta });
  } catch (error: any) {
    console.error('[StorageAPI] List benchmarks failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/benchmarks/:id - Get by ID
// Query params:
//   fields      - 'polling' to exclude heavy static fields (versions, testCaseSnapshots, headers)
//   runsSize    - max number of runs to return (default: all)
//   runsOffset  - offset into runs array for pagination (default: 0)
router.get('/api/storage/benchmarks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { fields, runsSize: runsSizeParam, runsOffset: runsOffsetParam } = req.query;
    const isPolling = fields === 'polling';
    const runsSize = runsSizeParam ? parseInt(runsSizeParam as string, 10) : null;
    const runsOffset = runsOffsetParam ? parseInt(runsOffsetParam as string, 10) : 0;

    // Check sample data first
    if (isSampleId(id)) {
      const sample = SAMPLE_BENCHMARKS.find(bench => bench.id === id);
      if (sample) {
        let normalized = normalizeBenchmark(sample);

        // Strip heavy fields in polling mode
        if (isPolling) {
          normalized = {
            ...normalized,
            versions: [],
            runs: normalized.runs.map((r: any) => ({
              ...r,
              testCaseSnapshots: [],
              headers: undefined,
            })),
          };
        }

        // Paginate runs
        if (runsSize !== null) {
          const allRuns = normalized.runs;
          const totalRuns = allRuns.length;
          const paginatedRuns = allRuns.slice(runsOffset, runsOffset + runsSize);
          return res.json({
            ...normalized,
            runs: paginatedRuns,
            totalRuns,
            hasMoreRuns: runsOffset + runsSize < totalRuns,
          });
        }

        return res.json(normalized);
      }
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    // Fetch from storage backend
    const storage = getStorageModule();
    const rawBenchmark = await storage.benchmarks.getById(id);

    if (!rawBenchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const normalized = normalizeBenchmark(rawBenchmark);

    // Lazy backfill: compute stats for completed runs missing them
    await backfillRunStats(id, normalized.runs);

    // Paginate runs
    if (runsSize !== null) {
      const allRuns = normalized.runs;
      const totalRuns = allRuns.length;
      const paginatedRuns = allRuns.slice(runsOffset, runsOffset + runsSize);
      return res.json({
        ...normalized,
        runs: paginatedRuns,
        totalRuns,
        hasMoreRuns: runsOffset + runsSize < totalRuns,
      });
    }

    res.json(normalized);
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Get benchmark failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/benchmarks/:id/export - Export test cases as import-compatible JSON
router.get('/api/storage/benchmarks/:id/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let benchmark: Benchmark | null = null;

    // Check sample data first
    if (isSampleId(id)) {
      const sample = SAMPLE_BENCHMARKS.find(bench => bench.id === id);
      if (sample) {
        benchmark = normalizeBenchmark(sample);
      }
    } else {
      const storage = getStorageModule();
      const rawBenchmark = await storage.benchmarks.getById(id);
      if (rawBenchmark) {
        benchmark = normalizeBenchmark(rawBenchmark);
      }
    }

    if (!benchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    // Resolve test case IDs to full test case objects
    const testCaseIds = benchmark.testCaseIds || [];
    const fullTestCases: TestCase[] = [];

    // Fetch from sample data
    const sampleTestCases = SAMPLE_TEST_CASES.filter(
      (tc: any) => testCaseIds.includes(tc.id)
    ) as unknown as TestCase[];
    fullTestCases.push(...sampleTestCases);

    // Fetch remaining from storage
    const resolvedIds = new Set(fullTestCases.map(tc => tc.id));
    const unresolvedIds = testCaseIds.filter(tcId => !resolvedIds.has(tcId));

    if (unresolvedIds.length > 0) {
      const storage = getStorageModule();
      for (const tcId of unresolvedIds) {
        try {
          const tc = await storage.testCases.getById(tcId);
          if (tc) fullTestCases.push(tc);
        } catch (e: any) {
          console.warn('[StorageAPI] Failed to fetch test case for export:', e.message);
        }
      }
    }

    // Convert to export format
    const exportData = convertTestCasesToExportFormat(fullTestCases);
    const filename = generateExportFilename(benchmark.name);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch (error: any) {
    console.error('[StorageAPI] Export benchmark failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks - Create
router.post('/api/storage/benchmarks', async (req: Request, res: Response) => {
  try {
    const benchmark = { ...req.body };

    // Reject creating with demo- prefix
    if (benchmark.id && isSampleId(benchmark.id)) {
      return res.status(400).json({ error: 'Cannot create benchmark with demo- prefix (reserved for sample data)' });
    }

    const validationError = validateBenchmarkCreate(benchmark);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const now = new Date().toISOString();

    // Initialize versioning - start at version 1
    benchmark.currentVersion = 1;
    benchmark.versions = [{
      version: 1,
      createdAt: now,
      testCaseIds: benchmark.testCaseIds || [],
    }];

    benchmark.runs = (benchmark.runs || []).map((run: any) => ({
      ...run,
      id: run.id || generateId('run'),
      createdAt: run.createdAt || now,
      benchmarkVersion: 1,
      testCaseSnapshots: [],
    }));

    const storage = getStorageModule();
    const created = await storage.benchmarks.create(benchmark);

    debug('StorageAPI', `Created benchmark: ${created.id} (v1)`);
    res.status(201).json(created);
  } catch (error: any) {
    console.error('[StorageAPI] Create benchmark failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Compare two arrays of test case IDs to detect changes
 */
function testCaseIdsChanged(oldIds: string[], newIds: string[]): boolean {
  if (oldIds.length !== newIds.length) return true;
  const sortedOld = [...oldIds].sort();
  const sortedNew = [...newIds].sort();
  return sortedOld.some((id, i) => id !== sortedNew[i]);
}

// PUT /api/storage/benchmarks/:id - Update benchmark (creates new version if testCaseIds changed)
router.put('/api/storage/benchmarks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, testCaseIds, runs } = req.body;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot modify sample data. Sample benchmarks are read-only.' });
    }

    const storage = getStorageModule();

    // Get existing benchmark
    const rawExisting = await storage.benchmarks.getById(id);
    if (!rawExisting) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const existing = normalizeBenchmark(rawExisting);
    const now = new Date().toISOString();

    // Check if test cases changed (triggers new version)
    const newTestCaseIds = testCaseIds ?? existing.testCaseIds;
    const hasTestCaseChanges = testCaseIds !== undefined && testCaseIdsChanged(existing.testCaseIds, testCaseIds);

    let updated: Benchmark;

    if (hasTestCaseChanges) {
      // Test cases changed - create new version
      const newVersion = existing.currentVersion + 1;
      const newVersionEntry: BenchmarkVersion = {
        version: newVersion,
        createdAt: now,
        testCaseIds: newTestCaseIds,
      };

      updated = {
        ...existing,
        name: name ?? existing.name,
        description: description ?? existing.description,
        updatedAt: now,
        currentVersion: newVersion,
        versions: [...existing.versions, newVersionEntry],
        testCaseIds: newTestCaseIds,
      };

      debug('StorageAPI', `Updated benchmark: ${id} (v${existing.currentVersion} → v${newVersion}, test cases changed)`);
    } else {
      // Metadata only - no version change
      updated = {
        ...existing,
        name: name ?? existing.name,
        description: description ?? existing.description,
        updatedAt: now,
      };

      debug('StorageAPI', `Updated benchmark metadata: ${id} (v${existing.currentVersion}, no version change)`);
    }

    // Handle runs update if provided
    if (runs) {
      updated.runs = runs.map((run: any) => ({
        ...run,
        id: run.id || generateId('run'),
        createdAt: run.createdAt || now,
        benchmarkVersion: run.benchmarkVersion ?? updated.currentVersion,
        testCaseSnapshots: run.testCaseSnapshots ?? [],
      }));
    }

    const saved = await storage.benchmarks.update(id, updated);
    res.json(saved);
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Update benchmark failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/storage/benchmarks/:id/metadata - Update metadata only (no version change)
router.patch('/api/storage/benchmarks/:id/metadata', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot modify sample data. Sample benchmarks are read-only.' });
    }

    if (name === undefined && description === undefined) {
      return res.status(400).json({ error: 'Provide name and/or description to update' });
    }

    // Regression guard (API KPI probe finding): the route previously
    // trusted `name`/`description` verbatim, so `{ name: 12345 }` persisted
    // (and was returned back) as a number \u2014 type-confused metadata that
    // breaks any consumer expecting a string.
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'name must be a non-empty string when provided' });
    }
    if (description !== undefined && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be a string when provided' });
    }

    const storage = getStorageModule();

    // Get existing benchmark
    const rawExisting = await storage.benchmarks.getById(id);
    if (!rawExisting) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const existing = normalizeBenchmark(rawExisting);
    const now = new Date().toISOString();

    const updates: Partial<Benchmark> = { updatedAt: now };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    const updated = await storage.benchmarks.update(id, updates);

    debug('StorageAPI', `Updated benchmark metadata: ${id} (v${existing.currentVersion})`);
    res.json(updated);
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Update benchmark metadata failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks/:id/link-test-case-ids - Union test case ids into
// the benchmark's top-level testCaseIds AND its current version's testCaseIds,
// in place (no version bump). Server-side counterpart of
// services/benchmarkPromotion.ts:linkTestCaseIdsToBenchmark — the same path
// POST /api/storage/evaluation-runs uses at run-creation time, exposed here so
// `agent-health benchmark repair-links --apply` can drive the identical,
// already-unit-tested repair for benchmarks that went stale before that link
// existed (top-level testCaseIds correct, current version's testCaseIds empty
// or behind — see cli/utils/benchmarkDoctor.ts's computeVersionLinkRepairPlan).
router.post('/api/storage/benchmarks/:id/link-test-case-ids', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { testCaseIds } = req.body;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot modify sample data. Sample benchmarks are read-only.' });
    }
    if (!Array.isArray(testCaseIds)) {
      return res.status(400).json({ error: 'testCaseIds must be an array' });
    }

    const storage = getStorageModule();
    const result = await linkTestCaseIdsToBenchmark(id, testCaseIds, storage);
    if (!result) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    debug('StorageAPI', `Linked ${result.added.length} new test case id(s) into benchmark ${id} (top level + current version)`);
    res.json(result);
  } catch (error: any) {
    console.error('[StorageAPI] Link test case ids to benchmark failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/benchmarks/:id/versions - List all versions
router.get('/api/storage/benchmarks/:id/versions', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check sample data first
    if (isSampleId(id)) {
      const sample = SAMPLE_BENCHMARKS.find(bench => bench.id === id);
      if (sample) {
        const normalized = normalizeBenchmark(sample);
        return res.json({ versions: normalized.versions, total: normalized.versions.length });
      }
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    // Fetch from storage backend
    const storage = getStorageModule();
    const rawBenchmark = await storage.benchmarks.getById(id);

    if (!rawBenchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const benchmark = normalizeBenchmark(rawBenchmark);
    res.json({ versions: benchmark.versions, total: benchmark.versions.length });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Get benchmark versions failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/benchmarks/:id/versions/:version - Get specific version
router.get('/api/storage/benchmarks/:id/versions/:version', async (req: Request, res: Response) => {
  try {
    const { id, version: versionStr } = req.params;
    const targetVersion = parseInt(versionStr, 10);

    if (isNaN(targetVersion) || targetVersion < 1) {
      return res.status(400).json({ error: 'Invalid version number' });
    }

    // Check sample data first
    if (isSampleId(id)) {
      const sample = SAMPLE_BENCHMARKS.find(bench => bench.id === id);
      if (sample) {
        const normalized = normalizeBenchmark(sample);
        const versionEntry = normalized.versions.find(v => v.version === targetVersion);
        if (!versionEntry) {
          return res.status(404).json({ error: `Version ${targetVersion} not found` });
        }
        return res.json(versionEntry);
      }
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    // Fetch from storage backend
    const storage = getStorageModule();
    const rawBenchmark = await storage.benchmarks.getById(id);

    if (!rawBenchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const benchmark = normalizeBenchmark(rawBenchmark);
    const versionEntry = benchmark.versions.find(v => v.version === targetVersion);

    if (!versionEntry) {
      return res.status(404).json({ error: `Version ${targetVersion} not found` });
    }

    res.json(versionEntry);
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Get benchmark version failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/benchmarks/:id - Delete
router.delete('/api/storage/benchmarks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Reject deleting sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot delete sample data. Sample benchmarks are read-only.' });
    }

    const storage = getStorageModule();
    const result = await storage.benchmarks.delete(id);

    // Regression guard (API KPI probe finding): the delete() adapter call
    // already returns { deleted: boolean } reflecting whether a document
    // was actually found and removed, but this route used to ignore it and
    // always answer 200 { deleted: true } \u2014 lying about deletes of
    // nonexistent benchmarks even though GET correctly 404s for the same id.
    if (!result.deleted) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    debug('StorageAPI', `Deleted benchmark: ${id}`);
    res.json({ deleted: true });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Delete benchmark failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks/bulk - Bulk create
router.post('/api/storage/benchmarks/bulk', async (req: Request, res: Response) => {
  try {
    const { benchmarks } = req.body;
    if (!Array.isArray(benchmarks)) {
      return res.status(400).json({ error: 'benchmarks must be an array' });
    }

    // Check for demo- prefixes
    const hasDemoIds = benchmarks.some(bench => bench.id && isSampleId(bench.id));
    if (hasDemoIds) {
      return res.status(400).json({ error: 'Cannot create benchmarks with demo- prefix (reserved for sample data)' });
    }

    // Filter out invalid entries (e.g. `{}`) before persisting — the adapter's
    // create() does not validate `name` itself, so without this guard a
    // garbage item would silently persist a nameless benchmark.
    //
    // codex_review finding, applied: reporting these as a plain `errors`
    // count made a silent drop indistinguishable from an adapter-level
    // failure on an otherwise-valid item — a caller checking only
    // `errors > 0` can't tell "N of your items were malformed" from "the
    // adapter rejected N valid items". `invalid`/`invalidIndexes` (mirrors
    // /test-cases/bulk's index-listing style) make the validation-drop
    // count and its exact positions explicit and machine-readable, while
    // `errors` keeps its original total-failures meaning for existing
    // callers that only check that.
    const invalidIndexes = benchmarks
      .map((bench, i) => (validateBenchmarkCreate(bench) === null ? -1 : i))
      .filter((i) => i !== -1);
    const validBenchmarks = benchmarks.filter((_, i) => !invalidIndexes.includes(i));
    const invalidCount = invalidIndexes.length;

    const now = new Date().toISOString();
    const prepared = validBenchmarks.map(bench => {
      if (!bench.id) bench.id = generateId('bench');
      bench.createdAt = bench.createdAt || now;
      bench.updatedAt = bench.updatedAt || now;
      bench.runs = bench.runs || [];

      // Initialize versioning if not present
      if (!bench.currentVersion) {
        bench.currentVersion = 1;
        bench.versions = [{
          version: 1,
          createdAt: bench.createdAt,
          testCaseIds: bench.testCaseIds || [],
        }];
      }
      return bench;
    });

    const storage = getStorageModule();
    const result = await storage.benchmarks.bulkCreate(prepared);

    debug('StorageAPI', `Bulk created ${result.created} benchmarks (${invalidCount} rejected by validation)`);
    res.json({
      created: result.created,
      errors: result.errors + invalidCount,
      invalid: invalidCount,
      invalidIndexes,
    });
  } catch (error: any) {
    console.error('[StorageAPI] Bulk create benchmarks failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks/:id/execute — REMOVED (410 Gone).
//
// The legacy per-benchmark runner behind this route (services/benchmarkRunner.ts)
// executed every test case of a run under one `test_suite_run` trace and
// streamed progress over SSE. It has been removed: every first-party caller
// (UI, CLI, SDK) already runs through the unified evaluation-runs API, which
// also embeds a projection of each run into `benchmark.runs[]`, so nothing is
// lost for readers. The route stays registered so any remaining API client
// gets an explicit, actionable error instead of a 404.
router.post('/api/storage/benchmarks/:id/execute', (_req: Request, res: Response) => {
  res.setHeader('Deprecation', LEGACY_EXECUTE_REMOVED.deprecationHeader);
  res.setHeader('Sunset', LEGACY_EXECUTE_REMOVED.sunsetHeader);
  res.setHeader('Link', `<${LEGACY_EXECUTE_REMOVED.docsUrl}>; rel="deprecation"`);
  res.status(410).json({
    error: LEGACY_EXECUTE_REMOVED.error,
    code: LEGACY_EXECUTE_REMOVED.code,
    replacement: LEGACY_EXECUTE_REMOVED.replacement,
    docs: LEGACY_EXECUTE_REMOVED.docs,
  });
});

// DELETE /api/storage/benchmarks/:id/runs/:runId - Delete a specific run
//
// Removes the projection embedded in `benchmark.runs[]` AND the first-class
// evaluation-run document of the same id when that document belongs to this
// benchmark (see server/services/runDelete.ts). Before this, a run that had
// not (yet) been embedded — every in-flight run, and every run that finished
// while linking failed — 404ed here even though it plainly existed, and a
// run that HAD been embedded left its document behind to be merged back into
// the benchmark page as a ghost row.
router.delete('/api/storage/benchmarks/:id/runs/:runId', async (req: Request, res: Response) => {
  const { id, runId } = req.params;

  // Reject modifying sample data
  if (isSampleId(id)) {
    return res.status(400).json({ error: 'Cannot modify sample data. Sample benchmarks are read-only.' });
  }

  try {
    const storage = getStorageModule();

    // `benchmarkId: id` scopes the delete to THIS benchmark: the projection is
    // removed from it, and the run document is only deleted when it is
    // actually associated with it (a colliding or unlinked doc is left
    // alone — see runDelete.ts).
    const result = await deleteRunEverywhere(storage, runId, {
      benchmarkId: id,
      cancelActive: cancelActiveRun,
    });
    if (!result.deleted) {
      return res.status(404).json({ error: 'Run not found' });
    }

    res.json({
      deleted: true,
      runId,
      projectionDeleted: result.projectionDeleted,
      docDeleted: result.docDeleted,
      ...(result.docSkippedNotOwned ? { docSkippedNotOwned: true } : {}),
      cancelled: result.cancelled,
    });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Delete run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/storage/benchmarks/:id/runs/:runId/stats - Update run stats (for migration and incremental updates)
router.patch('/api/storage/benchmarks/:id/runs/:runId/stats', async (req: Request, res: Response) => {
  const { id, runId } = req.params;
  const stats: RunStats = req.body;

  // Validate stats object
  if (!stats || typeof stats.passed !== 'number' || typeof stats.failed !== 'number' ||
      typeof stats.pending !== 'number' || typeof stats.total !== 'number') {
    return res.status(400).json({ error: 'Invalid stats object. Required: passed, failed, pending, total (all numbers)' });
  }

  // Reject modifying sample data
  if (isSampleId(id)) {
    return res.status(400).json({ error: 'Cannot modify sample data. Sample benchmarks are read-only.' });
  }

  try {
    const storage = getStorageModule();
    const updated = await storage.benchmarks.updateRun(id, runId, { stats } as any);

    if (!updated) {
      return res.status(404).json({ error: 'Run not found' });
    }

    debug('StorageAPI', `Updated stats for run ${runId}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}`);
    res.json({ updated: true, runId, stats });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Update run stats failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks/:id/cancel - Cancel a run embedded in benchmark.runs[]
//
// EMBEDDED RUNS ONLY. Runs execute through the evaluation-runs API and are
// linked into `benchmark.runs[]` only once terminal, so an in-flight run is
// never found here — cancel those with `POST /api/storage/evaluation-runs/:id/cancel`
// (what the UI and CLI do). What this route still handles is the "zombie"
// left behind by the removed legacy runner (or a dead process): an embedded
// run whose doc still says `running` with no executor anywhere. It is marked
// cancelled directly once old enough that an executor cannot still be starting.
router.post('/api/storage/benchmarks/:id/cancel', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { runId } = req.body;

  if (!runId) {
    return res.status(400).json({ error: 'runId is required' });
  }

  const storage = getStorageModule();
  const benchmark = await storage.benchmarks.getById(id);
  const run = benchmark?.runs?.find(r => r.id === runId);
  if (!run) {
    return res.status(404).json({
      error: 'Run not found or already completed',
      hint: `In-flight runs are not embedded in the benchmark until they finish; cancel them with POST /api/storage/evaluation-runs/${encodeURIComponent(runId)}/cancel`,
    });
  }
  if (run.status !== 'running') {
    return res.status(400).json({ error: `Run is not currently running (status: ${run.status})` });
  }
  if (!isOldEnoughForZombieCancel(run.createdAt)) {
    return res.status(409).json({
      error: `Run was created less than ${ZOMBIE_CANCEL_MIN_AGE_MS / 1000}s ago; its executor may not have started yet. Try cancelling again in a moment.`,
    });
  }

  const cancelNote = 'Cancelled: no active executor found for this run (process restarted or crashed) — marked cancelled directly.';
  try {
    await storage.benchmarks.updateRun(id, runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      cancelNote,
    } as any);
  } catch (error: any) {
    console.error('[StorageAPI] Zombie-cancel doc update failed:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ cancelled: true, runId, viaFallback: true, note: cancelNote });
});

// POST /api/storage/benchmarks/:id/refresh-all-stats - Force recompute stats for all runs
router.post('/api/storage/benchmarks/:id/refresh-all-stats', async (req: Request, res: Response) => {
  const { id } = req.params;

  // Reject modifying sample data
  if (isSampleId(id)) {
    return res.status(400).json({ error: 'Cannot refresh stats for sample data. Sample benchmarks are read-only.' });
  }

  try {
    const storage = getStorageModule();
    const rawBenchmark = await storage.benchmarks.getById(id);

    if (!rawBenchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const benchmark = normalizeBenchmark(rawBenchmark);
    const runs = benchmark.runs || [];

    debug('StorageAPI', `[RefreshStats] Manually refreshing stats for ${runs.length} runs in benchmark ${id}`);

    // Recompute stats for ALL runs (not just those missing stats)
    await Promise.all(runs.map(async (run) => {
      try {
        const { judgeFailureSummary, ...stats } = await computeStatsForRun(run);
        run.stats = stats;
        if (judgeFailureSummary) run.judgeFailureSummary = judgeFailureSummary;

        debug('StorageAPI', `[RefreshStats] Computed stats for run ${run.id}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}, total=${stats.total}`);

        // Persist via adapter
        await storage.benchmarks.updateRun(id, run.id, { stats, judgeFailureSummary: judgeFailureSummary ?? null } as any);

        debug('StorageAPI', `[RefreshStats] Successfully updated stats for run ${run.id}`);
      } catch (e: any) {
        console.warn('[StorageAPI] Failed to refresh stats for run:', run.id, e.message);
      }
    }));

    debug('StorageAPI', `[RefreshStats] Completed manual stats refresh for benchmark ${id}`);
    res.json({ refreshed: runs.length });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Refresh all stats failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks/:id/runs/:runId/refresh-stats - Refresh stats for a single run
router.post('/api/storage/benchmarks/:id/runs/:runId/refresh-stats', async (req: Request, res: Response) => {
  const { id, runId } = req.params;

  // Reject modifying sample data
  if (isSampleId(id)) {
    return res.status(400).json({ error: 'Cannot refresh stats for sample data. Sample benchmarks are read-only.' });
  }

  try {
    const storage = getStorageModule();
    const rawBenchmark = await storage.benchmarks.getById(id);

    if (!rawBenchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const benchmark = normalizeBenchmark(rawBenchmark);
    const run = benchmark.runs?.find((r: BenchmarkRun) => r.id === runId);

    if (!run) {
      return res.status(404).json({ error: 'Run not found in benchmark' });
    }

    debug('StorageAPI', `[RefreshStats] Manually refreshing stats for run ${runId} in benchmark ${id}`);

    // Recompute stats for the run
    const { judgeFailureSummary, ...stats } = await computeStatsForRun(run);

    debug('StorageAPI', `[RefreshStats] Computed stats for run ${runId}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}, total=${stats.total}`);

    // Persist via adapter
    await storage.benchmarks.updateRun(id, runId, { stats, judgeFailureSummary: judgeFailureSummary ?? null } as any);

    debug('StorageAPI', `[RefreshStats] Successfully updated stats for run ${runId}`);
    res.json({ refreshed: true, runId, stats, judgeFailureSummary });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Refresh run stats failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
