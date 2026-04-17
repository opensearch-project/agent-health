/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { SpanStatusCode } from '@opentelemetry/api';
import type { Benchmark, BenchmarkRun, TestCase, TestCaseRun } from '@/types';

// Mock the provider module
const mockIsEnabled = jest.fn().mockReturnValue(true);
const mockStartSpan = jest.fn();
const mockGetTracer = jest.fn();

jest.mock('@/lib/telemetry/provider', () => ({
  isEvalTelemetryEnabled: () => mockIsEnabled(),
  getEvalTracer: () => mockGetTracer(),
  flushEvalTracer: () => Promise.resolve(),
}));

import {
  startTestSuiteRunSpan,
  startTestCaseSpan,
  addEvaluationResultEvents,
  finalizeTestCaseSpan,
  finalizeTestSuiteRunSpan,
  emitDeferredTestCaseSpan,
} from '@/lib/telemetry/evalSpans';

// Helper: create a mock span
function createMockSpan() {
  return {
    setAttribute: jest.fn(),
    setStatus: jest.fn(),
    addEvent: jest.fn(),
    end: jest.fn(),
    spanContext: jest.fn().mockReturnValue({ traceId: 'test-trace', spanId: 'test-span' }),
  };
}

// Helper: create a mock tracer
function createMockTracer(span: ReturnType<typeof createMockSpan>) {
  return {
    startSpan: jest.fn().mockReturnValue(span),
  };
}

// Test fixtures
function createTestBenchmark(overrides?: Partial<Benchmark>): Benchmark {
  return {
    id: 'bench-1',
    name: 'Test Benchmark',
    description: 'A test benchmark',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    currentVersion: 1,
    versions: [],
    testCaseIds: ['tc-1'],
    runs: [],
    ...overrides,
  };
}

function createTestRun(overrides?: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    id: 'run-1',
    name: 'Test Run',
    createdAt: '2024-01-01T00:00:00Z',
    agentKey: 'test-agent',
    modelId: 'test-model',
    results: {},
    ...overrides,
  };
}

function createTestCase(overrides?: Partial<TestCase>): TestCase {
  return {
    id: 'tc-1',
    name: 'Test Case 1',
    description: 'A test case',
    labels: ['category:RCA'],
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    currentVersion: 1,
    versions: [],
    isPromoted: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'Why are there 500 errors?',
    context: [],
    expectedOutcomes: ['Should identify the root cause'],
    ...overrides,
  };
}

function createTestReport(overrides?: Partial<TestCaseRun>): TestCaseRun {
  return {
    id: 'report-1',
    timestamp: '2024-01-01T00:00:00Z',
    testCaseId: 'tc-1',
    agentName: 'Test Agent',
    modelName: 'test-model',
    status: 'completed',
    passFailStatus: 'passed',
    trajectory: [
      { id: '1', timestamp: Date.now(), type: 'response', content: 'The root cause is X' },
    ],
    metrics: { accuracy: 85 },
    llmJudgeReasoning: 'The agent correctly identified the root cause.',
    ...overrides,
  };
}

describe('Evaluation Span Helpers', () => {
  let mockSpan: ReturnType<typeof createMockSpan>;
  let mockTracer: ReturnType<typeof createMockTracer>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockSpan = createMockSpan();
    mockTracer = createMockTracer(mockSpan);
    mockGetTracer.mockReturnValue(mockTracer);
  });

  describe('startTestSuiteRunSpan', () => {
    it('should return null when telemetry is disabled', () => {
      mockIsEnabled.mockReturnValue(false);

      const result = startTestSuiteRunSpan(createTestBenchmark(), createTestRun());

      expect(result).toBeNull();
    });

    it('should create a span with correct name and attributes', () => {
      const benchmark = createTestBenchmark({ name: 'My Benchmark' });
      const run = createTestRun({ id: 'run-123' });

      const result = startTestSuiteRunSpan(benchmark, run);

      expect(result).not.toBeNull();
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'test_suite_run My Benchmark',
        expect.objectContaining({
          attributes: expect.objectContaining({
            'test.suite.name': 'My Benchmark',
            'test.suite.run.id': 'run-123',
            'gen_ai.operation.name': 'evaluation',
          }),
        })
      );
    });
  });

  describe('startTestCaseSpan', () => {
    it('should return null when telemetry is disabled', () => {
      mockIsEnabled.mockReturnValue(false);
      const { context } = require('@opentelemetry/api');

      const result = startTestCaseSpan(
        context.active(),
        createTestCase(),
        createTestBenchmark(),
        createTestRun()
      );

      expect(result).toBeNull();
    });

    it('should create a span with correct attributes', () => {
      const { context } = require('@opentelemetry/api');
      const testCase = createTestCase({
        id: 'tc-42',
        name: 'Error Analysis',
        initialPrompt: 'Investigate 500 errors',
        expectedOutcomes: ['Find root cause', 'Suggest fix'],
      });

      startTestCaseSpan(context.active(), testCase, createTestBenchmark(), createTestRun());

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'test_case',
        expect.objectContaining({
          attributes: expect.objectContaining({
            'test.case.id': 'tc-42',
            'test.case.name': 'Error Analysis',
            'gen_ai.operation.name': 'evaluation',
            'test.case.input': 'Investigate 500 errors',
            'test.case.expected': '["Find root cause","Suggest fix"]',
          }),
        }),
        expect.anything() // parent context
      );
    });
  });

  describe('addEvaluationResultEvents', () => {
    it('should not add events when telemetry is disabled', () => {
      mockIsEnabled.mockReturnValue(false);

      addEvaluationResultEvents(mockSpan as any, createTestReport());

      expect(mockSpan.addEvent).not.toHaveBeenCalled();
    });

    it('should add accuracy event with correct attributes', () => {
      const report = createTestReport({
        metrics: { accuracy: 92 },
        passFailStatus: 'passed',
        llmJudgeReasoning: 'Good analysis.',
      });

      addEvaluationResultEvents(mockSpan as any, report);

      expect(mockSpan.addEvent).toHaveBeenCalledWith(
        'gen_ai.evaluation.result',
        expect.objectContaining({
          'gen_ai.evaluation.name': 'accuracy',
          'gen_ai.evaluation.score.value': 92,
          'gen_ai.evaluation.score.label': 'pass',
          'gen_ai.evaluation.explanation': 'Good analysis.',
        })
      );
    });

    it('should set label to fail when passFailStatus is failed', () => {
      const report = createTestReport({ passFailStatus: 'failed' });

      addEvaluationResultEvents(mockSpan as any, report);

      expect(mockSpan.addEvent).toHaveBeenCalledWith(
        'gen_ai.evaluation.result',
        expect.objectContaining({
          'gen_ai.evaluation.score.label': 'fail',
        })
      );
    });

    it('should add additional metrics as separate events', () => {
      const report = createTestReport({
        metrics: {
          accuracy: 85,
          faithfulness: 90,
          latency_score: 75,
          trajectory_alignment_score: 80,
        },
      });

      addEvaluationResultEvents(mockSpan as any, report);

      // Should have 4 events (accuracy + 3 additional metrics)
      expect(mockSpan.addEvent).toHaveBeenCalledTimes(4);

      const eventNames = mockSpan.addEvent.mock.calls.map(
        (call: any[]) => call[1]['gen_ai.evaluation.name']
      );
      expect(eventNames).toEqual([
        'accuracy',
        'faithfulness',
        'latency_score',
        'trajectory_alignment_score',
      ]);
    });
  });

  describe('finalizeTestCaseSpan', () => {
    it('should set pass status and end span', () => {
      const report = createTestReport({ passFailStatus: 'passed' });

      finalizeTestCaseSpan(mockSpan as any, report);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'test.case.result.status',
        'pass'
      );
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('should set fail status for failed reports', () => {
      const report = createTestReport({ passFailStatus: 'failed' });

      finalizeTestCaseSpan(mockSpan as any, report);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'test.case.result.status',
        'fail'
      );
    });

    it('should extract agent response from trajectory', () => {
      const report = createTestReport({
        trajectory: [
          { id: '1', timestamp: Date.now(), type: 'thinking', content: 'Let me analyze...' },
          { id: '2', timestamp: Date.now(), type: 'response', content: 'The root cause is X' },
        ],
      });

      finalizeTestCaseSpan(mockSpan as any, report);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'test.case.output',
        'The root cause is X'
      );
    });

    it('should set error status for failed evaluations', () => {
      const report = createTestReport({ status: 'failed' });

      finalizeTestCaseSpan(mockSpan as any, report);

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'Evaluation failed',
      });
    });

    it('should set extension attributes when available', () => {
      const report = createTestReport({
        connectorProtocol: 'agui-streaming' as any,
        performanceMetrics: {
          durationMs: 5000,
          agentDurationMs: 3000,
          judgeDurationMs: 2000,
          judgeAttempts: 1,
        },
      });

      finalizeTestCaseSpan(mockSpan as any, report);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'agent_health.connector.protocol',
        'agui-streaming'
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'agent_health.agent.duration_ms',
        3000
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'agent_health.judge.duration_ms',
        2000
      );
    });
  });

  describe('finalizeTestSuiteRunSpan', () => {
    it('should set success status when all cases pass', () => {
      const run = createTestRun({
        results: {
          'tc-1': { reportId: 'r1', status: 'completed' },
          'tc-2': { reportId: 'r2', status: 'completed' },
        },
      });

      finalizeTestSuiteRunSpan(mockSpan as any, run);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'test.suite.run.status',
        'success'
      );
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('should set failure status when any case fails', () => {
      const run = createTestRun({
        results: {
          'tc-1': { reportId: 'r1', status: 'completed' },
          'tc-2': { reportId: '', status: 'failed', error: 'Timeout' },
        },
      });

      finalizeTestSuiteRunSpan(mockSpan as any, run);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'test.suite.run.status',
        'failure'
      );
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: '1 case(s) failed',
      });
    });
  });

  describe('emitDeferredTestCaseSpan', () => {
    it('should not emit when telemetry is disabled', () => {
      mockIsEnabled.mockReturnValue(false);

      emitDeferredTestCaseSpan(
        createTestCase(),
        createTestReport(),
        { name: 'Benchmark' },
        'run-1'
      );

      expect(mockTracer.startSpan).not.toHaveBeenCalled();
    });

    it('should create a complete span with evaluation events', () => {
      const testCase = createTestCase({ id: 'tc-deferred' });
      const report = createTestReport({
        metrics: { accuracy: 78 },
        passFailStatus: 'failed',
      });

      emitDeferredTestCaseSpan(
        testCase,
        report,
        { name: 'Deferred Benchmark' },
        'run-deferred',
        undefined,
        new Date('2024-01-01T10:00:00Z')
      );

      // Should create span (no agentTraceId → parentCtx is undefined)
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'test_case',
        expect.objectContaining({
          startTime: new Date('2024-01-01T10:00:00Z'),
          attributes: expect.objectContaining({
            'test.case.id': 'tc-deferred',
            'test.suite.name': 'Deferred Benchmark',
            'test.suite.run.id': 'run-deferred',
          }),
        }),
        undefined
      );

      // Should add evaluation events and end span
      expect(mockSpan.addEvent).toHaveBeenCalled();
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('should create span within agent trace when agentTraceId is provided', () => {
      const testCase = createTestCase({ id: 'tc-linked' });
      const report = createTestReport({ metrics: { accuracy: 85 } });

      emitDeferredTestCaseSpan(
        testCase,
        report,
        { name: 'Linked Benchmark' },
        'run-linked',
        'agent-run-id',
        new Date('2024-01-01T10:00:00Z'),
        new Date('2024-01-01T10:05:00Z'),
        'abc123def456abc123def456abc12345' // 32-char hex agentTraceId
      );

      // Should create span with a parent context (3rd arg to startSpan)
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'test_case',
        expect.objectContaining({
          attributes: expect.objectContaining({
            'test.case.id': 'tc-linked',
            'gen_ai.request.id': 'agent-run-id',
          }),
        }),
        expect.anything() // parent context carrying agentTraceId
      );

      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('should pass endTime to span.end()', () => {
      const testCase = createTestCase({ id: 'tc-deferred-end' });
      const report = createTestReport({ metrics: { accuracy: 90 } });
      const startTime = new Date('2024-01-01T10:00:00Z');
      const endTime = new Date('2024-01-01T10:05:00Z');

      emitDeferredTestCaseSpan(
        testCase,
        report,
        { name: 'Deferred Benchmark' },
        'run-deferred',
        undefined,
        startTime,
        endTime
      );

      expect(mockSpan.end).toHaveBeenCalledWith(endTime);
    });
  });
});
