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

      it('round-trips a fixture envelope and opaque payload through plain JSON storage', async () => {
        const fixture = {
          type: 'filesystem-workspace',
          ref: 'cache-refactor',
          integrity: 'sha256:abc123',
          payload: { manifest: { files: [{ path: 'src/cache.ts', mode: 420 }] } },
        };

        const created = await mod.testCases.create({
          name: 'Fixture case',
          initialPrompt: 'Investigate the workspace',
          fixture,
        });
        const fetched = await mod.testCases.getById(created.id);
        const onDisk = JSON.parse(fs.readFileSync(
          path.join(tmpDir, 'test-cases', `${created.id}-v1.json`),
          'utf8',
        ));

        expect(fetched?.fixture).toEqual(fixture);
        expect(onDisk.fixture).toEqual(fixture);
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

      it('creates a new version when fixture content changes', async () => {
        const created = await mod.testCases.create({
          name: 'Versioned fixture',
          initialPrompt: 'Investigate',
          fixture: {
            type: 'filesystem-workspace',
            ref: 'workspace-v1',
            integrity: 'sha256:aaa111',
          },
        });

        const updated = await mod.testCases.update(created.id, {
          fixture: {
            type: 'filesystem-workspace',
            ref: 'workspace-v2',
            integrity: 'sha256:bbb222',
          },
        });
        const versions = await mod.testCases.getVersions(created.id);

        expect(updated.version).toBe(2);
        expect(versions).toHaveLength(2);
        expect(versions.map((version) => version.fixture?.ref)).toEqual(['workspace-v2', 'workspace-v1']);
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
  });
});
