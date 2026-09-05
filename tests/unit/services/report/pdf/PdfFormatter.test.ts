/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PdfFormatter } from '@/services/report/pdf/PdfFormatter';
import type { ReportData } from '@/services/report/types';

const mockPdf = jest.fn().mockResolvedValue(Buffer.from('pdf-content'));
const mockSetContent = jest.fn().mockResolvedValue(undefined);
const mockNewPage = jest.fn().mockResolvedValue({
  setContent: mockSetContent,
  pdf: mockPdf,
});
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockLaunch = jest.fn().mockResolvedValue({
  newPage: mockNewPage,
  close: mockClose,
});

jest.mock('puppeteer', () => ({
  launch: mockLaunch,
}), { virtual: true });

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

describe('PdfFormatter', () => {
  let formatter: PdfFormatter;

  beforeEach(() => {
    jest.clearAllMocks();
    formatter = new PdfFormatter();
  });

  it('should have format property set to pdf', () => {
    expect(formatter.format).toBe('pdf');
  });

  it('should have extension property set to pdf', () => {
    expect(formatter.extension).toBe('pdf');
  });

  it('should return Buffer content from generate()', async () => {
    const output = await formatter.generate(mockReportData);

    expect(Buffer.isBuffer(output.content)).toBe(true);
  });

  it('should have mimeType set to application/pdf', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.mimeType).toBe('application/pdf');
  });

  it('should produce a filename ending with .pdf', async () => {
    const output = await formatter.generate(mockReportData);

    expect(output.filename).toMatch(/\.pdf$/);
  });

  it('should call puppeteer.launch with headless: true', async () => {
    await formatter.generate(mockReportData);

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true })
    );
  });

  it('should call page.setContent with HTML string', async () => {
    await formatter.generate(mockReportData);

    expect(mockSetContent).toHaveBeenCalledTimes(1);
    const htmlArg = mockSetContent.mock.calls[0][0];
    expect(typeof htmlArg).toBe('string');
    expect(htmlArg).toContain('<!DOCTYPE html>');
  });

  it('should call page.pdf with A4 format', async () => {
    await formatter.generate(mockReportData);

    expect(mockPdf).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'A4' })
    );
  });

  it('should close browser in finally block', async () => {
    await formatter.generate(mockReportData);

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  describe('when puppeteer is not available', () => {
    beforeEach(() => {
      jest.resetModules();
      jest.doMock('puppeteer', () => {
        throw new Error('Cannot find module');
      }, { virtual: true });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should throw error with install instructions, the Node >= 22.12 floor, and the underlying cause', async () => {
      const { PdfFormatter: FreshPdfFormatter } = require('@/services/report/pdf/PdfFormatter');
      const freshFormatter = new FreshPdfFormatter();

      const err: Error = await freshFormatter.generate(mockReportData).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('npm install puppeteer');
      // puppeteer >= 25 is ESM-only / Node >= 22.12; on older Node the optional
      // dep is skipped at install, so the message must say WHY, not just "install it".
      expect(err.message).toContain('Node >= 22.12');
      expect(err.message).toContain(`running ${process.version}`);
      // The underlying loader failure is appended for diagnosis instead of
      // being swallowed (under Jest's CJS transform that is the ESM fallback's
      // own error; in a real ESM bundle it is the module-not-found).
      expect(err.message).toMatch(/\(.+\)$/);
    });
  });
});
