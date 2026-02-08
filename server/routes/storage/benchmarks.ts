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
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { SAMPLE_BENCHMARKS, isSampleBenchmarkId } from '../../../cli/demo/sampleBenchmarks.js';
import { SAMPLE_TEST_CASES } from '../../../cli/demo/sampleTestCases.js';
import { Benchmark, BenchmarkRun, BenchmarkProgress, RunConfigInput, TestCase, BenchmarkVersion, TestCaseSnapshot, StorageMetadata } from '../../../types/index.js';
import {
  executeRun,
  createCancellationToken,
  CancellationToken,
} from '../../../services/benchmarkRunner.js';

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
  return null;
}

/**
 * Get all test cases (sample + real) for lookups
 */
async function getAllTestCases(req: Request): Promise<TestCase[]> {
  const sampleTestCases = SAMPLE_TEST_CASES.map(s => ({
    id: s.id,
    name: s.name,
  })) as TestCase[];

  if (!isStorageAvailable(req)) {
    return sampleTestCases;
  }

  try {
    const client = requireStorageClient(req);
    const result = await client.search({
      index: INDEXES.testCases,
      body: {
        size: 10000,
        _source: ['id', 'name'],
        query: { match_all: {} },
      },
    });
    const realTestCases = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
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
    const storageConfigured = isStorageAvailable(req);

    // Fetch from OpenSearch if configured
    if (storageConfigured) {
      try {
        const client = requireStorageClient(req);
        const result = await client.search({
          index: INDEX,
          body: {
            size: 1000,
            sort: [{ updatedAt: { order: 'desc' } }],
            query: { match_all: {} },
          },
        });
        realData = result.body.hits?.hits?.map((hit: any) => normalizeBenchmark(hit._source)) || [];
        storageReachable = true;
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable, returning sample data only:', e.message);
        warnings.push(`OpenSearch unavailable: ${e.message}`);
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
router.get('/api/storage/benchmarks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check sample data first
    if (isSampleId(id)) {
      const sample = SAMPLE_BENCHMARKS.find(bench => bench.id === id);
      if (sample) {
        return res.json(normalizeBenchmark(sample));
      }
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    // Fetch from OpenSearch
    if (!isStorageAvailable(req)) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const client = requireStorageClient(req);
    const result = await client.get({ index: INDEX, id });

    if (!result.body.found) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    res.json(normalizeBenchmark(result.body._source));
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }
    console.error('[StorageAPI] Get benchmark failed:', error.message);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot create benchmarks in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    const now = new Date().toISOString();

    if (!benchmark.id) benchmark.id = generateId('bench');
    benchmark.createdAt = now;
    benchmark.updatedAt = now;

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

    await client.index({ index: INDEX, id: benchmark.id, body: benchmark, refresh: true });

    console.log(`[StorageAPI] Created benchmark: ${benchmark.id} (v1)`);
    res.status(201).json(benchmark);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot update benchmarks in sample-only mode.' });
    }

    const client = requireStorageClient(req);

    // Get existing benchmark
    const getResult = await client.get({ index: INDEX, id });
    if (!getResult.body.found) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const existing = normalizeBenchmark(getResult.body._source);
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

      console.log(`[StorageAPI] Updated benchmark: ${id} (v${existing.currentVersion} → v${newVersion}, test cases changed)`);
    } else {
      // Metadata only - no version change
      updated = {
        ...existing,
        name: name ?? existing.name,
        description: description ?? existing.description,
        updatedAt: now,
      };

      console.log(`[StorageAPI] Updated benchmark metadata: ${id} (v${existing.currentVersion}, no version change)`);
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

    await client.index({ index: INDEX, id, body: updated, refresh: true });
    res.json(updated);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot update benchmarks in sample-only mode.' });
    }

    const client = requireStorageClient(req);

    // Get existing benchmark
    const getResult = await client.get({ index: INDEX, id });
    if (!getResult.body.found) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const existing = normalizeBenchmark(getResult.body._source);
    const now = new Date().toISOString();

    const updated = {
      ...existing,
      name: name ?? existing.name,
      description: description ?? existing.description,
      updatedAt: now,
    };

    await client.index({ index: INDEX, id, body: updated, refresh: true });

    console.log(`[StorageAPI] Updated benchmark metadata: ${id} (v${existing.currentVersion})`);
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

    // Fetch from OpenSearch
    if (!isStorageAvailable(req)) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const client = requireStorageClient(req);
    const result = await client.get({ index: INDEX, id });

    if (!result.body.found) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const benchmark = normalizeBenchmark(result.body._source);
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

    // Fetch from OpenSearch
    if (!isStorageAvailable(req)) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const client = requireStorageClient(req);
    const result = await client.get({ index: INDEX, id });

    if (!result.body.found) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const benchmark = normalizeBenchmark(result.body._source);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot delete benchmarks in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    await client.delete({ index: INDEX, id, refresh: true });

    console.log(`[StorageAPI] Deleted benchmark: ${id}`);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot create benchmarks in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    const now = new Date().toISOString();
    const operations: any[] = [];

    for (const bench of benchmarks) {
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

      operations.push({ index: { _index: INDEX, _id: bench.id } });
      operations.push(bench);
    }

    const result = await client.bulk({ body: operations, refresh: true });

    console.log(`[StorageAPI] Bulk created ${benchmarks.length} benchmarks`);
    res.json({ created: benchmarks.length, errors: result.body.errors });
  } catch (error: any) {
    console.error('[StorageAPI] Bulk create benchmarks failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/benchmarks/:id/execute - Execute benchmark and stream progress via SSE
router.post('/api/storage/benchmarks/:id/execute', async (req: Request, res: Response) => {
  console.log('[Execute] ========== BENCHMARK EXECUTION STARTED ==========');
  console.log('[Execute] Request params:', req.params);
  console.log('[Execute] Request body:', JSON.stringify(req.body, null, 2));

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
    console.log('[Execute] Benchmark loaded:', benchmark.id, benchmark.name);
    console.log('[Execute] Test case IDs:', benchmark.testCaseIds);

    // Fetch test cases for progress display and version snapshots
    console.log('[Execute] Fetching test cases...');
    const allTestCases = await getAllTestCases(req);
    console.log('[Execute] Found', allTestCases.length, 'test cases');
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
      console.log('[Execute] Starting executeRun for run:', run.id);
      console.log('[Execute] Run config:', { agentKey: run.agentKey, modelId: run.modelId });
      const completedRun = await executeRun(
        benchmark,
        run,
        (progress: BenchmarkProgress) => {
          // Stream progress to client
          console.log('[Execute] Progress:', progress.currentTestCaseIndex + 1, '/', progress.totalTestCases, 'status:', progress.status);
          res.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
        },
        {
          cancellationToken,
          client,
          onTestCaseComplete: async (testCaseId, result) => {
            // Persist intermediate progress to OpenSearch for real-time polling
            try {
              await updateTestCaseResult(client, id, run.id, testCaseId, result);
            } catch (err: any) {
              console.warn(`[Execute] Failed to persist ${testCaseId}:`, err.message);
            }
          },
        }
      );
      console.log('[Execute] executeRun completed');

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

      const finalRun = {
        ...completedRun,
        status: wasCancelled ? 'cancelled' as const : 'completed' as const,
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

// DELETE /api/storage/benchmarks/:id/runs/:runId - Delete a specific run (atomic)
router.delete('/api/storage/benchmarks/:id/runs/:runId', async (req: Request, res: Response) => {
  const { id, runId } = req.params;

  // Reject modifying sample data
  if (isSampleId(id)) {
    return res.status(400).json({ error: 'Cannot modify sample data. Sample benchmarks are read-only.' });
  }

  if (!isStorageAvailable(req)) {
    return res.status(400).json({ error: 'OpenSearch not configured' });
  }

  const client = requireStorageClient(req);

  try {
    // Use Painless script to atomically remove only the specific run
    // This avoids the read-modify-write pattern that could corrupt other runs
    const result = await client.update({
      index: INDEX,
      id,
      body: {
        script: {
          source: `
            def runIndex = -1;
            for (int i = 0; i < ctx._source.runs.size(); i++) {
              if (ctx._source.runs[i].id == params.runId) {
                runIndex = i;
                break;
              }
            }
            if (runIndex >= 0) {
              ctx._source.runs.remove(runIndex);
            } else {
              ctx.op = 'noop';
            }
          `,
          params: { runId },
        },
      },
      refresh: true,
    });

    // Check if the script found and removed the run
    if (result.body.result === 'noop') {
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

export default router;
