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
