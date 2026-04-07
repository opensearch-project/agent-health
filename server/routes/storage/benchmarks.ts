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
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { getStorageModule } from '../../adapters/index.js';
import { SAMPLE_BENCHMARKS, isSampleBenchmarkId } from '../../../cli/demo/sampleBenchmarks.js';
import { SAMPLE_TEST_CASES } from '../../../cli/demo/sampleTestCases.js';
import { Benchmark, BenchmarkRun, BenchmarkProgress, RunConfigInput, TestCase, BenchmarkVersion, TestCaseSnapshot, StorageMetadata, RunStats, EvaluationReport } from '../../../types/index.js';
import {
  executeRun,
  createCancellationToken,
  CancellationToken,
} from '../../../services/benchmarkRunner.js';
import { convertTestCasesToExportFormat, generateExportFilename } from '../../../lib/benchmarkExport.js';

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
const INDEX = INDEXES.benchmarks;

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
      const stats = await computeStatsForRun(run);
      run.stats = stats;

      debug('StorageAPI', `[Backfill] Computed stats for run ${run.id}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}, total=${stats.total}`);

      // Persist via adapter (fire-and-forget)
      storage.benchmarks.updateRun(benchmarkId, run.id, { stats } as any)
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
 * Compute stats for a benchmark run by fetching its reports.
 * Accepts an optional raw OpenSearch client for use during execution (Painless script paths).
 * Falls back to storage adapter when no client provided.
 */
async function computeStatsForRun(
  run: BenchmarkRun,
  client?: any
): Promise<RunStats> {
  // Collect report IDs from run results
  const reportIds = Object.values(run.results || {})
    .map(r => r.reportId)
    .filter(Boolean);

  let passed = 0;
  let failed = 0;
  let pending = 0;
  const total = Object.keys(run.results || {}).length;

  // Fetch reports to get passFailStatus
  if (reportIds.length > 0) {
    try {
      const reportsMap = new Map<string, any>();

      if (client) {
        // Use raw client during execution (OpenSearch path)
        const reportsResult = await client.search({
          index: INDEXES.runs,
          body: {
            size: reportIds.length,
            query: { terms: { 'id': reportIds } },
            _source: ['id', 'passFailStatus', 'metricsStatus', 'status'],
          },
        });
        (reportsResult.body.hits?.hits || []).forEach((hit: any) => {
          reportsMap.set(hit._source.id, hit._source);
        });
      } else {
        // Use storage adapter
        const storage = getStorageModule();
        for (const reportId of reportIds) {
          try {
            const report = await storage.runs.getById(reportId);
            if (report) reportsMap.set(report.id, report);
          } catch { /* skip */ }
        }
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

          if (report.passFailStatus === 'passed') {
            passed++;
          } else {
            failed++;
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

  return { passed, failed, pending, total };
}

/**
 * Atomically update a single test case result within a benchmark run.
 * Used for persisting intermediate progress during benchmark execution.
 */
async function updateTestCaseResult(
  client: any,
  benchmarkId: string,
  runId: string,
  testCaseId: string,
  result: { reportId: string; status: string }
): Promise<void> {
  await client.update({
    index: INDEX,
    id: benchmarkId,
    retry_on_conflict: 3,
    body: {
      script: {
        source: `
          for (int i = 0; i < ctx._source.runs.size(); i++) {
            if (ctx._source.runs[i].id == params.runId) {
              if (ctx._source.runs[i].results == null) {
                ctx._source.runs[i].results = new HashMap();
              }
              ctx._source.runs[i].results[params.testCaseId] = params.result;
              break;
            }
          }
        `,
        params: { runId, testCaseId, result },
      },
    },
    refresh: false, // Don't wait for refresh on intermediate updates
  });
}

// Registry of active cancellation tokens for in-progress runs
const activeRuns = new Map<string, CancellationToken>();

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
 * Validate run configuration input
 * Returns error message if invalid, null if valid
 */
function validateRunConfig(config: any): string | null {
  if (!config || typeof config !== 'object') {
    return 'Request body must be a valid run configuration object';
  }
  if (!config.name || typeof config.name !== 'string' || !config.name.trim()) {
    return 'name is required and must be a non-empty string';
  }
  if (!config.agentKey || typeof config.agentKey !== 'string') {
    return 'agentKey is required and must be a string';
  }
  if (!config.modelId || typeof config.modelId !== 'string') {
    return 'modelId is required and must be a string';
  }
  if (config.concurrency !== undefined) {
    const c = Number(config.concurrency);
    if (!Number.isInteger(c) || c < 1 || c > 20) {
      return 'concurrency must be an integer between 1 and 20';
    }
  }
  return null;
}

/**
 * Get all test cases (sample + real) for lookups
 */
async function getAllTestCases(): Promise<TestCase[]> {
  const sampleTestCases = SAMPLE_TEST_CASES.map(s => ({
    id: s.id,
    name: s.name,
  })) as TestCase[];

  const storage = getStorageModule();
  if (!storage.isConfigured()) {
    return sampleTestCases;
  }

  try {
    const result = await storage.testCases.getAll({ size: 10000 });
    // Only need id and name for lookups
    const realTestCases = result.items.map(tc => ({ id: tc.id, name: tc.name })) as TestCase[];
    return [...sampleTestCases, ...realTestCases];
  } catch {
    return sampleTestCases;
  }
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
        realData = result.items.map(normalizeBenchmark);
        storageReachable = true;
      } catch (e: any) {
        console.warn('[StorageAPI] Storage unavailable, returning sample data only:', e.message);
        warnings.push(`Storage unavailable: ${e.message}`);
      }
    }

    // Sort real data by updatedAt descending (most recently modified first)
    // Falls back to createdAt if updatedAt is missing
    const sortedRealData = realData.sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTime - aTime;
    });

    // Sort and normalize sample data by updatedAt descending
    const sortedSampleData = [...SAMPLE_BENCHMARKS].map(normalizeBenchmark).sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTime - aTime;
    });

    // User data first, then sample data
    const allData = [...sortedRealData, ...sortedSampleData];

    // Build metadata
    const meta: StorageMetadata = {
      storageConfigured,
      storageReachable,
      realDataCount: realData.length,
      sampleDataCount: sortedSampleData.length,
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
    await storage.benchmarks.delete(id);

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

    const now = new Date().toISOString();
    const prepared = benchmarks.map(bench => {
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

    debug('StorageAPI', `Bulk created ${result.created} benchmarks`);
    res.json(result);
  } catch (error: any) {
    console.error('[StorageAPI] Bulk create benchmarks failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks/:id/execute - Execute benchmark and stream progress via SSE
router.post('/api/storage/benchmarks/:id/execute', async (req: Request, res: Response) => {
  debug('StorageAPI', '========== BENCHMARK EXECUTION STARTED ==========');
  debug('StorageAPI', 'Execute request params:', req.params);
  debug('StorageAPI', 'Execute request body:', JSON.stringify(req.body, null, 2));

  const { id } = req.params;
  const runConfig: RunConfigInput = req.body;

  // Reject executing sample benchmarks (they're pre-completed)
  if (isSampleId(id)) {
    return res.status(400).json({
      error: 'Cannot execute sample benchmarks. Sample data is read-only with pre-completed runs.',
    });
  }

  // Validate run configuration
  const validationError = validateRunConfig(runConfig);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Require OpenSearch for execution
  if (!isStorageAvailable(req)) {
    return res.status(400).json({ error: 'OpenSearch not configured. Cannot execute benchmarks in sample-only mode.' });
  }

  try {
    const client = requireStorageClient(req);

    // Get benchmark
    const getResult = await client.get({ index: INDEX, id });
    if (!getResult.body.found) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const benchmark = normalizeBenchmark(getResult.body._source);
    debug('StorageAPI', 'Benchmark loaded:', benchmark.id, benchmark.name);
    debug('StorageAPI', 'Test case IDs:', benchmark.testCaseIds);

    // Fetch test cases for progress display and version snapshots
    debug('StorageAPI', 'Fetching test cases...');
    const allTestCases = await getAllTestCases();
    debug('StorageAPI', 'Found', allTestCases.length, 'test cases');
    const testCaseMap = new Map(allTestCases.map((tc: any) => [tc.id, tc]));

    // Capture test case snapshots at execution time (for reproducibility)
    const testCaseSnapshots: TestCaseSnapshot[] = benchmark.testCaseIds.map(tcId => {
      const tc = testCaseMap.get(tcId);
      return {
        id: tcId,
        version: (tc as any)?.currentVersion ?? 1,
        name: tc?.name || tcId,
      };
    });

    // Create new run with 'running' status and version tracking
    const run: BenchmarkRun = {
      ...runConfig,
      id: generateId('run'),
      createdAt: new Date().toISOString(),
      status: 'running',
      benchmarkVersion: benchmark.currentVersion,
      testCaseSnapshots,
      results: {},
    };

    // Initialize pending status for all test cases
    benchmark.testCaseIds.forEach(testCaseId => {
      run.results[testCaseId] = { reportId: '', status: 'pending' };
    });

    // Setup SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Save run to benchmark immediately so it persists across page refreshes
    // Also update updatedAt so benchmark appears at top of list (sorted by recent activity)
    const initialRuns = [...(benchmark.runs || []), run];
    await client.update({
      index: INDEX,
      id,
      body: { doc: { runs: initialRuns, updatedAt: run.createdAt } },
      refresh: true,
    });

    // Build test case list for progress display
    const testCasesForProgress = benchmark.testCaseIds.map(tcId => {
      const tc = testCaseMap.get(tcId);
      return { id: tcId, name: tc?.name || tcId, status: 'pending' as const };
    });

    // Send initial event with run ID and test cases
    res.write(`data: ${JSON.stringify({
      type: 'started',
      runId: run.id,
      testCases: testCasesForProgress,
    })}\n\n`);

    // Create cancellation token
    const cancellationToken = createCancellationToken();
    activeRuns.set(run.id, cancellationToken);

    // Handle client disconnect - execution continues in background
    req.on('close', () => {});

    try {
      // Execute the run
      debug('StorageAPI', 'Starting executeRun for run:', run.id);
      debug('StorageAPI', 'Run config:', { agentKey: run.agentKey, modelId: run.modelId });
      const completedRun = await executeRun(
        benchmark,
        run,
        (progress: BenchmarkProgress) => {
          // Stream progress to client
          debug('StorageAPI', 'Execute progress:', progress.currentTestCaseIndex + 1, '/', progress.totalTestCases, 'status:', progress.status);
          res.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
        },
        {
          cancellationToken,
          client,
          onTestCaseComplete: async (testCaseId, result) => {
            // Stream per-test-case result to the client
            const tc = testCaseMap.get(testCaseId);
            const completedCount = Object.values(run.results).filter(
              r => r.status === 'completed' || r.status === 'failed'
            ).length;
            res.write(`data: ${JSON.stringify({
              type: 'progress',
              currentTestCaseIndex: completedCount - 1,
              totalTestCases: benchmark.testCaseIds.length,
              currentTestCase: { id: testCaseId, name: tc?.name || testCaseId },
              result: { status: result.status, error: result.error },
            })}\n\n`);

            // Persist intermediate progress to OpenSearch for real-time polling
            try {
              await updateTestCaseResult(client, id, run.id, testCaseId, result);
            } catch (err: any) {
              console.warn(`[Execute] Failed to persist ${testCaseId}:`, err.message);
            }
          },
        }
      );
      debug('StorageAPI', 'executeRun completed');

      // Determine final status - check if cancelled
      const wasCancelled = cancellationToken.isCancelled;

      // Mark remaining pending results as failed if cancelled
      if (wasCancelled) {
        Object.entries(completedRun.results).forEach(([testCaseId, result]) => {
          if (result.status === 'pending') {
            completedRun.results[testCaseId] = { ...result, status: 'failed' };
          }
        });
      }

      // Compute final stats from reports
      debug('StorageAPI', '[StatsUpdate] Computing final stats for completed run:', run.id);
      const stats = await computeStatsForRun(completedRun, client);
      debug('StorageAPI', `[StatsUpdate] Final stats for run ${run.id}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}, total=${stats.total}`);

      const finalRun = {
        ...completedRun,
        status: wasCancelled ? 'cancelled' as const : 'completed' as const,
        stats,
      };

      // Update benchmark with final run results
      await client.update({
        index: INDEX,
        id,
        retry_on_conflict: 3,
        body: {
          script: {
            source: `
              for (int i = 0; i < ctx._source.runs.size(); i++) {
                if (ctx._source.runs[i].id == params.runId) {
                  ctx._source.runs[i] = params.finalRun;
                  break;
                }
              }
            `,
            params: { runId: run.id, finalRun },
          },
        },
        refresh: true,
      });

      // Send completion event with final status
      const eventType = wasCancelled ? 'cancelled' : 'completed';
      res.write(`data: ${JSON.stringify({ type: eventType, run: finalRun })}\n\n`);
    } catch (error: any) {
      console.error(`[StorageAPI] Benchmark run failed: ${run.id}`, error.message);

      // Update benchmark to mark run as failed
      try {
        const failedRun = { ...run, status: 'failed', error: error.message };
        await client.update({
          index: INDEX,
          id,
          retry_on_conflict: 3,
          body: {
            script: {
              source: `
                for (int i = 0; i < ctx._source.runs.size(); i++) {
                  if (ctx._source.runs[i].id == params.runId) {
                    ctx._source.runs[i] = params.failedRun;
                    break;
                  }
                }
              `,
              params: { runId: run.id, failedRun },
            },
          },
          refresh: true,
        });
      } catch (updateError: any) {
        console.error(`[StorageAPI] Failed to update benchmark with failed run: ${updateError.message}`);
      }

      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message, runId: run.id })}\n\n`);
    } finally {
      // Cleanup
      activeRuns.delete(run.id);
      res.end();
    }
  } catch (error: any) {
    // Handle 404 from OpenSearch client.get()
    if (error.meta?.statusCode === 404) {
      if (!res.headersSent) {
        return res.status(404).json({ error: 'Benchmark not found' });
      }
      return;
    }
    console.error('[StorageAPI] Execute benchmark failed:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// DELETE /api/storage/benchmarks/:id/runs/:runId - Delete a specific run
router.delete('/api/storage/benchmarks/:id/runs/:runId', async (req: Request, res: Response) => {
  const { id, runId } = req.params;

  // Reject modifying sample data
  if (isSampleId(id)) {
    return res.status(400).json({ error: 'Cannot modify sample data. Sample benchmarks are read-only.' });
  }

  try {
    const storage = getStorageModule();
    const deleted = await storage.benchmarks.deleteRun(id, runId);

    if (!deleted) {
      return res.status(404).json({ error: 'Run not found' });
    }

    res.json({ deleted: true, runId });
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

// POST /api/storage/benchmarks/:id/cancel - Cancel an in-progress run
router.post('/api/storage/benchmarks/:id/cancel', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { runId } = req.body;

  if (!runId) {
    return res.status(400).json({ error: 'runId is required' });
  }

  const cancellationToken = activeRuns.get(runId);
  if (!cancellationToken) {
    return res.status(404).json({ error: 'Run not found or already completed' });
  }

  // Set cancellation flag
  cancellationToken.cancel();

  // Immediately update run status in DB to 'cancelled'
  // This fixes race condition where client refreshes before execute loop updates DB
  const client = requireStorageClient(req);
  try {
    await client.update({
      index: INDEX,
      id,
      body: {
        script: {
          source: `
            for (int i = 0; i < ctx._source.runs.size(); i++) {
              if (ctx._source.runs[i].id == params.runId) {
                ctx._source.runs[i].status = 'cancelled';
                break;
              }
            }
          `,
          params: { runId },
        },
      },
      refresh: true,
    });
  } catch (error: any) {
    console.error('[StorageAPI] Failed to update cancelled status:', error.message);
    // Continue anyway - the execute loop will also try to update
  }

  res.json({ cancelled: true, runId });
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
        const stats = await computeStatsForRun(run);
        run.stats = stats;

        debug('StorageAPI', `[RefreshStats] Computed stats for run ${run.id}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}, total=${stats.total}`);

        // Persist via adapter
        await storage.benchmarks.updateRun(id, run.id, { stats } as any);

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
    const stats = await computeStatsForRun(run);

    debug('StorageAPI', `[RefreshStats] Computed stats for run ${runId}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}, total=${stats.total}`);

    // Persist via adapter
    await storage.benchmarks.updateRun(id, runId, { stats } as any);

    debug('StorageAPI', `[RefreshStats] Successfully updated stats for run ${runId}`);
    res.json({ refreshed: true, runId, stats });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Refresh run stats failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
