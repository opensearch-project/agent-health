/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Route-level integration test for the async deep-dive job pattern
 * (iteration 5) \u2014 mounts the REAL server/routes/comparison.ts router
 * in-process (express + supertest) with the underlying
 * generateComparisonDeepDive() + storage lookup mocked at the service
 * boundary, exactly like tests/integration/server/routes/assistant.integration.test.ts
 * does for the SSE route. No LLM/AWS creds, no running dev server required.
 *
 * Covers what a purely network-level integration test (hitting an
 * already-running backend, see comparisonDeepDive.integration.test.ts)
 * cannot: controlling exactly when the "generation" itself settles, so we
 * can assert the job's running/done/error states, the de-dupe behavior, and
 * the concurrency cap \u2014 all deterministically, without a real model call.
 */

import express from 'express';
import request from 'supertest';

const mockGetById = jest.fn();
jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({ runs: { getById: (...a: any[]) => mockGetById(...a) } }),
}));

const mockGenerate = jest.fn();
jest.mock('@/server/services/comparisonDeepDiveService', () => ({
  generateComparisonDeepDive: (...a: any[]) => mockGenerate(...a),
  SYSTEM_PROMPT: 'MOCK SYSTEM PROMPT',
}));

jest.mock('@/server/services/comparisonCaseResolver', () => ({
  resolveReportTraceContext: () => ({ runId: undefined, agents: [] }),
  extractToolNames: () => [],
  extractFinalOutput: () => undefined,
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

function buildApp() {
  jest.resetModules();
  // Re-require AFTER resetModules so the route module's job-store singleton
  // is fresh per test \u2014 the concurrency cap and de-dupe map must not leak
  // running jobs across unrelated tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('@/server/routes/comparison').default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

/** A report shape sufficient for the route's default-case resolution. */
function report(id: string, testCaseId: string) {
  return { id, testCaseId, agentKey: 'demo', passFailStatus: 'passed', metrics: { accuracy: 90 } };
}

/** Resolves/rejects on demand \u2014 lets a test control exactly when the "generation" finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockGetById.mockReset();
  mockGenerate.mockReset();
});

describe('POST /api/comparison/deep-dive \u2014 async job pattern', () => {
  it('validates synchronously (400) BEFORE ever touching storage or the generator', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['only-one'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly 2/);
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('404s synchronously when a report does not exist \u2014 before any job is created', async () => {
    mockGetById.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-missing-a', 'rep-missing-b'] });

    expect(res.status).toBe(404);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns { jobId } (202) WITHOUT waiting for the generator to settle \u2014 the whole point of the async-job conversion', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    const d = deferred<any>();
    mockGenerate.mockImplementation(() => d.promise); // never resolves during this test

    const app = buildApp();
    const res = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });

    expect(res.status).toBe(202);
    expect(typeof res.body.jobId).toBe('string');
    expect(res.body.jobId.length).toBeGreaterThan(0);
    // The generator WAS invoked (job started)...
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    // ...but the POST already returned despite it never having resolved.
  });
});

describe('GET /api/comparison/deep-dive/jobs/:jobId', () => {
  it('404s for an unknown jobId', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/comparison/deep-dive/jobs/never-existed');
    expect(res.status).toBe(404);
  });

  it('reports "running" with an elapsedMs while the generator has not settled yet', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    const d = deferred<any>();
    mockGenerate.mockImplementation(() => d.promise);

    const app = buildApp();
    const postRes = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });
    const { jobId } = postRes.body;

    const pollRes = await request(app).get(`/api/comparison/deep-dive/jobs/${jobId}`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('running');
    expect(typeof pollRes.body.elapsedMs).toBe('number');
    expect(pollRes.body.result).toBeUndefined();
  });

  it('reaches "done" with the SAME result shape the old synchronous POST used to return directly', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    const d = deferred<any>();
    mockGenerate.mockImplementation(() => d.promise);

    const app = buildApp();
    const postRes = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });
    const { jobId } = postRes.body;

    d.resolve({
      markdown: '**A wins on RCA cases**',
      modelId: 'amazon-bedrock/claude-opus-4-8',
      durationMs: 4200,
      visitedCases: [
        { key: 'A', caseId: 'tc-1', reportId: 'rep-a', runId: 'run-a', serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
      ],
    });
    // Give the job store's .then() microtask a turn.
    await Promise.resolve();
    await Promise.resolve();

    const pollRes = await request(app).get(`/api/comparison/deep-dive/jobs/${jobId}`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('done');
    expect(pollRes.body.result.markdown).toBe('**A wins on RCA cases**');
    expect(pollRes.body.result.modelId).toBe('amazon-bedrock/claude-opus-4-8');
    // runs[] meta derived from visitedCases, same shape client has always rendered.
    expect(pollRes.body.result.runs).toEqual([
      { key: 'A', caseId: 'tc-1', reportId: 'rep-a', runId: 'run-a', serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
    ]);
  });

  it('reaches "error" with the generator\'s rejection message when it rejects', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    const d = deferred<any>();
    mockGenerate.mockImplementation(() => d.promise);

    const app = buildApp();
    const postRes = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });
    const { jobId } = postRes.body;

    d.reject(new Error('Comparison deep-dive timed out after 180s'));
    await Promise.resolve();
    await Promise.resolve();

    const pollRes = await request(app).get(`/api/comparison/deep-dive/jobs/${jobId}`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('error');
    expect(pollRes.body.error).toBe('Comparison deep-dive timed out after 180s');
    expect(pollRes.body.result).toBeUndefined();
  });
});

describe('POST /api/comparison/deep-dive \u2014 de-dupe onto an existing running job', () => {
  it('a second POST for the SAME report pair while the first is still running returns the SAME jobId and does not re-invoke the generator', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    const d = deferred<any>();
    mockGenerate.mockImplementation(() => d.promise);

    const app = buildApp();
    const first = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });
    const second = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });

    expect(second.status).toBe(202);
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('report order does not matter for de-dupe (A,B and B,A are the same pair)', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    const d = deferred<any>();
    mockGenerate.mockImplementation(() => d.promise);

    const app = buildApp();
    const first = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });
    const second = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-b', 'rep-a'] });

    expect(second.body.jobId).toBe(first.body.jobId);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT systemPrompt for the same report pair starts its OWN job (not deduped)', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    mockGenerate.mockImplementation(() => deferred<any>().promise);

    const app = buildApp();
    const first = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'], systemPrompt: 'focus on token usage' });
    const second = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'], systemPrompt: 'focus on latency' });

    expect(second.body.jobId).not.toBe(first.body.jobId);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('once the job for a report pair completes, a later POST for the same pair starts a genuinely new job', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, 'tc-1'));
    const d1 = deferred<any>();
    mockGenerate.mockImplementationOnce(() => d1.promise);

    const app = buildApp();
    const first = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });
    d1.resolve({ markdown: 'first', modelId: 'm', durationMs: 1, visitedCases: [] });
    await Promise.resolve();
    await Promise.resolve();

    mockGenerate.mockImplementationOnce(() => deferred<any>().promise);
    const second = await request(app).post('/api/comparison/deep-dive').send({ reportIds: ['rep-a', 'rep-b'] });

    expect(second.body.jobId).not.toBe(first.body.jobId);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/comparison/deep-dive \u2014 concurrency cap (429)', () => {
  it('rejects a genuinely NEW report pair with 429 once 3 jobs are already running', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, id));
    mockGenerate.mockImplementation(() => deferred<any>().promise); // every job stays "running"

    const app = buildApp();
    const post = (a: string, b: string) => request(app).post('/api/comparison/deep-dive').send({ reportIds: [a, b] });

    const r1 = await post('rep-1a', 'rep-1b');
    const r2 = await post('rep-2a', 'rep-2b');
    const r3 = await post('rep-3a', 'rep-3b');
    expect([r1.status, r2.status, r3.status]).toEqual([202, 202, 202]);

    const r4 = await post('rep-4a', 'rep-4b');
    expect(r4.status).toBe(429);
    expect(r4.body.error).toMatch(/too many/i);
  });

  it('a DEDUPED request for an already-running pair is never blocked by the cap, even when at capacity', async () => {
    mockGetById.mockImplementation(async (id: string) => report(id, id));
    mockGenerate.mockImplementation(() => deferred<any>().promise);

    const app = buildApp();
    const post = (a: string, b: string) => request(app).post('/api/comparison/deep-dive').send({ reportIds: [a, b] });

    await post('rep-1a', 'rep-1b');
    await post('rep-2a', 'rep-2b');
    const third = await post('rep-3a', 'rep-3b');
    expect(third.status).toBe(202);

    // Re-POST the SAME pair as job #3 -- dedupes, must NOT 429 even though
    // the store is at its 3-job cap.
    const dedupedRepeat = await post('rep-3a', 'rep-3b');
    expect(dedupedRepeat.status).toBe(202);
    expect(dedupedRepeat.body.jobId).toBe(third.body.jobId);
  });
});
