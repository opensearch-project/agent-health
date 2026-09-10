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
    // The suite runs on Node 18/20/22 in CI; puppeteer here is MOCKED, so
    // neutralize the real runtime engine gate for the generate() tests. The
    // gate itself is tested directly in the 'Node engine guard' describe.
    jest.spyOn(formatter as any, 'assertRuntimeSupported').mockImplementation(() => {});
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

  describe('Node engine guard (puppeteer 25 requires Node >=22.12)', () => {
    const { assertNodeSupportsPuppeteer } = require('@/services/report/pdf/PdfFormatter');

    it('throws an actionable error on Node < 22.12 instead of loading puppeteer', () => {
      expect(() => assertNodeSupportsPuppeteer('20.11.0')).toThrow(
        /PDF generation requires Node\.js >=22\.12.*running Node 20\.11\.0/s
      );
      expect(() => assertNodeSupportsPuppeteer('18.19.0')).toThrow(/Node\.js >=22\.12/);
    });

    it('throws on Node 22.x below the 22.12 floor', () => {
      expect(() => assertNodeSupportsPuppeteer('22.11.0')).toThrow(/Node\.js >=22\.12/);
    });

    it('allows Node at or above the floor', () => {
      expect(() => assertNodeSupportsPuppeteer('22.12.0')).not.toThrow();
      expect(() => assertNodeSupportsPuppeteer('24.15.0')).not.toThrow();
    });

    it('generate() invokes the gate BEFORE loading puppeteer, and rejects when it throws', async () => {
      const gated = new PdfFormatter();
      jest
        .spyOn(gated as any, 'assertRuntimeSupported')
        .mockImplementation(() => assertNodeSupportsPuppeteer('20.11.0'));

      await expect(gated.generate(mockReportData)).rejects.toThrow(/Node\.js >=22\.12/);
      // The guard fires before puppeteer is ever loaded/launched.
      expect(mockLaunch).not.toHaveBeenCalled();
    });

    it('generate() proceeds when the gate passes (wired into the path)', async () => {
      const gated = new PdfFormatter();
      const spy = jest
        .spyOn(gated as any, 'assertRuntimeSupported')
        .mockImplementation(() => assertNodeSupportsPuppeteer('22.12.0'));

      const output = await gated.generate(mockReportData);
      expect(output.mimeType).toBe('application/pdf');
      expect(spy).toHaveBeenCalled();
      expect(mockLaunch).toHaveBeenCalled();
    });
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

    it('should throw error with install instructions', async () => {
      const { PdfFormatter: FreshPdfFormatter } = require('@/services/report/pdf/PdfFormatter');
      const freshFormatter = new FreshPdfFormatter();
      // Neutralize the engine gate so this test exercises the missing-module
      // path specifically, on every CI Node version.
      jest.spyOn(freshFormatter as any, 'assertRuntimeSupported').mockImplementation(() => {});

      await expect(freshFormatter.generate(mockReportData)).rejects.toThrow('Install it with: npm install puppeteer');
    });
  });

});
