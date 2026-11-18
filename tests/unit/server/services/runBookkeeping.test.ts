/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run bookkeeping (#612) against a REAL FileStorageModule: the benchmark link
 * and the image stamp a run creation records, shared by the UI route and the
 * run-ingestion route so a CLI-ingested run is linked exactly like a
 * server-executed one.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { computeImageDigest } from '@/lib/benchmarkImage';
import { performRunBookkeeping, performIngestedRunBookkeeping, linkRunTestCasesToBenchmark, BenchmarkNotFoundError } from '@/server/services/runBookkeeping';

describe('runBookkeeping (real file storage)', () => {
  let dir: string;
  let storage: FileStorageModule;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ah-bookkeeping-'));
    storage = new FileStorageModule(dir);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

  const makeCases = async (n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await storage.testCases.create({ name: `case ${i}`, category: 'General', difficulty: 'Easy', initialPrompt: `q${i}`, expectedOutcomes: ['a'] } as any));
    return out;
  };

  it('links the run\'s test cases into the benchmark and stamps the image with lastRunAt', async () => {
    const cases = await makeCases(2);
    const bench = await storage.benchmarks.create({ name: 'B', description: '', testCaseIds: [] } as any);
    const now = '2026-01-01T00:00:00.000Z';
    const { imageDigest } = await performRunBookkeeping(storage, { benchmarkId: bench.id, testCases: cases, evalConditions: { evaluatorId: 'ev-1', judgeModelId: 'demo-model' }, now });
    expect(imageDigest).toBe(computeImageDigest({ testCases: cases, evalConditions: { evaluatorId: 'ev-1', judgeModelId: 'demo-model' } }));
    const linked = (await storage.benchmarks.getById(bench.id))!;
    expect(linked.testCaseIds).toEqual(cases.map((c) => c.id));
    // Every version entry the adapter keeps agrees with the top level (see linkTestCaseIds).
    for (const v of linked.versions ?? []) expect(v.testCaseIds).toEqual(expect.arrayContaining(cases.map((c) => c.id)));
    const image = await storage.images.getByDigest(imageDigest!);
    expect(image).toMatchObject({ digest: imageDigest, lastRunAt: now });
    expect(image!.testCaseFingerprints).toHaveLength(2);
  });

  it('is idempotent on the image (same conditions → same digest, one image) and tolerates no benchmark', async () => {
    const cases = await makeCases(1);
    const a = await performRunBookkeeping(storage, { testCases: cases, evalConditions: {}, now: 't1' });
    const b = await performRunBookkeeping(storage, { testCases: cases, evalConditions: {}, now: 't2' });
    expect(a.imageDigest).toBe(b.imageDigest);
    expect((await storage.images.getAll()).total).toBe(1);
    expect((await storage.images.getByDigest(a.imageDigest!))!.lastRunAt).toBe('t2');
  });

  it('refuses an unknown benchmark (the only refusal) and nothing is linked', async () => {
    const cases = await makeCases(1);
    await expect(linkRunTestCasesToBenchmark(storage, 'bench-missing', cases.map((c) => c.id))).rejects.toBeInstanceOf(BenchmarkNotFoundError);
    await expect(performIngestedRunBookkeeping(storage, { benchmarkId: 'bench-missing', testCaseSnapshots: cases.map((c) => ({ id: c.id })) })).rejects.toThrow('Benchmark not found: bench-missing');
  });

  it('ingested run: resolves the cases from the snapshots (at the snapshot version), links only stored ids, stamps with the SERVER clock; an unknown or re-versioned snapshot → no image, not linked', async () => {
    const cases = await makeCases(2);
    const bench = await storage.benchmarks.create({ name: 'B2', description: '', testCaseIds: ['stale-id'] } as any);
    const run = { benchmarkId: bench.id, testCaseSnapshots: cases.map((c) => ({ id: c.id, version: 1 })), evaluatorId: 'ev-2', judgeModelId: undefined };
    const { imageDigest } = await performIngestedRunBookkeeping(storage, run, '2026-02-02T00:00:00.000Z');
    expect(imageDigest).toBe(computeImageDigest({ testCases: cases, evalConditions: { evaluatorId: 'ev-2', judgeModelId: undefined } }));
    expect((await storage.benchmarks.getById(bench.id))!.testCaseIds).toEqual(cases.map((c) => c.id));
    expect((await storage.images.getByDigest(imageDigest!))!.lastRunAt).toBe('2026-02-02T00:00:00.000Z');

    // A snapshot naming an id that is not stored is dropped from the link and blocks the image.
    const partial = await performIngestedRunBookkeeping(storage, { benchmarkId: bench.id, testCaseSnapshots: [{ id: cases[0].id, version: 1 }, { id: 'tc-not-stored' }] });
    expect(partial.imageDigest).toBeUndefined();
    expect((await storage.benchmarks.getById(bench.id))!.testCaseIds).toEqual([cases[0].id]);

    // The case was edited (new version) after the executor resolved it: the digest would describe other content → no image.
    await storage.testCases.update(cases[0].id, { initialPrompt: 'edited' } as any);
    const reversioned = await performIngestedRunBookkeeping(storage, { testCaseSnapshots: [{ id: cases[0].id, version: 1 }] });
    expect(reversioned.imageDigest).toBeUndefined();
  });
});
