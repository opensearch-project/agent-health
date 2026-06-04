/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { HtmlFormatter } from '@/services/report/html/HtmlFormatter';
import { escapeHtml } from '@/services/report/html/htmlTemplate';
import type { ReportData } from '@/services/report/types';

const mockReportData: ReportData = {
  benchmark: {
    id: 'bench-1',
    name: 'Test Benchmark',
    description: 'Test description',
    testCaseCount: 2,
  },
  runs: [
    {
      id: 'run-1',
      name: 'Run 1',
      createdAt: '2024-01-01T00:00:00Z',
      agentKey: 'mock',
      modelId: 'claude-sonnet',
      aggregates: {
        runId: 'run-1',
        runName: 'Run 1',
        createdAt: '2024-01-01T00:00:00Z',
        modelId: 'claude-sonnet',
        agentKey: 'mock',
        totalTestCases: 2,
        passedCount: 1,
        failedCount: 1,
        avgAccuracy: 75,
        passRatePercent: 50,
      },
    },
  ],
  comparisonRows: [
    {
      testCaseId: 'tc-1',
      testCaseName: 'Test Case 1',
      labels: ['category:RCA'],
      category: 'RCA' as any,
      difficulty: 'Medium' as any,
      results: {
        'run-1': {
          reportId: 'report-1',
          status: 'completed' as const,
          passFailStatus: 'passed' as any,
          accuracy: 85,
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
      timestamp: '2024-01-01T00:00:00Z',
      agentName: 'Mock Agent',
      modelName: 'Sonnet',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [
        { id: 's1', timestamp: 1, type: 'thinking', content: 'Thinking...' },
        { id: 's2', timestamp: 2, type: 'action', content: 'Running tool', toolName: 'search' },
        { id: 's3', timestamp: 3, type: 'tool_result', content: 'Found results', status: 'SUCCESS' },
        { id: 's4', timestamp: 4, type: 'response', content: 'Final answer' },
      ],
      metrics: { accuracy: 85 },
      llmJudgeReasoning: 'Good performance overall',
      improvementStrategies: [
        { category: 'Search', issue: 'Narrow results', recommendation: 'Add filters', priority: 'high' },
      ],
    } as any,
  },
  generatedAt: '2024-01-15T12:00:00Z',
  generatedBy: 'test',
};

describe('HtmlFormatter', () => {
  let formatter: HtmlFormatter;

  beforeEach(() => {
    jest.clearAllMocks();
    formatter = new HtmlFormatter();
  });

  it('should have format property set to html', () => {
    expect(formatter.format).toBe('html');
  });

  it('should have extension property set to html', () => {
    expect(formatter.extension).toBe('html');
  });

  it('should return HTML string containing <!DOCTYPE html> from generate()', async () => {
    const output = await formatter.generate(mockReportData);

    expect(typeof output.content).toBe('string');
    expect(output.content).toContain('<!DOCTYPE html>');
  });

  it('should contain benchmark name in the HTML', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.content).toContain('Test Benchmark');
  });

  it('should contain run name in the HTML', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.content).toContain('Run 1');
  });

  it('should contain test case name in the HTML', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.content).toContain('Test Case 1');
  });

  it('should contain trajectory step content in the HTML', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.content).toContain('Thinking...');
    expect(output.content).toContain('Running tool');
    expect(output.content).toContain('Found results');
    expect(output.content).toContain('Final answer');
  });

  it('should contain judge reasoning in the HTML', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.content).toContain('Good performance overall');
  });

  it('should contain improvement strategy in the HTML', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.content).toContain('Search');
    expect(output.content).toContain('Narrow results');
    expect(output.content).toContain('Add filters');
  });

  it('should have mimeType set to text/html', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.mimeType).toBe('text/html');
  });

  it('should produce a filename ending with .html', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.filename).toMatch(/\.html$/);
  });

  describe('escapeHtml', () => {
    it('should escape <, >, &, ", and \'', () => {
      const input = '<div class="test">&\'quoted\'</div>';
      const escaped = escapeHtml(input);

      expect(escaped).toContain('&lt;');
      expect(escaped).toContain('&gt;');
      expect(escaped).toContain('&amp;');
      expect(escaped).toContain('&quot;');
      expect(escaped).toContain('&#39;');
      expect(escaped).not.toContain('<div');
      expect(escaped).not.toContain('</div>');
    });
  });

  it('should contain truncation notice when maxTrajectorySteps is 2', async () => {
    const output = await formatter.generate(mockReportData, { maxTrajectorySteps: 2 });

    expect(output.content).toContain('more steps not shown');
  });

  it('should not contain trajectory step content when includeTrajectories is false', async () => {
    const output = await formatter.generate(mockReportData, { includeTrajectories: false });

    expect(output.content).not.toContain('Thinking...');
    expect(output.content).not.toContain('Running tool');
    expect(output.content).not.toContain('Found results');
    expect(output.content).not.toContain('Final answer');
  });

  it('should handle missing result in comparison table', async () => {
    const data: ReportData = {
      ...mockReportData,
      comparisonRows: [
        {
          testCaseId: 'tc-missing',
          testCaseName: 'Missing Result Test',
          labels: [],
          category: 'RCA' as any,
          difficulty: 'Easy' as any,
          results: {
            'run-1': {
              reportId: '',
              status: 'missing' as any,
            },
          },
          hasVersionDifference: false,
          versions: ['v1'],
        },
      ],
    };
    const output = await formatter.generate(data);
    // Missing results should show a dash
    expect(output.content).toContain('Missing Result Test');
  });

  it('should handle failed tool_result step', async () => {
    const data: ReportData = {
      ...mockReportData,
      reports: {
        'report-1': {
          ...mockReportData.reports['report-1'],
          trajectory: [
            { id: 's1', timestamp: 1, type: 'tool_result', content: 'Error', status: 'FAILURE' },
          ],
        } as any,
      },
    };
    const output = await formatter.generate(data);
    expect(output.content).toContain('Error');
  });

  it('should handle benchmark without description', async () => {
    const data: ReportData = {
      ...mockReportData,
      benchmark: {
        ...mockReportData.benchmark,
        description: undefined,
      },
    };
    const output = await formatter.generate(data);
    expect(output.content).toContain('Test Benchmark');
  });

  it('should handle report without llmJudgeReasoning', async () => {
    const data: ReportData = {
      ...mockReportData,
      reports: {
        'report-1': {
          ...mockReportData.reports['report-1'],
          llmJudgeReasoning: undefined,
        } as any,
      },
    };
    const output = await formatter.generate(data);
    expect(output.content).not.toContain('Judge Reasoning');
  });

  it('should handle report without improvement strategies', async () => {
    const data: ReportData = {
      ...mockReportData,
      reports: {
        'report-1': {
          ...mockReportData.reports['report-1'],
          improvementStrategies: [],
        } as any,
      },
    };
    const output = await formatter.generate(data);
    expect(output.content).not.toContain('Improvement Strategies');
  });

  it('should handle medium and low priority strategies', async () => {
    const data: ReportData = {
      ...mockReportData,
      reports: {
        'report-1': {
          ...mockReportData.reports['report-1'],
          improvementStrategies: [
            { category: 'Perf', issue: 'Slow', recommendation: 'Optimize', priority: 'medium' },
            { category: 'Style', issue: 'Verbose', recommendation: 'Shorten', priority: 'low' },
          ],
        } as any,
      },
    };
    const output = await formatter.generate(data);
    expect(output.content).toContain('medium');
    expect(output.content).toContain('low');
  });

  it('should handle result with undefined accuracy', async () => {
    const data: ReportData = {
      ...mockReportData,
      comparisonRows: [
        {
          testCaseId: 'tc-1',
          testCaseName: 'No Accuracy Test',
          labels: [],
          category: 'RCA' as any,
          difficulty: 'Easy' as any,
          results: {
            'run-1': {
              reportId: 'report-1',
              status: 'completed' as const,
              passFailStatus: 'failed' as any,
              accuracy: undefined,
            },
          },
          hasVersionDifference: false,
          versions: ['v1'],
        },
      ],
    };
    const output = await formatter.generate(data);
    expect(output.content).toContain('FAIL');
  });

  it('should handle report with empty trajectory', async () => {
    const data: ReportData = {
      ...mockReportData,
      reports: {
        'report-1': {
          ...mockReportData.reports['report-1'],
          trajectory: [],
        } as any,
      },
    };
    const output = await formatter.generate(data);
    expect(output.content).toContain('Test Benchmark');
  });

  it('should handle custom title option', async () => {
    const output = await formatter.generate(mockReportData, { title: 'My Custom Report' });
    expect(output.content).toContain('My Custom Report');
  });

  it('should handle report with assistant step type', async () => {
    const data: ReportData = {
      ...mockReportData,
      reports: {
        'report-1': {
          ...mockReportData.reports['report-1'],
          trajectory: [
            { id: 's1', timestamp: 1, type: 'assistant', content: 'Helper message' },
          ],
        } as any,
      },
    };
    const output = await formatter.generate(data);
    expect(output.content).toContain('Helper message');
  });

  it('should handle report with no reportId in comparison row', async () => {
    const data: ReportData = {
      ...mockReportData,
      comparisonRows: [
        {
          testCaseId: 'tc-1',
          testCaseName: 'No Report Test',
          labels: ['tag:test'],
          category: 'RCA' as any,
          difficulty: 'Easy' as any,
          results: {
            'run-1': {
              reportId: '',
              status: 'completed' as const,
              passFailStatus: 'passed' as any,
              accuracy: 50,
            },
          },
          hasVersionDifference: false,
          versions: ['v1'],
        },
      ],
    };
    const output = await formatter.generate(data);
    expect(output.content).toContain('No Report Test');
  });
});
