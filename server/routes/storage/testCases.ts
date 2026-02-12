/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test Cases Routes - Versioned CRUD operations
 *
 * Sample data (demo-*) is always included in responses.
 * Real data from OpenSearch is merged when configured.
 */

import { Router, Request, Response } from 'express';
import { isStorageAvailable, requireStorageClient, INDEXES } from '../../middleware/storageClient.js';
import { SAMPLE_TEST_CASES } from '../../../cli/demo/sampleTestCases.js';
import type { TestCase, StorageMetadata } from '../../../types/index.js';

const router = Router();
const INDEX = INDEXES.testCases;

/** Fields included in summary mode (list view) */
const SUMMARY_SOURCE_INCLUDES = [
  'id', 'name', 'labels', 'category', 'difficulty',
  'createdAt', 'updatedAt', 'initialPrompt', 'description', 'version', 'tags',
];

/**
 * Convert a full test case to a lightweight summary for list views.
 * Truncates initialPrompt to 200 chars and strips heavy fields.
 */
function toSummary(doc: any): any {
  return {
    ...doc,
    initialPrompt: doc.initialPrompt?.length > 200
      ? doc.initialPrompt.slice(0, 200) + '...'
      : doc.initialPrompt,
    context: [],
    expectedOutcomes: [],
    versions: [],
  };
}

function generateId(): string {
  return `tc-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Check if an ID belongs to sample data (read-only)
 */
function isSampleId(id: string): boolean {
  return id.startsWith('demo-');
}

/**
 * Convert sample test case format to full TestCase format
 */
function toTestCase(sample: typeof SAMPLE_TEST_CASES[0]): TestCase {
  const now = new Date().toISOString();
  return {
    id: sample.id,
    name: sample.name,
    description: sample.description || '',
    labels: sample.labels,
    category: 'RCA',
    difficulty: sample.labels.find(l => l.startsWith('difficulty:'))?.split(':')[1] as any || 'Medium',
    currentVersion: 1,
    versions: [{
      version: 1,
      createdAt: now,
      initialPrompt: sample.initialPrompt,
      context: sample.context.map(c => ({ description: c.type, value: JSON.stringify(c.content) })),
      expectedOutcomes: sample.expectedOutcomes,
    }],
    isPromoted: sample.tags?.includes('promoted') || false,
    createdAt: now,
    updatedAt: now,
    initialPrompt: sample.initialPrompt,
    context: sample.context.map(c => ({ description: c.type, value: JSON.stringify(c.content) })),
    expectedOutcomes: sample.expectedOutcomes,
  };
}

/**
 * Get sample test cases as full TestCase objects
 */
function getSampleTestCases(): TestCase[] {
  return SAMPLE_TEST_CASES.map(toTestCase);
}

// GET /api/storage/test-cases - List all (latest versions) or filter by IDs
// Query params:
//   ids       - comma-separated IDs to filter by
//   fields    - 'summary' for lightweight list-view payload
//   size      - page size (default: all results)
//   after     - cursor token for pagination (composite aggregation key)
router.get('/api/storage/test-cases', async (req: Request, res: Response) => {
  try {
    const { ids, fields, size: sizeParam, after } = req.query;
    const filterIds = ids ? (ids as string).split(',').filter(Boolean) : null;
    const isSummary = fields === 'summary';
    const pageSize = sizeParam ? parseInt(sizeParam as string, 10) : null;
    const afterCursor = after as string | undefined;

    let realData: TestCase[] = [];
    const warnings: string[] = [];
    let storageReachable = false;
    const storageConfigured = isStorageAvailable(req);
    let totalCount: number | null = null;
    let nextAfter: string | null = null;

    // Build top_hits options (with optional _source filtering)
    const topHitsOptions: any = {
      size: 1,
      sort: [{ version: { order: 'desc' } }],
    };
    if (isSummary) {
      topHitsOptions._source = { includes: SUMMARY_SOURCE_INCLUDES };
    }

    // Fetch from OpenSearch if configured
    if (storageConfigured) {
      try {
        const client = requireStorageClient(req);

        if (filterIds) {
          // Filter by specific IDs - get latest version of each
          const nonSampleIds = filterIds.filter(id => !isSampleId(id));
          if (nonSampleIds.length > 0) {
            const result = await client.search({
              index: INDEX,
              body: {
                size: 0,
                aggs: {
                  by_id: {
                    terms: { field: 'id', size: nonSampleIds.length },
                    aggs: {
                      latest: { top_hits: topHitsOptions },
                    },
                  },
                },
                query: {
                  terms: { id: nonSampleIds },
                },
              },
            });

            const buckets = (result.body.aggregations?.by_id as any)?.buckets || [];
            realData = buckets.map((b: any) => b.latest.hits.hits[0]._source);
          }
        } else if (pageSize) {
          // Paginated mode: use composite aggregation with cursor
          const compositeAggs: any = {
            size: pageSize,
            sources: [{ id: { terms: { field: 'id' } } }],
          };
          if (afterCursor) {
            compositeAggs.after = { id: afterCursor };
          }

          const aggs: any = {
            by_id: {
              composite: compositeAggs,
              aggs: {
                latest: { top_hits: topHitsOptions },
              },
            },
          };

          // Add cardinality aggregation for total count
          aggs.total_count = {
            cardinality: { field: 'id' },
          };

          const result = await client.search({
            index: INDEX,
            body: { size: 0, aggs },
          });

          const buckets = (result.body.aggregations?.by_id as any)?.buckets || [];
          realData = buckets.map((b: any) => b.latest.hits.hits[0]._source);

          // Extract next cursor from last bucket
          const afterKey = (result.body.aggregations?.by_id as any)?.after_key;
          if (afterKey && buckets.length === pageSize) {
            nextAfter = afterKey.id;
          }

          // Get total unique test case count
          totalCount = (result.body.aggregations?.total_count as any)?.value || 0;
        } else {
          // Unpaginated mode: return all results (backward compat)
          const result = await client.search({
            index: INDEX,
            body: {
              size: 0,
              aggs: {
                by_id: {
                  terms: { field: 'id', size: 10000 },
                  aggs: {
                    latest: { top_hits: topHitsOptions },
                  },
                },
              },
            },
          });

          const buckets = (result.body.aggregations?.by_id as any)?.buckets || [];
          realData = buckets.map((b: any) => b.latest.hits.hits[0]._source);
        }
        storageReachable = true;
      } catch (e: any) {
        console.warn('[StorageAPI] OpenSearch unavailable, returning sample data only:', e.message);
        warnings.push(`OpenSearch unavailable: ${e.message}`);
      }
    }

    // Apply summary transformation to real data
    if (isSummary) {
      realData = realData.map(toSummary);
    }

    // Sort real data by createdAt descending (newest first)
    const sortedRealData = realData.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    // Get sample data (filtered by IDs if specified)
    let sampleData = getSampleTestCases();
    if (filterIds) {
      const sampleIds = filterIds.filter(id => isSampleId(id));
      sampleData = sampleData.filter(tc => sampleIds.includes(tc.id));
    }
    // Apply summary transformation to sample data
    if (isSummary) {
      sampleData = sampleData.map(toSummary);
    }
    // Sort sample data by createdAt descending
    sampleData = sampleData.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    // User data first, then sample data
    let allData = [...sortedRealData, ...sampleData];

    // For paginated mode without cursor (first page), also handle sample data pagination
    if (pageSize && !afterCursor) {
      // First page: include sample data, cap to pageSize
      if (allData.length > pageSize) {
        allData = allData.slice(0, pageSize);
        // There are more results
        if (!nextAfter && allData.length === pageSize) {
          nextAfter = '__sample__';
        }
      }
    } else if (pageSize && afterCursor) {
      // Subsequent pages: sample data already included in first page or not at all
      // Just use real data from composite aggregation
      allData = sortedRealData;
    }

    // Build metadata
    const meta: StorageMetadata = {
      storageConfigured,
      storageReachable,
      realDataCount: realData.length,
      sampleDataCount: sampleData.length,
      ...(warnings.length > 0 && { warnings }),
    };

    const response: any = {
      testCases: allData,
      total: totalCount !== null ? totalCount + sampleData.length : allData.length,
      meta,
    };

    // Include pagination info when paginating
    if (pageSize) {
      response.after = nextAfter;
      response.hasMore = !!nextAfter;
    }

    res.json(response);
  } catch (error: any) {
    console.error('[StorageAPI] List test cases failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/test-cases/:id - Get latest version
router.get('/api/storage/test-cases/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check sample data first
    if (isSampleId(id)) {
      const sample = SAMPLE_TEST_CASES.find(tc => tc.id === id);
      if (sample) {
        return res.json(toTestCase(sample));
      }
      return res.status(404).json({ error: 'Test case not found' });
    }

    // Fetch from OpenSearch
    if (!isStorageAvailable(req)) {
      return res.status(404).json({ error: 'Test case not found' });
    }

    const client = requireStorageClient(req);
    const result = await client.search({
      index: INDEX,
      body: {
        size: 1,
        sort: [{ version: { order: 'desc' } }],
        query: { term: { id } },
      },
    });

    const testCase = result.body.hits?.hits?.[0]?._source;
    if (!testCase) {
      return res.status(404).json({ error: 'Test case not found' });
    }
    res.json(testCase);
  } catch (error: any) {
    console.error('[StorageAPI] Get test case failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/test-cases/:id/versions - Get all versions
router.get('/api/storage/test-cases/:id/versions', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Sample data has only one version
    if (isSampleId(id)) {
      const sample = SAMPLE_TEST_CASES.find(tc => tc.id === id);
      if (sample) {
        const testCase = toTestCase(sample);
        return res.json({ versions: [testCase], total: 1 });
      }
      return res.status(404).json({ error: 'Test case not found' });
    }

    if (!isStorageAvailable(req)) {
      return res.status(404).json({ error: 'Test case not found' });
    }

    const client = requireStorageClient(req);
    const result = await client.search({
      index: INDEX,
      body: {
        size: 1000,
        sort: [{ version: { order: 'desc' } }],
        query: { term: { id } },
      },
    });

    const versions = result.body.hits?.hits?.map((hit: any) => hit._source) || [];
    res.json({ versions, total: versions.length });
  } catch (error: any) {
    console.error('[StorageAPI] Get test case versions failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/test-cases/:id/versions/:version - Get specific version
router.get('/api/storage/test-cases/:id/versions/:version', async (req: Request, res: Response) => {
  try {
    const { id, version } = req.params;

    // Sample data has only version 1
    if (isSampleId(id)) {
      if (version === '1') {
        const sample = SAMPLE_TEST_CASES.find(tc => tc.id === id);
        if (sample) {
          return res.json(toTestCase(sample));
        }
      }
      return res.status(404).json({ error: 'Test case version not found' });
    }

    if (!isStorageAvailable(req)) {
      return res.status(404).json({ error: 'Test case version not found' });
    }

    const client = requireStorageClient(req);
    const result = await client.search({
      index: INDEX,
      body: {
        size: 1,
        query: {
          bool: {
            must: [{ term: { id } }, { term: { version: parseInt(version) } }],
          },
        },
      },
    });

    const testCase = result.body.hits?.hits?.[0]?._source;
    if (!testCase) {
      return res.status(404).json({ error: 'Test case version not found' });
    }
    res.json(testCase);
  } catch (error: any) {
    console.error('[StorageAPI] Get test case version failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/test-cases - Create new (version 1)
router.post('/api/storage/test-cases', async (req: Request, res: Response) => {
  try {
    const testCase = { ...req.body };

    // Reject creating with demo- prefix
    if (testCase.id && isSampleId(testCase.id)) {
      return res.status(400).json({ error: 'Cannot create test case with demo- prefix (reserved for sample data)' });
    }

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot create new test cases in sample-only mode.' });
    }

    const client = requireStorageClient(req);

    if (!testCase.id) testCase.id = generateId();
    testCase.version = 1;
    testCase.createdAt = new Date().toISOString();
    testCase.updatedAt = testCase.createdAt;

    const docId = `${testCase.id}-v${testCase.version}`;
    await client.index({ index: INDEX, id: docId, body: testCase, refresh: true });

    console.log(`[StorageAPI] Created test case: ${testCase.id} v${testCase.version}`);
    res.status(201).json(testCase);
  } catch (error: any) {
    console.error('[StorageAPI] Create test case failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/storage/test-cases/:id - Create new version
router.put('/api/storage/test-cases/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Reject modifying sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot modify sample data. Sample test cases are read-only.' });
    }

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot update test cases in sample-only mode.' });
    }

    const client = requireStorageClient(req);

    // Get current latest version
    const searchResult = await client.search({
      index: INDEX,
      body: {
        size: 1,
        sort: [{ version: { order: 'desc' } }],
        query: { term: { id } },
      },
    });
    const currentVersion = searchResult.body.hits?.hits?.[0]?._source?.version || 0;

    // Create new version
    const newTestCase = {
      ...req.body,
      id,
      version: currentVersion + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const docId = `${id}-v${newTestCase.version}`;
    await client.index({ index: INDEX, id: docId, body: newTestCase, refresh: true });

    console.log(`[StorageAPI] Updated test case: ${id} → v${newTestCase.version}`);
    res.json(newTestCase);
  } catch (error: any) {
    console.error('[StorageAPI] Update test case failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/test-cases/:id - Delete all versions
router.delete('/api/storage/test-cases/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Reject deleting sample data
    if (isSampleId(id)) {
      return res.status(400).json({ error: 'Cannot delete sample data. Sample test cases are read-only.' });
    }

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot delete test cases in sample-only mode.' });
    }

    const client = requireStorageClient(req);

    const result = await client.deleteByQuery({
      index: INDEX,
      body: { query: { term: { id } } },
      refresh: true,
    });

    const deleted = (result.body as any).deleted || 0;
    console.log(`[StorageAPI] Deleted test case: ${id} (${deleted} versions)`);
    res.json({ deleted });
  } catch (error: any) {
    console.error('[StorageAPI] Delete test case failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/test-cases/bulk - Bulk create
router.post('/api/storage/test-cases/bulk', async (req: Request, res: Response) => {
  try {
    const { testCases } = req.body;
    if (!Array.isArray(testCases)) {
      return res.status(400).json({ error: 'testCases must be an array' });
    }

    // Check for demo- prefixes
    const hasDemoIds = testCases.some(tc => tc.id && isSampleId(tc.id));
    if (hasDemoIds) {
      return res.status(400).json({ error: 'Cannot create test cases with demo- prefix (reserved for sample data)' });
    }

    // Require OpenSearch for writes
    if (!isStorageAvailable(req)) {
      return res.status(400).json({ error: 'OpenSearch not configured. Cannot create test cases in sample-only mode.' });
    }

    const client = requireStorageClient(req);
    const now = new Date().toISOString();
    const operations: any[] = [];

    for (const tc of testCases) {
      if (!tc.id) tc.id = generateId();
      tc.version = tc.version || 1;
      tc.createdAt = tc.createdAt || now;
      tc.updatedAt = tc.updatedAt || now;

      const docId = `${tc.id}-v${tc.version}`;
      operations.push({ index: { _index: INDEX, _id: docId } });
      operations.push(tc);
    }

    const result = await client.bulk({ body: operations, refresh: true });

    console.log(`[StorageAPI] Bulk created ${testCases.length} test cases`);
    res.json({ created: testCases.length, errors: result.body.errors, testCases });
  } catch (error: any) {
    console.error('[StorageAPI] Bulk create test cases failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
