/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';

describe('FileStorageModule', () => {
  let tmpDir: string;
  let mod: FileStorageModule;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-test-'));
    mod = new FileStorageModule(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('testCases', () => {
    describe('create', () => {
      it('should throw when name is missing', async () => {
        await expect(
          mod.testCases.create({ initialPrompt: 'test' })
        ).rejects.toThrow('Test case name is required');
      });

      it('should create and retrieve a test case', async () => {
        const created = await mod.testCases.create({
          name: 'My Test Case',
          initialPrompt: 'Do something',
        });

        expect(created.id).toMatch(/^tc-/);
        expect(created.name).toBe('My Test Case');
        expect(created.version).toBe(1);
        expect(created.createdAt).toBeDefined();

        const fetched = await mod.testCases.getById(created.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.name).toBe('My Test Case');
      });
    });

    describe('update', () => {
      it('should throw when entity does not exist', async () => {
        await expect(
          mod.testCases.update('nonexistent-id', { name: 'Updated' })
        ).rejects.toThrow('Test case nonexistent-id not found');
      });

      it('should update an existing entity', async () => {
        const created = await mod.testCases.create({
          name: 'Original',
          initialPrompt: 'Test',
        });

        const updated = await mod.testCases.update(created.id, { name: 'Updated' });

        expect(updated.name).toBe('Updated');
        expect(updated.version).toBe(2);

        const fetched = await mod.testCases.getById(created.id);
        expect(fetched!.name).toBe('Updated');
        expect(fetched!.version).toBe(2);
      });
    });

    describe('getById', () => {
      it('should return null for nonexistent id', async () => {
        const result = await mod.testCases.getById('does-not-exist');
        expect(result).toBeNull();
      });
    });
  });

  describe('runs', () => {
    it('applies pagination before lazily loading legacy report documents', async () => {
      for (let index = 0; index < 3; index++) {
        await mod.runs.create({
          id: `legacy-${index}`,
          timestamp: new Date(1_700_000_000_000 + index).toISOString(),
          testCaseId: 'tc-legacy',
          status: 'completed',
          rawEvents: [{ payload: 'x'.repeat(1_000) }],
        } as any);
      }
      fs.rmSync(path.join(tmpDir, 'runs', '.summaries'), { recursive: true, force: true });

      const listed = await mod.runs.getAll({ size: 1, _source: ['id', 'status'] });
      const cached = fs.readdirSync(path.join(tmpDir, 'runs', '.summaries'));

      expect(listed.items).toHaveLength(1);
      expect(listed.total).toBe(3);
      expect(cached).toHaveLength(1);
    });

    it('lists a 50 MB report as a summary while getById keeps the full document', async () => {
      const rawPayload = 'x'.repeat(50 * 1024 * 1024);
      await mod.runs.create({
        id: 'huge-report',
        timestamp: '2026-01-01T00:00:00.000Z',
        testCaseId: 'tc-huge',
        status: 'completed',
        passFailStatus: 'passed',
        metrics: { accuracy: 100 },
        matcherResults: [{
          description: 'large report matcher',
          pass: true,
          method: 'llm-judge',
          reasoning: 'r'.repeat(2_000),
        }],
        rawEvents: [{ rawPayload }],
        trajectory: [{ type: 'assistant', content: 'detail trajectory' }],
        llmJudgeResponse: { rawResponse: 'detail judge response' },
      } as any);
      fs.rmSync(path.join(tmpDir, 'runs', '.summaries'), { recursive: true, force: true });

      const listed = await mod.runs.getAll({ size: 1, _source: [
        'id', 'testCaseId', 'status', 'metrics', 'matcherResults',
        'rawEvents', 'trajectory', 'llmJudgeResponse', 'rawResponse',
      ] });
      const detail = await mod.runs.getById('huge-report');

      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({
        id: 'huge-report',
        testCaseId: 'tc-huge',
        status: 'completed',
        metrics: { accuracy: 100 },
      });
      expect((listed.items[0] as any).rawEvents).toBeUndefined();
      expect((listed.items[0] as any).trajectory).toBeUndefined();
      expect((listed.items[0] as any).llmJudgeResponse).toBeUndefined();
      expect((listed.items[0] as any).rawResponse).toBeUndefined();
      expect((listed.items[0] as any).matcherResults[0].reasoning.length).toBeLessThanOrEqual(501);
      expect((detail as any).rawEvents[0].rawPayload).toHaveLength(50 * 1024 * 1024);
      expect((detail as any).trajectory[0].content).toBe('detail trajectory');
      expect((detail as any).llmJudgeResponse.rawResponse).toBe('detail judge response');
    });
  });

  describe('benchmarks', () => {
    // Regression: benchmarks and evaluation-runs share the same on-disk `benchmarks/`
    // dir, discriminated by `docType`. Without the docType filter, an eval-run
    // detail route renders it as an empty benchmark instead of 404ing.
    it('getById returns null for an evaluation-run id (eval-run rendered as empty benchmark)', async () => {
      await mod.evaluationRuns.create({
        id: 'eval-run-leak-2',
        name: 'CLI eval-run',
        status: 'completed',
        agentKey: 'demo',
        modelId: 'claude-sonnet',
        sources: [],
        trigger: 'api',
        testCaseSnapshots: [],
        results: {},
      } as any);

      const result = await mod.benchmarks.getById('eval-run-leak-2');

      expect(result).toBeNull();
    });

    it('getById still returns a real benchmark', async () => {
      const bm = await mod.benchmarks.create({ name: 'Real Benchmark 2', testCaseIds: [] });

      const result = await mod.benchmarks.getById(bm.id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(bm.id);
    });

    it('excludes co-located evaluation-run documents from getAll', async () => {
      await mod.benchmarks.create({ id: 'bench-1', name: 'Suite', testCaseIds: [], runs: [] });
      await mod.evaluationRuns.create({
        id: 'eval-run-1',
        docType: 'evaluation-run',
        name: 'CLI Run',
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [],
        trigger: 'cli',
        testCaseSnapshots: [],
        results: {},
      });

      const result = await mod.benchmarks.getAll();
      expect(result.total).toBe(1);
      expect(result.items.map(item => item.id)).toEqual(['bench-1']);
    });

    /**
     * `linkTestCaseIds` is the file adapter's atomic (within-process)
     * counterpart to the OpenSearch adapter's Painless scripted `_update`
     * (see tests/unit/server/adapters/opensearch/StorageModule.test.ts).
     * The file backend has no server-side atomic-update primitive, so it
     * serializes through the module-level `withBenchmarkWriteLock` mutex
     * in server/adapters/file/StorageModule.ts instead -- these tests use
     * the REAL adapter against a real temp directory (no mocks) so the
     * concurrency assertions mean something.
     */
    describe('linkTestCaseIds', () => {
      it('unions ids into both the top level and the current version, without a version bump', async () => {
        const bm = await mod.benchmarks.create({ name: 'Shell', testCaseIds: [] });

        const result = await mod.benchmarks.linkTestCaseIds(bm.id, ['tc-1', 'tc-2', 'tc-1']);

        expect(result?.added).toEqual(['tc-1', 'tc-2']);
        expect(result?.benchmark.testCaseIds).toEqual(['tc-1', 'tc-2']);
        // create() doesn't itself synthesize versions/currentVersion, so
        // this exercises the SAME legacy-doc v1-synthesis path as the
        // dedicated test below — no bump: currentVersion is never written.
        expect(result?.benchmark.currentVersion).toBeUndefined();
        expect(result?.benchmark.versions[0].testCaseIds).toEqual(['tc-1', 'tc-2']);
        const fetched = await mod.benchmarks.getById(bm.id);
        expect(fetched?.testCaseIds).toEqual(['tc-1', 'tc-2']);
      });

      it('returns null when the benchmark does not exist', async () => {
        const result = await mod.benchmarks.linkTestCaseIds('missing-bench', ['tc-1']);
        expect(result).toBeNull();
      });

      it('is a no-op (no write) when both levels already have every id', async () => {
        const bm = await mod.benchmarks.create({ name: 'Shell', testCaseIds: ['tc-1'] });
        await mod.benchmarks.linkTestCaseIds(bm.id, ['tc-1']); // seed the current version too
        const before = await mod.benchmarks.getById(bm.id);

        const result = await mod.benchmarks.linkTestCaseIds(bm.id, ['tc-1']);

        expect(result?.added).toEqual([]);
        expect(result?.benchmark.updatedAt).toBe(before?.updatedAt);
      });

      it("repairs a stale current-version testCaseIds even when the top level is already correct (the bug this function exists to fix)", async () => {
        const bm = await mod.benchmarks.create({
          id: 'bench-stale-version',
          name: 'Stale',
          testCaseIds: ['tc-1', 'tc-2', 'tc-3'],
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [] }],
        } as any);

        const result = await mod.benchmarks.linkTestCaseIds(bm.id, ['tc-1', 'tc-2', 'tc-3']);

        expect(result?.added).toEqual([]); // nothing NEW at the top level
        expect(result?.benchmark.versions[0].testCaseIds).toEqual(['tc-1', 'tc-2', 'tc-3']); // version repaired anyway
      });

      it('synthesizes a v1 version entry for a legacy doc with no versions array', async () => {
        const bm = await mod.benchmarks.create({ id: 'bench-legacy', name: 'Legacy', testCaseIds: [] } as any);
        // Simulate a pre-versioning doc by deleting the versions field the
        // create() path already populated as [] -- write it back directly.
        const fp = path.join(tmpDir, 'benchmarks', `${bm.id}.json`);
        const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        delete raw.versions;
        delete raw.currentVersion;
        fs.writeFileSync(fp, JSON.stringify(raw));

        const result = await mod.benchmarks.linkTestCaseIds(bm.id, ['tc-1']);

        expect(result?.benchmark.versions).toHaveLength(1);
        expect(result?.benchmark.versions[0]).toMatchObject({ version: 1, testCaseIds: ['tc-1'] });
        expect(result?.benchmark.currentVersion).toBeUndefined(); // no bump: field never written
      });

      it('targets the version matching currentVersion, not array index 0, when there are multiple versions', async () => {
        const bm = await mod.benchmarks.create({
          id: 'bench-multi',
          name: 'Multi',
          testCaseIds: ['tc-1', 'tc-2'],
          currentVersion: 2,
          versions: [
            { version: 1, createdAt: new Date().toISOString(), testCaseIds: ['tc-1'] },
            { version: 2, createdAt: new Date().toISOString(), testCaseIds: [] },
          ],
        } as any);

        await mod.benchmarks.linkTestCaseIds(bm.id, ['tc-1', 'tc-2']);

        const fetched = await mod.benchmarks.getById(bm.id);
        expect(fetched?.versions[0].testCaseIds).toEqual(['tc-1']); // v1 untouched
        expect(fetched?.versions[1].testCaseIds).toEqual(['tc-1', 'tc-2']); // v2 (current) repaired
      });

      it('CONCURRENCY: two simultaneous linkTestCaseIds calls against the same benchmark both land — no lost update', async () => {
        const bm = await mod.benchmarks.create({ name: 'Race', testCaseIds: [] });

        const [r1, r2] = await Promise.all([
          mod.benchmarks.linkTestCaseIds(bm.id, ['tc-a']),
          mod.benchmarks.linkTestCaseIds(bm.id, ['tc-b']),
        ]);

        expect(r1).not.toBeNull();
        expect(r2).not.toBeNull();
        const fetched = await mod.benchmarks.getById(bm.id);
        // Both ids present regardless of which write landed first — this is
        // exactly the case a client-side optimistic-retry-but-unguarded-write
        // implementation could still lose (codex_review's finding).
        expect(fetched?.testCaseIds.sort()).toEqual(['tc-a', 'tc-b']);
        expect(fetched?.versions[0].testCaseIds.sort()).toEqual(['tc-a', 'tc-b']);
      });

      it('CONCURRENCY: many simultaneous linkTestCaseIds calls against the same benchmark all land — no lost update', async () => {
        const bm = await mod.benchmarks.create({ name: 'BigRace', testCaseIds: [] });
        const ids = Array.from({ length: 15 }, (_, i) => `tc-race-${i}`);

        await Promise.all(ids.map(id => mod.benchmarks.linkTestCaseIds(bm.id, [id])));

        const fetched = await mod.benchmarks.getById(bm.id);
        expect(fetched?.testCaseIds.slice().sort()).toEqual(ids.slice().sort());
        expect(fetched?.versions[0].testCaseIds.slice().sort()).toEqual(ids.slice().sort());
      });

      it('CONCURRENCY: linkTestCaseIds racing a plain update() version bump does not clobber the bump, and the linked ids still land', async () => {
        const bm = await mod.benchmarks.create({ name: 'RaceVsBump', testCaseIds: ['tc-1'] });
        await mod.benchmarks.linkTestCaseIds(bm.id, ['tc-1']); // seed v1's own array too

        // A normal PUT /api/storage/benchmarks/:id edit bumps a new version
        // (this is what the real edit route does — not going through
        // linkTestCaseIds at all). Racing it against a concurrent link call
        // for a DIFFERENT id.
        const bump = mod.benchmarks.update(bm.id, {
          testCaseIds: ['tc-1', 'tc-2'],
          currentVersion: 2,
          versions: [
            { version: 1, createdAt: new Date().toISOString(), testCaseIds: ['tc-1'] },
            { version: 2, createdAt: new Date().toISOString(), testCaseIds: ['tc-1', 'tc-2'] },
          ],
        } as any);
        const link = mod.benchmarks.linkTestCaseIds(bm.id, ['tc-3']);

        await Promise.all([bump, link]);

        const fetched = await mod.benchmarks.getById(bm.id);
        // tc-3 must have landed SOMEWHERE (top level at minimum) regardless
        // of ordering — this is best-effort under a real race against a
        // caller that bypasses the mutex entirely (update() isn't
        // serialized through it, matching production: the normal edit
        // route doesn't go through linkTestCaseIds). The mutex only
        // guarantees linkTestCaseIds calls don't lose each other's writes;
        // it can't retroactively serialize a concurrent plain update().
        expect(fetched?.testCaseIds).toContain('tc-3');
      });
    });
  });

  describe('images', () => {
    const baseImage = () => ({
      digest: 'digest-abc',
      testCaseFingerprints: [{ id: 'tc-1', name: 'TC 1', contentHash: 'hash1' }],
      testCaseCount: 1,
      evalConditions: { evaluatorId: 'ev-1' },
    });

    it('creates an image and stamps id/docType/createdAt/tags defaults', async () => {
      const created = await mod.images.create(baseImage() as any);

      expect(created.id).toBe('img-digest-abc');
      expect(created.docType).toBe('benchmark-image');
      expect(created.tags).toEqual([]);
      expect(created.createdAt).toBeDefined();
    });

    it('is find-or-create: creating with the same digest again returns the original (preserves tags)', async () => {
      const first = await mod.images.create({ ...baseImage(), tags: ['nightly'] } as any);
      const second = await mod.images.create({ ...baseImage(), tags: ['different'] } as any);

      expect(second).toEqual(first);
      expect(second.tags).toEqual(['nightly']);
    });

    it('getByDigest returns null for an unknown digest', async () => {
      const result = await mod.images.getByDigest('nope');
      expect(result).toBeNull();
    });

    it('getByDigest returns null for a non-image doc (docType mismatch)', async () => {
      await mod.benchmarks.create({ id: 'img-digest-abc', name: 'Not really an image', testCaseIds: [] });
      const result = await mod.images.getByDigest('digest-abc');
      expect(result).toBeNull();
    });

    it('getAll lists images sorted by createdAt desc', async () => {
      await mod.images.create({ ...baseImage(), digest: 'digest-old', createdAt: '2020-01-01T00:00:00.000Z' } as any);
      await mod.images.create({ ...baseImage(), digest: 'digest-new', createdAt: '2025-01-01T00:00:00.000Z' } as any);

      const { items, total } = await mod.images.getAll();
      expect(total).toBe(2);
      expect(items.map(i => i.digest)).toEqual(['digest-new', 'digest-old']);
    });

    it('update mutates only tags/lastRunAt, preserving content identity fields', async () => {
      const created = await mod.images.create(baseImage() as any);
      const updated = await mod.images.update(created.digest, { tags: ['v2'], lastRunAt: '2026-01-01T00:00:00.000Z' });

      expect(updated.tags).toEqual(['v2']);
      expect(updated.lastRunAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated.digest).toBe(created.digest);
      expect(updated.testCaseCount).toBe(created.testCaseCount);
    });

    it('update throws when the image does not exist', async () => {
      await expect(mod.images.update('missing-digest', { tags: ['x'] })).rejects.toThrow('Benchmark image missing-digest not found');
    });

    it('delete removes an existing image and returns deleted:true', async () => {
      const created = await mod.images.create(baseImage() as any);
      const result = await mod.images.delete(created.digest);
      expect(result).toEqual({ deleted: true });
      expect(await mod.images.getByDigest(created.digest)).toBeNull();
    });

    it('delete returns deleted:false for a nonexistent digest', async () => {
      const result = await mod.images.delete('nonexistent-digest');
      expect(result).toEqual({ deleted: false });
    });

    it('images and benchmarks are cross-invisible via docType (shared dir)', async () => {
      await mod.images.create(baseImage() as any);
      await mod.benchmarks.create({ name: 'Real Benchmark', testCaseIds: [] });

      const benchmarks = await mod.benchmarks.getAll();
      expect(benchmarks.items.every(b => b.name !== undefined)).toBe(true);
      expect(benchmarks.items.some((b: any) => b.docType === 'benchmark-image')).toBe(false);
    });
  });

  describe('sessionMetadata', () => {
    it('should return null for nonexistent session', async () => {
      const result = await mod.sessionMetadata.get('claude-code', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should put and get metadata', async () => {
      const saved = await mod.sessionMetadata.put('claude-code', 's1', {
        status: 'interesting',
        notes: 'great session',
        rating: 5,
      });

      expect(saved.agentKind).toBe('claude-code');
      expect(saved.sessionId).toBe('s1');
      expect(saved.status).toBe('interesting');
      expect((saved as any).notes).toBe('great session');
      expect((saved as any).rating).toBe(5);
      expect(saved.updatedAt).toBeDefined();

      const fetched = await mod.sessionMetadata.get('claude-code', 's1');
      expect(fetched).toEqual(saved);
    });

    it('should merge on subsequent put', async () => {
      await mod.sessionMetadata.put('claude-code', 's2', { status: 'normal', bookmarked: true });
      const merged = await mod.sessionMetadata.put('claude-code', 's2', { status: 'problematic', rating: 3 });

      expect((merged as any).bookmarked).toBe(true);
      expect(merged.status).toBe('problematic');
      expect((merged as any).rating).toBe(3);
    });

    it('should list all metadata docs', async () => {
      await mod.sessionMetadata.put('claude-code', 'a', { x: 1 });
      await mod.sessionMetadata.put('kiro', 'b', { x: 2 });

      const { items, total } = await mod.sessionMetadata.list();
      expect(total).toBe(2);
      expect(items.map(i => i.sessionId).sort()).toEqual(['a', 'b']);
    });

    describe('delete', () => {
      it('should return { deleted: false } for a nonexistent session', async () => {
        const result = await mod.sessionMetadata.delete('claude-code', 'nonexistent');
        expect(result).toEqual({ deleted: false });
      });

      it('should delete an existing session and return { deleted: true }', async () => {
        await mod.sessionMetadata.put('claude-code', 's3', { status: 'interesting' });

        const result = await mod.sessionMetadata.delete('claude-code', 's3');
        expect(result).toEqual({ deleted: true });

        const fetched = await mod.sessionMetadata.get('claude-code', 's3');
        expect(fetched).toBeNull();
      });

      it('should be idempotent — deleting twice returns false the second time', async () => {
        await mod.sessionMetadata.put('claude-code', 's4', { status: 'interesting' });

        expect(await mod.sessionMetadata.delete('claude-code', 's4')).toEqual({ deleted: true });
        expect(await mod.sessionMetadata.delete('claude-code', 's4')).toEqual({ deleted: false });
      });

      it('should not affect other sessions', async () => {
        await mod.sessionMetadata.put('claude-code', 'keep-me', { x: 1 });
        await mod.sessionMetadata.put('claude-code', 'delete-me', { x: 2 });

        await mod.sessionMetadata.delete('claude-code', 'delete-me');

        expect(await mod.sessionMetadata.get('claude-code', 'delete-me')).toBeNull();
        expect(await mod.sessionMetadata.get('claude-code', 'keep-me')).not.toBeNull();
      });
    });
  });
});
