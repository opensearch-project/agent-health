/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extended unit tests for FileStorageModule — covers CRUD/search/versioning
 * surfaces not exercised by the base StorageModule.test.ts: test-case search
 * & bulk operations, benchmark run mutation (addRun/updateRun/deleteRun),
 * run search/annotations/iterations, analytics, evaluator versioning, and
 * evaluation-run list/updateResult. All against a real temp directory (no
 * mocking) — mirrors the existing FileStorageModule test file's convention.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';

describe('FileStorageModule (extended)', () => {
  let tmpDir: string;
  let mod: FileStorageModule;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-ext-test-'));
    mod = new FileStorageModule(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('testCases', () => {
    it('getVersions/getVersion return all versions and a specific version', async () => {
      const tc = await mod.testCases.create({ name: 'V1', initialPrompt: 'p' });
      await mod.testCases.update(tc.id, { name: 'V2' });

      const versions = await mod.testCases.getVersions(tc.id);
      expect(versions).toHaveLength(2);
      expect(versions.map(v => v.version).sort()).toEqual([1, 2]);

      const v1 = await mod.testCases.getVersion(tc.id, 1);
      expect(v1?.name).toBe('V1');
      const missing = await mod.testCases.getVersion(tc.id, 99);
      expect(missing).toBeNull();
    });

    it('update throws when the test case does not exist', async () => {
      await expect(mod.testCases.update('nope', { name: 'x' })).rejects.toThrow('Test case nope not found');
    });

    it('delete removes every version and reports the count', async () => {
      const tc = await mod.testCases.create({ name: 'ToDelete', initialPrompt: 'p' });
      await mod.testCases.update(tc.id, { name: 'ToDelete v2' });

      const result = await mod.testCases.delete(tc.id);
      expect(result.deleted).toBe(2);
      expect(await mod.testCases.getById(tc.id)).toBeNull();
    });

    it('delete on a nonexistent id deletes nothing', async () => {
      const result = await mod.testCases.delete('nonexistent-tc');
      expect(result.deleted).toBe(0);
    });

    it('search filters by category, difficulty, labels, isPromoted and textSearch', async () => {
      await mod.testCases.create({ name: 'Alpha search', initialPrompt: 'p', category: 'k8s', difficulty: 'hard', labels: ['prod'], isPromoted: true } as any);
      await mod.testCases.create({ name: 'Beta', initialPrompt: 'p', category: 'db', difficulty: 'easy', labels: ['dev'], isPromoted: false } as any);

      expect((await mod.testCases.search({ category: 'k8s' })).items).toHaveLength(1);
      expect((await mod.testCases.search({ difficulty: 'easy' })).items).toHaveLength(1);
      expect((await mod.testCases.search({ labels: ['prod'] })).items).toHaveLength(1);
      expect((await mod.testCases.search({ isPromoted: true })).items).toHaveLength(1);
      expect((await mod.testCases.search({ textSearch: 'alpha' })).items).toHaveLength(1);
      expect((await mod.testCases.search({ textSearch: 'nonexistentxyz' })).items).toHaveLength(0);
    });

    it('bulkCreate creates valid entries and counts errors for invalid ones', async () => {
      const result = await mod.testCases.bulkCreate([
        { name: 'Good 1', initialPrompt: 'p' },
        { initialPrompt: 'no name' } as any, // missing name -> throws inside create()
        { name: 'Good 2', initialPrompt: 'p' },
      ]);
      expect(result.created).toBe(2);
      expect(result.errors).toBe(1);
      expect(result.testCases).toHaveLength(2);
    });

    it('bulkUpsert leaves an entry unchanged when its sourceHash matches (single-item batch)', async () => {
      const existing = await mod.testCases.create({ name: 'Existing', initialPrompt: 'p', sourceFile: 'a.ts', sourceHash: 'hash-1' } as any);

      const result = await mod.testCases.bulkUpsert([
        { name: 'Existing', sourceFile: 'a.ts', sourceHash: 'hash-1', initialPrompt: 'p' } as any,
      ]);

      expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
      expect(result.testCases).toEqual([existing]);
    });

    it('bulkUpsert updates an entry whose sourceHash changed (single-item batch)', async () => {
      const existing = await mod.testCases.create({ name: 'Existing', initialPrompt: 'p', sourceFile: 'a.ts', sourceHash: 'hash-1' } as any);

      const result = await mod.testCases.bulkUpsert([
        { name: 'Existing', sourceFile: 'a.ts', sourceHash: 'hash-2', initialPrompt: 'p changed' } as any,
      ]);

      expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
      expect(result.testCases[0].id).toBe(existing.id);
      expect(result.testCases[0].sourceHash).toBe('hash-2');
      expect(result.testCases[0].initialPrompt).toBe('p changed');
      expect(result.testCases[0].version).toBe(2);
    });

    // NOTE (found while writing this test, reported not fixed per test-only
    // scope): bulkUpsert() reads `all` ONCE before its loop and matches every
    // item in the batch against that single pre-batch snapshot (see
    // server/adapters/file/StorageModule.ts's bulkUpsert). So when two items
    // in the SAME batch share a name+sourceFile key, the second item does
    // NOT see the first item's update -- both resolve against the original
    // pre-batch entity, and the second item's update wins (last-write-wins)
    // rather than the two being sequenced/merged. Deterministic, not a crash
    // risk, but a caller feeding two revisions of the "same" test case in one
    // bulkUpsert call would not get the intermediate state reflected in the
    // created/updated/unchanged counts the way the method name might suggest.
    it('bulkUpsert matches every item in a batch against the SAME pre-batch snapshot (documents last-write-wins on duplicate keys within one call)', async () => {
      const existing = await mod.testCases.create({ name: 'Existing', initialPrompt: 'p', sourceFile: 'a.ts', sourceHash: 'hash-1' } as any);

      const result = await mod.testCases.bulkUpsert([
        { name: 'Existing', sourceFile: 'a.ts', sourceHash: 'hash-1', initialPrompt: 'p' } as any, // matches existing (unchanged)
        { name: 'Existing', sourceFile: 'a.ts', sourceHash: 'hash-2', initialPrompt: 'p changed' } as any, // also matches the ORIGINAL existing (pre-batch snapshot), not item 1's result
      ]);

      expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
      expect(result.testCases[0]).toEqual(existing); // item 1: unchanged, returns the original doc
      expect(result.testCases[1].id).toBe(existing.id); // item 2: updates the SAME original entity (stale-snapshot match)
      expect(result.testCases[1].sourceHash).toBe('hash-2');
      expect(result.testCases[1].version).toBe(2);

      const finalState = await mod.testCases.getById(existing.id);
      expect(finalState?.sourceHash).toBe('hash-2'); // item 2's update is what persists
    });

    it('bulkUpsert creates a brand-new test case when no match exists', async () => {
      const result = await mod.testCases.bulkUpsert([
        { name: 'Totally New', initialPrompt: 'p' } as any,
      ]);
      expect(result.created).toBe(1);
      expect(result.testCases[0].name).toBe('Totally New');
    });
  });

  describe('benchmarks — run mutation', () => {
    it('addRun appends a run and is idempotent for a duplicate run id', async () => {
      const bench = await mod.benchmarks.create({ name: 'B', testCaseIds: [] });
      const run = { id: 'run-1', name: 'Run 1', status: 'completed' } as any;

      expect(await mod.benchmarks.addRun(bench.id, run)).toBe(true);
      expect(await mod.benchmarks.addRun(bench.id, run)).toBe(true); // idempotent, no dup

      const updated = await mod.benchmarks.getById(bench.id);
      expect(updated!.runs).toHaveLength(1);
    });

    it('addRun returns false for a nonexistent benchmark', async () => {
      expect(await mod.benchmarks.addRun('missing-bench', { id: 'r1' } as any)).toBe(false);
    });

    it('updateRun merges updates into the matching run', async () => {
      const bench = await mod.benchmarks.create({ name: 'B', testCaseIds: [], runs: [{ id: 'run-1', status: 'running' } as any] });
      const ok = await mod.benchmarks.updateRun(bench.id, 'run-1', { status: 'completed' } as any);
      expect(ok).toBe(true);

      const updated = await mod.benchmarks.getById(bench.id);
      expect(updated!.runs![0].status).toBe('completed');
    });

    it('updateRun returns false when the benchmark or the run is missing', async () => {
      expect(await mod.benchmarks.updateRun('missing-bench', 'run-1', {})).toBe(false);
      const bench = await mod.benchmarks.create({ name: 'B', testCaseIds: [] });
      expect(await mod.benchmarks.updateRun(bench.id, 'missing-run', {})).toBe(false);
    });

    it('deleteRun removes a run and returns false when nothing changed', async () => {
      const bench = await mod.benchmarks.create({ name: 'B', testCaseIds: [], runs: [{ id: 'run-1' } as any] });
      expect(await mod.benchmarks.deleteRun(bench.id, 'run-1')).toBe(true);
      expect(await mod.benchmarks.deleteRun(bench.id, 'run-1')).toBe(false); // already gone
      expect(await mod.benchmarks.deleteRun('missing-bench', 'run-1')).toBe(false);
    });

    it('bulkCreate creates all valid benchmarks', async () => {
      const result = await mod.benchmarks.bulkCreate([{ name: 'B1', testCaseIds: [] }, { name: 'B2', testCaseIds: [] }]);
      expect(result.created).toBe(2);
      expect(result.errors).toBe(0);
    });

    it('update throws when the benchmark does not exist', async () => {
      await expect(mod.benchmarks.update('missing', { name: 'x' })).rejects.toThrow('Benchmark missing not found');
    });

    it('delete removes an existing benchmark and no-ops on a missing one', async () => {
      const bench = await mod.benchmarks.create({ name: 'B', testCaseIds: [] });
      expect(await mod.benchmarks.delete(bench.id)).toEqual({ deleted: true });
      expect(await mod.benchmarks.delete(bench.id)).toEqual({ deleted: false });
    });
  });

  describe('runs', () => {
    it('create/getById/update/delete round trip', async () => {
      const run = await mod.runs.create({ testCaseId: 'tc-1', status: 'running' } as any);
      expect(await mod.runs.getById(run.id)).toEqual(run);

      const updated = await mod.runs.update(run.id, { status: 'completed' } as any);
      expect(updated.status).toBe('completed');

      expect(await mod.runs.delete(run.id)).toEqual({ deleted: true });
      expect(await mod.runs.getById(run.id)).toBeNull();
      expect(await mod.runs.delete(run.id)).toEqual({ deleted: false });
    });

    it('update throws for a nonexistent run', async () => {
      await expect(mod.runs.update('nope', {} as any)).rejects.toThrow('Run nope not found');
    });

    it('search applies experimentId/experimentRunId/agentId/modelId/status/passFailStatus/dateRange filters', async () => {
      await mod.runs.create({
        testCaseId: 'tc-1', experimentId: 'exp-1', experimentRunId: 'run-a', agentKey: 'agent-1',
        modelId: 'model-1', status: 'completed', passFailStatus: 'passed', timestamp: '2025-06-01T00:00:00Z',
      } as any);
      await mod.runs.create({
        testCaseId: 'tc-2', experimentId: 'exp-2', experimentRunId: 'run-b', agentKey: 'agent-2',
        modelId: 'model-2', status: 'failed', passFailStatus: 'failed', timestamp: '2025-01-01T00:00:00Z',
      } as any);

      expect((await mod.runs.search({ experimentId: 'exp-1' })).items).toHaveLength(1);
      expect((await mod.runs.search({ experimentRunId: 'run-a' })).items).toHaveLength(1);
      expect((await mod.runs.search({ agentId: 'agent-2' })).items).toHaveLength(1);
      expect((await mod.runs.search({ modelId: 'model-1' })).items).toHaveLength(1);
      expect((await mod.runs.search({ status: 'failed' })).items).toHaveLength(1);
      expect((await mod.runs.search({ passFailStatus: 'passed' })).items).toHaveLength(1);
      expect((await mod.runs.search({ dateRange: { start: '2025-05-01', end: '2025-07-01' } })).items).toHaveLength(1);
    });

    it('getByExperiment / getByExperimentRun delegate to search', async () => {
      await mod.runs.create({ testCaseId: 'tc-1', experimentId: 'exp-1', experimentRunId: 'run-a' } as any);
      expect(await mod.runs.getByExperiment('exp-1')).toHaveLength(1);
      expect(await mod.runs.getByExperimentRun('exp-1', 'run-a')).toHaveLength(1);
      expect(await mod.runs.getByExperimentRun('exp-1', 'run-nonexistent')).toHaveLength(0);
    });

    it('getIterations returns items/total/maxIteration', async () => {
      await mod.runs.create({ testCaseId: 'tc-1', experimentId: 'exp-1', iteration: 1 } as any);
      await mod.runs.create({ testCaseId: 'tc-1', experimentId: 'exp-1', iteration: 3 } as any);

      const result = await mod.runs.getIterations('exp-1', 'tc-1');
      expect(result.total).toBe(2);
      expect(result.maxIteration).toBe(3);
    });

    it('getIterations scopes by experimentRunId when provided', async () => {
      await mod.runs.create({ testCaseId: 'tc-1', experimentId: 'exp-1', experimentRunId: 'run-a', iteration: 1 } as any);
      await mod.runs.create({ testCaseId: 'tc-1', experimentId: 'exp-1', experimentRunId: 'run-b', iteration: 5 } as any);

      const result = await mod.runs.getIterations('exp-1', 'tc-1', 'run-a');
      expect(result.total).toBe(1);
      expect(result.maxIteration).toBe(1);
    });

    it('bulkCreate creates all runs', async () => {
      const result = await mod.runs.bulkCreate([{ testCaseId: 'tc-1' }, { testCaseId: 'tc-2' }] as any);
      expect(result.created).toBe(2);
      expect(result.errors).toBe(0);
    });

    describe('annotations', () => {
      it('addAnnotation appends a fully-formed annotation to the run', async () => {
        const run = await mod.runs.create({ testCaseId: 'tc-1' } as any);
        const ann = await mod.runs.addAnnotation(run.id, { text: 'looks off' } as any);

        expect(ann.reportId).toBe(run.id);
        expect(ann.text).toBe('looks off');
        expect(ann.timestamp).toBeDefined();

        const updated = await mod.runs.getById(run.id);
        expect(updated!.annotations).toHaveLength(1);
      });

      it('addAnnotation throws when the run does not exist', async () => {
        await expect(mod.runs.addAnnotation('missing', {} as any)).rejects.toThrow('Run missing not found');
      });

      it('updateAnnotation merges updates and throws for a missing run/annotation', async () => {
        const run = await mod.runs.create({ testCaseId: 'tc-1' } as any);
        const ann = await mod.runs.addAnnotation(run.id, { text: 'v1' } as any);

        const updated = await mod.runs.updateAnnotation(run.id, ann.id, { text: 'v2' } as any);
        expect(updated.text).toBe('v2');

        await expect(mod.runs.updateAnnotation('missing-run', ann.id, {} as any)).rejects.toThrow('Run missing-run not found');
        await expect(mod.runs.updateAnnotation(run.id, 'missing-ann', {} as any)).rejects.toThrow('Annotation missing-ann not found');
      });

      it('deleteAnnotation removes an annotation and no-ops otherwise', async () => {
        const run = await mod.runs.create({ testCaseId: 'tc-1' } as any);
        const ann = await mod.runs.addAnnotation(run.id, { text: 'v1' } as any);

        expect(await mod.runs.deleteAnnotation(run.id, ann.id)).toEqual({ deleted: true });
        expect(await mod.runs.deleteAnnotation(run.id, ann.id)).toEqual({ deleted: false });
        expect(await mod.runs.deleteAnnotation('missing-run', ann.id)).toEqual({ deleted: false });
      });
    });

    it('countsByTestCase aggregates run counts per test case', async () => {
      await mod.runs.create({ testCaseId: 'tc-1' } as any);
      await mod.runs.create({ testCaseId: 'tc-1' } as any);
      await mod.runs.create({ testCaseId: 'tc-2' } as any);

      const counts = await mod.runs.countsByTestCase();
      expect(counts).toEqual({ 'tc-1': 2, 'tc-2': 1 });
    });
  });

  describe('analytics', () => {
    it('query returns paginated stored records', async () => {
      await mod.analytics.writeRecord({ metric: 'a', value: 1 });
      await mod.analytics.writeRecord({ metric: 'b', value: 2 });

      const result = await mod.analytics.query({});
      expect(result.total).toBe(2);
    });

    it('aggregations returns an empty result with the requested groupBy echoed back', async () => {
      const result = await mod.analytics.aggregations('exp-1', 'agentKey');
      expect(result).toEqual({ aggregations: [], groupBy: 'agentKey' });

      const defaulted = await mod.analytics.aggregations();
      expect(defaulted.groupBy).toBe('none');
    });

    it('backfill is a no-op that reports zero counts', async () => {
      const result = await mod.analytics.backfill();
      expect(result).toEqual({ backfilled: 0, errors: 0, total: 0 });
    });
  });

  describe('evaluators', () => {
    const validEvaluator = () => ({
      name: 'My Evaluator',
      systemPrompt: 'Judge this.',
      scoringConfig: { type: 'binary' },
    });

    it('create validates required fields', async () => {
      await expect(mod.evaluators.create({})).rejects.toThrow('Evaluator name is required');
      await expect(mod.evaluators.create({ name: 'X' })).rejects.toThrow('Evaluator system prompt is required');
      await expect(mod.evaluators.create({ name: 'X', systemPrompt: 'p' })).rejects.toThrow('Evaluator scoring config is required');
    });

    it('create/getById round trip with an initial version entry', async () => {
      const ev = await mod.evaluators.create(validEvaluator() as any);
      expect(ev.currentVersion).toBe(1);
      expect(ev.isSystem).toBe(false);
      expect(ev.versions).toHaveLength(1);

      const fetched = await mod.evaluators.getById(ev.id);
      expect(fetched).toEqual(ev);
      expect(await mod.evaluators.getById('missing')).toBeNull();
    });

    it('update creates a new version and appends to versions[]', async () => {
      const ev = await mod.evaluators.create(validEvaluator() as any);
      const updated = await mod.evaluators.update(ev.id, { systemPrompt: 'New prompt' } as any);

      expect(updated.currentVersion).toBe(2);
      expect(updated.systemPrompt).toBe('New prompt');
      expect(updated.versions).toHaveLength(2);

      const versions = await mod.evaluators.getVersions(ev.id);
      expect(versions).toHaveLength(2);
      const v1 = await mod.evaluators.getVersion(ev.id, 1);
      expect(v1?.systemPrompt).toBe('Judge this.');
    });

    it('update throws for a missing evaluator and refuses to edit system evaluators', async () => {
      await expect(mod.evaluators.update('missing', {} as any)).rejects.toThrow('Evaluator missing not found');

      const sysEv = await mod.evaluators.create({ ...validEvaluator(), isSystem: true } as any);
      await expect(mod.evaluators.update(sysEv.id, { systemPrompt: 'x' } as any)).rejects.toThrow('Cannot edit system evaluators');
    });

    it('delete removes all versions and refuses to delete system evaluators', async () => {
      const ev = await mod.evaluators.create(validEvaluator() as any);
      await mod.evaluators.update(ev.id, { systemPrompt: 'v2' } as any);

      const result = await mod.evaluators.delete(ev.id);
      expect(result.deleted).toBe(2);
      expect(await mod.evaluators.getById(ev.id)).toBeNull();

      expect(await mod.evaluators.delete('missing')).toEqual({ deleted: 0 });

      const sysEv = await mod.evaluators.create({ ...validEvaluator(), isSystem: true } as any);
      await expect(mod.evaluators.delete(sysEv.id)).rejects.toThrow('Cannot delete system evaluators');
    });

    it('getAll returns only the latest version of each evaluator', async () => {
      const ev = await mod.evaluators.create(validEvaluator() as any);
      await mod.evaluators.update(ev.id, { systemPrompt: 'v2' } as any);
      await mod.evaluators.create({ ...validEvaluator(), name: 'Second' } as any);

      const { items, total } = await mod.evaluators.getAll();
      expect(total).toBe(2);
      const first = items.find(i => i.id === ev.id);
      expect(first!.currentVersion).toBe(2);
    });
  });

  describe('evaluationRuns', () => {
    it('create/getById/update/delete round trip and never leak as a benchmark', async () => {
      const run = await mod.evaluationRuns.create({ id: 'evalrun-1', agentKey: 'a1', sources: [], testCaseSnapshots: [] } as any);
      expect(run.docType).toBe('evaluation-run');
      expect(run.status).toBe('pending');

      expect(await mod.evaluationRuns.getById(run.id)).toEqual(run);
      expect(await mod.benchmarks.getById(run.id)).toBeNull(); // shared dir, not a benchmark

      const updated = await mod.evaluationRuns.update(run.id, { status: 'completed' } as any);
      expect(updated.status).toBe('completed');

      expect(await mod.evaluationRuns.delete(run.id)).toEqual({ deleted: true });
    });

    // Data-integrity twin of the OpenSearch version-conflict fix (2026-09-04):
    // the file adapter's read→modify→write must not interleave across an
    // `await`, and mergeMissingResults must never overwrite an existing entry.
    it('concurrent updateResult() calls for different cases all land (no lost update)', async () => {
      const run = await mod.evaluationRuns.create({ id: 'evalrun-conc', agentKey: 'a1', sources: [], testCaseSnapshots: [] } as any);
      await Promise.all(Array.from({ length: 12 }, (_, i) =>
        mod.evaluationRuns.updateResult(run.id, `tc-${i}`, { reportId: `r-${i}`, status: 'completed' })));
      const persisted = await mod.evaluationRuns.getById(run.id);
      expect(Object.keys(persisted!.results)).toHaveLength(12);
    });

    it('update() concurrent with updateResult() does not clobber per-case results', async () => {
      const run = await mod.evaluationRuns.create({ id: 'evalrun-conc2', agentKey: 'a1', sources: [], testCaseSnapshots: [] } as any);
      await Promise.all([
        mod.evaluationRuns.updateResult(run.id, 'tc-1', { reportId: 'r1', status: 'completed' }),
        mod.evaluationRuns.update(run.id, { name: 'renamed', status: 'cancelled' } as any),
        mod.evaluationRuns.updateResult(run.id, 'tc-2', { reportId: 'r2', status: 'failed' }),
      ]);
      const persisted = await mod.evaluationRuns.getById(run.id);
      expect(persisted!.name).toBe('renamed');
      expect(persisted!.status).toBe('cancelled');
      expect(Object.keys(persisted!.results).sort()).toEqual(['tc-1', 'tc-2']);
    });

    it('update() ignores id/docType in the patch so a doc cannot be re-keyed', async () => {
      const run = await mod.evaluationRuns.create({ id: 'evalrun-keys', agentKey: 'a1', sources: [], testCaseSnapshots: [] } as any);
      const updated = await mod.evaluationRuns.update(run.id, { id: 'other', docType: 'benchmark', status: 'completed' } as any);
      expect(updated.id).toBe('evalrun-keys');
      expect(updated.docType).toBe('evaluation-run');
      expect(await mod.evaluationRuns.getById('other')).toBeNull();
    });

    it('mergeMissingResults() adds absent keys, never overwrites existing ones, and returns false for a missing run', async () => {
      const run = await mod.evaluationRuns.create({ id: 'evalrun-merge', agentKey: 'a1', sources: [], testCaseSnapshots: [] } as any);
      await mod.evaluationRuns.updateResult(run.id, 'tc-1', { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } as any);
      await mod.evaluationRuns.mergeMissingResults(run.id, {
        'tc-1': { reportId: '', status: 'cancelled' },   // must NOT overwrite the verdict
        'tc-2': { reportId: '', status: 'cancelled' },   // absent → added
      });
      const persisted = await mod.evaluationRuns.getById(run.id);
      expect(persisted!.results['tc-1']).toEqual({ reportId: 'r1', status: 'completed', passFailStatus: 'passed' });
      expect(persisted!.results['tc-2']).toEqual({ reportId: '', status: 'cancelled' });
      expect(await mod.evaluationRuns.mergeMissingResults('nope', { a: { reportId: '', status: 'cancelled' } })).toBe(false);
    });

    it('delete is idempotent (second delete reports deleted: false)', async () => {
      const run = await mod.evaluationRuns.create({ id: 'evalrun-del', agentKey: 'a1', sources: [], testCaseSnapshots: [] } as any);
      expect(await mod.evaluationRuns.delete(run.id)).toEqual({ deleted: true });
      expect(await mod.evaluationRuns.delete(run.id)).toEqual({ deleted: false });
    });

    it('update throws for a nonexistent evaluation run', async () => {
      await expect(mod.evaluationRuns.update('missing', {} as any)).rejects.toThrow('Evaluation run missing not found');
    });

    it('list filters by benchmarkId/agentKey/status/trigger/testCaseId and sorts', async () => {
      await mod.evaluationRuns.create({
        id: 'run-a', benchmarkId: 'b1', agentKey: 'agent-1', status: 'completed', trigger: 'cli',
        sources: [], testCaseSnapshots: [{ id: 'tc-1' } as any], createdAt: '2025-01-01T00:00:00Z',
      } as any);
      await mod.evaluationRuns.create({
        id: 'run-b', benchmarkId: 'b2', agentKey: 'agent-2', status: 'failed', trigger: 'api',
        sources: [], testCaseSnapshots: [{ id: 'tc-2' } as any], createdAt: '2025-02-01T00:00:00Z',
      } as any);

      expect((await mod.evaluationRuns.list({ benchmarkId: 'b1' })).items).toHaveLength(1);
      expect((await mod.evaluationRuns.list({ agentKey: 'agent-2' })).items).toHaveLength(1);
      expect((await mod.evaluationRuns.list({ status: 'failed' })).items).toHaveLength(1);
      expect((await mod.evaluationRuns.list({ trigger: 'cli' })).items).toHaveLength(1);
      expect((await mod.evaluationRuns.list({ testCaseId: 'tc-2' })).items).toHaveLength(1);

      const ascending = await mod.evaluationRuns.list({ order: 'asc' });
      expect(ascending.items[0].id).toBe('run-a');
      const descending = await mod.evaluationRuns.list({ order: 'desc' });
      expect(descending.items[0].id).toBe('run-b');
    });

    it('updateResult writes a per-test-case result and returns false for a missing run', async () => {
      const run = await mod.evaluationRuns.create({ id: 'run-x', sources: [], testCaseSnapshots: [] } as any);
      const ok = await mod.evaluationRuns.updateResult(run.id, 'tc-1', { reportId: 'report-1', status: 'completed' });
      expect(ok).toBe(true);

      const updated = await mod.evaluationRuns.getById(run.id);
      expect(updated!.results['tc-1']).toEqual({ reportId: 'report-1', status: 'completed' });

      expect(await mod.evaluationRuns.updateResult('missing', 'tc-1', { reportId: 'r', status: 'completed' })).toBe(false);
    });
  });
});
