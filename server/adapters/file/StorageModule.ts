/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-based Storage Module
 *
 * Implements IStorageModule using JSON files on disk.
 * Each entity is stored as a single JSON file in a subdirectory:
 *   .agent-health/data/test-cases/{id}-v{version}.json
 *   .agent-health/data/benchmarks/{id}.json
 *   .agent-health/data/runs/{id}.json
 *   .agent-health/data/analytics/{id}.json
 *
 * Same document shape as OpenSearch — portable between backends.
 */

import * as fs from 'fs';
import * as path from 'path';
import { projectDataDir } from '../../../lib/config/statePaths.js';
import { assertValidTestCaseFixture } from '../../../lib/testCaseFixture.js';
import type {
  TestCase,
  Benchmark,
  BenchmarkRun,
  BenchmarkImage,
  EvaluationRun,
  TestCaseRun,
  RunAnnotation,
  SessionMetadata,
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

// ============================================================================
// File Helpers
// ============================================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Sanitize an ID to prevent path traversal (strips directory components) */
function sanitizeId(id: string): string {
  return path.basename(id);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function listJsonFiles(dir: string): string[] {
  ensureDir(dir);
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function readAllFromDir<T>(dir: string): T[] {
  return listJsonFiles(dir)
    .map(f => readJsonFile<T>(path.join(dir, f)))
    .filter((item): item is T => item !== null);
}

function paginate<T>(items: T[], options?: PaginationOptions): { items: T[]; total: number } {
  const total = items.length;
  const from = options?.from ?? 0;
  const size = options?.size ?? total;
  return { items: items.slice(from, from + size), total };
}

// ============================================================================
// Test Case Operations
// ============================================================================

class FileTestCaseOperations implements ITestCaseOperations {
  constructor(private baseDir: string) {}

  private get dir() { return path.join(this.baseDir, 'test-cases'); }

  private docPath(id: string, version: number): string {
    return path.join(this.dir, `${sanitizeId(id)}-v${version}.json`);
  }

  /**
   * Get the storage-level version number from a document.
   * Routes store a flat `version` field alongside `currentVersion`.
   */
  private ver(tc: any): number {
    return tc.version ?? tc.currentVersion ?? 0;
  }

  async getAll(options?: PaginationOptions): Promise<{ items: TestCase[]; total: number }> {
    const all = readAllFromDir<TestCase>(this.dir);
    // Group by ID, return latest version of each
    const byId = new Map<string, TestCase>();
    for (const tc of all) {
      const existing = byId.get(tc.id);
      if (!existing || this.ver(tc) > this.ver(existing)) {
        byId.set(tc.id, tc);
      }
    }
    const latest = Array.from(byId.values()).sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
    return paginate(latest, options);
  }

  async getById(id: string): Promise<TestCase | null> {
    const all = readAllFromDir<TestCase>(this.dir).filter(tc => tc.id === id);
    if (all.length === 0) return null;
    all.sort((a, b) => this.ver(b) - this.ver(a));
    return all[0];
  }

  async getVersions(id: string): Promise<TestCase[]> {
    return readAllFromDir<TestCase>(this.dir)
      .filter(tc => tc.id === id)
      .sort((a, b) => this.ver(b) - this.ver(a));
  }

  async getVersion(id: string, version: number): Promise<TestCase | null> {
    return readJsonFile<TestCase>(this.docPath(id, version));
  }

  async create(testCase: Partial<TestCase>): Promise<TestCase> {
    assertValidTestCaseFixture(testCase);
    if (!testCase.name) throw new Error('Test case name is required');
    const now = new Date().toISOString();
    const id = testCase.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const doc = {
      ...testCase,
      id,
      version: 1,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    } as TestCase;

    writeJsonFile(this.docPath(id, 1), doc);
    return doc;
  }

  async update(id: string, updates: Partial<TestCase>): Promise<TestCase> {
    assertValidTestCaseFixture(updates);
    const current = await this.getById(id);
    if (!current) throw new Error(`Test case ${id} not found`);
    const currentVer = this.ver(current);
    const newVer = currentVer + 1;
    const now = new Date().toISOString();

    const doc = {
      ...current,
      ...updates,
      id,
      version: newVer,
      currentVersion: newVer,
      createdAt: now,
      updatedAt: now,
    } as TestCase;

    writeJsonFile(this.docPath(id, newVer), doc);
    return doc;
  }

  async delete(id: string): Promise<{ deleted: number }> {
    const versions = await this.getVersions(id);
    let deleted = 0;
    for (const tc of versions) {
      const v = this.ver(tc) || 1;
      const fp = this.docPath(id, v);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        deleted++;
      }
    }
    return { deleted };
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

    return paginate(filtered, options);
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
    const { items: all } = await this.getAll();
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const results: TestCase[] = [];

    for (const tc of testCases) {
      assertValidTestCaseFixture(tc);
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

class FileBenchmarkOperations implements IBenchmarkOperations {
  constructor(private baseDir: string) {}

  private get dir() { return path.join(this.baseDir, 'benchmarks'); }

  private docPath(id: string): string {
    return path.join(this.dir, `${sanitizeId(id)}.json`);
  }

  async getAll(options?: PaginationOptions): Promise<{ items: Benchmark[]; total: number }> {
    // Benchmarks share this dir with evaluation-runs and benchmark-images
    // (docType discriminator); exclude both so they don't surface as empty
    // benchmark rows. Mirrors getById.
    const all = readAllFromDir<Benchmark & { docType?: string }>(this.dir)
      .filter(doc => doc.docType !== 'evaluation-run' && doc.docType !== 'benchmark-image')
      .sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
    return paginate(all, options);
  }

  async getById(id: string): Promise<Benchmark | null> {
    const doc = readJsonFile<Benchmark & { docType?: string }>(this.docPath(id));
    // Shared dir — an eval-run / image id is NOT a benchmark.
    if (!doc) return null;
    return doc.docType === undefined || doc.docType === 'benchmark' ? doc : null;
  }

  async create(benchmark: Partial<Benchmark>): Promise<Benchmark> {
    const now = new Date().toISOString();
    const id = benchmark.id || `bench-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const doc: Benchmark = {
      ...benchmark,
      id,
      runs: benchmark.runs || [],
      createdAt: now,
      updatedAt: now,
    } as Benchmark;

    writeJsonFile(this.docPath(id), doc);
    return doc;
  }

  async update(id: string, updates: Partial<Benchmark>): Promise<Benchmark> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Benchmark ${id} not found`);

    const doc: Benchmark = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    };

    writeJsonFile(this.docPath(id), doc);
    return doc;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const fp = this.docPath(id);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      return { deleted: true };
    }
    return { deleted: false };
  }

  async addRun(benchmarkId: string, run: BenchmarkRun): Promise<boolean> {
    const benchmark = await this.getById(benchmarkId);
    if (!benchmark) return false;

    benchmark.runs = benchmark.runs || [];
    if (benchmark.runs.some(existing => existing.id === run.id)) return true;
    benchmark.runs.push(run);
    benchmark.updatedAt = new Date().toISOString();

    writeJsonFile(this.docPath(benchmarkId), benchmark);
    return true;
  }

  async updateRun(benchmarkId: string, runId: string, updates: Partial<BenchmarkRun>): Promise<boolean> {
    const benchmark = await this.getById(benchmarkId);
    if (!benchmark) return false;

    const runIndex = benchmark.runs?.findIndex(r => r.id === runId);
    if (runIndex === undefined || runIndex === -1) return false;

    benchmark.runs![runIndex] = { ...benchmark.runs![runIndex], ...updates };
    benchmark.updatedAt = new Date().toISOString();

    writeJsonFile(this.docPath(benchmarkId), benchmark);
    return true;
  }

  async deleteRun(benchmarkId: string, runId: string): Promise<boolean> {
    const benchmark = await this.getById(benchmarkId);
    if (!benchmark) return false;

    const originalLength = benchmark.runs?.length || 0;
    benchmark.runs = (benchmark.runs || []).filter(r => r.id !== runId);

    if (benchmark.runs.length === originalLength) return false;

    benchmark.updatedAt = new Date().toISOString();
    writeJsonFile(this.docPath(benchmarkId), benchmark);
    return true;
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

class FileRunOperations implements IRunOperations {
  constructor(private baseDir: string) {}

  private get dir() { return path.join(this.baseDir, 'runs'); }

  private docPath(id: string): string {
    return path.join(this.dir, `${sanitizeId(id)}.json`);
  }

  async getAll(options?: PaginationOptions): Promise<{ items: TestCaseRun[]; total: number }> {
    const all = readAllFromDir<TestCaseRun>(this.dir).sort(
      (a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()
    );
    return paginate(all, options);
  }

  async getById(id: string): Promise<TestCaseRun | null> {
    return readJsonFile<TestCaseRun>(this.docPath(id));
  }

  async create(run: Partial<TestCaseRun>): Promise<TestCaseRun> {
    const now = new Date().toISOString();
    const id = run.id || `report-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const doc: TestCaseRun = {
      ...run,
      id,
      timestamp: run.timestamp || now,
    } as TestCaseRun;

    writeJsonFile(this.docPath(id), doc);
    return doc;
  }

  async update(id: string, updates: Partial<TestCaseRun>): Promise<TestCaseRun> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Run ${id} not found`);

    const doc: TestCaseRun = { ...existing, ...updates, id };
    writeJsonFile(this.docPath(id), doc);
    return doc;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const fp = this.docPath(id);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      return { deleted: true };
    }
    return { deleted: false };
  }

  async search(filters: RunSearchFilters, options?: PaginationOptions): Promise<{ items: TestCaseRun[]; total: number }> {
    const { items: all } = await this.getAll();
    let filtered = all;

    if (filters.experimentId) {
      filtered = filtered.filter(r => r.experimentId === filters.experimentId);
    }
    if (filters.experimentRunId) {
      filtered = filtered.filter(r => r.experimentRunId === filters.experimentRunId);
    }
    if (filters.testCaseId) {
      filtered = filtered.filter(r => r.testCaseId === filters.testCaseId);
    }
    if (filters.agentId) {
      filtered = filtered.filter(r => r.agentKey === filters.agentId);
    }
    if (filters.modelId) {
      filtered = filtered.filter(r => r.modelId === filters.modelId);
    }
    if (filters.status) {
      filtered = filtered.filter(r => r.status === filters.status);
    }
    if (filters.passFailStatus) {
      filtered = filtered.filter(r => r.passFailStatus === filters.passFailStatus);
    }
    if (filters.dateRange) {
      const start = new Date(filters.dateRange.start).getTime();
      const end = new Date(filters.dateRange.end).getTime();
      filtered = filtered.filter(r => {
        const t = new Date(r.timestamp || 0).getTime();
        return t >= start && t <= end;
      });
    }

    return paginate(filtered, options);
  }

  async getByTestCase(testCaseId: string, size?: number, from?: number): Promise<{ items: TestCaseRun[]; total: number }> {
    return this.search({ testCaseId }, { size, from });
  }

  async getByExperiment(experimentId: string, size?: number): Promise<TestCaseRun[]> {
    const { items } = await this.search({ experimentId }, { size });
    return items;
  }

  async getByExperimentRun(experimentId: string, runId: string, size?: number): Promise<TestCaseRun[]> {
    const { items } = await this.search({ experimentId, experimentRunId: runId }, { size });
    return items;
  }

  async getIterations(experimentId: string, testCaseId: string, experimentRunId?: string): Promise<{
    items: TestCaseRun[];
    total: number;
    maxIteration: number;
  }> {
    const filters: RunSearchFilters = { experimentId, testCaseId };
    if (experimentRunId) filters.experimentRunId = experimentRunId;
    const { items } = await this.search(filters);

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

    if (!run.annotations) run.annotations = [];
    run.annotations.push(fullAnnotation);

    writeJsonFile(this.docPath(runId), run);
    return fullAnnotation;
  }

  async updateAnnotation(runId: string, annotationId: string, updates: Partial<RunAnnotation>): Promise<RunAnnotation> {
    const run = await this.getById(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const idx = run.annotations?.findIndex(a => a.id === annotationId);
    if (idx === undefined || idx === -1) throw new Error(`Annotation ${annotationId} not found`);

    run.annotations![idx] = {
      ...run.annotations![idx],
      ...updates,
      timestamp: new Date().toISOString(),
    };

    writeJsonFile(this.docPath(runId), run);
    return run.annotations![idx];
  }

  async deleteAnnotation(runId: string, annotationId: string): Promise<{ deleted: boolean }> {
    const run = await this.getById(runId);
    if (!run) return { deleted: false };

    const originalLength = run.annotations?.length || 0;
    run.annotations = (run.annotations || []).filter(a => a.id !== annotationId);

    if (run.annotations.length === originalLength) return { deleted: false };

    writeJsonFile(this.docPath(runId), run);
    return { deleted: true };
  }

  async countsByTestCase(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const run of readAllFromDir<TestCaseRun>(this.dir)) {
      if (run.testCaseId) {
        counts[run.testCaseId] = (counts[run.testCaseId] || 0) + 1;
      }
    }
    return counts;
  }
}

// ============================================================================
// Analytics Operations
// ============================================================================

class FileAnalyticsOperations implements IAnalyticsOperations {
  constructor(private baseDir: string) {}

  private get dir() { return path.join(this.baseDir, 'analytics'); }

  async query(_filters: Record<string, unknown>, options?: PaginationOptions): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const all = readAllFromDir<Record<string, unknown>>(this.dir);
    return paginate(all, options);
  }

  async aggregations(_experimentId?: string, _groupBy?: string): Promise<{ aggregations: Record<string, unknown>[]; groupBy: string }> {
    // File backend doesn't support aggregations — return empty
    return { aggregations: [], groupBy: _groupBy || 'none' };
  }

  async writeRecord(record: Record<string, unknown>): Promise<void> {
    const id = (record.id as string) || `analytics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeJsonFile(path.join(this.dir, `${id}.json`), { ...record, id });
  }

  async backfill(): Promise<{ backfilled: number; errors: number; total: number }> {
    // No-op for file backend
    return { backfilled: 0, errors: 0, total: 0 };
  }
}

// ============================================================================
// Evaluator Operations
// ============================================================================

class FileEvaluatorOperations implements IEvaluatorOperations {
  constructor(private baseDir: string) {}

  private get dir() { return path.join(this.baseDir, 'evaluators'); }

  private docPath(id: string, version: number): string {
    return path.join(this.dir, `${sanitizeId(id)}-v${version}.json`);
  }

  async getAll(options?: PaginationOptions): Promise<{ items: Evaluator[]; total: number }> {
    const allDocs = readAllFromDir<Evaluator>(this.dir);
    // Group by ID, keep latest version
    const byId = new Map<string, Evaluator>();
    for (const doc of allDocs) {
      const existing = byId.get(doc.id);
      const docVer = doc.currentVersion ?? 1;
      const existVer = existing?.currentVersion ?? 0;
      if (!existing || docVer > existVer) {
        byId.set(doc.id, doc);
      }
    }

    const items = Array.from(byId.values()).sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    return paginate(items, options);
  }

  async getById(id: string): Promise<Evaluator | null> {
    const allDocs = readAllFromDir<Evaluator>(this.dir);
    const versions = allDocs.filter(doc => doc.id === id);
    if (versions.length === 0) return null;
    return versions.reduce((latest, current) =>
      (current.currentVersion ?? 1) > (latest.currentVersion ?? 1) ? current : latest
    );
  }

  async getVersions(id: string): Promise<Evaluator[]> {
    const allDocs = readAllFromDir<Evaluator>(this.dir);
    return allDocs
      .filter(doc => doc.id === id)
      .sort((a, b) => (b.currentVersion ?? 1) - (a.currentVersion ?? 1));
  }

  async getVersion(id: string, version: number): Promise<Evaluator | null> {
    return readJsonFile<Evaluator>(this.docPath(id, version));
  }

  async create(evaluator: Partial<Evaluator>): Promise<Evaluator> {
    if (!evaluator.name) throw new Error('Evaluator name is required');
    if (!evaluator.systemPrompt) throw new Error('Evaluator system prompt is required');
    if (!evaluator.scoringConfig) throw new Error('Evaluator scoring config is required');

    const now = new Date().toISOString();
    const id = evaluator.id || `eval-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const version = 1;

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

    writeJsonFile(this.docPath(id, version), doc);
    return doc;
  }

  async update(id: string, updates: Partial<Evaluator>): Promise<Evaluator> {
    const current = await this.getById(id);
    if (!current) throw new Error(`Evaluator ${id} not found`);

    // Prevent editing system evaluators
    if (current.isSystem) {
      throw new Error('Cannot edit system evaluators. Duplicate them to create a custom version.');
    }

    const currentVer = current.currentVersion ?? 1;
    const newVer = currentVer + 1;
    const now = new Date().toISOString();

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

    writeJsonFile(this.docPath(id, newVer), doc);
    return doc;
  }

  async delete(id: string): Promise<{ deleted: number }> {
    const evaluator = await this.getById(id);
    if (!evaluator) return { deleted: 0 };

    // Prevent deleting system evaluators
    if (evaluator.isSystem) {
      throw new Error('Cannot delete system evaluators');
    }

    // Delete all version files
    const versions = await this.getVersions(id);
    let deleted = 0;
    for (const version of versions) {
      const ver = version.currentVersion ?? 1;
      const filePath = this.docPath(id, ver);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    return { deleted };
  }
}

// ============================================================================
// Session Metadata Operations
// ============================================================================

export class FileSessionMetadataOperations implements ISessionMetadataOperations {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || projectDataDir();
  }

  private get dir() { return path.join(this.baseDir, 'session-metadata'); }

  private docPath(agentKind: string, sessionId: string): string {
    // Sanitize to prevent path traversal
    const safeAgent = agentKind.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    return path.join(this.dir, `${safeAgent}--${safeSession}.json`);
  }

  async get(agentKind: string, sessionId: string): Promise<SessionMetadata | null> {
    return readJsonFile<SessionMetadata>(this.docPath(agentKind, sessionId));
  }

  async put(agentKind: string, sessionId: string, data: Record<string, unknown>): Promise<SessionMetadata> {
    const existing = readJsonFile<SessionMetadata>(this.docPath(agentKind, sessionId));
    const doc: SessionMetadata = {
      ...(existing ?? {}),
      ...data,
      agentKind,
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    if (!existing) {
      (doc as any).createdAt = doc.updatedAt;
    }
    writeJsonFile(this.docPath(agentKind, sessionId), doc);
    return doc;
  }

  async list(options?: PaginationOptions): Promise<{ items: SessionMetadata[]; total: number }> {
    const all = readAllFromDir<SessionMetadata>(this.dir);
    return paginate(all, options);
  }
}

// ============================================================================
// File Evaluation Run Operations (stored in benchmarks dir with docType discriminator)
// ============================================================================

class FileEvaluationRunOperations implements IEvaluationRunOperations {
  private readonly dir: string;

  constructor(baseDir: string) {
    // Stored in same directory as benchmarks (same "index" concept)
    this.dir = path.join(baseDir, 'benchmarks');
    ensureDir(this.dir);
  }

  async create(run: EvaluationRun): Promise<EvaluationRun> {
    const id = run.id || `evalrun-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const doc: EvaluationRun = {
      ...run,
      id,
      docType: 'evaluation-run',
      createdAt: run.createdAt || new Date().toISOString(),
      status: run.status || 'pending',
      results: run.results || {},
      sources: run.sources || [],
      testCaseSnapshots: run.testCaseSnapshots || [],
    };
    writeJsonFile(path.join(this.dir, `${id}.json`), doc);
    return doc;
  }

  async getById(id: string): Promise<EvaluationRun | null> {
    const doc = readJsonFile<any>(path.join(this.dir, `${id}.json`));
    if (!doc || doc.docType !== 'evaluation-run') return null;
    return doc as EvaluationRun;
  }

  async update(id: string, updates: Partial<EvaluationRun>): Promise<EvaluationRun> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Evaluation run ${id} not found`);
    const updated = { ...existing, ...updates } as EvaluationRun;
    writeJsonFile(path.join(this.dir, `${id}.json`), updated);
    return updated;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const filePath = path.join(this.dir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { deleted: true };
    }
    return { deleted: false };
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
    const all = readAllFromDir<any>(this.dir)
      .filter((doc: any) => doc.docType === 'evaluation-run') as EvaluationRun[];

    let filtered = all;
    if (options?.benchmarkId) filtered = filtered.filter(r => r.benchmarkId === options.benchmarkId);
    if (options?.agentKey) filtered = filtered.filter(r => r.agentKey === options.agentKey);
    if (options?.status) filtered = filtered.filter(r => r.status === options.status);
    if (options?.trigger) filtered = filtered.filter(r => r.trigger === options.trigger);
    if (options?.imageDigest) filtered = filtered.filter(r => r.imageDigest === options.imageDigest);
    if (options?.testCaseId) {
      filtered = filtered.filter(r =>
        r.testCaseSnapshots?.some(s => s.id === options.testCaseId)
      );
    }

    const sortField = options?.sort || 'createdAt';
    const order = options?.order || 'desc';
    filtered.sort((a, b) => {
      const aVal = new Date(a[sortField] || a.createdAt).getTime();
      const bVal = new Date(b[sortField] || b.createdAt).getTime();
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });

    return paginate(filtered, options);
  }

  async updateResult(runId: string, testCaseId: string, result: {
    reportId: string;
    status: RunResultStatus;
    error?: string;
  }): Promise<boolean> {
    const existing = await this.getById(runId);
    if (!existing) return false;
    existing.results[testCaseId] = result;
    writeJsonFile(path.join(this.dir, `${runId}.json`), existing);
    return true;
  }
}

// ============================================================================
// File Benchmark Image Operations (stored in benchmarks dir, docType
// 'benchmark-image', content-addressed by digest — id is `img-<digest>`)
// ============================================================================

class FileBenchmarkImageOperations implements IBenchmarkImageOperations {
  private readonly dir: string;

  constructor(baseDir: string) {
    // Same directory as benchmarks (same "index" concept, docType discriminated)
    this.dir = path.join(baseDir, 'benchmarks');
    ensureDir(this.dir);
  }

  private docPath(digest: string): string {
    return path.join(this.dir, `img-${sanitizeId(digest)}.json`);
  }

  async create(image: BenchmarkImage): Promise<BenchmarkImage> {
    // Find-or-create: content-addressed identity means an existing digest is
    // the same image by definition — never overwrite (preserves tags/createdAt).
    const existing = await this.getByDigest(image.digest);
    if (existing) return existing;
    const doc: BenchmarkImage = {
      ...image,
      id: `img-${image.digest}`,
      docType: 'benchmark-image',
      tags: image.tags || [],
      createdAt: image.createdAt || new Date().toISOString(),
    };
    writeJsonFile(this.docPath(image.digest), doc);
    return doc;
  }

  async getByDigest(digest: string): Promise<BenchmarkImage | null> {
    const doc = readJsonFile<any>(this.docPath(digest));
    if (!doc || doc.docType !== 'benchmark-image') return null;
    return doc as BenchmarkImage;
  }

  async getAll(options?: PaginationOptions): Promise<{ items: BenchmarkImage[]; total: number }> {
    const all = (readAllFromDir<any>(this.dir)
      .filter((doc: any) => doc.docType === 'benchmark-image') as BenchmarkImage[])
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return paginate(all, options);
  }

  async update(
    digest: string,
    updates: Partial<Pick<BenchmarkImage, 'tags' | 'lastRunAt'>>
  ): Promise<BenchmarkImage> {
    const existing = await this.getByDigest(digest);
    if (!existing) throw new Error(`Benchmark image ${digest} not found`);
    // Only mutable metadata may change — the content fields ARE the identity.
    const updated: BenchmarkImage = {
      ...existing,
      ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
      ...(updates.lastRunAt !== undefined ? { lastRunAt: updates.lastRunAt } : {}),
    };
    writeJsonFile(this.docPath(digest), updated);
    return updated;
  }

  async delete(digest: string): Promise<{ deleted: boolean }> {
    const filePath = this.docPath(digest);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { deleted: true };
    }
    return { deleted: false };
  }
}

// ============================================================================
// File Storage Module
// ============================================================================

export class FileStorageModule implements IStorageModule {
  readonly testCases: ITestCaseOperations;
  readonly benchmarks: IBenchmarkOperations;
  readonly evaluationRuns: IEvaluationRunOperations;
  readonly images: IBenchmarkImageOperations;
  readonly runs: IRunOperations;
  readonly analytics: IAnalyticsOperations;
  readonly evaluators: IEvaluatorOperations;
  readonly sessionMetadata: ISessionMetadataOperations;

  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || projectDataDir();
    ensureDir(this.baseDir);

    this.testCases = new FileTestCaseOperations(this.baseDir);
    this.benchmarks = new FileBenchmarkOperations(this.baseDir);
    this.evaluationRuns = new FileEvaluationRunOperations(this.baseDir);
    this.images = new FileBenchmarkImageOperations(this.baseDir);
    this.runs = new FileRunOperations(this.baseDir);
    this.analytics = new FileAnalyticsOperations(this.baseDir);
    this.evaluators = new FileEvaluatorOperations(this.baseDir);
    this.sessionMetadata = new FileSessionMetadataOperations(this.baseDir);
  }

  async health(): Promise<HealthStatus> {
    try {
      // Verify we can read/write the data directory
      const testFile = path.join(this.baseDir, '.health-check');
      fs.writeFileSync(testFile, 'ok', 'utf-8');
      fs.unlinkSync(testFile);
      return { status: 'ok' };
    } catch (error: any) {
      return { status: 'error', error: error.message };
    }
  }

  isConfigured(): boolean {
    // File storage is always available
    return true;
  }
}
