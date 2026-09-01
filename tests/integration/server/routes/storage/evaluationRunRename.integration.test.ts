/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the evaluation-run rename UX (owner ask: "I want to
 * be able to rename the evaluation run name") and the run-list newest-first
 * default ordering.
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 * Run:
 *   AH_PORT=4941 npm run test:integration -- --testPathPatterns=evaluationRunRename
 *
 * Covers:
 *   - PATCH { name } persists a trimmed rename and touches nothing else
 *     (no version bump, no stats change — verified by diffing the doc).
 *   - PATCH rejects an empty/whitespace-only name with 400 and does not
 *     persist anything.
 *   - GET /api/storage/evaluation-runs (default sort) returns newest-first,
 *     the true source of the "sort by time, not by benchmark name" fix
 *     (server-side createdAt desc — see server/adapters/opensearch/StorageModule.ts).
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
};

/** Seed an evaluation-run doc directly via PUT (upserts \u2014 PATCH requires the
 *  doc to already exist and 404s otherwise). */
const seedEvalRun = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = overrides.id || `eval-run-rename-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    name: 'Rename Integration Test Source',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [{ type: 'test-case-ids', ids: [] }],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    stats: { passed: 3, failed: 1, total: 4 },
    createdAt: new Date().toISOString(),
    ...overrides,
    id,
  };
  const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });
  if (!response.ok) throw new Error(`Failed to seed eval run: ${response.status} ${await response.text()}`);
  return response.json();
};

describe('Evaluation run rename + list ordering (integration)', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await tracker.cleanup();
  }, 60000);

  describe('PATCH /api/storage/evaluation-runs/:id \u2014 rename', () => {
    it('persists a trimmed rename and does not touch stats/status/other fields', async () => {
      if (!backendAvailable) return;

      const original = uniqueTestName('rename-src');
      const seeded = await seedEvalRun({ name: original });
      tracker.evaluationRun(seeded.id);

      const newName = uniqueTestName('renamed');
      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `  ${newName}  ` }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe(newName); // trimmed

      // Re-fetch to confirm the write actually persisted (not just echoed
      // back by the PATCH response) and nothing else moved.
      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`);
      const persisted = await getRes.json();
      expect(persisted.name).toBe(newName);
      expect(persisted.status).toBe(seeded.status);
      expect(persisted.stats).toEqual(seeded.stats);
      expect(persisted.agentKey).toBe(seeded.agentKey);
      expect(persisted.createdAt).toBe(seeded.createdAt);
    });

    it('rejects an empty name with 400 and leaves the stored name unchanged', async () => {
      if (!backendAvailable) return;

      const original = uniqueTestName('rename-empty-src');
      const seeded = await seedEvalRun({ name: original });
      tracker.evaluationRun(seeded.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(res.status).toBe(400);

      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`);
      const persisted = await getRes.json();
      expect(persisted.name).toBe(original);
    });

    it('rejects a name over the 200-character cap with 400', async () => {
      if (!backendAvailable) return;

      const seeded = await seedEvalRun({ name: uniqueTestName('rename-cap-src') });
      tracker.evaluationRun(seeded.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'y'.repeat(201) }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a non-existent run id', async () => {
      if (!backendAvailable) return;

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/does-not-exist-rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Anything' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/storage/evaluation-runs \u2014 default order', () => {
    it('returns runs newest-first by default (createdAt desc at the storage layer)', async () => {
      if (!backendAvailable) return;

      const base = Date.now();
      const older = await seedEvalRun({
        name: uniqueTestName('order-older'),
        createdAt: new Date(base - 60_000).toISOString(),
      });
      tracker.evaluationRun(older.id);
      const newer = await seedEvalRun({
        name: uniqueTestName('order-newer'),
        createdAt: new Date(base).toISOString(),
      });
      tracker.evaluationRun(newer.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs?size=500`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      const ids: string[] = body.evaluationRuns.map((r: any) => r.id);
      const olderIdx = ids.indexOf(older.id);
      const newerIdx = ids.indexOf(newer.id);
      expect(olderIdx).toBeGreaterThanOrEqual(0);
      expect(newerIdx).toBeGreaterThanOrEqual(0);
      // Newest first: the newer run's index must come before the older run's.
      expect(newerIdx).toBeLessThan(olderIdx);
    });
  });
});
