/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for server/routes/comparison.ts.
 *
 * Iteration 5: the route was converted to an async job pattern (POST
 * returns { jobId } immediately; GET /jobs/:jobId is polled for the
 * result) — see comparisonDeepDiveJobs.integration.test.ts for the
 * job-lifecycle/de-dupe/concurrency-cap coverage. THIS file's unique value
 * is asserting the DETAILED runInputs construction the route builds from
 * each report before handing off to generateComparisonDeepDive() (service
 * name derivation: configured traceServiceName -> protocol-derived ->
 * env-derived -> agentKey-derived fallback chain, and trajectory-derived
 * finalOutput extraction) — still exercised via the mocked generator's call
 * arguments, which are captured synchronously (the job's generator function
 * is invoked before the POST handler responds, even though its RESOLUTION
 * is asynchronous).
 */

const mockLoadConfigSync = jest.fn();
const mockRunsGetById = jest.fn();
const mockGenerateComparisonDeepDive = jest.fn();
const mockDebug = jest.fn();

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: (...args: any[]) => mockLoadConfigSync(...args),
}));

jest.mock('@/server/adapters', () => ({
  getStorageModule: jest.fn(() => ({
    runs: {
      getById: (...args: any[]) => mockRunsGetById(...args),
    },
  })),
}));

jest.mock('@/server/services/comparisonDeepDiveService', () => ({
  generateComparisonDeepDive: (...args: any[]) => mockGenerateComparisonDeepDive(...args),
  SYSTEM_PROMPT: 'MOCK SYSTEM PROMPT',
}));

jest.mock('@/lib/debug', () => ({
  debug: (...args: any[]) => mockDebug(...args),
}));

import express, { Application } from 'express';
const request = require('supertest');
import comparisonRouter from '@/server/routes/comparison';

function makeApp(): Application {
  const app = express();
  // Match the real app's body-size limit (server/middleware/index.ts) so
  // this test's own MAX_ROWS_PAYLOAD_BYTES check (well under 10mb) is what
  // actually rejects an oversized rows payload, not Express's default
  // 100kb json() limit kicking in first with a misleading 413.
  app.use(express.json({ limit: '10mb' }));
  app.use(comparisonRouter);
  return app;
}

/** Let the job store's internal `run().then(...)` microtask settle before polling/asserting on the terminal state. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Comparison routes', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 when reportIds is not exactly two strings', async () => {
    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['only-one'] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'reportIds must be an array of exactly 2 report id strings',
    });
  });

  it('returns 404 when one or more reports are missing', async () => {
    mockRunsGetById
      .mockResolvedValueOnce({ id: 'report-a' })
      .mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-b'] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'report(s) not found: report-b',
    });
  });

  it('builds deep-dive inputs from reports using configured and protocol-derived service names, and returns a jobId immediately', async () => {
    mockLoadConfigSync.mockReturnValue({
      agents: [{ key: 'agent-a', traceServiceName: 'custom-a' }],
    });
    mockRunsGetById.mockImplementation(async (id: string) => ({
      'report-a': {
        id: 'report-a',
        agentKey: 'agent-a',
        agentName: 'Agent A',
        runId: 'run-a',
        timestamp: '2024-01-01T00:00:00.000Z',
        performanceMetrics: { durationMs: 5000 },
        passFailStatus: 'passed',
        metrics: { accuracy: 91 },
        finalOutput: 'Final output A',
        trajectory: [{ type: 'action', toolName: 'search_logs' }],
      },
      'report-b': {
        id: 'report-b',
        agentKey: 'agent-b',
        connectorProtocol: 'pi',
        runId: 'run-b',
        timestamp: '2024-01-01T00:10:00.000Z',
        passFailStatus: 'failed',
        metrics: { accuracy: 12 },
        output: 'Output B',
        trajectory: [{ type: 'action', toolName: 'inspect_metrics' }],
      },
    }[id]));
    mockGenerateComparisonDeepDive.mockResolvedValue({
      markdown: 'analysis',
      modelId: 'judge-1',
      durationMs: 88,
      visitedCases: [
        { key: 'A', caseId: undefined, reportId: 'report-a', runId: 'run-a', serviceName: 'custom-a', startedAt: Date.parse('2024-01-01T00:00:00.000Z') - 65000, endedAt: Date.parse('2024-01-01T00:00:00.000Z') + 65000 },
        { key: 'B', caseId: undefined, reportId: 'report-b', runId: 'run-b', serviceName: 'pi-agent', startedAt: Date.parse('2024-01-01T00:10:00.000Z') - 1800000, endedAt: Date.parse('2024-01-01T00:10:00.000Z') + 1800000 },
      ],
    });

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-b'], modelId: 'judge-1' });

    // Async job pattern (iteration 5): the POST returns a jobId, not the
    // full result, and does so without waiting for the generator to settle.
    expect(res.status).toBe(202);
    expect(typeof res.body.jobId).toBe('string');

    expect(mockGenerateComparisonDeepDive).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'judge-1',
        runs: [
          {
            key: 'A',
            label: 'Agent A',
            reportId: 'report-a',
            runId: 'run-a',
            agents: [{
              serviceName: 'custom-a',
              startedAt: Date.parse('2024-01-01T00:00:00.000Z') - 65000,
              endedAt: Date.parse('2024-01-01T00:00:00.000Z') + 65000,
            }],
            passFailStatus: 'passed',
            accuracy: 91,
            toolNames: ['search_logs'],
            durationMs: 5000,
            finalOutput: 'Final output A',
          },
          {
            key: 'B',
            label: 'agent-b',
            reportId: 'report-b',
            runId: 'run-b',
            agents: [{
              serviceName: 'pi-agent',
              startedAt: Date.parse('2024-01-01T00:10:00.000Z') - 1800000,
              endedAt: Date.parse('2024-01-01T00:10:00.000Z') + 1800000,
            }],
            passFailStatus: 'failed',
            accuracy: 12,
            toolNames: ['inspect_metrics'],
            durationMs: undefined,
            finalOutput: 'Output B',
          },
        ],
      })
    );

    // Poll for the (now-settled) job result — same shape the old synchronous
    // POST used to return directly.
    await flushMicrotasks();
    const pollRes = await request(app).get(`/api/comparison/deep-dive/jobs/${res.body.jobId}`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('done');
    expect(pollRes.body.result).toEqual({
      markdown: 'analysis',
      modelId: 'judge-1',
      durationMs: 88,
      visitedCases: [
        { key: 'A', caseId: undefined, reportId: 'report-a', runId: 'run-a', serviceName: 'custom-a', startedAt: Date.parse('2024-01-01T00:00:00.000Z') - 65000, endedAt: Date.parse('2024-01-01T00:00:00.000Z') + 65000 },
        { key: 'B', caseId: undefined, reportId: 'report-b', runId: 'run-b', serviceName: 'pi-agent', startedAt: Date.parse('2024-01-01T00:10:00.000Z') - 1800000, endedAt: Date.parse('2024-01-01T00:10:00.000Z') + 1800000 },
      ],
      runs: [
        {
          key: 'A',
          caseId: undefined,
          reportId: 'report-a',
          runId: 'run-a',
          serviceName: 'custom-a',
          startedAt: Date.parse('2024-01-01T00:00:00.000Z') - 65000,
          endedAt: Date.parse('2024-01-01T00:00:00.000Z') + 65000,
        },
        {
          key: 'B',
          caseId: undefined,
          reportId: 'report-b',
          runId: 'run-b',
          serviceName: 'pi-agent',
          startedAt: Date.parse('2024-01-01T00:10:00.000Z') - 1800000,
          endedAt: Date.parse('2024-01-01T00:10:00.000Z') + 1800000,
        },
      ],
    });
  });

  it('falls back to env-based and agentKey-derived service names and trajectory-derived final output', async () => {
    mockLoadConfigSync.mockReturnValue({
      agents: [{ key: 'agent-env', connectorConfig: { env: { OTEL_SERVICE_NAME: 'env-service' } } }],
    });
    mockRunsGetById.mockImplementation(async (id: string) => ({
      'report-a': {
        id: 'report-a',
        agentKey: 'agent-env',
        timestamp: '2024-01-01T01:00:00.000Z',
        trajectory: [{ type: 'response', content: 'from trajectory A' }],
      },
      'report-b': {
        id: 'report-b',
        agentKey: 'orphan',
        timestamp: '2024-01-01T02:00:00.000Z',
        trajectory: [{ type: 'assistant', content: 'noise' }, { type: 'response', output: 'from trajectory B' }],
      },
    }[id]));
    mockGenerateComparisonDeepDive.mockResolvedValue({ markdown: 'ok', modelId: 'judge-2', durationMs: 1, visitedCases: [] });

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-b'] });

    expect(res.status).toBe(202);
    expect(mockGenerateComparisonDeepDive).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: undefined,
        runs: [
          expect.objectContaining({
            key: 'A',
            label: 'agent-env',
            agents: [{
              serviceName: 'env-service',
              startedAt: Date.parse('2024-01-01T01:00:00.000Z') - 1800000,
              endedAt: Date.parse('2024-01-01T01:00:00.000Z') + 1800000,
            }],
            finalOutput: 'from trajectory A',
          }),
          expect.objectContaining({
            key: 'B',
            label: 'orphan',
            agents: [{
              serviceName: 'orphan-agent',
              startedAt: Date.parse('2024-01-01T02:00:00.000Z') - 1800000,
              endedAt: Date.parse('2024-01-01T02:00:00.000Z') + 1800000,
            }],
            finalOutput: 'from trajectory B',
          }),
        ],
      })
    );
  });

  it('a generator rejection settles the job in the error state (surfaced via GET, not a synchronous 500 any more)', async () => {
    mockLoadConfigSync.mockReturnValue({ agents: [] });
    mockRunsGetById.mockResolvedValue({ id: 'report-a', timestamp: '2024-01-01T00:00:00.000Z' });
    mockGenerateComparisonDeepDive.mockRejectedValue(new Error('judge unavailable'));

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-a'] });

    // The POST itself still succeeds (202 + jobId) -- the rejection happens
    // inside the background job, not synchronously in the request handler.
    expect(res.status).toBe(202);

    await flushMicrotasks();
    const pollRes = await request(app).get(`/api/comparison/deep-dive/jobs/${res.body.jobId}`);
    expect(pollRes.body.status).toBe('error');
    expect(pollRes.body.error).toBe('judge unavailable');
  });

  it('still returns a synchronous 500 for an error thrown BEFORE job creation (e.g. a storage lookup failure)', async () => {
    mockLoadConfigSync.mockReturnValue({ agents: [] });
    mockRunsGetById.mockRejectedValue(new Error('storage cluster unreachable'));

    const res = await request(app)
      .post('/api/comparison/deep-dive')
      .send({ reportIds: ['report-a', 'report-b'] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'storage cluster unreachable' });
    expect(mockGenerateComparisonDeepDive).not.toHaveBeenCalled();
  });

  describe('rows[] input caps (hardening round, codex review of PR #460)', () => {
    beforeEach(() => {
      mockLoadConfigSync.mockReturnValue({ agents: [] });
      mockRunsGetById.mockResolvedValue({ id: 'report-a', timestamp: '2024-01-01T00:00:00.000Z' });
      mockGenerateComparisonDeepDive.mockResolvedValue({ markdown: 'ok', modelId: 'm', durationMs: 1, visitedCases: [] });
    });

    it('silently drops a row whose testCaseId exceeds the 128-char id cap, without 400ing the request', async () => {
      const oversizedId = 'x'.repeat(129);
      const res = await request(app)
        .post('/api/comparison/deep-dive')
        .send({
          reportIds: ['report-a', 'report-b'],
          rows: [
            { testCaseId: oversizedId, testCaseName: 'Oversized' },
            { testCaseId: 'tc-ok', testCaseName: 'Fine' },
          ],
        });

      expect(res.status).toBe(202);
      const rowsPassed = mockGenerateComparisonDeepDive.mock.calls[0][0].rows;
      expect(rowsPassed).toHaveLength(1);
      expect(rowsPassed[0].testCaseId).toBe('tc-ok');
    });

    it('accepts a testCaseId at exactly the 128-char cap (boundary)', async () => {
      const exactlyAtCap = 'x'.repeat(128);
      const res = await request(app)
        .post('/api/comparison/deep-dive')
        .send({ reportIds: ['report-a', 'report-b'], rows: [{ testCaseId: exactlyAtCap, testCaseName: 'Boundary' }] });

      expect(res.status).toBe(202);
      const rowsPassed = mockGenerateComparisonDeepDive.mock.calls[0][0].rows;
      expect(rowsPassed).toHaveLength(1);
      expect(rowsPassed[0].testCaseId).toBe(exactlyAtCap);
    });

    it('silently drops a row whose SIDE reportId exceeds the 128-char id cap, without 400ing the request', async () => {
      const oversizedReportId = 'r'.repeat(129);
      const res = await request(app)
        .post('/api/comparison/deep-dive')
        .send({
          reportIds: ['report-a', 'report-b'],
          rows: [
            { testCaseId: 'tc-1', testCaseName: 'Bad side', a: { passFailStatus: 'passed', reportId: oversizedReportId } },
            { testCaseId: 'tc-2', testCaseName: 'Fine', a: { passFailStatus: 'passed', reportId: 'rep-ok' } },
          ],
        });

      expect(res.status).toBe(202);
      const rowsPassed = mockGenerateComparisonDeepDive.mock.calls[0][0].rows;
      expect(rowsPassed).toHaveLength(1);
      expect(rowsPassed[0].testCaseId).toBe('tc-2');
    });

    it('truncates an oversized testCaseName to 200 chars rather than dropping the row', async () => {
      const longName = 'y'.repeat(300);
      const res = await request(app)
        .post('/api/comparison/deep-dive')
        .send({ reportIds: ['report-a', 'report-b'], rows: [{ testCaseId: 'tc-1', testCaseName: longName }] });

      expect(res.status).toBe(202);
      const rowsPassed = mockGenerateComparisonDeepDive.mock.calls[0][0].rows;
      expect(rowsPassed).toHaveLength(1);
      expect(rowsPassed[0].testCaseName).toHaveLength(200);
    });

    it('returns 400 when the total serialized rows payload exceeds the 256KB cap, before ever touching storage', async () => {
      // A single row whose testCaseName alone is well past 256KB once serialized.
      const hugeName = 'z'.repeat(300 * 1024);
      const res = await request(app)
        .post('/api/comparison/deep-dive')
        .send({ reportIds: ['report-a', 'report-b'], rows: [{ testCaseId: 'tc-1', testCaseName: hugeName }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/rows payload too large/i);
      expect(mockRunsGetById).not.toHaveBeenCalled();
      expect(mockGenerateComparisonDeepDive).not.toHaveBeenCalled();
    });

    it('accepts a large-but-under-cap rows payload (e.g. 500 rows of realistic names)', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => ({ testCaseId: `tc-${i}`, testCaseName: `A reasonably descriptive test case name ${i}` }));
      const res = await request(app)
        .post('/api/comparison/deep-dive')
        .send({ reportIds: ['report-a', 'report-b'], rows });

      expect(res.status).toBe(202);
      expect(mockGenerateComparisonDeepDive.mock.calls[0][0].rows).toHaveLength(500);
    });
  });
});
