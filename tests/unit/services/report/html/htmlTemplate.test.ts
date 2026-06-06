/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  escapeHtml,
  generateDonutSvg,
  getHeatmapBg,
  formatNumber,
  formatDurationMs,
  generateHtmlReport,
} from '@/services/report/html/htmlTemplate';
import type { ReportData } from '@/services/report/types';

// ============ Test Data Factories ============

function createMockReportData(overrides?: Partial<ReportData>): ReportData {
  return {
    benchmark: {
      id: 'bench-1',
      name: 'Test Benchmark',
      description: 'A benchmark for testing',
      testCaseCount: 2,
    },
    runs: [
      {
        id: 'run-1',
        name: 'Run Alpha',
        createdAt: '2024-06-01T10:00:00Z',
        agentKey: 'mock-agent',
        modelId: 'claude-sonnet',
        aggregates: {
          runId: 'run-1',
          runName: 'Run Alpha',
          createdAt: '2024-06-01T10:00:00Z',
          modelId: 'claude-sonnet',
          agentKey: 'mock-agent',
          totalTestCases: 2,
          passedCount: 1,
          failedCount: 1,
          avgAccuracy: 72,
          passRatePercent: 50,
        },
      },
    ],
    comparisonRows: [
      {
        testCaseId: 'tc-1',
        testCaseName: 'Test Case Alpha',
        labels: ['category:RCA', 'difficulty:Medium'],
        category: 'RCA' as any,
        difficulty: 'Medium' as any,
        results: {
          'run-1': {
            reportId: 'report-1',
            status: 'completed' as const,
            passFailStatus: 'passed' as any,
            accuracy: 90,
          },
        },
        hasVersionDifference: false,
        versions: ['v1'],
      },
      {
        testCaseId: 'tc-2',
        testCaseName: 'Test Case Beta',
        labels: [],
        category: 'Logs' as any,
        difficulty: 'Hard' as any,
        results: {
          'run-1': {
            reportId: 'report-2',
            status: 'completed' as const,
            passFailStatus: 'failed' as any,
            accuracy: 40,
          },
        },
        hasVersionDifference: false,
        versions: ['v1'],
      },
    ],
    reports: {
      'report-1': {
        id: 'report-1',
        testCaseId: 'tc-1',
        timestamp: '2024-06-01T10:00:00Z',
        agentName: 'Mock Agent',
        modelName: 'Sonnet',
        status: 'completed',
        passFailStatus: 'passed',
        trajectory: [
          { id: 's1', timestamp: 1, type: 'thinking', content: 'Analyzing the problem...' },
          { id: 's2', timestamp: 2, type: 'action', content: 'Running search tool', toolName: 'search_logs' },
          { id: 's3', timestamp: 3, type: 'tool_result', content: 'Found 3 results', status: 'SUCCESS' },
          { id: 's4', timestamp: 4, type: 'response', content: 'The root cause is...' },
        ],
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'The agent correctly identified the root cause.',
        improvementStrategies: [
          { category: 'Search', issue: 'Too broad query', recommendation: 'Use targeted filters', priority: 'high' },
          { category: 'Reasoning', issue: 'Slow reasoning', recommendation: 'Be more concise', priority: 'medium' },
          { category: 'Style', issue: 'Verbose output', recommendation: 'Shorten response', priority: 'low' },
        ],
      } as any,
      'report-2': {
        id: 'report-2',
        testCaseId: 'tc-2',
        timestamp: '2024-06-01T10:01:00Z',
        agentName: 'Mock Agent',
        modelName: 'Sonnet',
        status: 'completed',
        passFailStatus: 'failed',
        trajectory: [
          { id: 's5', timestamp: 5, type: 'thinking', content: 'Not sure...' },
          { id: 's6', timestamp: 6, type: 'response', content: 'I could not determine the cause.' },
        ],
        metrics: { accuracy: 40 },
        llmJudgeReasoning: 'The agent failed to identify the root cause.',
        improvementStrategies: [],
      } as any,
    },
    generatedAt: '2024-06-15T12:00:00Z',
    generatedBy: 'test',
    ...overrides,
  };
}

function createMultiRunReportData(): ReportData {
  return createMockReportData({
    runs: [
      {
        id: 'run-1',
        name: 'Run Alpha',
        createdAt: '2024-06-01T10:00:00Z',
        agentKey: 'mock-agent',
        modelId: 'claude-sonnet',
        aggregates: {
          runId: 'run-1',
          runName: 'Run Alpha',
          createdAt: '2024-06-01T10:00:00Z',
          modelId: 'claude-sonnet',
          agentKey: 'mock-agent',
          totalTestCases: 2,
          passedCount: 2,
          failedCount: 0,
          avgAccuracy: 90,
          passRatePercent: 100,
        },
      },
      {
        id: 'run-2',
        name: 'Run Beta',
        createdAt: '2024-06-02T10:00:00Z',
        agentKey: 'holmesgpt',
        modelId: 'gpt-4',
        aggregates: {
          runId: 'run-2',
          runName: 'Run Beta',
          createdAt: '2024-06-02T10:00:00Z',
          modelId: 'gpt-4',
          agentKey: 'holmesgpt',
          totalTestCases: 2,
          passedCount: 1,
          failedCount: 1,
          avgAccuracy: 65,
          passRatePercent: 50,
        },
      },
    ],
    comparisonRows: [
      {
        testCaseId: 'tc-1',
        testCaseName: 'Test Case Alpha',
        labels: ['category:RCA'],
        category: 'RCA' as any,
        difficulty: 'Medium' as any,
        results: {
          'run-1': { reportId: 'report-1', status: 'completed' as const, passFailStatus: 'passed' as any, accuracy: 90 },
          'run-2': { reportId: 'report-3', status: 'completed' as const, passFailStatus: 'passed' as any, accuracy: 70 },
        },
        hasVersionDifference: false,
        versions: ['v1'],
      },
      {
        testCaseId: 'tc-2',
        testCaseName: 'Test Case Beta',
        labels: [],
        category: 'Logs' as any,
        difficulty: 'Hard' as any,
        results: {
          'run-1': { reportId: 'report-2', status: 'completed' as const, passFailStatus: 'passed' as any, accuracy: 85 },
          'run-2': { reportId: 'report-4', status: 'completed' as const, passFailStatus: 'failed' as any, accuracy: 45 },
        },
        hasVersionDifference: false,
        versions: ['v1'],
      },
    ],
    reports: {
      'report-1': {
        id: 'report-1', testCaseId: 'tc-1', timestamp: '2024-06-01T10:00:00Z',
        agentName: 'Mock', modelName: 'Sonnet', status: 'completed', passFailStatus: 'passed',
        trajectory: [{ id: 's1', timestamp: 1, type: 'response', content: 'Answer' }],
        metrics: { accuracy: 90 },
      } as any,
      'report-2': {
        id: 'report-2', testCaseId: 'tc-2', timestamp: '2024-06-01T10:01:00Z',
        agentName: 'Mock', modelName: 'Sonnet', status: 'completed', passFailStatus: 'passed',
        trajectory: [{ id: 's2', timestamp: 2, type: 'response', content: 'Answer 2' }],
        metrics: { accuracy: 85 },
      } as any,
      'report-3': {
        id: 'report-3', testCaseId: 'tc-1', timestamp: '2024-06-02T10:00:00Z',
        agentName: 'Holmes', modelName: 'GPT-4', status: 'completed', passFailStatus: 'passed',
        trajectory: [{ id: 's3', timestamp: 3, type: 'response', content: 'Answer 3' }],
        metrics: { accuracy: 70 },
      } as any,
      'report-4': {
        id: 'report-4', testCaseId: 'tc-2', timestamp: '2024-06-02T10:01:00Z',
        agentName: 'Holmes', modelName: 'GPT-4', status: 'completed', passFailStatus: 'failed',
        trajectory: [{ id: 's4', timestamp: 4, type: 'response', content: 'Answer 4' }],
        metrics: { accuracy: 45 },
        llmJudgeReasoning: 'Agent missed the root cause.',
        improvementStrategies: [
          { category: 'Analysis', issue: 'Incomplete', recommendation: 'Dig deeper', priority: 'high' },
        ],
      } as any,
    },
  });
}

// ============ Tests ============

describe('htmlTemplate utilities', () => {
  describe('escapeHtml', () => {
    it('should escape all XSS-relevant characters', () => {
      const input = '<script>alert("xss")&\'</script>';
      const result = escapeHtml(input);

      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&quot;');
      expect(result).toContain('&#39;');
      expect(result).not.toContain('<script');
    });

    it('should return empty string for empty input', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should not double-escape already escaped content', () => {
      expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    });
  });

  describe('formatNumber', () => {
    it('should return dash for undefined/null', () => {
      expect(formatNumber(undefined)).toBe('-');
      expect(formatNumber(null)).toBe('-');
    });

    it('should format millions with M suffix', () => {
      expect(formatNumber(1_500_000)).toBe('1.5M');
    });

    it('should format thousands with K suffix', () => {
      expect(formatNumber(12_400)).toBe('12.4K');
    });

    it('should show raw numbers below 1000', () => {
      expect(formatNumber(42)).toBe('42');
      expect(formatNumber(999)).toBe('999');
    });

    it('should handle zero', () => {
      expect(formatNumber(0)).toBe('0');
    });
  });

  describe('formatDurationMs', () => {
    it('should return dash for undefined/null', () => {
      expect(formatDurationMs(undefined)).toBe('-');
      expect(formatDurationMs(null)).toBe('-');
    });

    it('should format milliseconds below 1s', () => {
      expect(formatDurationMs(500)).toBe('500ms');
    });

    it('should format seconds below 1 minute', () => {
      expect(formatDurationMs(2300)).toBe('2.3s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDurationMs(83000)).toBe('1m 23s');
    });

    it('should handle exact boundaries', () => {
      expect(formatDurationMs(1000)).toBe('1.0s');
      expect(formatDurationMs(60000)).toBe('1m 0s');
    });
  });
});

describe('generateDonutSvg', () => {
  it('should return valid SVG with N/A for zero total', () => {
    const svg = generateDonutSvg(0, 0);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('N/A');
  });

  it('should return 100% when all pass', () => {
    const svg = generateDonutSvg(5, 0);
    expect(svg).toContain('100%');
    expect(svg).toContain('#015aa3');
    expect(svg).not.toContain('#b91c1c');
  });

  it('should return 0% when all fail', () => {
    const svg = generateDonutSvg(0, 3);
    expect(svg).toContain('0%');
    expect(svg).toContain('#b91c1c');
  });

  it('should render mixed results with both arcs', () => {
    const svg = generateDonutSvg(3, 2, 100);
    expect(svg).toContain('60%');
    expect(svg).toContain('#015aa3');
    expect(svg).toContain('#b91c1c');
    expect(svg).toContain('width="100"');
  });

  it('should use provided size', () => {
    const svg = generateDonutSvg(1, 1, 80);
    expect(svg).toContain('width="80"');
    expect(svg).toContain('height="80"');
  });

  it('should render 50% for equal pass/fail', () => {
    const svg = generateDonutSvg(5, 5);
    expect(svg).toContain('50%');
  });
});

describe('getHeatmapBg', () => {
  it('should return empty string when min equals max', () => {
    expect(getHeatmapBg(50, 50, 50)).toBe('');
  });

  it('should return green for high normalized values (higherIsBetter)', () => {
    const result = getHeatmapBg(95, 0, 100, true);
    expect(result).toContain('rgba(16,185,129');
    expect(result).toContain('0.10');
  });

  it('should return red for low normalized values (higherIsBetter)', () => {
    const result = getHeatmapBg(10, 0, 100, true);
    expect(result).toContain('rgba(239,68,68');
    expect(result).toContain('0.10');
  });

  it('should return empty string for middle values', () => {
    expect(getHeatmapBg(50, 0, 100, true)).toBe('');
  });

  it('should invert normalization when higherIsBetter is false', () => {
    // Low value should be green when lower is better
    const lowResult = getHeatmapBg(5, 0, 100, false);
    expect(lowResult).toContain('rgba(16,185,129');

    // High value should be red when lower is better
    const highResult = getHeatmapBg(95, 0, 100, false);
    expect(highResult).toContain('rgba(239,68,68');
  });

  it('should handle boundary values at 0.6 normalized', () => {
    const result = getHeatmapBg(60, 0, 100, true);
    expect(result).toContain('rgba(16,185,129');
    expect(result).toContain('0.05');
  });

  it('should handle boundary values at 0.2 normalized', () => {
    const result = getHeatmapBg(20, 0, 100, true);
    expect(result).toContain('rgba(239,68,68');
    expect(result).toContain('0.05');
  });
});

describe('generateHtmlReport', () => {
  describe('common structure', () => {
    it('should produce valid HTML document', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('</html>');
      expect(html).toContain('<head>');
      expect(html).toContain('</head>');
      expect(html).toContain('<body>');
      expect(html).toContain('</body>');
    });

    it('should contain benchmark name', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Test Benchmark');
    });

    it('should contain benchmark description', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('A benchmark for testing');
    });

    it('should contain generated date', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Generated');
    });

    it('should include branding elements', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Agent Health');
      expect(html).toContain('AH');
    });

    it('should use custom title when provided', () => {
      const html = generateHtmlReport(createMockReportData(), { title: 'Custom Report Title' });
      expect(html).toContain('Custom Report Title');
    });

    it('should include footer', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Generated by Agent Health');
    });

    it('should contain inline CSS (self-contained)', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('<style>');
      expect(html).toContain('--os-blue');
    });

    it('should not contain external font or script references', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).not.toContain('<link rel="stylesheet"');
      expect(html).not.toContain('<script src=');
    });
  });

  describe('single-run report', () => {
    it('should render executive summary with donut chart', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Executive Summary');
      expect(html).toContain('<svg');
      expect(html).toContain('50%'); // pass rate of 50%
    });

    it('should render metric cards with agent and model info', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('mock-agent');
      expect(html).toContain('claude-sonnet');
      expect(html).toContain('Pass Rate');
      expect(html).toContain('Accuracy');
    });

    it('should render flat test case results table (not comparison)', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Test Case Results');
      expect(html).toContain('Test Case Alpha');
      expect(html).toContain('Test Case Beta');
    });

    it('should not render run summary table for single run', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).not.toContain('Run Summary');
      expect(html).not.toContain('Per Test Case Comparison');
    });

    it('should show pass/fail icons in test case table', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('PASS');
      expect(html).toContain('FAIL');
    });

    it('should render test case details with trajectories', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Test Case Details');
      expect(html).toContain('Analyzing the problem...');
      expect(html).toContain('Running search tool');
      expect(html).toContain('Found 3 results');
      expect(html).toContain('The root cause is...');
    });

    it('should render judge reasoning', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Judge Reasoning');
      expect(html).toContain('The agent correctly identified the root cause.');
    });

    it('should render improvement strategies with priority badges', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('Improvement Strategies');
      expect(html).toContain('Too broad query');
      expect(html).toContain('Use targeted filters');
      expect(html).toContain('strategy-high');
      expect(html).toContain('strategy-medium');
      expect(html).toContain('strategy-low');
    });

    it('should show accuracy progress bar in test case details', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('progress-bar');
      expect(html).toContain('progress-fill');
    });

    it('should render token metrics when available', () => {
      const data = createMockReportData();
      data.runs[0].aggregates.totalTokens = 15000;
      data.runs[0].aggregates.totalCostUsd = 0.42;
      const html = generateHtmlReport(data);
      expect(html).toContain('Total Tokens');
      expect(html).toContain('15.0K');
      expect(html).toContain('Total Cost');
      expect(html).toContain('$0.42');
    });

    it('should not render token metrics when unavailable', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).not.toContain('Total Tokens');
      expect(html).not.toContain('Total Cost');
    });
  });

  describe('multi-run report', () => {
    it('should render per-run summary cards with small donuts', () => {
      const html = generateHtmlReport(createMultiRunReportData());
      expect(html).toContain('Executive Summary');
      expect(html).toContain('Run Alpha');
      expect(html).toContain('Run Beta');
      expect(html).toContain('run-cards-grid');
    });

    it('should render run summary table', () => {
      const html = generateHtmlReport(createMultiRunReportData());
      expect(html).toContain('Run Summary');
      expect(html).toContain('mock-agent');
      expect(html).toContain('holmesgpt');
    });

    it('should render comparison table with heatmap styles', () => {
      const html = generateHtmlReport(createMultiRunReportData());
      expect(html).toContain('Per Test Case Comparison');
      expect(html).toContain('Test Case Alpha');
      expect(html).toContain('Test Case Beta');
      // Should have heatmap background on accuracy cells
      expect(html).toContain('background-color: rgba');
    });

    it('should render check and X icons in comparison table', () => {
      const html = generateHtmlReport(createMultiRunReportData());
      // SVG check icon (green circle)
      expect(html).toContain('#15803d');
      // SVG X icon (red circle) - for failed result
      expect(html).toContain('#b91c1c');
    });

    it('should render test case details for multiple runs', () => {
      const html = generateHtmlReport(createMultiRunReportData());
      expect(html).toContain('Test Case Details');
      expect(html).toContain('Answer');
      expect(html).toContain('Answer 4');
    });

    it('should render improvement strategies in multi-run details', () => {
      const html = generateHtmlReport(createMultiRunReportData());
      expect(html).toContain('Dig deeper');
      expect(html).toContain('strategy-high');
    });
  });

  describe('options', () => {
    it('should omit trajectories when includeTrajectories is false', () => {
      const html = generateHtmlReport(createMockReportData(), { includeTrajectories: false });
      expect(html).not.toContain('Analyzing the problem...');
      expect(html).not.toContain('Running search tool');
      expect(html).not.toContain('Found 3 results');
      expect(html).not.toContain('The root cause is...');
      // Should still contain judge reasoning and strategies
      expect(html).toContain('The agent correctly identified the root cause.');
    });

    it('should truncate trajectories with maxTrajectorySteps', () => {
      const html = generateHtmlReport(createMockReportData(), { maxTrajectorySteps: 2 });
      // First 2 steps should be present
      expect(html).toContain('Analyzing the problem...');
      expect(html).toContain('Running search tool');
      // Truncation notice should appear
      expect(html).toContain('more steps not shown');
    });
  });

  describe('edge cases', () => {
    it('should handle missing results in comparison rows', () => {
      const data = createMockReportData({
        comparisonRows: [
          {
            testCaseId: 'tc-1',
            testCaseName: 'Missing Test',
            labels: [],
            category: 'RCA' as any,
            difficulty: 'Easy' as any,
            results: {
              'run-1': { reportId: '', status: 'missing' as any },
            },
            hasVersionDifference: false,
            versions: ['v1'],
          },
        ],
      });
      const html = generateHtmlReport(data);
      expect(html).toContain('Missing Test');
    });

    it('should handle benchmark without description', () => {
      const data = createMockReportData();
      data.benchmark.description = undefined;
      const html = generateHtmlReport(data);
      expect(html).toContain('Test Benchmark');
    });

    it('should handle report without llmJudgeReasoning', () => {
      const data = createMockReportData();
      (data.reports['report-1'] as any).llmJudgeReasoning = undefined;
      (data.reports['report-2'] as any).llmJudgeReasoning = undefined;
      const html = generateHtmlReport(data);
      expect(html).not.toContain('Judge Reasoning');
    });

    it('should handle report without improvement strategies', () => {
      const data = createMockReportData();
      (data.reports['report-1'] as any).improvementStrategies = [];
      const html = generateHtmlReport(data);
      // report-1 should not have improvement strategies section
      // but report-2 has empty strategies too, so no strategies at all
      expect(html).toContain('Test Benchmark');
    });

    it('should handle empty trajectory array', () => {
      const data = createMockReportData();
      (data.reports['report-1'] as any).trajectory = [];
      const html = generateHtmlReport(data);
      expect(html).toContain('Test Benchmark');
    });

    it('should handle failed tool_result step styling', () => {
      const data = createMockReportData();
      (data.reports['report-1'] as any).trajectory = [
        { id: 's1', timestamp: 1, type: 'tool_result', content: 'Error occurred', status: 'FAILURE' },
      ];
      const html = generateHtmlReport(data);
      expect(html).toContain('Error occurred');
      expect(html).toContain('failed');
    });

    it('should handle assistant step type', () => {
      const data = createMockReportData();
      (data.reports['report-1'] as any).trajectory = [
        { id: 's1', timestamp: 1, type: 'assistant', content: 'Helper message' },
      ];
      const html = generateHtmlReport(data);
      expect(html).toContain('Helper message');
    });

    it('should handle result with undefined accuracy', () => {
      const data = createMockReportData();
      data.comparisonRows[0].results['run-1'].accuracy = undefined;
      const html = generateHtmlReport(data);
      expect(html).toContain('Test Case Alpha');
    });

    it('should show label badges in test case rows', () => {
      const html = generateHtmlReport(createMockReportData());
      expect(html).toContain('category:RCA');
      expect(html).toContain('badge-label');
    });

    it('should handle empty runs array gracefully', () => {
      const data = createMockReportData({ runs: [] });
      // With no runs, single-run branch runs with undefined run[0]
      // The function should not throw
      expect(() => generateHtmlReport(data)).not.toThrow();
    });
  });
});
