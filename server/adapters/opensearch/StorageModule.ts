/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenSearch Storage Module
 *
 * Implements IStorageModule using an OpenSearch client.
 * Thin wrapper: delegates to the OpenSearch client with the same query patterns
 * used by the old route code.
 *
 * Index layout:
 *   evals_test_cases   - doc ID: {id}-v{version}
 *   evals_experiments   - doc ID: {id}   (benchmarks, name kept for data compat)
 *   evals_runs          - doc ID: {id}
 *   evals_analytics     - doc ID: analytics-{runId}
 */

import { Client } from '@opensearch-project/opensearch';
import type {
  TestCase,
  Benchmark,
  BenchmarkRun,
  BenchmarkImage,
  EvaluationRun,
  TestCaseRun,
  RunAnnotation,
  HealthStatus,
  Evaluator,
  RunResultStatus,
} from '../../../types/index.js';
import type {
  IStorageModule,
  ITestCaseOperations,
  IBenchmarkOperations,
  IBenchmarkImageOperations,
  IEvaluationRunOperations,
  IRunOperations,
  IAnalyticsOperations,
  IEvaluatorOperations,
  ISessionMetadataOperations,
  PaginationOptions,
  TestCaseSearchFilters,
  RunSearchFilters,
} from '../types.js';
import { STORAGE_INDEXES } from '../../middleware/dataSourceConfig.js';
import { assertNotMigrating } from '../../services/migrationLock.js';
import { describeOpenSearchError } from '../../services/opensearchClientFactory.js';
import { RUN_SUMMARY_FIELDS } from '../runSummary.js';

// ============================================================================
// Helpers
// ============================================================================

function hitsToSources<T>(hits: any[]): T[] {
  return hits.map((h: any) => h._source as T);
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Exact discriminator match across both current text+keyword and legacy text-only mappings. */
function docTypeIs(value: string): any {
  return {
    bool: {
      should: [
        { term: { 'docType.keyword': value } },
        { match_phrase: { docType: value } },
      ],
      minimum_should_match: 1,
    },
  };
}

/**
 * Detect index-not-found errors from OpenSearch.
 * Returns true if the error indicates the index doesn't exist yet,
 * allowing callers to return empty results instead of throwing.
 */
function isIndexNotFound(error: any): boolean {
  return error.meta?.statusCode === 404 ||
    error.meta?.body?.error?.type === 'index_not_found_exception';
}

// ============================================================================
// Test Case Operations
// ============================================================================

class OpenSearchTestCaseOperations implements ITestCaseOperations {
  constructor(private client: Client) {}

  private get index() { return STORAGE_INDEXES.testCases; }

  async getAll(options?: PaginationOptions): Promise<{ items: TestCase[]; total: number }> {
    const size = options?.size ?? 10000;
    const from = options?.from ?? 0;

    let result;
    try {
      // Fetch all docs, then group by ID to return latest version of each
      result = await this.client.search({
        index: this.index,
        body: {
          size,
          from,
          sort: [{ createdAt: { order: 'desc' } }],
          query: { match_all: {} },
        },
      });
    } catch (error: any) {
      if (isIndexNotFound(error)) return { items: [], total: 0 };
      throw error;
    }

    const hits = result.body.hits?.hits || [];
    const allDocs = hitsToSources<TestCase & { version?: number }>(hits);
    const total = typeof result.body.hits?.total === 'object'
      ? result.body.hits.total.value
      : result.body.hits?.total ?? 0;

    // Group by ID, keep latest version
    const byId = new Map<string, TestCase>();
    for (const doc of allDocs) {
      const existing = byId.get(doc.id);
      const docVer = (doc as any).version ?? (doc as any).currentVersion ?? 0;
      const existVer = existing ? ((existing as any).version ?? (existing as any).currentVersion ?? 0) : -1;
      if (!existing || docVer > existVer) {
        byId.set(doc.id, doc);
      }
    }

    const items = Array.from(byId.values()).sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    return { items, total: items.length };
  }

  async getById(id: string): Promise<TestCase | null> {
    // Search for latest version of this test case
    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size: 1,
          sort: [{ version: { order: 'desc' } }],
          query: { term: { id } },
        },
      });

      const hits = result.body.hits?.hits || [];
      return hits.length > 0 ? hits[0]._source as TestCase : null;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async getVersions(id: string): Promise<TestCase[]> {
    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size: 100,
          sort: [{ version: { order: 'desc' } }],
          query: { term: { id } },
        },
      });

      return hitsToSources<TestCase>(result.body.hits?.hits || []);
    } catch (error: any) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  async getVersion(id: string, version: number): Promise<TestCase | null> {
    const docId = `${id}-v${version}`;
    try {
      const result = await this.client.get({ index: this.index, id: docId });
      return result.body.found ? result.body._source as TestCase : null;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async create(testCase: Partial<TestCase>): Promise<TestCase> {
    assertNotMigrating(this.index);
    if (!testCase.name) throw new Error('Test case name is required');
    const now = new Date().toISOString();
    const id = testCase.id || generateId('tc');
    const version = 1;
    const docId = `${id}-v${version}`;

    const doc: TestCase = {
      ...testCase,
      id,
      version,
      currentVersion: version,
      createdAt: now,
      updatedAt: now,
    } as TestCase;

    await this.client.index({
      index: this.index,
      id: docId,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async update(id: string, updates: Partial<TestCase>): Promise<TestCase> {
    assertNotMigrating(this.index);
    const current = await this.getById(id);
    if (!current) throw new Error(`Test case ${id} not found`);
    const currentVer = (current as any).version ?? (current as any).currentVersion ?? 0;
    const newVer = currentVer + 1;
    const now = new Date().toISOString();
    const docId = `${id}-v${newVer}`;

    const doc: TestCase = {
      ...current,
      ...updates,
      id,
      version: newVer,
      currentVersion: newVer,
      createdAt: now,
      updatedAt: now,
    } as TestCase;

    await this.client.index({
      index: this.index,
      id: docId,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async delete(id: string): Promise<{ deleted: number }> {
    assertNotMigrating(this.index);
    const result = await this.client.deleteByQuery({
      index: this.index,
      body: { query: { term: { id } } },
      refresh: true,
    });

    return { deleted: (result.body as any).deleted || 0 };
  }

  async search(filters: TestCaseSearchFilters, options?: PaginationOptions): Promise<{ items: TestCase[]; total: number }> {
    const { items: all } = await this.getAll();
    let filtered = all;

    if (filters.labels?.length) {
      filtered = filtered.filter(tc =>
        filters.labels!.some(label => tc.labels?.includes(label))
      );
    }
    if (filters.category) {
      filtered = filtered.filter(tc => tc.category === filters.category);
    }
    if (filters.difficulty) {
      filtered = filtered.filter(tc => tc.difficulty === filters.difficulty);
    }
    if (filters.isPromoted !== undefined) {
      filtered = filtered.filter(tc => tc.isPromoted === filters.isPromoted);
    }
    if (filters.textSearch) {
      const q = filters.textSearch.toLowerCase();
      filtered = filtered.filter(tc =>
        tc.name?.toLowerCase().includes(q) ||
        tc.description?.toLowerCase().includes(q) ||
        tc.initialPrompt?.toLowerCase().includes(q)
      );
    }

    const total = filtered.length;
    const from = options?.from ?? 0;
    const size = options?.size ?? total;
    return { items: filtered.slice(from, from + size), total };
  }

  async bulkCreate(testCases: Partial<TestCase>[]): Promise<{ created: number; errors: number; testCases: TestCase[] }> {
    let created = 0;
    let errors = 0;
    const createdTestCases: TestCase[] = [];
    for (const tc of testCases) {
      try {
        const result = await this.create(tc);
        createdTestCases.push(result);
        created++;
      } catch {
        errors++;
      }
    }
    return { created, errors, testCases: createdTestCases };
  }

  async bulkUpsert(testCases: Partial<TestCase>[]): Promise<{ created: number; updated: number; unchanged: number; testCases: TestCase[] }> {
    const { items: all } = await this.getAll({ size: 10000 });
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const results: TestCase[] = [];

    for (const tc of testCases) {
      const existing = all.find(
        e => e.name === tc.name && (tc.sourceFile ? e.sourceFile === tc.sourceFile : true)
      );

      if (existing) {
        if (existing.sourceHash === tc.sourceHash) {
          unchanged++;
          results.push(existing);
        } else {
          const updatedTc = await this.update(existing.id, {
            ...tc,
            sourceHash: tc.sourceHash,
          });
          updated++;
          results.push(updatedTc);
        }
      } else {
        const newTc = await this.create(tc);
        created++;
        results.push(newTc);
      }
    }

    return { created, updated, unchanged, testCases: results };
  }
}

// ============================================================================
// Benchmark Operations
// ============================================================================

class OpenSearchBenchmarkOperations implements IBenchmarkOperations {
  constructor(private client: Client) {}

  private get index() { return STORAGE_INDEXES.benchmarks; }

  async getAll(options?: PaginationOptions): Promise<{ items: Benchmark[]; total: number }> {
    const size = options?.size ?? 1000;
    const from = options?.from ?? 0;

    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size,
          from,
          sort: [{ createdAt: { order: 'desc' } }],
          // Benchmarks share this index with evaluation-runs and
          // benchmark-images. Legacy benchmarks have no docType; exclude both
          // non-benchmark discriminators so they don't surface as empty rows.
          query: {
            bool: {
              must_not: [docTypeIs('evaluation-run'), docTypeIs('benchmark-image')],
            },
          },
        },
      });

      const items = hitsToSources<Benchmark>(result.body.hits?.hits || []);
      const total = typeof result.body.hits?.total === 'object'
        ? result.body.hits.total.value
        : result.body.hits?.total ?? 0;

      return { items, total };
    } catch (error: any) {
      if (isIndexNotFound(error)) return { items: [], total: 0 };
      throw error;
    }
  }

  async getById(id: string): Promise<Benchmark | null> {
    try {
      const result = await this.client.get({ index: this.index, id });
      if (!result.body.found) return null;
      const doc = result.body._source as Benchmark & { docType?: string };
      // Shared index — an eval-run / image id is NOT a benchmark, so the
      // benchmark detail route must not render it as an empty benchmark.
      return doc.docType === undefined || doc.docType === 'benchmark' ? doc : null;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async create(benchmark: Partial<Benchmark>): Promise<Benchmark> {
    assertNotMigrating(this.index);
    const now = new Date().toISOString();
    const id = benchmark.id || generateId('bench');

    const doc: Benchmark = {
      ...benchmark,
      id,
      runs: benchmark.runs || [],
      createdAt: now,
      updatedAt: now,
    } as Benchmark;

    await this.client.index({
      index: this.index,
      id,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async update(id: string, updates: Partial<Benchmark>): Promise<Benchmark> {
    assertNotMigrating(this.index);
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Benchmark ${id} not found`);

    const doc: Benchmark = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    };

    await this.client.index({
      index: this.index,
      id,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    assertNotMigrating(this.index);
    try {
      await this.client.delete({ index: this.index, id, refresh: 'wait_for' });
      return { deleted: true };
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return { deleted: false };
      throw error;
    }
  }

  async addRun(benchmarkId: string, run: BenchmarkRun): Promise<boolean> {
    assertNotMigrating(this.index);
    try {
      await this.client.update({
        index: this.index,
        id: benchmarkId,
        retry_on_conflict: 3,
        body: {
          script: {
            source: `
              if (ctx._source.runs == null) {
                ctx._source.runs = [];
              }
              boolean exists = false;
              for (def existing : ctx._source.runs) {
                if (existing.id == params.run.id) { exists = true; break; }
              }
              if (!exists) {
                ctx._source.runs.add(params.run);
                ctx._source.updatedAt = params.now;
              }
            `,
            params: { run, now: new Date().toISOString() },
          },
        },
        refresh: 'wait_for',
      });
      return true;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return false;
      throw error;
    }
  }

  async updateRun(benchmarkId: string, runId: string, updates: Partial<BenchmarkRun>): Promise<boolean> {
    assertNotMigrating(this.index);
    try {
      await this.client.update({
        index: this.index,
        id: benchmarkId,
        retry_on_conflict: 3,
        body: {
          script: {
            source: `
              for (int i = 0; i < ctx._source.runs.size(); i++) {
                if (ctx._source.runs[i].id == params.runId) {
                  for (def entry : params.updates.entrySet()) {
                    ctx._source.runs[i][entry.getKey()] = entry.getValue();
                  }
                  break;
                }
              }
              ctx._source.updatedAt = params.now;
            `,
            params: { runId, updates, now: new Date().toISOString() },
          },
        },
        refresh: 'wait_for',
      });
      return true;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return false;
      throw error;
    }
  }

  async deleteRun(benchmarkId: string, runId: string): Promise<boolean> {
    assertNotMigrating(this.index);
    try {
      await this.client.update({
        index: this.index,
        id: benchmarkId,
        retry_on_conflict: 3,
        body: {
          script: {
            source: `
              ctx._source.runs.removeIf(r -> r.id == params.runId);
              ctx._source.updatedAt = params.now;
            `,
            params: { runId, now: new Date().toISOString() },
          },
        },
        refresh: 'wait_for',
      });
      return true;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return false;
      throw error;
    }
  }

  async bulkCreate(benchmarks: Partial<Benchmark>[]): Promise<{ created: number; errors: number }> {
    let created = 0;
    let errors = 0;
    for (const b of benchmarks) {
      try {
        await this.create(b);
        created++;
      } catch {
        errors++;
      }
    }
    return { created, errors };
  }
}

// ============================================================================
// Run (TestCaseRun) Operations
// ============================================================================

class OpenSearchRunOperations implements IRunOperations {
  constructor(private client: Client) {}

  private get index() { return STORAGE_INDEXES.runs; }

  async getAll(options?: PaginationOptions): Promise<{ items: TestCaseRun[]; total: number }> {
    const size = options?.size ?? 100;
    const from = options?.from ?? 0;

    const body: any = {
      size,
      from,
      sort: [{ createdAt: { order: 'desc' } }],
      query: { match_all: {} },
    };

    if (options?._source && options._source.length > 0) {
      body._source = options._source;
    }

    try {
      const result = await this.client.search({
        index: this.index,
        body,
      });

      const items = hitsToSources<TestCaseRun>(result.body.hits?.hits || []);
      const total = typeof result.body.hits?.total === 'object'
        ? result.body.hits.total.value
        : result.body.hits?.total ?? 0;

      return { items, total };
    } catch (error: any) {
      if (isIndexNotFound(error)) return { items: [], total: 0 };
      throw error;
    }
  }

  async getById(id: string): Promise<TestCaseRun | null> {
    try {
      const result = await this.client.get({ index: this.index, id });
      if (!result.body.found) return null;
      const doc = result.body._source as any;
      // Normalize: storage uses 'traceId' but app layer expects 'runId'
      if (doc.traceId && !doc.runId) {
        doc.runId = doc.traceId;
      }
      return doc as TestCaseRun;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async create(run: Partial<TestCaseRun>): Promise<TestCaseRun> {
    assertNotMigrating(this.index);
    const now = new Date().toISOString();
    const id = run.id || generateId('report');

    const doc: TestCaseRun = {
      ...run,
      id,
      timestamp: (run as any).timestamp || now,
      createdAt: now,
    } as TestCaseRun;

    await this.client.index({
      index: this.index,
      id,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async update(id: string, updates: Partial<TestCaseRun>): Promise<TestCaseRun> {
    assertNotMigrating(this.index);
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Run ${id} not found`);

    const doc: TestCaseRun = { ...existing, ...updates, id } as TestCaseRun;

    await this.client.index({
      index: this.index,
      id,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    assertNotMigrating(this.index);
    try {
      await this.client.delete({ index: this.index, id, refresh: 'wait_for' });
      return { deleted: true };
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return { deleted: false };
      throw error;
    }
  }

  async search(filters: RunSearchFilters, options?: PaginationOptions): Promise<{ items: TestCaseRun[]; total: number }> {
    const must: any[] = [];

    if (filters.experimentId) must.push({ term: { experimentId: filters.experimentId } });
    if (filters.experimentRunId) must.push({ term: { experimentRunId: filters.experimentRunId } });
    if (filters.testCaseId) must.push({ term: { testCaseId: filters.testCaseId } });
    if (filters.agentId) must.push({ term: { agentId: filters.agentId } });
    if (filters.modelId) must.push({ term: { modelId: filters.modelId } });
    if (filters.status) must.push({ term: { status: filters.status } });
    if (filters.passFailStatus) must.push({ term: { passFailStatus: filters.passFailStatus } });
    if (filters.dateRange) {
      must.push({
        range: {
          createdAt: {
            gte: filters.dateRange.start,
            lte: filters.dateRange.end,
          },
        },
      });
    }

    const query = must.length > 0 ? { bool: { must } } : { match_all: {} };
    const size = options?.size ?? 100;
    const from = options?.from ?? 0;

    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size,
          from,
          sort: [{ createdAt: { order: 'desc' } }],
          query,
          ...(options?._source?.length ? { _source: options._source } : {}),
        },
      });

      const items = hitsToSources<TestCaseRun>(result.body.hits?.hits || []);
      const total = typeof result.body.hits?.total === 'object'
        ? result.body.hits.total.value
        : result.body.hits?.total ?? 0;

      return { items, total };
    } catch (error: any) {
      if (isIndexNotFound(error)) return { items: [], total: 0 };
      throw error;
    }
  }

  async getByTestCase(testCaseId: string, size?: number, from?: number): Promise<{ items: TestCaseRun[]; total: number }> {
    return this.search({ testCaseId }, { size, from, _source: [...RUN_SUMMARY_FIELDS] });
  }

  async getByExperiment(experimentId: string, size?: number): Promise<TestCaseRun[]> {
    const { items } = await this.search({ experimentId }, { size, _source: [...RUN_SUMMARY_FIELDS] });
    return items;
  }

  async getByExperimentRun(experimentId: string, runId: string, size?: number): Promise<TestCaseRun[]> {
    const { items } = await this.search(
      { experimentId, experimentRunId: runId },
      { size, _source: [...RUN_SUMMARY_FIELDS] },
    );
    return items;
  }

  async getIterations(experimentId: string, testCaseId: string, experimentRunId?: string): Promise<{
    items: TestCaseRun[];
    total: number;
    maxIteration: number;
  }> {
    const filters: RunSearchFilters = { experimentId, testCaseId };
    if (experimentRunId) filters.experimentRunId = experimentRunId;
    const { items } = await this.search(filters, { size: 1000, _source: [...RUN_SUMMARY_FIELDS] });

    const maxIteration = items.reduce((max, r) => Math.max(max, (r as any).iteration || 0), 0);
    return { items, total: items.length, maxIteration };
  }

  async bulkCreate(runs: Partial<TestCaseRun>[]): Promise<{ created: number; errors: number }> {
    let created = 0;
    let errors = 0;
    for (const r of runs) {
      try {
        await this.create(r);
        created++;
      } catch {
        errors++;
      }
    }
    return { created, errors };
  }

  async addAnnotation(runId: string, annotation: Partial<RunAnnotation>): Promise<RunAnnotation> {
    assertNotMigrating(this.index);
    const run = await this.getById(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const now = new Date().toISOString();
    const fullAnnotation: RunAnnotation = {
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      reportId: runId,
      text: '',
      ...annotation,
      timestamp: now,
    } as RunAnnotation;

    const annotations = (run as any).annotations || [];
    annotations.push(fullAnnotation);

    await this.client.update({
      index: this.index,
      id: runId,
      body: { doc: { annotations } },
      refresh: 'wait_for',
    });

    return fullAnnotation;
  }

  async updateAnnotation(runId: string, annotationId: string, updates: Partial<RunAnnotation>): Promise<RunAnnotation> {
    assertNotMigrating(this.index);
    const run = await this.getById(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const annotations = (run as any).annotations || [];
    const idx = annotations.findIndex((a: any) => a.id === annotationId);
    if (idx === -1) throw new Error(`Annotation ${annotationId} not found`);

    annotations[idx] = {
      ...annotations[idx],
      ...updates,
      timestamp: new Date().toISOString(),
    };

    await this.client.update({
      index: this.index,
      id: runId,
      body: { doc: { annotations } },
      refresh: 'wait_for',
    });

    return annotations[idx];
  }

  async deleteAnnotation(runId: string, annotationId: string): Promise<{ deleted: boolean }> {
    assertNotMigrating(this.index);
    const run = await this.getById(runId);
    if (!run) return { deleted: false };

    const annotations = (run as any).annotations || [];
    const originalLength = annotations.length;
    const filtered = annotations.filter((a: any) => a.id !== annotationId);

    if (filtered.length === originalLength) return { deleted: false };

    await this.client.update({
      index: this.index,
      id: runId,
      body: { doc: { annotations: filtered } },
      refresh: 'wait_for',
    });

    return { deleted: true };
  }

  async countsByTestCase(): Promise<Record<string, number>> {
    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size: 0,
          aggs: {
            by_test_case: {
              terms: { field: 'testCaseId', size: 10000 },
            },
          },
        },
      });
      const buckets: Array<{ key: string; doc_count: number }> =
        (result.body.aggregations as any)?.by_test_case?.buckets ?? [];
      const counts: Record<string, number> = {};
      for (const bucket of buckets) {
        if (bucket.key) counts[bucket.key] = bucket.doc_count;
      }
      return counts;
    } catch (error: any) {
      if (isIndexNotFound(error)) return {};
      throw error;
    }
  }
}

// ============================================================================
// Analytics Operations
// ============================================================================

class OpenSearchAnalyticsOperations implements IAnalyticsOperations {
  constructor(private client: Client) {}

  private get index() { return STORAGE_INDEXES.analytics; }

  async query(filters: Record<string, unknown>, options?: PaginationOptions): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const must: any[] = [];
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null) {
        must.push({ term: { [key]: value } });
      }
    }

    const query = must.length > 0 ? { bool: { must } } : { match_all: {} };
    const size = options?.size ?? 1000;
    const from = options?.from ?? 0;

    try {
      const result = await this.client.search({
        index: this.index,
        body: { size, from, query },
      });

      const items = hitsToSources<Record<string, unknown>>(result.body.hits?.hits || []);
      const total = typeof result.body.hits?.total === 'object'
        ? result.body.hits.total.value
        : result.body.hits?.total ?? 0;

      return { items, total };
    } catch (error: any) {
      // Index may not exist yet
      if (error.meta?.statusCode === 404) {
        return { items: [], total: 0 };
      }
      throw error;
    }
  }

  async aggregations(experimentId?: string, groupBy?: string): Promise<{ aggregations: Record<string, unknown>[]; groupBy: string }> {
    const field = groupBy || 'agentId';
    const must: any[] = [];
    if (experimentId) must.push({ term: { experimentId } });

    const query = must.length > 0 ? { bool: { must } } : { match_all: {} };

    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size: 0,
          query,
          aggs: {
            by_field: {
              terms: { field: `${field}.keyword`, size: 100 },
              aggs: {
                avg_accuracy: { avg: { field: 'metric_accuracy' } },
                pass_count: { filter: { term: { passFailStatus: 'passed' } } },
                fail_count: { filter: { term: { passFailStatus: 'failed' } } },
              },
            },
          },
        },
      });

      const buckets = (result.body.aggregations?.by_field as any)?.buckets || [];
      const aggregations = buckets.map((b: any) => ({
        key: b.key,
        metrics: { avgAccuracy: b.avg_accuracy?.value },
        passCount: b.pass_count?.doc_count || 0,
        failCount: b.fail_count?.doc_count || 0,
        totalRuns: b.doc_count || 0,
      }));

      return { aggregations, groupBy: field };
    } catch (error: any) {
      if (error.meta?.statusCode === 404) {
        return { aggregations: [], groupBy: field };
      }
      throw error;
    }
  }

  async writeRecord(record: Record<string, unknown>): Promise<void> {
    assertNotMigrating(this.index);
    const id = (record.id as string) || `analytics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.client.index({
      index: this.index,
      id,
      body: { ...record, id },
      refresh: 'wait_for',
    });
  }

  async backfill(): Promise<{ backfilled: number; errors: number; total: number }> {
    // Backfill is handled at a higher level (admin route)
    return { backfilled: 0, errors: 0, total: 0 };
  }
}

// ============================================================================
// Evaluator Operations
// ============================================================================

class OpenSearchEvaluatorOperations implements IEvaluatorOperations {
  constructor(private client: Client) {}

  private get index() { return STORAGE_INDEXES.evaluators; }

  async getAll(options?: PaginationOptions): Promise<{ items: Evaluator[]; total: number }> {
    const size = options?.size ?? 10000;
    const from = options?.from ?? 0;

    let result;
    try {
      // Fetch all docs, then group by ID to return latest version of each
      result = await this.client.search({
        index: this.index,
        body: {
          size,
          from,
          sort: [{ createdAt: { order: 'desc' } }],
          query: { match_all: {} },
        },
      });
    } catch (error: any) {
      if (isIndexNotFound(error)) return { items: [], total: 0 };
      throw error;
    }

    const hits = result.body.hits?.hits || [];
    const allDocs = hitsToSources<Evaluator & { version?: number }>(hits);
    const total = typeof result.body.hits?.total === 'object'
      ? result.body.hits.total.value
      : result.body.hits?.total ?? 0;

    // Group by ID, keep latest version
    const byId = new Map<string, Evaluator>();
    for (const doc of allDocs) {
      const existing = byId.get(doc.id);
      const docVer = (doc as any).version ?? (doc as any).currentVersion ?? 0;
      const existVer = existing ? ((existing as any).version ?? (existing as any).currentVersion ?? 0) : -1;
      if (!existing || docVer > existVer) {
        byId.set(doc.id, doc);
      }
    }

    const items = Array.from(byId.values()).sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    return { items, total: items.length };
  }

  async getById(id: string): Promise<Evaluator | null> {
    // Search for latest version of this evaluator
    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size: 1,
          sort: [{ currentVersion: { order: 'desc' } }],
          query: { term: { id } },
        },
      });

      const hits = result.body.hits?.hits || [];
      return hits.length > 0 ? hits[0]._source as Evaluator : null;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async getVersions(id: string): Promise<Evaluator[]> {
    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size: 100,
          sort: [{ currentVersion: { order: 'desc' } }],
          query: { term: { id } },
        },
      });

      return hitsToSources<Evaluator>(result.body.hits?.hits || []);
    } catch (error: any) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  async getVersion(id: string, version: number): Promise<Evaluator | null> {
    const docId = `${id}-v${version}`;
    try {
      const result = await this.client.get({ index: this.index, id: docId });
      return result.body.found ? result.body._source as Evaluator : null;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async create(evaluator: Partial<Evaluator>): Promise<Evaluator> {
    assertNotMigrating(this.index);
    if (!evaluator.name) throw new Error('Evaluator name is required');
    if (!evaluator.systemPrompt) throw new Error('Evaluator system prompt is required');
    if (!evaluator.scoringConfig) throw new Error('Evaluator scoring config is required');

    const now = new Date().toISOString();
    const id = evaluator.id || generateId('eval');
    const version = 1;
    const docId = `${id}-v${version}`;

    const doc: Evaluator = {
      ...evaluator,
      id,
      currentVersion: version,
      createdAt: now,
      updatedAt: now,
      isSystem: evaluator.isSystem ?? false,
      versions: [
        {
          version,
          createdAt: now,
          systemPrompt: evaluator.systemPrompt,
          scoringConfig: evaluator.scoringConfig,
          inferenceConfig: evaluator.inferenceConfig || {},
        },
      ],
    } as Evaluator;

    await this.client.index({
      index: this.index,
      id: docId,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async update(id: string, updates: Partial<Evaluator>): Promise<Evaluator> {
    assertNotMigrating(this.index);
    const current = await this.getById(id);
    if (!current) throw new Error(`Evaluator ${id} not found`);

    // Prevent editing system evaluators
    if (current.isSystem) {
      throw new Error('Cannot edit system evaluators. Duplicate them to create a custom version.');
    }

    const currentVer = current.currentVersion ?? 1;
    const newVer = currentVer + 1;
    const now = new Date().toISOString();
    const docId = `${id}-v${newVer}`;

    const newVersion = {
      version: newVer,
      createdAt: now,
      systemPrompt: updates.systemPrompt ?? current.systemPrompt,
      scoringConfig: updates.scoringConfig ?? current.scoringConfig,
      inferenceConfig: updates.inferenceConfig ?? current.inferenceConfig,
    };

    const doc: Evaluator = {
      ...current,
      ...updates,
      id,
      currentVersion: newVer,
      updatedAt: now,
      systemPrompt: newVersion.systemPrompt,
      scoringConfig: newVersion.scoringConfig,
      inferenceConfig: newVersion.inferenceConfig,
      versions: [...(current.versions || []), newVersion],
    };

    await this.client.index({
      index: this.index,
      id: docId,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async delete(id: string): Promise<{ deleted: number }> {
    assertNotMigrating(this.index);
    const evaluator = await this.getById(id);
    if (!evaluator) return { deleted: 0 };

    // Prevent deleting system evaluators
    if (evaluator.isSystem) {
      throw new Error('Cannot delete system evaluators');
    }

    // Delete all versions
    try {
      const result = await this.client.deleteByQuery({
        index: this.index,
        body: {
          query: { term: { id } },
        },
        refresh: true,
      });

      return { deleted: (result.body as any).deleted || 0 };
    } catch (error: any) {
      if (isIndexNotFound(error)) return { deleted: 0 };
      throw error;
    }
  }
}

// ============================================================================
// Evaluation Run Operations (same index as benchmarks, filtered by docType)
// ============================================================================

class OpenSearchEvaluationRunOperations implements IEvaluationRunOperations {
  constructor(private client: Client) {}

  // Uses same index as benchmarks — discriminated by docType field
  private get index() { return STORAGE_INDEXES.benchmarks; }

  async create(run: EvaluationRun): Promise<EvaluationRun> {
    assertNotMigrating(this.index);
    const now = new Date().toISOString();
    const id = run.id || generateId('evalrun');

    const doc: EvaluationRun = {
      ...run,
      id,
      docType: 'evaluation-run',
      createdAt: run.createdAt || now,
      status: run.status || 'pending',
      results: run.results || {},
      sources: run.sources || [],
      testCaseSnapshots: run.testCaseSnapshots || [],
    };

    await this.client.index({
      index: this.index,
      id,
      body: doc,
      refresh: 'wait_for',
    });

    return doc;
  }

  async getById(id: string): Promise<EvaluationRun | null> {
    try {
      const result = await this.client.get({ index: this.index, id });
      if (!result.body.found) return null;
      const doc = result.body._source as any;
      // Only return if it's actually an evaluation-run doc
      if (doc.docType !== 'evaluation-run') return null;
      return doc as EvaluationRun;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async update(id: string, updates: Partial<EvaluationRun>): Promise<EvaluationRun> {
    assertNotMigrating(this.index);
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Evaluation run ${id} not found`);

    const updated = { ...existing, ...updates };
    await this.client.index({
      index: this.index,
      id,
      body: updated,
      refresh: 'wait_for',
    });

    return updated as EvaluationRun;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    assertNotMigrating(this.index);
    try {
      await this.client.delete({ index: this.index, id, refresh: 'wait_for' });
      return { deleted: true };
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return { deleted: false };
      throw error;
    }
  }

  async list(options?: PaginationOptions & {
    benchmarkId?: string;
    agentKey?: string;
    status?: string;
    testCaseId?: string;
    trigger?: string;
    imageDigest?: string;
    sort?: 'createdAt' | 'completedAt';
    order?: 'asc' | 'desc';
  }): Promise<{ items: EvaluationRun[]; total: number }> {
    const size = options?.size ?? 100;
    const from = options?.from ?? 0;
    const sortField = options?.sort || 'createdAt';
    const order = options?.order || 'desc';

    // Deployed legacy indices may map docType as text-only, while current
    // dynamic mappings add `.keyword`. Query both shapes; match_phrase keeps
    // the hyphenated discriminator exact on the analyzed legacy field.
    const must: any[] = [docTypeIs('evaluation-run')];

    if (options?.benchmarkId) must.push({ term: { 'benchmarkId.keyword': options.benchmarkId } });
    if (options?.agentKey) must.push({ term: { 'agentKey.keyword': options.agentKey } });
    if (options?.status) must.push({ term: { 'status.keyword': options.status } });
    if (options?.trigger) must.push({ term: { 'trigger.keyword': options.trigger } });
    if (options?.imageDigest) must.push({ term: { 'imageDigest.keyword': options.imageDigest } });
    // NOTE: `testCaseSnapshots` on EvaluationRun docs is a plain dynamically-
    // mapped `object` array (see indexMappings.ts — it's intentionally left
    // out of the explicit top-level mapping since it's a bounded 3-property
    // shape regardless of array length, not a growth vector), NOT `nested`.
    // A `nested` query against a non-nested field 400s with
    // "query_shard_exception: nested object under path [testCaseSnapshots] is
    // not of nested type" — verified against a real OpenSearch 2.17.0
    // instance. A plain `term` on the array's flattened `.keyword` multi-field
    // matches if ANY element has that id, which is exactly the filter this
    // needs; no `nested`/`inner_hits` semantics are required here.
    if (options?.testCaseId) {
      must.push({ term: { 'testCaseSnapshots.id.keyword': options.testCaseId } });
    }

    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size,
          from,
          sort: [{ [sortField]: { order } }],
          query: { bool: { must } },
        },
      });

      const items = hitsToSources<EvaluationRun>(result.body.hits?.hits || []);
      const total = typeof result.body.hits?.total === 'object'
        ? result.body.hits.total.value
        : result.body.hits?.total ?? 0;

      return { items, total };
    } catch (error: any) {
      if (isIndexNotFound(error)) return { items: [], total: 0 };
      throw error;
    }
  }

  async updateResult(runId: string, testCaseId: string, result: {
    reportId: string;
    status: RunResultStatus;
    error?: string;
  }): Promise<boolean> {
    assertNotMigrating(this.index);
    try {
      await this.client.update({
        index: this.index,
        id: runId,
        body: {
          script: {
            source: `ctx._source.results.put(params.testCaseId, params.result)`,
            lang: 'painless',
            params: { testCaseId, result },
          },
        },
        refresh: 'wait_for',
      });
      return true;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return false;
      throw error;
    }
  }
}

// ============================================================================
// OpenSearch Benchmark Image Operations (same index as benchmarks, docType
// 'benchmark-image', content-addressed by digest — doc id is `img-<digest>`)
// ============================================================================

class OpenSearchBenchmarkImageOperations implements IBenchmarkImageOperations {
  constructor(private client: Client) {}

  private get index() { return STORAGE_INDEXES.benchmarks; }

  private docId(digest: string): string { return `img-${digest}`; }

  async create(image: BenchmarkImage): Promise<BenchmarkImage> {
    assertNotMigrating(this.index);
    // Find-or-create: an existing digest IS the same image by definition —
    // never overwrite (preserves tags/createdAt).
    const existing = await this.getByDigest(image.digest);
    if (existing) return existing;
    const doc: BenchmarkImage = {
      ...image,
      id: this.docId(image.digest),
      docType: 'benchmark-image',
      tags: image.tags || [],
      createdAt: image.createdAt || new Date().toISOString(),
    };
    await this.client.index({
      index: this.index,
      id: doc.id,
      body: doc,
      refresh: 'wait_for',
    });
    return doc;
  }

  async getByDigest(digest: string): Promise<BenchmarkImage | null> {
    try {
      const result = await this.client.get({ index: this.index, id: this.docId(digest) });
      if (!result.body.found) return null;
      const doc = result.body._source as any;
      if (doc.docType !== 'benchmark-image') return null;
      return doc as BenchmarkImage;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return null;
      throw error;
    }
  }

  async getAll(options?: PaginationOptions): Promise<{ items: BenchmarkImage[]; total: number }> {
    const size = options?.size ?? 1000;
    const from = options?.from ?? 0;
    try {
      const result = await this.client.search({
        index: this.index,
        body: {
          size,
          from,
          sort: [{ createdAt: { order: 'desc' } }],
          // See evaluation-run list note: dynamic mapping → term on .keyword.
          query: { term: { 'docType.keyword': 'benchmark-image' } },
        },
      });
      const items = hitsToSources<BenchmarkImage>(result.body.hits?.hits || []);
      const total = typeof result.body.hits?.total === 'object'
        ? result.body.hits.total.value
        : result.body.hits?.total ?? 0;
      return { items, total };
    } catch (error: any) {
      if (isIndexNotFound(error)) return { items: [], total: 0 };
      throw error;
    }
  }

  async update(
    digest: string,
    updates: Partial<Pick<BenchmarkImage, 'tags' | 'lastRunAt'>>
  ): Promise<BenchmarkImage> {
    assertNotMigrating(this.index);
    const existing = await this.getByDigest(digest);
    if (!existing) throw new Error(`Benchmark image ${digest} not found`);
    // Only mutable metadata may change — the content fields ARE the identity.
    const updated: BenchmarkImage = {
      ...existing,
      ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
      ...(updates.lastRunAt !== undefined ? { lastRunAt: updates.lastRunAt } : {}),
    };
    await this.client.index({
      index: this.index,
      id: this.docId(digest),
      body: updated,
      refresh: 'wait_for',
    });
    return updated;
  }

  async delete(digest: string): Promise<{ deleted: boolean }> {
    assertNotMigrating(this.index);
    try {
      await this.client.delete({ index: this.index, id: this.docId(digest), refresh: 'wait_for' });
      return { deleted: true };
    } catch (error: any) {
      if (error.meta?.statusCode === 404) return { deleted: false };
      throw error;
    }
  }
}

// ============================================================================
// OpenSearch Storage Module
// ============================================================================

export class OpenSearchStorageModule implements IStorageModule {
  readonly testCases: ITestCaseOperations;
  readonly benchmarks: IBenchmarkOperations;
  readonly evaluationRuns: IEvaluationRunOperations;
  readonly images: IBenchmarkImageOperations;
  readonly runs: IRunOperations;
  readonly analytics: IAnalyticsOperations;
  readonly evaluators: IEvaluatorOperations;
  readonly sessionMetadata: ISessionMetadataOperations;

  constructor(private client: Client, sessionMetadata: ISessionMetadataOperations) {
    this.testCases = new OpenSearchTestCaseOperations(client);
    this.benchmarks = new OpenSearchBenchmarkOperations(client);
    this.evaluationRuns = new OpenSearchEvaluationRunOperations(client);
    this.images = new OpenSearchBenchmarkImageOperations(client);
    this.runs = new OpenSearchRunOperations(client);
    this.analytics = new OpenSearchAnalyticsOperations(client);
    this.evaluators = new OpenSearchEvaluatorOperations(client);
    this.sessionMetadata = sessionMetadata;
  }

  async health(): Promise<HealthStatus> {
    try {
      const result = await this.client.cluster.health({ timeout: '10s' });
      return {
        status: 'ok',
        cluster: {
          name: result.body.cluster_name,
          status: result.body.status,
        },
      };
    } catch (error: any) {
      // describeOpenSearchError() appends the HTTP status code so a 403 (stale/
      // rotated SigV4 credentials) reads differently in the UI/logs than a 5xx
      // (cluster-side failure) — this is the exact endpoint used to diagnose a
      // wedged storage client.
      return { status: 'error', error: describeOpenSearchError(error) || 'Unknown error' };
    }
  }

  isConfigured(): boolean {
    // This module is only created when OpenSearch is available
    return true;
  }
}
