/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects for storage types
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { runStorage as opensearchRuns } from '@/services/storage/opensearchClient';
import type { EvaluationReport, TrajectoryStep } from '@/types';

// Mock the OpenSearch client
jest.mock('@/services/storage/opensearchClient', () => ({
  runStorage: {
    create: jest.fn(),
    getByTestCase: jest.fn(),
    getAll: jest.fn(),
    getById: jest.fn(),
    getByIds: jest.fn(),
    delete: jest.fn(),
    partialUpdate: jest.fn(),
    count: jest.fn(),
    search: jest.fn(),
    addAnnotation: jest.fn(),
    updateAnnotation: jest.fn(),
    deleteAnnotation: jest.fn(),
    getByBenchmarkRun: jest.fn(),
    getByBenchmark: jest.fn(),
    getIterations: jest.fn(),
    bulkCreate: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

const mockOsRuns = opensearchRuns as jest.Mocked<typeof opensearchRuns>;

describe('AsyncRunStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a mock storage run
  const createMockStorageRun = (id: string = 'run-1') => ({
    id,
    createdAt: '2024-01-01T00:00:00Z',
    testCaseId: 'tc-1',
    testCaseVersionId: 'tc-1-v1',
    experimentId: '',
    experimentRunId: '',
    agentId: 'test-agent',
    modelId: 'test-model',
    iteration: 1,
    status: 'completed' as const,
    passFailStatus: 'passed' as const,
    traceId: 'trace-1',
    tags: [],
    actualOutcomes: [],
    llmJudgeReasoning: 'Good performance',
    metrics: {
      accuracy: 0.95,
      faithfulness: 0.9,
      latency_score: 0.85,
      trajectory_alignment_score: 0.88,
    },
    trajectory: [
      { type: 'action', content: 'Test action' },
    ] as TrajectoryStep[],
    annotations: [],
  });

  // Helper to create a mock evaluation report
  const createMockReport = (id: string = 'report-1'): EvaluationReport => ({
    id,
    testCaseId: 'tc-1',
    testCaseVersion: 1,
    agentKey: 'test-agent',
    modelId: 'test-model',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'trace-1',
    llmJudgeReasoning: 'Good performance',
    metrics: {
      accuracy: 0.95,
      faithfulness: 0.9,
      latency_score: 0.85,
      trajectory_alignment_score: 0.88,
    },
    trajectory: [
      { type: 'action', content: 'Test action' },
    ] as TrajectoryStep[],
    evaluatedAt: '2024-01-01T00:00:00Z',
  });

  describe('saveReport', () => {
    it('saves a report and returns the created document', async () => {
      const mockStorageRun = createMockStorageRun('new-run-1');
      mockOsRuns.create.mockResolvedValue(mockStorageRun);

      const report = createMockReport('new-report-1');
      const result = await asyncRunStorage.saveReport(report);

      expect(mockOsRuns.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('new-run-1');
      expect(result.testCaseId).toBe('tc-1');
      expect(result.status).toBe('completed');
    });

    it('includes experiment context when provided', async () => {
      const mockStorageRun = createMockStorageRun('run-exp');
      mockOsRuns.create.mockResolvedValue(mockStorageRun);

      const report = createMockReport();
      await asyncRunStorage.saveReport(report, {
        experimentId: 'exp-1',
        experimentRunId: 'exp-run-1',
        iteration: 3,
      });

      expect(mockOsRuns.create).toHaveBeenCalledWith(
        expect.objectContaining({
          experimentId: 'exp-1',
          experimentRunId: 'exp-run-1',
          iteration: 3,
        })
      );
    });

    it('persists sessionId (Strategy D) through toStorageFormat (#313)', async () => {
      mockOsRuns.create.mockResolvedValue(createMockStorageRun('run-sd'));
      const report = createMockReport();
      (report as any).sessionId = 'sess-roundtrip';
      await asyncRunStorage.saveReport(report);
      expect(mockOsRuns.create).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-roundtrip' })
      );
    });

    it('persists verdict, timing, identity, and trace metadata on create', async () => {
      mockOsRuns.create.mockResolvedValue(createMockStorageRun('run-rich'));
      const report = {
        ...createMockReport(),
        agentName: 'Friendly agent',
        agentEndpoint: 'http://agent.example',
        judgeModelId: 'judge-model',
        evaluatorId: 'custom-evaluator',
        traceStatus: 'not_configured' as const,
        performanceMetrics: { durationMs: 42, agentDurationMs: 30 },
        llmJudgeResponse: {
          modelId: 'judge-model',
          timestamp: '2024-01-01T00:00:00Z',
          promptTokens: 10,
          completionTokens: 5,
          latencyMs: 12,
          rawResponse: '{}',
        },
      };

      await asyncRunStorage.saveReport(report);

      expect(mockOsRuns.create).toHaveBeenCalledWith(expect.objectContaining({
        agentName: 'Friendly agent',
        agentId: 'test-agent',
        agentEndpoint: 'http://agent.example',
        judgeModelId: 'judge-model',
        evaluatorId: 'custom-evaluator',
        traceStatus: 'not_configured',
        performanceMetrics: report.performanceMetrics,
        llmJudgeResponse: report.llmJudgeResponse,
      }));
    });
  });

  describe('getReportsByTestCase', () => {
    it('returns reports and total for a test case', async () => {
      const mockRuns = [createMockStorageRun('run-1'), createMockStorageRun('run-2')];
      mockOsRuns.getByTestCase.mockResolvedValue({ runs: mockRuns, total: 2 });

      const result = await asyncRunStorage.getReportsByTestCase('tc-1');

      expect(mockOsRuns.getByTestCase).toHaveBeenCalledWith('tc-1', 100, 0);
      expect(result.reports).toHaveLength(2);
      expect(result.reports[0].id).toBe('run-1');
      expect(result.reports[1].id).toBe('run-2');
      expect(result.total).toBe(2);
    });

    it('respects limit option', async () => {
      mockOsRuns.getByTestCase.mockResolvedValue({ runs: [], total: 0 });

      await asyncRunStorage.getReportsByTestCase('tc-1', { limit: 50 });

      expect(mockOsRuns.getByTestCase).toHaveBeenCalledWith('tc-1', 50, 0);
    });

    // The runs list on the Test Case detail page reads runs through this
    // method; if `name` / `description` / `evaluatorId` aren't carried
    // through `toTestCaseRun`, the page renders every row with the
    // generated `Run <short-id>` fallback even when the user supplied a
    // custom name in the Configure Run dialog. These three fields are the
    // ones the *Configure Run* form lets the user fill in, so they're the
    // ones that have to round-trip cleanly.
    it('preserves name, description, and evaluatorId from the stored run', async () => {
      const stored = {
        ...createMockStorageRun('run-named-1'),
        name: 'Baseline',
        description: 'Smoke test of the v2 prompt',
        evaluatorId: 'system-rca',
      };
      mockOsRuns.getByTestCase.mockResolvedValue({ runs: [stored as any], total: 1 });

      const result = await asyncRunStorage.getReportsByTestCase('tc-1');

      expect(result.reports[0].name).toBe('Baseline');
      expect(result.reports[0].description).toBe('Smoke test of the v2 prompt');
      expect(result.reports[0].evaluatorId).toBe('system-rca');
    });

    it('leaves name/description undefined for legacy runs that pre-date the fields', async () => {
      // Older stored runs simply don't have these keys — the read mapper
      // must not invent values; the UI's `getRunDisplayName` fallback
      // handles the missing-name case by synthesising `Run <short-id>`.
      const stored = createMockStorageRun('run-legacy-1');
      mockOsRuns.getByTestCase.mockResolvedValue({ runs: [stored], total: 1 });

      const result = await asyncRunStorage.getReportsByTestCase('tc-1');

      expect(result.reports[0].name).toBeUndefined();
      expect(result.reports[0].description).toBeUndefined();
    });

    it('passes offset to opensearch client', async () => {
      mockOsRuns.getByTestCase.mockResolvedValue({ runs: [], total: 150 });

      const result = await asyncRunStorage.getReportsByTestCase('tc-1', { limit: 100, offset: 100 });

      expect(mockOsRuns.getByTestCase).toHaveBeenCalledWith('tc-1', 100, 100);
      expect(result.total).toBe(150);
    });
  });

  describe('getAllReports', () => {
    it('returns all reports with default pagination', async () => {
      const mockRuns = [createMockStorageRun('run-1')];
      mockOsRuns.getAll.mockResolvedValue({ runs: mockRuns, total: 1 });

      const result = await asyncRunStorage.getAllReports();

      expect(mockOsRuns.getAll).toHaveBeenCalledWith({ size: 100, from: 0 });
      expect(result).toHaveLength(1);
    });

    it('respects pagination options', async () => {
      mockOsRuns.getAll.mockResolvedValue({ runs: [], total: 0 });

      await asyncRunStorage.getAllReports({ limit: 50, offset: 10 });

      expect(mockOsRuns.getAll).toHaveBeenCalledWith({ size: 50, from: 10 });
    });
  });

  describe('getReportById', () => {
    it('returns a report when found', async () => {
      const mockRun = createMockStorageRun('run-1');
      mockOsRuns.getById.mockResolvedValue(mockRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(mockOsRuns.getById).toHaveBeenCalledWith('run-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('run-1');
    });

    it('maps file-backed timestamp and report-page fields without dropping them (#407)', async () => {
      const stored = {
        ...createMockStorageRun('file-report'),
        createdAt: undefined,
        timestamp: '2026-08-24T22:42:33.122Z',
        testCaseVersion: 2,
        modelId: undefined,
        modelName: 'file-model',
        logs: undefined,
        openSearchLogs: [{ timestamp: '2026-08-24T22:42:33.122Z', message: 'file log' }],
        annotations: [{
          id: 'ann-file',
          text: 'file annotation',
          timestamp: '2026-08-24T22:43:00.000Z',
        }],
        performanceMetrics: {
          durationMs: 166254,
          agentDurationMs: 97091,
          judgeDurationMs: 69162,
          judgeAttempts: 1,
        },
        llmJudgeResponse: {
          modelId: 'judge-model',
          timestamp: '2026-08-24T22:42:33.122Z',
          promptTokens: 123,
          completionTokens: 45,
          latencyMs: 69162,
          rawResponse: '{"pass_fail_status":"passed"}',
          parsedMetrics: { accuracy: 100 },
        },
        matcherResults: [{
          description: 'judge: expected outcomes',
          method: 'llm-judge',
          pass: true,
          score: 1,
        }],
        traceStatus: 'not_configured',
      } as any;
      mockOsRuns.getById.mockResolvedValue(stored);

      const result = await asyncRunStorage.getReportById('file-report');

      expect(result?.timestamp).toBe('2026-08-24T22:42:33.122Z');
      expect(Number.isNaN(Date.parse(result!.timestamp))).toBe(false);
      expect(result?.testCaseVersion).toBe(2);
      expect(result?.modelName).toBe('file-model');
      expect(result?.modelId).toBe('file-model');
      expect(result?.logs).toEqual(stored.openSearchLogs);
      expect(result?.annotations?.[0].timestamp).toBe('2026-08-24T22:43:00.000Z');
      expect(result?.performanceMetrics).toEqual(stored.performanceMetrics);
      expect(result?.llmJudgeResponse).toEqual(stored.llmJudgeResponse);
      expect(result?.matcherResults).toEqual(stored.matcherResults);
      expect(result?.traceStatus).toBe('not_configured');
    });

    it('reads back sessionId from storage for Strategy D (#313)', async () => {
      const mockRun = { ...createMockStorageRun('run-1'), sessionId: 'sess-read' } as any;
      mockOsRuns.getById.mockResolvedValue(mockRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(result?.sessionId).toBe('sess-read');
    });

    it('maps judgeModelId from storage so recovery judges with the configured model', async () => {
      const mockRun = { ...createMockStorageRun('run-1'), judgeModelId: 'claude-sonnet-4-6' } as any;
      mockOsRuns.getById.mockResolvedValue(mockRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(result?.judgeModelId).toBe('claude-sonnet-4-6');
    });

    it('returns null when not found', async () => {
      mockOsRuns.getById.mockResolvedValue(null);

      const result = await asyncRunStorage.getReportById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getReportsByIds', () => {
    it('returns an empty map for no ids without hitting the API', async () => {
      const result = await asyncRunStorage.getReportsByIds([]);
      expect(result).toEqual({});
      expect(mockOsRuns.getByIds).not.toHaveBeenCalled();
    });

    it('issues a single request and maps results by id for a small id list', async () => {
      mockOsRuns.getByIds.mockResolvedValue([
        createMockStorageRun('r-1'),
        createMockStorageRun('r-2'),
      ]);

      const result = await asyncRunStorage.getReportsByIds(['r-1', 'r-2']);

      expect(mockOsRuns.getByIds).toHaveBeenCalledTimes(1);
      expect(mockOsRuns.getByIds).toHaveBeenCalledWith(['r-1', 'r-2']);
      expect(Object.keys(result)).toEqual(['r-1', 'r-2']);
    });

    // Regression guard for the comparison-page 431 ("Request Header Fields
    // Too Large"): a single unchunked GET /api/storage/runs?ids=<all> blew
    // past the server's URL/header size limit once ids climbed into the
    // thousands (4 runs x 400 reports = 1600 ids). Chunking must kick in
    // well before that.
    it('chunks large id lists into batches of 100 issued in parallel', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `r-${i}`);
      mockOsRuns.getByIds.mockImplementation(async (chunk: string[]) =>
        chunk.map(id => createMockStorageRun(id))
      );

      const result = await asyncRunStorage.getReportsByIds(ids);

      expect(mockOsRuns.getByIds).toHaveBeenCalledTimes(3);
      expect(mockOsRuns.getByIds.mock.calls[0][0]).toHaveLength(100);
      expect(mockOsRuns.getByIds.mock.calls[1][0]).toHaveLength(100);
      expect(mockOsRuns.getByIds.mock.calls[2][0]).toHaveLength(50);
      // Every id present, order-independent, nothing dropped or duplicated
      // across chunk boundaries.
      expect(Object.keys(result).sort()).toEqual([...ids].sort());
      ids.forEach(id => expect(result[id]).toBeDefined());
    });

    // A very large comparison (many runs x a large benchmark) can produce far
    // more than a handful of chunks. Fan-out must stay capped — firing all
    // chunks at once would turn a single oversized request into an unbounded
    // burst of parallel ones, just moving the stampede risk elsewhere.
    it('never runs more than a modest number of chunk requests concurrently', async () => {
      const ids = Array.from({ length: 1600 }, (_, i) => `r-${i}`); // 16 chunks of 100
      let inFlight = 0;
      let maxInFlight = 0;
      mockOsRuns.getByIds.mockImplementation(async (chunk: string[]) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 0));
        inFlight--;
        return chunk.map(id => createMockStorageRun(id));
      });

      await asyncRunStorage.getReportsByIds(ids);

      expect(mockOsRuns.getByIds).toHaveBeenCalledTimes(16);
      expect(maxInFlight).toBeGreaterThan(0);
      expect(maxInFlight).toBeLessThanOrEqual(8);
    });

    // A URL-length regression guard: at CHUNK_SIZE=100, even a 1600-id
    // request (the exact 4-run x 400-report shape that triggered the 431)
    // never issues a single request whose id list could blow the header
    // limit — each individual chunk's joined-id query string stays tiny.
    it('keeps each individual chunk small enough to stay well under URL/header size limits', async () => {
      const ids = Array.from({ length: 1600 }, (_, i) => `report-id-${i}`);
      mockOsRuns.getByIds.mockResolvedValue([]);

      await asyncRunStorage.getReportsByIds(ids);

      expect(mockOsRuns.getByIds).toHaveBeenCalledTimes(16);
      for (const call of mockOsRuns.getByIds.mock.calls) {
        const [chunk] = call;
        expect(chunk.length).toBeLessThanOrEqual(100);
        // Rough proxy for the eventual `ids=<comma-joined>` query param length.
        expect(chunk.join(',').length).toBeLessThan(1600);
      }
    });

    it('merges results from every chunk, preserving all ids regardless of chunk order of resolution', async () => {
      let resolveFirst!: (v: unknown) => void;
      const firstPending = new Promise(resolve => { resolveFirst = resolve; });
      mockOsRuns.getByIds.mockImplementationOnce(() => firstPending as any)
        .mockImplementationOnce(async () => [createMockStorageRun('r-101')]);

      const ids = [...Array.from({ length: 100 }, (_, i) => `r-${i}`), 'r-101'];
      const pending = asyncRunStorage.getReportsByIds(ids);

      // Resolve the second (faster) chunk's underlying promise first to
      // prove ordering of resolution doesn't drop or misplace results.
      await Promise.resolve();
      resolveFirst([createMockStorageRun('r-0')]);

      const result = await pending;
      expect(result['r-0']).toBeDefined();
      expect(result['r-101']).toBeDefined();
    });

    // A genuinely failed chunk must propagate, not be swallowed into a
    // partial/empty result that the UI would render as "Not run" for every
    // cell (the exact pre-fix masking symptom).
    it('propagates a chunk failure instead of swallowing it', async () => {
      mockOsRuns.getByIds.mockRejectedValue(new Error('431 Request Header Fields Too Large'));

      await expect(asyncRunStorage.getReportsByIds(['r-1'])).rejects.toThrow(
        '431 Request Header Fields Too Large'
      );
    });
  });

  describe('getReportSummariesByIds', () => {
    it('returns an empty map for no ids without hitting the API', async () => {
      const result = await asyncRunStorage.getReportSummariesByIds([]);
      expect(result).toEqual({});
      expect(mockOsRuns.getByIds).not.toHaveBeenCalled();
    });

    it('requests only lightweight status fields and maps traceId → runId', async () => {
      mockOsRuns.getByIds.mockResolvedValue([
        { id: 'r-1', status: 'completed', passFailStatus: 'passed', metricsStatus: 'ready', traceId: 'otel-1', createdAt: '2024-01-01T00:00:00Z' },
      ]);

      const result = await asyncRunStorage.getReportSummariesByIds(['r-1']);

      expect(mockOsRuns.getByIds).toHaveBeenCalledTimes(1);
      const [ids, options] = mockOsRuns.getByIds.mock.calls[0];
      expect(ids).toEqual(['r-1']);
      expect(options.fields).toEqual(expect.arrayContaining(['status', 'passFailStatus', 'metricsStatus', 'traceId', 'annotations']));
      expect(result['r-1'].passFailStatus).toBe('passed');
      expect(result['r-1'].metricsStatus).toBe('ready');
      expect(result['r-1'].runId).toBe('otel-1');
    });

    it('chunks large id lists into batches of 100', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `r-${i}`);
      mockOsRuns.getByIds.mockResolvedValue([]);

      await asyncRunStorage.getReportSummariesByIds(ids);

      expect(mockOsRuns.getByIds).toHaveBeenCalledTimes(3);
      expect(mockOsRuns.getByIds.mock.calls[0][0]).toHaveLength(100);
      expect(mockOsRuns.getByIds.mock.calls[1][0]).toHaveLength(100);
      expect(mockOsRuns.getByIds.mock.calls[2][0]).toHaveLength(50);
    });
  });

  describe('deleteReport', () => {
    it('returns true when deletion succeeds', async () => {
      mockOsRuns.delete.mockResolvedValue({ deleted: true });

      const result = await asyncRunStorage.deleteReport('run-1');

      expect(mockOsRuns.delete).toHaveBeenCalledWith('run-1');
      expect(result).toBe(true);
    });

    it('returns false when deletion fails', async () => {
      mockOsRuns.delete.mockResolvedValue({ deleted: false });

      const result = await asyncRunStorage.deleteReport('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('updateReport', () => {
    it('updates a report with new values', async () => {
      const mockUpdated = {
        ...createMockStorageRun('run-1'),
        status: 'completed' as const,
        passFailStatus: 'failed' as const,
      };
      mockOsRuns.partialUpdate.mockResolvedValue(mockUpdated);

      const result = await asyncRunStorage.updateReport('run-1', {
        status: 'completed',
        passFailStatus: 'failed',
      });

      expect(mockOsRuns.partialUpdate).toHaveBeenCalledWith('run-1', expect.objectContaining({
        status: 'completed',
        passFailStatus: 'failed',
      }));
      expect(result?.passFailStatus).toBe('failed');
    });

    it('updates trace-mode fields', async () => {
      const mockUpdated = createMockStorageRun('run-1');
      mockOsRuns.partialUpdate.mockResolvedValue({
        ...mockUpdated,
        metricsStatus: 'ready',
        traceFetchAttempts: 5,
      });

      await asyncRunStorage.updateReport('run-1', {
        metricsStatus: 'ready',
        traceFetchAttempts: 5,
      });

      expect(mockOsRuns.partialUpdate).toHaveBeenCalledWith('run-1', expect.objectContaining({
        metricsStatus: 'ready',
        traceFetchAttempts: 5,
      }));
    });

    it('preserves dynamic metrics and report-page fields on update', async () => {
      const mockUpdated = createMockStorageRun('run-1');
      mockOsRuns.partialUpdate.mockResolvedValue(mockUpdated);
      const matcherResults = [{ description: 'judge', method: 'llm-judge', pass: true }];
      const llmJudgeResponse = {
        modelId: 'judge-model',
        timestamp: '2024-01-01T00:00:00Z',
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 12,
        rawResponse: '{}',
      };
      const performanceMetrics = { durationMs: 42, judgeDurationMs: 12 };

      await asyncRunStorage.updateReport('run-1', {
        metrics: {
          accuracy: 0.98,
          custom_rubric_score: 73,
        },
        matcherResults,
        llmJudgeResponse,
        performanceMetrics,
        traceStatus: 'unavailable',
      } as any);

      expect(mockOsRuns.partialUpdate).toHaveBeenCalledWith('run-1', expect.objectContaining({
        metrics: {
          accuracy: 0.98,
          custom_rubric_score: 73,
        },
        matcherResults,
        llmJudgeResponse,
        performanceMetrics,
        traceStatus: 'unavailable',
      }));
    });
  });

  describe('format conversion', () => {
    it('converts storage format to app format correctly', async () => {
      const mockStorageRun = {
        ...createMockStorageRun('run-1'),
        annotations: [
          {
            id: 'ann-1',
            text: 'Test annotation',
            createdAt: '2024-01-01T12:00:00Z',
            tags: ['tag1'],
            author: 'user1',
          },
        ],
      };
      mockOsRuns.getById.mockResolvedValue(mockStorageRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(result).toMatchObject({
        id: 'run-1',
        testCaseId: 'tc-1',
        testCaseVersion: 1,
        agentKey: 'test-agent',
        modelId: 'test-model',
        status: 'completed',
        passFailStatus: 'passed',
        runId: 'trace-1',
        annotations: expect.arrayContaining([
          expect.objectContaining({
            id: 'ann-1',
            text: 'Test annotation',
            tags: ['tag1'],
          }),
        ]),
      });
    });

    it('handles trace-mode fields in conversion', async () => {
      const mockStorageRun = {
        ...createMockStorageRun('run-1'),
        metricsStatus: 'ready',
        traceFetchAttempts: 3,
        lastTraceFetchAt: '2024-01-01T12:00:00Z',
        traceError: undefined,
        spans: [{ spanId: 'span-1' }],
      };
      mockOsRuns.getById.mockResolvedValue(mockStorageRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(result).toMatchObject({
        metricsStatus: 'ready',
        traceFetchAttempts: 3,
        lastTraceFetchAt: '2024-01-01T12:00:00Z',
        spans: [{ spanId: 'span-1' }],
      });
    });
  });

  describe('getReportCount', () => {
    it('returns total count of reports', async () => {
      mockOsRuns.getAll.mockResolvedValue({ runs: [], total: 42 });

      const result = await asyncRunStorage.getReportCount();

      expect(mockOsRuns.getAll).toHaveBeenCalledWith({ size: 0 });
      expect(result).toBe(42);
    });
  });

  describe('getReportCountByTestCase', () => {
    it('returns count for a specific test case', async () => {
      mockOsRuns.getByTestCase.mockResolvedValue({ runs: [], total: 42 });

      const result = await asyncRunStorage.getReportCountByTestCase('tc-1');

      expect(mockOsRuns.getByTestCase).toHaveBeenCalledWith('tc-1', 0);
      expect(result).toBe(42);
    });
  });

  describe('getByBenchmark', () => {
    it('returns runs for an experiment', async () => {
      const mockRuns = [createMockStorageRun('run-1'), createMockStorageRun('run-2')];
      mockOsRuns.getByBenchmark.mockResolvedValue(mockRuns);

      const result = await asyncRunStorage.getByExperiment('exp-1');

      expect(mockOsRuns.getByBenchmark).toHaveBeenCalledWith('exp-1', undefined);
      expect(result).toHaveLength(2);
    });

    it('respects size option', async () => {
      mockOsRuns.getByBenchmark.mockResolvedValue([]);

      await asyncRunStorage.getByExperiment('exp-1', 50);

      expect(mockOsRuns.getByBenchmark).toHaveBeenCalledWith('exp-1', 50);
    });
  });

  describe('getByBenchmarkRun', () => {
    it('returns runs for a specific experiment run', async () => {
      const mockRuns = [createMockStorageRun('run-1')];
      mockOsRuns.getByBenchmarkRun.mockResolvedValue(mockRuns);

      const result = await asyncRunStorage.getByBenchmarkRun('exp-1', 'run-1');

      expect(mockOsRuns.getByBenchmarkRun).toHaveBeenCalledWith('exp-1', 'run-1', undefined);
      expect(result).toHaveLength(1);
    });

    it('respects size option', async () => {
      mockOsRuns.getByBenchmarkRun.mockResolvedValue([]);

      await asyncRunStorage.getByBenchmarkRun('exp-1', 'run-1', 25);

      expect(mockOsRuns.getByBenchmarkRun).toHaveBeenCalledWith('exp-1', 'run-1', 25);
    });
  });

  describe('getIterations', () => {
    it('returns iterations for a test case in an experiment', async () => {
      const mockRuns = [createMockStorageRun('run-1'), createMockStorageRun('run-2')];
      mockOsRuns.getIterations.mockResolvedValue({
        runs: mockRuns,
        total: 2,
        maxIteration: 2,
      });

      const result = await asyncRunStorage.getIterations('exp-1', 'tc-1');

      expect(mockOsRuns.getIterations).toHaveBeenCalledWith('exp-1', 'tc-1', undefined);
      expect(result.runs).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.maxIteration).toBe(2);
    });

    it('filters by experiment run ID when provided', async () => {
      mockOsRuns.getIterations.mockResolvedValue({
        runs: [],
        total: 0,
        maxIteration: 0,
      });

      await asyncRunStorage.getIterations('exp-1', 'tc-1', 'exp-run-1');

      expect(mockOsRuns.getIterations).toHaveBeenCalledWith('exp-1', 'tc-1', 'exp-run-1');
    });
  });

  describe('annotation operations', () => {
    describe('addAnnotation', () => {
      it('adds an annotation to a report', async () => {
        const mockAnnotation = {
          id: 'ann-1',
          text: 'Test annotation',
          createdAt: '2024-01-01T12:00:00Z',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        };
        mockOsRuns.addAnnotation.mockResolvedValue(mockAnnotation);

        const result = await asyncRunStorage.addAnnotation('run-1', {
          text: 'Test annotation',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        });

        expect(mockOsRuns.addAnnotation).toHaveBeenCalledWith('run-1', {
          text: 'Test annotation',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        });
        expect(result).toMatchObject({
          id: 'ann-1',
          reportId: 'run-1',
          text: 'Test annotation',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        });
      });
    });

    describe('updateAnnotation', () => {
      it('returns true when update succeeds', async () => {
        mockOsRuns.updateAnnotation.mockResolvedValue(undefined);

        const result = await asyncRunStorage.updateAnnotation('run-1', 'ann-1', {
          text: 'Updated text',
          tags: ['new-tag'],
        });

        expect(mockOsRuns.updateAnnotation).toHaveBeenCalledWith('run-1', 'ann-1', {
          text: 'Updated text',
          tags: ['new-tag'],
        });
        expect(result).toBe(true);
      });

      it('returns false when update fails', async () => {
        mockOsRuns.updateAnnotation.mockRejectedValue(new Error('Update failed'));

        const result = await asyncRunStorage.updateAnnotation('run-1', 'non-existent', {
          text: 'Updated text',
        });

        expect(result).toBe(false);
      });
    });

    describe('deleteAnnotation', () => {
      it('returns true when deletion succeeds', async () => {
        mockOsRuns.deleteAnnotation.mockResolvedValue({ deleted: true });

        const result = await asyncRunStorage.deleteAnnotation('run-1', 'ann-1');

        expect(mockOsRuns.deleteAnnotation).toHaveBeenCalledWith('run-1', 'ann-1');
        expect(result).toBe(true);
      });

      it('returns false when deletion fails', async () => {
        mockOsRuns.deleteAnnotation.mockResolvedValue({ deleted: false });

        const result = await asyncRunStorage.deleteAnnotation('run-1', 'non-existent');

        expect(result).toBe(false);
      });
    });

    describe('getAnnotationsByReport', () => {
      it('returns annotations for a report', async () => {
        const mockStorageRun = {
          ...createMockStorageRun('run-1'),
          annotations: [
            {
              id: 'ann-1',
              text: 'Annotation 1',
              createdAt: '2024-01-01T12:00:00Z',
              tags: ['tag1'],
              author: 'user1',
            },
            {
              id: 'ann-2',
              text: 'Annotation 2',
              createdAt: '2024-01-01T13:00:00Z',
              tags: [],
              author: 'user2',
            },
          ],
        };
        mockOsRuns.getById.mockResolvedValue(mockStorageRun);

        const result = await asyncRunStorage.getAnnotationsByReport('run-1');

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({
          id: 'ann-1',
          reportId: 'run-1',
          text: 'Annotation 1',
          tags: ['tag1'],
        });
      });

      it('returns empty array when report not found', async () => {
        mockOsRuns.getById.mockResolvedValue(null);

        const result = await asyncRunStorage.getAnnotationsByReport('non-existent');

        expect(result).toEqual([]);
      });

      it('returns empty array when report has no annotations', async () => {
        const mockStorageRun = {
          ...createMockStorageRun('run-1'),
          annotations: undefined,
        };
        mockOsRuns.getById.mockResolvedValue(mockStorageRun);

        const result = await asyncRunStorage.getAnnotationsByReport('run-1');

        expect(result).toEqual([]);
      });
    });
  });

  describe('searchReports', () => {
    it('searches with test case filter', async () => {
      const mockRuns = [createMockStorageRun('run-1')];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 1 });

      const result = await asyncRunStorage.searchReports({
        testCaseIds: ['tc-1'],
      });

      expect(mockOsRuns.search).toHaveBeenCalledWith(
        expect.objectContaining({
          testCaseId: 'tc-1',
        })
      );
      expect(result).toHaveLength(1);
    });

    it('searches with date range filter', async () => {
      mockOsRuns.search.mockResolvedValue({ runs: [], total: 0 });

      await asyncRunStorage.searchReports({
        dateRange: { start: '2024-01-01', end: '2024-12-31' },
      });

      expect(mockOsRuns.search).toHaveBeenCalledWith(
        expect.objectContaining({
          dateRange: { start: '2024-01-01', end: '2024-12-31' },
        })
      );
    });

    it('searches with status filter', async () => {
      mockOsRuns.search.mockResolvedValue({ runs: [], total: 0 });

      await asyncRunStorage.searchReports({
        status: ['completed'],
      });

      expect(mockOsRuns.search).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
        })
      );
    });

    it('applies client-side agent name filter', async () => {
      const mockRuns = [
        { ...createMockStorageRun('run-1'), agentId: 'agent-1' },
        { ...createMockStorageRun('run-2'), agentId: 'agent-2' },
      ];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 2 });

      const result = await asyncRunStorage.searchReports({
        agentNames: ['agent-1'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].agentName).toBe('agent-1');
    });

    it('applies client-side model name filter', async () => {
      const mockRuns = [
        { ...createMockStorageRun('run-1'), modelId: 'model-1' },
        { ...createMockStorageRun('run-2'), modelId: 'model-2' },
      ];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 2 });

      const result = await asyncRunStorage.searchReports({
        modelNames: ['model-1'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].modelName).toBe('model-1');
    });

    it('applies client-side min accuracy filter', async () => {
      const mockRuns = [
        { ...createMockStorageRun('run-1'), metrics: { ...createMockStorageRun('run-1').metrics, accuracy: 0.8 } },
        { ...createMockStorageRun('run-2'), metrics: { ...createMockStorageRun('run-2').metrics, accuracy: 0.95 } },
      ];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 2 });

      const result = await asyncRunStorage.searchReports({
        minAccuracy: 0.9,
      });

      expect(result).toHaveLength(1);
      expect(result[0].metrics.accuracy).toBe(0.95);
    });
  });

  describe('generateReportId', () => {
    it('generates unique IDs', () => {
      const id1 = asyncRunStorage.generateReportId();
      const id2 = asyncRunStorage.generateReportId();

      expect(id1).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('bulkCreate', () => {
    it('creates multiple runs in bulk', async () => {
      mockOsRuns.bulkCreate.mockResolvedValue({ created: 2, errors: false });

      const reports = [createMockReport('report-1'), createMockReport('report-2')];
      const result = await asyncRunStorage.bulkCreate(reports);

      expect(mockOsRuns.bulkCreate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'report-1' }),
          expect.objectContaining({ id: 'report-2' }),
        ])
      );
      expect(result).toEqual({ created: 2, errors: false });
    });

    it('handles bulk create with errors', async () => {
      mockOsRuns.bulkCreate.mockResolvedValue({ created: 1, errors: true });

      const reports = [createMockReport('report-1'), createMockReport('report-2')];
      const result = await asyncRunStorage.bulkCreate(reports);

      expect(result).toEqual({ created: 1, errors: true });
    });
  });

  describe('toStorageFormat', () => {
    it('correctly maps all trace-mode fields', async () => {
      const mockStorageRun = createMockStorageRun('run-1');
      mockOsRuns.create.mockResolvedValue(mockStorageRun);

      const reportWithTraceFields: EvaluationReport = {
        ...createMockReport('report-1'),
        metricsStatus: 'calculating',
        traceFetchAttempts: 2,
        lastTraceFetchAt: '2024-01-01T10:00:00Z',
        traceError: 'Timeout error',
        spans: [{ spanId: 'span-1', name: 'test' }] as any[],
        openSearchLogs: [{ message: 'test log' }] as any[],
      };

      await asyncRunStorage.saveReport(reportWithTraceFields);

      expect(mockOsRuns.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metricsStatus: 'calculating',
          traceFetchAttempts: 2,
          lastTraceFetchAt: '2024-01-01T10:00:00Z',
          traceError: 'Timeout error',
          spans: [{ spanId: 'span-1', name: 'test' }],
          logs: [{ message: 'test log' }],
        })
      );
    });
  });
});
