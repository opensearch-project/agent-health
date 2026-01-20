/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs Routes - Test case execution results with search, annotations, and lookups
 *
 * Sample data (demo-*) is always included in responses.
 * Real data from OpenSearch is merged when configured.
 */

import { Router, Request, Response } from 'express';
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import {
  SAMPLE_RUNS,
  getSampleRun,
  getSampleRunsByTestCase,
  getSampleRunsByBenchmark,
  getSampleRunsByBenchmarkRun,
} from '../../../cli/demo/sampleRuns.js';
import { createRunWithClient, getRunByIdWithClient, updateRunWithClient } from '../../services/storage/index.js';
import type { TestCaseRun } from '../../../types/index.js';
import type { Client } from '@opensearch-project/opensearch';

const router = Router();
const INDEX = INDEXES.runs;

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
    const { size = '100', from = '0' } = req.query;
    let realData: TestCaseRun[] = [];

    // Fetch from OpenSearch if configured
    if (isStorageAvailable(req)) {
      try {
        const client = requireStorageClient(req);
        const result = await client.search({
          index: INDEX,
          body: {
            size: parseInt(size as string),
            from: parseInt(from as string),
            sort: [{ createdAt: { order: 'desc' } }],
            query: { match_all: {} },
          },
        });
        realData = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable, returning sample data only:', e.message);
      }
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

    // Fetch from OpenSearch
    if (!isStorageAvailable(req)) {
      return res.status(404).json({ error: 'Run not found' });
    }

    const client = requireStorageClient(req);
    const run = await getRunByIdWithClient(client, id);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot create runs in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    const run = await createRunWithClient(client, runData);
    console.log(`[StorageAPI] Created run: ${run.id}`);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot update runs in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    const updated = await updateRunWithClient(client, id, updates);
    console.log(`[StorageAPI] Updated run: ${id}`);
    res.json(updated);
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot delete runs in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    await client.delete({ index: INDEX, id, refresh: true });

    console.log(`[StorageAPI] Deleted run: ${id}`);
    res.json({ deleted: true });
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return res.status(404).json({ error: 'Run not found' });
    }
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

    // Fetch from OpenSearch if configured
    if (isStorageAvailable(req)) {
      try {
        const must: any[] = [];
        if (experimentId) must.push({ term: { experimentId } });
        if (testCaseId) must.push({ term: { testCaseId } });
        if (experimentRunId) must.push({ term: { experimentRunId } });
        if (agentId) must.push({ term: { agentId } });
        if (modelId) must.push({ term: { modelId } });
        if (status) must.push({ term: { status } });
        if (passFailStatus) must.push({ term: { passFailStatus } });
        if (tags?.length) must.push({ terms: { tags } });

        if (dateRange) {
          const range: any = { createdAt: {} };
          if (dateRange.start) range.createdAt.gte = dateRange.start;
          if (dateRange.end) range.createdAt.lte = dateRange.end;
          must.push({ range });
        }

        const client = requireStorageClient(req);
        const result = await client.search({
          index: INDEX,
          body: {
            size, from,
            sort: [{ createdAt: { order: 'desc' } }],
            query: must.length > 0 ? { bool: { must } } : { match_all: {} },
          },
        });
        realData = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable for search:', e.message);
      }
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
    const { size = '100' } = req.query;

    // Get sample runs for this test case
    const sampleResults = getSampleRunsByTestCase(testCaseId);

    let realData: TestCaseRun[] = [];

    // Fetch from OpenSearch if configured
    if (isStorageAvailable(req)) {
      try {
        const client = requireStorageClient(req);
        const result = await client.search({
          index: INDEX,
          body: {
            size: parseInt(size as string),
            sort: [{ createdAt: { order: 'desc' } }],
            query: { term: { testCaseId } },
          },
        });
        realData = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable:', e.message);
      }
    }

    // Sort sample results by timestamp descending (newest first)
    const sortedSampleResults = sampleResults.sort((a, b) =>
      getTimestampMs(b) - getTimestampMs(a)
    );

    // User data first, then sample data
    const allData = [...realData, ...sortedSampleResults];
    res.json({ runs: allData, total: allData.length });
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

    // Fetch from OpenSearch if configured
    // Note: Query uses experimentId field name (OpenSearch field preserved for data compatibility)
    if (isStorageAvailable(req)) {
      try {
        const client = requireStorageClient(req);
        const result = await client.search({
          index: INDEX,
          body: {
            size: parseInt(size as string),
            sort: [{ createdAt: { order: 'desc' } }],
            query: { term: { experimentId: benchmarkId } },
          },
        });
        realData = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable:', e.message);
      }
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

    // Fetch from OpenSearch if configured
    // Note: Query uses experimentId/experimentRunId field names (OpenSearch fields preserved for data compatibility)
    if (isStorageAvailable(req)) {
      try {
        const client = requireStorageClient(req);
        const result = await client.search({
          index: INDEX,
          body: {
            size: parseInt(size as string),
            sort: [{ createdAt: { order: 'desc' } }],
            query: {
              bool: {
                must: [{ term: { experimentId: benchmarkId } }, { term: { experimentRunId: runId } }],
              },
            },
          },
        });
        realData = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable:', e.message);
      }
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
    const { benchmarkRunId, size = '100' } = req.query;

    // Filter sample data
    // Note: Sample data still uses experimentId/experimentRunId field names for compatibility
    let sampleResults = SAMPLE_RUNS.filter(
      r => r.experimentId === benchmarkId && r.testCaseId === testCaseId
    );
    if (benchmarkRunId) {
      sampleResults = sampleResults.filter(r => r.experimentRunId === benchmarkRunId);
    }

    let realData: TestCaseRun[] = [];

    // Fetch from OpenSearch if configured
    // Note: Query uses experimentId/experimentRunId field names (OpenSearch fields preserved for data compatibility)
    if (isStorageAvailable(req)) {
      try {
        const must: any[] = [{ term: { experimentId: benchmarkId } }, { term: { testCaseId } }];
        if (benchmarkRunId) must.push({ term: { experimentRunId: benchmarkRunId } });

        const client = requireStorageClient(req);
        const result = await client.search({
          index: INDEX,
          body: {
            size: parseInt(size as string),
            sort: [{ iteration: { order: 'asc' } }],
            query: { bool: { must } },
          },
        });
        realData = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable:', e.message);
      }
    }

    // Sort sample results by iteration ascending (iteration is an optional field on stored runs)
    const sortedSampleResults = sampleResults.sort((a, b) =>
      ((a as any).iteration || 1) - ((b as any).iteration || 1)
    );

    // User data first, then sample data
    const allData = [...realData, ...sortedSampleResults];
    res.json({
      runs: allData,
      total: allData.length,
      maxIteration: allData.length > 0 ? Math.max(...allData.map((r: any) => r.iteration || 1)) : 0,
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot add annotations in sample-only mode.' });
    }

    const annotation = { ...req.body };
    annotation.id = annotation.id || generateId('ann');
    annotation.createdAt = new Date().toISOString();
    annotation.updatedAt = annotation.createdAt;

    const client = requireStorageClient(req);
    await client.update({
      index: INDEX, id,
      body: {
        script: {
          source: 'if (ctx._source.annotations == null) { ctx._source.annotations = []; } ctx._source.annotations.add(params.annotation)',
          params: { annotation },
        },
      },
      refresh: true,
    });

    console.log(`[StorageAPI] Added annotation to run: ${id}`);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot update annotations in sample-only mode.' });
    }

    const updates = { ...req.body, updatedAt: new Date().toISOString() };

    const client = requireStorageClient(req);
    await client.update({
      index: INDEX, id,
      body: {
        script: {
          source: `
            for (int i = 0; i < ctx._source.annotations.size(); i++) {
              if (ctx._source.annotations[i].id == params.annotationId) {
                ctx._source.annotations[i].text = params.text;
                ctx._source.annotations[i].tags = params.tags;
                ctx._source.annotations[i].updatedAt = params.updatedAt;
                break;
              }
            }
          `,
          params: { annotationId, text: updates.text, tags: updates.tags || [], updatedAt: updates.updatedAt },
        },
      },
      refresh: true,
    });

    console.log(`[StorageAPI] Updated annotation ${annotationId} on run: ${id}`);
    res.json({ ...updates, id: annotationId });
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot delete annotations in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    await client.update({
      index: INDEX, id,
      body: {
        script: {
          source: 'ctx._source.annotations.removeIf(a -> a.id == params.annotationId)',
          params: { annotationId },
        },
      },
      refresh: true,
    });

    console.log(`[StorageAPI] Deleted annotation ${annotationId} from run: ${id}`);
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

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot create runs in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    const now = new Date().toISOString();
    const operations: any[] = [];

    for (const run of runs) {
      if (!run.id) run.id = generateId('run');
      run.createdAt = run.createdAt || now;
      run.annotations = run.annotations || [];

      operations.push({ index: { _index: INDEX, _id: run.id } });
      operations.push(run);
    }

    const result = await client.bulk({ body: operations, refresh: true });

    console.log(`[StorageAPI] Bulk created ${runs.length} runs`);
    res.json({ created: runs.length, errors: result.body.errors });
  } catch (error: any) {
    console.error('[StorageAPI] Bulk create runs failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
