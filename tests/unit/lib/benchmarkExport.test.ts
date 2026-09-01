/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { convertTestCasesToExportFormat, generateExportFilename } from '@/lib/benchmarkExport';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';
import type { TestCase } from '@/types';

describe('benchmarkExport', () => {
  describe('convertTestCasesToExportFormat', () => {
    const makeTestCase = (overrides: Partial<TestCase> = {}): TestCase => ({
      id: 'tc-123',
      name: 'Test Case',
      description: 'A test case',
      labels: ['category:RCA', 'difficulty:Medium'],
      category: 'RCA',
      difficulty: 'Medium',
      currentVersion: 1,
      versions: [],
      isPromoted: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      initialPrompt: 'Do something',
      context: [{ description: 'ctx', value: 'val' }],
      expectedOutcomes: ['Outcome 1'],
      ...overrides,
    });

    it('should map correct fields from TestCase to export format', () => {
      const testCases = [makeTestCase()];
      const result = convertTestCasesToExportFormat(testCases);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'Test Case',
        description: 'A test case',
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Do something',
        context: [{ description: 'ctx', value: 'val' }],
        expectedOutcomes: ['Outcome 1'],
      });
    });

    it('round-trips a fixture envelope through benchmark export and import validation', () => {
      const fixture = {
        type: 'filesystem-workspace',
        ref: 'cache-refactor',
        integrity: 'sha256:abc123',
        payload: { files: ['src/cache.ts'] },
      };

      const exported = convertTestCasesToExportFormat([makeTestCase({ fixture })]);
      const validation = validateTestCasesArrayJson(exported);

      expect(exported[0].fixture).toEqual(fixture);
      expect(validation.valid).toBe(true);
      expect(validation.data?.[0].fixture).toEqual(fixture);
    });

    it('should exclude system fields like id, labels, versions, createdAt', () => {
      const testCases = [makeTestCase()];
      const result = convertTestCasesToExportFormat(testCases);

      const exported = result[0] as any;
      expect(exported.id).toBeUndefined();
      expect(exported.labels).toBeUndefined();
      expect(exported.versions).toBeUndefined();
      expect(exported.createdAt).toBeUndefined();
      expect(exported.updatedAt).toBeUndefined();
      expect(exported.currentVersion).toBeUndefined();
      expect(exported.isPromoted).toBeUndefined();
    });

    it('should include subcategory when present', () => {
      const testCases = [makeTestCase({ subcategory: 'Network' })];
      const result = convertTestCasesToExportFormat(testCases);

      expect(result[0].subcategory).toBe('Network');
    });

    it('should not include subcategory when absent', () => {
      const testCases = [makeTestCase({ subcategory: undefined })];
      const result = convertTestCasesToExportFormat(testCases);

      expect(result[0]).not.toHaveProperty('subcategory');
    });

    it('should handle missing optional fields gracefully', () => {
      const testCases = [makeTestCase({
        description: '',
        context: undefined as any,
        expectedOutcomes: undefined as any,
      })];
      const result = convertTestCasesToExportFormat(testCases);

      expect(result[0].description).toBe('');
      expect(result[0].context).toEqual([]);
      expect(result[0].expectedOutcomes).toEqual([]);
    });

    it('should handle empty array', () => {
      const result = convertTestCasesToExportFormat([]);
      expect(result).toEqual([]);
    });

    it('should handle multiple test cases', () => {
      const testCases = [
        makeTestCase({ name: 'TC 1' }),
        makeTestCase({ name: 'TC 2' }),
        makeTestCase({ name: 'TC 3' }),
      ];
      const result = convertTestCasesToExportFormat(testCases);

      expect(result).toHaveLength(3);
      expect(result.map(r => r.name)).toEqual(['TC 1', 'TC 2', 'TC 3']);
    });

    it('should produce output that passes import validation (round-trip)', () => {
      const testCases = [makeTestCase({
        name: 'Round Trip Test',
        category: 'RCA',
        difficulty: 'Hard',
        initialPrompt: 'Test prompt',
        expectedOutcomes: ['Expected result'],
      })];

      const exported = convertTestCasesToExportFormat(testCases);
      const validation = validateTestCasesArrayJson(exported);

      expect(validation.valid).toBe(true);
      expect(validation.data).toHaveLength(1);
      expect(validation.data![0].name).toBe('Round Trip Test');
    });
  });

  describe('generateExportFilename', () => {
    it('should generate filename from benchmark name', () => {
      expect(generateExportFilename('My Benchmark')).toBe('my-benchmark.json');
    });

    it('should remove special characters', () => {
      expect(generateExportFilename('Test! @#$% Bench')).toBe('test-bench.json');
    });

    it('should collapse multiple spaces/dashes', () => {
      expect(generateExportFilename('Test   ---  Benchmark')).toBe('test-benchmark.json');
    });

    it('should handle empty name', () => {
      expect(generateExportFilename('')).toBe('benchmark-export.json');
    });

    it('should handle name with only special chars', () => {
      expect(generateExportFilename('!!!@@@###')).toBe('benchmark-export.json');
    });

    it('should trim whitespace', () => {
      expect(generateExportFilename('  spaced  ')).toBe('spaced.json');
    });

    it('should lowercase the output', () => {
      expect(generateExportFilename('UPPERCASE Name')).toBe('uppercase-name.json');
    });

    it('should preserve hyphens and underscores', () => {
      expect(generateExportFilename('my-bench_test')).toBe('my-bench_test.json');
    });
  });
});
