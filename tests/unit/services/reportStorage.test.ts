/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects that don't match full type definitions
import { reportStorage, testCaseRunStorage } from '@/services/reportStorage';
import type { EvaluationReport, RunAnnotation } from '@/types';

// jsdom provides localStorage, so we just need to clear it between tests

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Test data factory
const createReport = (id: string, testCaseId: string, overrides: Partial<EvaluationReport> = {}): EvaluationReport => ({
  id,
  testCaseId,
  timestamp: new Date().toISOString(),
  agentName: 'Test Agent',
  modelName: 'claude-sonnet',
  status: 'completed',
  trajectory: [{ id: 'step-1', timestamp: Date.now(), type: 'response', content: 'Test response' }],
  metrics: { accuracy: 85 },
  passFailStatus: 'passed',
  llmJudgeReasoning: 'Test reasoning',
  ...overrides,
});

describe('ReportStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  describe('saveReport', () => {
    it('should save a new report', () => {
      const report = createReport('report-1', 'tc-1');
      reportStorage.saveReport(report);

      const saved = reportStorage.getReportById('report-1');
      expect(saved).toEqual(report);
    });

    it('should update an existing report', () => {
      const report = createReport('report-1', 'tc-1', { status: 'running' });
      reportStorage.saveReport(report);

      const updated = createReport('report-1', 'tc-1', { status: 'completed' });
      reportStorage.saveReport(updated);

      const saved = reportStorage.getReportById('report-1');
      expect(saved?.status).toBe('completed');
      expect(reportStorage.getReportCount()).toBe(1);
    });

    it('should organize reports by test case', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.saveReport(createReport('report-2', 'tc-1'));
      reportStorage.saveReport(createReport('report-3', 'tc-2'));

      expect(reportStorage.getReportCountByTestCase('tc-1')).toBe(2);
      expect(reportStorage.getReportCountByTestCase('tc-2')).toBe(1);
    });

    it('should sort reports by timestamp (newest first)', () => {
      const oldReport = createReport('report-1', 'tc-1', {
        timestamp: '2024-01-01T00:00:00.000Z',
      });
      const newReport = createReport('report-2', 'tc-1', {
        timestamp: '2024-01-02T00:00:00.000Z',
      });

      reportStorage.saveReport(oldReport);
      reportStorage.saveReport(newReport);

      const reports = reportStorage.getReportsByTestCase('tc-1');
      expect(reports[0].id).toBe('report-2');
      expect(reports[1].id).toBe('report-1');
    });

    it('should handle quota exceeded by pruning (tested via pruneOldReports)', () => {
      // This test verifies the pruning mechanism works
      // The actual quota handling is difficult to test without real quota limits
      for (let i = 0; i < 5; i++) {
        reportStorage.saveReport(createReport(`report-${i}`, 'tc-1', {
          timestamp: new Date(2024, 0, i + 1).toISOString(),
        }));
      }

      expect(reportStorage.getReportCount()).toBe(5);

      // Verify pruning works
      const pruned = reportStorage.pruneOldReports(3);
      expect(pruned).toBe(3);
      expect(reportStorage.getReportCount()).toBe(2);
    });
  });

  describe('getReportsByTestCase', () => {
    it('should return empty array for non-existent test case', () => {
      const reports = reportStorage.getReportsByTestCase('non-existent');
      expect(reports).toEqual([]);
    });

    it('should apply limit option', () => {
      for (let i = 0; i < 5; i++) {
        reportStorage.saveReport(createReport(`report-${i}`, 'tc-1'));
      }

      const reports = reportStorage.getReportsByTestCase('tc-1', { limit: 3 });
      expect(reports.length).toBe(3);
    });

    it('should apply offset option', () => {
      for (let i = 0; i < 5; i++) {
        reportStorage.saveReport(createReport(`report-${i}`, 'tc-1', {
          timestamp: new Date(2024, 0, i + 1).toISOString(),
        }));
      }

      const reports = reportStorage.getReportsByTestCase('tc-1', { offset: 2 });
      expect(reports.length).toBe(3);
    });

    it('should sort by accuracy', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1', { metrics: { accuracy: 90 } }));
      reportStorage.saveReport(createReport('report-2', 'tc-1', { metrics: { accuracy: 70 } }));

      const reportsDesc = reportStorage.getReportsByTestCase('tc-1', { sortBy: 'accuracy', order: 'desc' });
      expect(reportsDesc[0].metrics.accuracy).toBe(90);

      const reportsAsc = reportStorage.getReportsByTestCase('tc-1', { sortBy: 'accuracy', order: 'asc' });
      expect(reportsAsc[0].metrics.accuracy).toBe(70);
    });

    it('should sort by timestamp ascending', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1', {
        timestamp: '2024-01-01T00:00:00.000Z',
      }));
      reportStorage.saveReport(createReport('report-2', 'tc-1', {
        timestamp: '2024-01-02T00:00:00.000Z',
      }));

      const reports = reportStorage.getReportsByTestCase('tc-1', { order: 'asc' });
      expect(reports[0].id).toBe('report-1');
    });
  });

  describe('getAllReports', () => {
    it('should return all reports across test cases', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.saveReport(createReport('report-2', 'tc-2'));
      reportStorage.saveReport(createReport('report-3', 'tc-1'));

      const reports = reportStorage.getAllReports();
      expect(reports.length).toBe(3);
    });

    it('should sort all reports by timestamp', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1', {
        timestamp: '2024-01-01T00:00:00.000Z',
      }));
      reportStorage.saveReport(createReport('report-2', 'tc-2', {
        timestamp: '2024-01-03T00:00:00.000Z',
      }));

      const reportsDesc = reportStorage.getAllReports({ sortBy: 'timestamp', order: 'desc' });
      expect(reportsDesc[0].id).toBe('report-2');

      const reportsAsc = reportStorage.getAllReports({ sortBy: 'timestamp', order: 'asc' });
      expect(reportsAsc[0].id).toBe('report-1');
    });

    it('should sort all reports by accuracy', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1', { metrics: { accuracy: 60 } }));
      reportStorage.saveReport(createReport('report-2', 'tc-2', { metrics: { accuracy: 95 } }));

      const reports = reportStorage.getAllReports({ sortBy: 'accuracy', order: 'desc' });
      expect(reports[0].id).toBe('report-2');
    });
  });

  describe('getReportById', () => {
    it('should return null for non-existent report', () => {
      const report = reportStorage.getReportById('non-existent');
      expect(report).toBeNull();
    });

    it('should find report across test cases', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.saveReport(createReport('report-2', 'tc-2'));

      const report = reportStorage.getReportById('report-2');
      expect(report?.testCaseId).toBe('tc-2');
    });
  });

  describe('deleteReport', () => {
    it('should delete a report', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      expect(reportStorage.getReportById('report-1')).toBeDefined();

      const result = reportStorage.deleteReport('report-1');
      expect(result).toBe(true);
      expect(reportStorage.getReportById('report-1')).toBeNull();
    });

    it('should return false for non-existent report', () => {
      const result = reportStorage.deleteReport('non-existent');
      expect(result).toBe(false);
    });

    it('should clean up empty test case arrays', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.deleteReport('report-1');

      const reports = reportStorage.getReportsByTestCase('tc-1');
      expect(reports.length).toBe(0);
    });

    it('should delete associated annotations', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.addAnnotation('report-1', {
        text: 'Test annotation',
        author: 'tester',
        tags: [],
      });

      reportStorage.deleteReport('report-1');

      const annotations = reportStorage.getAnnotationsByReport('report-1');
      expect(annotations.length).toBe(0);
    });
  });

  describe('getReportCount', () => {
    it('should return 0 for empty storage', () => {
      expect(reportStorage.getReportCount()).toBe(0);
    });

    it('should return correct count', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.saveReport(createReport('report-2', 'tc-2'));
      expect(reportStorage.getReportCount()).toBe(2);
    });
  });

  describe('pruneOldReports', () => {
    it('should remove oldest reports', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1', {
        timestamp: '2024-01-01T00:00:00.000Z',
      }));
      reportStorage.saveReport(createReport('report-2', 'tc-1', {
        timestamp: '2024-01-02T00:00:00.000Z',
      }));
      reportStorage.saveReport(createReport('report-3', 'tc-1', {
        timestamp: '2024-01-03T00:00:00.000Z',
      }));

      const pruned = reportStorage.pruneOldReports(2);
      expect(pruned).toBe(2);
      expect(reportStorage.getReportCount()).toBe(1);
      expect(reportStorage.getReportById('report-3')).toBeDefined();
    });
  });

  describe('clearAllData', () => {
    it('should clear all data', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.addAnnotation('report-1', { text: 'Test', author: 'tester', tags: [] });

      expect(reportStorage.getReportCount()).toBe(1);

      reportStorage.clearAllData();

      expect(reportStorage.getReportCount()).toBe(0);
      expect(reportStorage.getAnnotationsByReport('report-1').length).toBe(0);
    });
  });

  describe('Annotations', () => {
    beforeEach(() => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
    });

    describe('addAnnotation', () => {
      it('should add an annotation', () => {
        const annotation = reportStorage.addAnnotation('report-1', {
          text: 'This is a test',
          author: 'tester',
          tags: ['important'],
        });

        expect(annotation.id).toMatch(/^ann-/);
        expect(annotation.timestamp).toBeDefined();
        expect(annotation.text).toBe('This is a test');
      });
    });

    describe('getAnnotationsByReport', () => {
      it('should return empty array for report with no annotations', () => {
        const annotations = reportStorage.getAnnotationsByReport('report-1');
        expect(annotations).toEqual([]);
      });

      it('should return all annotations for a report', () => {
        reportStorage.addAnnotation('report-1', { text: 'First', author: 'tester', tags: [] });
        reportStorage.addAnnotation('report-1', { text: 'Second', author: 'tester', tags: [] });

        const annotations = reportStorage.getAnnotationsByReport('report-1');
        expect(annotations.length).toBe(2);
      });
    });

    describe('updateAnnotation', () => {
      it('should update an existing annotation', () => {
        const annotation = reportStorage.addAnnotation('report-1', {
          text: 'Original',
          author: 'tester',
          tags: [],
        });

        const result = reportStorage.updateAnnotation(annotation.id, { text: 'Updated' });
        expect(result).toBe(true);

        const annotations = reportStorage.getAnnotationsByReport('report-1');
        expect(annotations[0].text).toBe('Updated');
      });

      it('should return false for non-existent annotation', () => {
        const result = reportStorage.updateAnnotation('non-existent', { text: 'Test' });
        expect(result).toBe(false);
      });
    });

    describe('deleteAnnotation', () => {
      it('should delete an annotation', () => {
        const annotation = reportStorage.addAnnotation('report-1', {
          text: 'Test',
          author: 'tester',
          tags: [],
        });

        const result = reportStorage.deleteAnnotation(annotation.id);
        expect(result).toBe(true);

        const annotations = reportStorage.getAnnotationsByReport('report-1');
        expect(annotations.length).toBe(0);
      });

      it('should return false for non-existent annotation', () => {
        const result = reportStorage.deleteAnnotation('non-existent');
        expect(result).toBe(false);
      });
    });
  });

  describe('searchReports', () => {
    beforeEach(() => {
      reportStorage.saveReport(createReport('report-1', 'tc-1', {
        timestamp: '2024-01-15T00:00:00.000Z',
        agentName: 'Agent A',
        modelName: 'claude-sonnet',
        status: 'completed',
        metrics: { accuracy: 90 },
      }));
      reportStorage.saveReport(createReport('report-2', 'tc-2', {
        timestamp: '2024-02-15T00:00:00.000Z',
        agentName: 'Agent B',
        modelName: 'claude-haiku',
        status: 'failed',
        metrics: { accuracy: 60 },
      }));
      reportStorage.saveReport(createReport('report-3', 'tc-1', {
        timestamp: '2024-03-15T00:00:00.000Z',
        agentName: 'Agent A',
        modelName: 'claude-sonnet',
        status: 'completed',
        metrics: { accuracy: 85 },
      }));
    });

    it('should filter by test case IDs', () => {
      const results = reportStorage.searchReports({ testCaseIds: ['tc-1'] });
      expect(results.length).toBe(2);
      expect(results.every(r => r.testCaseId === 'tc-1')).toBe(true);
    });

    it('should filter by date range', () => {
      const results = reportStorage.searchReports({
        dateRange: { start: '2024-02-01', end: '2024-02-28' },
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('report-2');
    });

    it('should filter by agent names', () => {
      const results = reportStorage.searchReports({ agentNames: ['Agent A'] });
      expect(results.length).toBe(2);
    });

    it('should filter by model names', () => {
      const results = reportStorage.searchReports({ modelNames: ['claude-haiku'] });
      expect(results.length).toBe(1);
    });

    it('should filter by minimum accuracy', () => {
      const results = reportStorage.searchReports({ minAccuracy: 80 });
      expect(results.length).toBe(2);
    });

    it('should filter by status', () => {
      const results = reportStorage.searchReports({ status: ['failed'] });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('failed');
    });

    it('should filter by has annotations', () => {
      reportStorage.addAnnotation('report-1', { text: 'Test', author: 'tester', tags: [] });

      const withAnnotations = reportStorage.searchReports({ hasAnnotations: true });
      expect(withAnnotations.length).toBe(1);
      expect(withAnnotations[0].id).toBe('report-1');

      const withoutAnnotations = reportStorage.searchReports({ hasAnnotations: false });
      expect(withoutAnnotations.length).toBe(2);
    });

    it('should filter by annotation tags', () => {
      reportStorage.addAnnotation('report-1', { text: 'Test', author: 'tester', tags: ['bug'] });

      const results = reportStorage.searchReports({ annotationTags: ['bug'] });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('report-1');
    });

    it('should combine multiple filters', () => {
      const results = reportStorage.searchReports({
        testCaseIds: ['tc-1'],
        agentNames: ['Agent A'],
        minAccuracy: 85,
      });
      expect(results.length).toBe(2);
    });
  });

  describe('exportReports', () => {
    it('should export all reports', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.saveReport(createReport('report-2', 'tc-2'));

      const exported = JSON.parse(reportStorage.exportReports());
      expect(exported.version).toBe('1.0');
      expect(exported.reports.length).toBe(2);
      expect(exported.exportDate).toBeDefined();
    });

    it('should export specific test cases', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.saveReport(createReport('report-2', 'tc-2'));

      const exported = JSON.parse(reportStorage.exportReports({ testCaseIds: ['tc-1'] }));
      expect(exported.reports.length).toBe(1);
      expect(exported.reports[0].testCaseId).toBe('tc-1');
    });

    it('should include annotations by default', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.addAnnotation('report-1', { text: 'Test', author: 'tester', tags: [] });

      const exported = JSON.parse(reportStorage.exportReports());
      expect(exported.annotations).toBeDefined();
      expect(exported.annotations['report-1'].length).toBe(1);
    });

    it('should exclude annotations when specified', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.addAnnotation('report-1', { text: 'Test', author: 'tester', tags: [] });

      const exported = JSON.parse(reportStorage.exportReports({ includeAnnotations: false }));
      expect(exported.annotations).toBeUndefined();
    });
  });

  describe('importReports', () => {
    it('should import valid reports', () => {
      const importData = JSON.stringify({
        version: '1.0',
        exportDate: new Date().toISOString(),
        reports: [createReport('import-1', 'tc-1')],
      });

      const result = reportStorage.importReports(importData);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors.length).toBe(0);
      expect(reportStorage.getReportById('import-1')).toBeDefined();
    });

    it('should skip duplicate reports', () => {
      reportStorage.saveReport(createReport('existing-1', 'tc-1'));

      const importData = JSON.stringify({
        version: '1.0',
        exportDate: new Date().toISOString(),
        reports: [createReport('existing-1', 'tc-1')],
      });

      const result = reportStorage.importReports(importData);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('should skip invalid reports', () => {
      const importData = JSON.stringify({
        version: '1.0',
        exportDate: new Date().toISOString(),
        reports: [{ id: 'invalid' }], // Missing required fields
      });

      const result = reportStorage.importReports(importData);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors.length).toBe(1);
    });

    it('should import annotations', () => {
      const importData = JSON.stringify({
        version: '1.0',
        exportDate: new Date().toISOString(),
        reports: [createReport('import-1', 'tc-1')],
        annotations: {
          'import-1': [{ id: 'ann-1', timestamp: new Date().toISOString(), text: 'Imported', author: 'tester', tags: [] }],
        },
      });

      reportStorage.importReports(importData);

      const annotations = reportStorage.getAnnotationsByReport('import-1');
      expect(annotations.length).toBe(1);
    });

    it('should handle invalid JSON', () => {
      const result = reportStorage.importReports('invalid json');
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('Parse error');
    });

    it('should handle invalid format', () => {
      const result = reportStorage.importReports(JSON.stringify({ invalid: 'format' }));
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('Invalid export format');
    });
  });

  describe('validateReportSchema', () => {
    it('should return true for valid report', () => {
      const report = createReport('report-1', 'tc-1');
      expect(reportStorage.validateReportSchema(report)).toBe(true);
    });

    it('should return false for invalid report', () => {
      expect(reportStorage.validateReportSchema(null)).toBe(false);
      expect(reportStorage.validateReportSchema({})).toBe(false);
      expect(reportStorage.validateReportSchema({ id: 'test' })).toBe(false);
    });
  });

  describe('getStorageStats', () => {
    it('should return storage statistics', () => {
      reportStorage.saveReport(createReport('report-1', 'tc-1'));
      reportStorage.saveReport(createReport('report-2', 'tc-2'));
      reportStorage.addAnnotation('report-1', { text: 'Test', author: 'tester', tags: [] });

      const stats = reportStorage.getStorageStats();
      expect(stats.totalReports).toBe(2);
      expect(stats.reportsByTestCase['tc-1']).toBe(1);
      expect(stats.reportsByTestCase['tc-2']).toBe(1);
      expect(stats.totalAnnotations).toBe(1);
      expect(stats.storageUsedBytes).toBeGreaterThan(0);
      expect(stats.storageQuotaBytes).toBe(10 * 1024 * 1024);
      expect(stats.usagePercent).toBeGreaterThan(0);
    });
  });

  describe('legacy migration', () => {
    it('should migrate from legacy storage key', () => {
      // Set up legacy data
      const legacyData = {
        'tc-1': [createReport('legacy-1', 'tc-1')],
      };
      localStorage.setItem('eval_reports_by_testcase', JSON.stringify(legacyData));

      // Access should trigger migration
      const report = reportStorage.getReportById('legacy-1');
      expect(report).toBeDefined();

      // Legacy key should be removed
      expect(localStorage.getItem('eval_reports_by_testcase')).toBeNull();
      // New key should have the data
      expect(localStorage.getItem('test_case_runs')).toBeDefined();
    });
  });

  describe('testCaseRunStorage alias', () => {
    it('should be the same as reportStorage', () => {
      expect(testCaseRunStorage).toBe(reportStorage);
    });
  });
});
