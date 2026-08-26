/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test Cases Routes - Versioned CRUD operations
 *
 * Storage-backend agnostic: uses IStorageModule adapter (file or OpenSearch).
 * Sample data (demo-*) is always included in responses.
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { getStorageModule } from '../../adapters/index.js';
import { SAMPLE_TEST_CASES } from '../../../cli/demo/sampleTestCases.js';
import type { TestCase, StorageMetadata } from '../../../types/index.js';

const router = Router();

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
//   after     - cursor token for pagination (ID-based cursor)
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
    const storage = getStorageModule();
    const storageConfigured = storage.isConfigured();
    let totalCount: number | null = null;
    let nextAfter: string | null = null;

    // Fetch from storage backend
    if (storageConfigured) {
      try {
        if (filterIds) {
          // Filter by specific IDs - get latest version of each. Fan out in
          // PARALLEL — this used to await each id sequentially, which at
          // ~80ms/OpenSearch round-trip made an 84-case benchmark inspect
          // page block ~7s on this request alone.
          const nonSampleIds = filterIds.filter(id => !isSampleId(id));
          const fetched = await Promise.all(
            nonSampleIds.map(id => storage.testCases.getById(id).catch(() => null)),
          );
          realData = fetched.filter((tc): tc is TestCase => tc !== null);
        } else {
          // Get all test cases (adapter returns latest versions)
          const result = await storage.testCases.getAll();
          let allItems = result.items;
          totalCount = result.total;

          // Handle cursor-based pagination
          if (pageSize) {
            if (afterCursor && afterCursor !== '__sample__') {
              const idx = allItems.findIndex(tc => tc.id === afterCursor);
              if (idx >= 0) {
                allItems = allItems.slice(idx + 1);
              }
            }
            realData = allItems.slice(0, pageSize);

            // Set next cursor if there are more results
            if (realData.length === pageSize && realData.length < allItems.length) {
              nextAfter = realData[realData.length - 1].id;
            }
          } else {
            realData = allItems;
          }
        }
        storageReachable = true;
      } catch (e: any) {
        console.warn('[StorageAPI] Storage unavailable, returning sample data only:', e.message);
        warnings.push(`Storage unavailable: ${e.message}`);
      }
    }

    // Apply summary transformation to real data
    if (isSummary) {
      realData = realData.map(toSummary);
    }

    // Determine whether to include sample data
    // Use totalCount (overall storage count) rather than realData.length (current page)
    const includeSampleParam = req.query.includeSample as string | undefined;
    const hasRealData = totalCount != null ? totalCount > 0 : realData.length > 0;
    const shouldIncludeSample = includeSampleParam === 'true' ? true
      : includeSampleParam === 'false' ? false
      : !hasRealData;

    // Sort real data by lastActivity (max of lastRunAt, updatedAt, createdAt) descending
    const lastActivity = (tc: any): number => Math.max(
      tc.lastRunAt ? new Date(tc.lastRunAt).getTime() : 0,
      tc.updatedAt ? new Date(tc.updatedAt).getTime() : 0,
      tc.createdAt ? new Date(tc.createdAt).getTime() : 0,
    );
    const sortedRealData = realData.sort((a, b) => lastActivity(b) - lastActivity(a));

    // Get sample data (filtered by IDs if specified), conditionally included
    let sampleData: TestCase[] = [];
    if (shouldIncludeSample) {
      sampleData = getSampleTestCases();
      if (filterIds) {
        const sampleIds = filterIds.filter(id => isSampleId(id));
        sampleData = sampleData.filter(tc => sampleIds.includes(tc.id));
      }
      // Apply summary transformation to sample data
      if (isSummary) {
        sampleData = sampleData.map(toSummary);
      }
      // Sort sample data by lastActivity descending
      sampleData = sampleData.sort((a, b) => lastActivity(b) - lastActivity(a));
    }

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
      // Just use real data from pagination
      allData = sortedRealData;
    }

    // Build metadata
    const meta: StorageMetadata = {
      storageConfigured,
      storageReachable,
      realDataCount: realData.length,
      sampleDataCount: sampleData.length,
      sampleDataIncluded: shouldIncludeSample,
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

    // Fetch from storage
    const storage = getStorageModule();
    const testCase = await storage.testCases.getById(id);
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

    const storage = getStorageModule();
    const versions = await storage.testCases.getVersions(id);
    if (versions.length === 0) {
      return res.status(404).json({ error: 'Test case not found' });
    }
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

    const storage = getStorageModule();
    const testCase = await storage.testCases.getVersion(id, parseInt(version));
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

    const storage = getStorageModule();
    const created = await storage.testCases.create(testCase);

    debug('StorageAPI', `Created test case: ${created.id} v1`);
    res.status(201).json(created);
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

    const storage = getStorageModule();
    const updated = await storage.testCases.update(id, req.body);

    debug('StorageAPI', `Updated test case: ${id} → v${(updated as any).version || (updated as any).currentVersion}`);
    res.json(updated);
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

    const storage = getStorageModule();
    const result = await storage.testCases.delete(id);

    debug('StorageAPI', `Deleted test case: ${id} (${result.deleted} versions)`);
    res.json(result);
  } catch (error: any) {
    console.error('[StorageAPI] Delete test case failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/test-cases/bulk - Bulk import
//
// Auto-routes based on `sourceFile`:
//  - Any incoming test case has `sourceFile` set (SDK / code-imported) →
//    `bulkUpsert` semantics: dedup by `(name, sourceFile)`, version-bump on
//    `sourceHash` drift, reuse existing TestCase IDs across runs of the same
//    .eval.js file. This is what stops `benchmark.testCaseIds` from growing
//    unbounded when a user re-runs the same SDK file via `npx agent-health
//    benchmark -f file.eval.js`.
//  - Otherwise (JSON imports / UI uploads) → strict `bulkCreate`. Pre-existing
//    callers don't carry `sourceFile`, so behaviour is unchanged for them.
//
// The response shape is a superset of both modes: `created` is always present,
// `updated` and `unchanged` are present only on the upsert path.
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

    const storage = getStorageModule();

    // Provenance gate. Reject mixed batches — in `bulkUpsert` an item without
    // `sourceFile` matches an existing record by `name` ALONE
    // (`e.name === tc.name && (tc.sourceFile ? e.sourceFile === tc.sourceFile : true)`),
    // which can silently overwrite an unrelated SDK TestCase that happens to
    // share a name and clear its `sourceHash` (the update payload sets
    // `sourceHash: tc.sourceHash`, which is `undefined` for JSON items). The
    // CLI never sends mixed batches — it imports either an SDK file (all
    // items carry `sourceFile`) or a JSON file (no items carry it) — so the
    // 400 is a hard contract, not a UX paper-cut. Callers wanting both must
    // split into two requests.
    const withSource = testCases.filter(tc => typeof tc?.sourceFile === 'string' && tc.sourceFile.length > 0);
    const withoutSource = testCases.length - withSource.length;
    if (withSource.length > 0 && withoutSource > 0) {
      return res.status(400).json({
        error:
          'Mixed batch rejected: every test case must either set `sourceFile` ' +
          '(SDK / code-import upsert path) or omit it (JSON strict-create path); ' +
          `received ${withSource.length} with sourceFile and ${withoutSource} without.`,
      });
    }

    if (withSource.length > 0) {
      const result = await storage.testCases.bulkUpsert(testCases);
      debug(
        'StorageAPI',
        `Bulk upserted: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged`
      );
      res.json({
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        errors: 0,
        testCases: result.testCases,
      });
      return;
    }

    const result = await storage.testCases.bulkCreate(testCases);
    debug('StorageAPI', `Bulk created ${result.created} test cases`);
    res.json({ created: result.created, errors: result.errors, testCases: result.testCases });
  } catch (error: any) {
    console.error('[StorageAPI] Bulk import test cases failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
