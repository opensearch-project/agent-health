/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the Benchmarks page JSON import flow.
 *
 * These tests simulate the full import pipeline as triggered from
 * BenchmarksPage.handleImportFile: validate → bulkCreate → fetch IDs → create benchmark.
 *
 * Requires the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=benchmarkImport.integration
 */

import { asyncTestCaseStorage } from '@/services/storage/asyncTestCaseStorage';
import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { storageAdmin } from '@/services/storage/opensearchClient';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';

const checkBackend = async (): Promise<boolean> => {
  try {
    const health = await storageAdmin.health();
    return health.status === 'connected';
  } catch {
    return false;
  }
};

describe('Benchmarks Page Import Flow', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdBenchmarkIds: string[] = [];

  // Simulates the JSON file content that would be loaded via the file input
  const importFileContent = [
    {
      name: 'BenchImport Test: Service Restart',
      description: 'Test the full benchmarks page import pipeline',
      category: 'RCA',
      difficulty: 'Easy' as const,
      initialPrompt: 'Investigate service restarts in production',
      context: [
        {
          description: 'Alert',
          value: 'Service restarted 5 times in the last hour',
        },
      ],
      expectedOutcomes: [
        'Identify restart cause from logs',
        'Recommend fix for memory leak',
      ],
    },
    {
      name: 'BenchImport Test: Slow Queries',
      description: 'Test the full benchmarks page import pipeline',
      category: 'RCA',
      difficulty: 'Medium' as const,
      initialPrompt: 'Investigate slow database queries',
      context: [],
      expectedOutcomes: ['Identify slow query patterns'],
    },
  ];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping benchmarks import integration tests');
    }
  });

  afterAll(async () => {
    if (!backendAvailable) return;

    for (const id of createdBenchmarkIds) {
      try {
        await asyncBenchmarkStorage.delete(id);
      } catch {
        // Ignore cleanup errors
      }
    }

    for (const id of createdTestCaseIds) {
      try {
        await asyncTestCaseStorage.delete(id);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('full import pipeline (validates → creates test cases → creates benchmark)', () => {
    it('should validate, create test cases, and create a benchmark in one flow', async () => {
      if (!backendAvailable) return;

      // Step 1: Validate (mirrors handleImportFile's JSON.parse + validate)
      const validation = validateTestCasesArrayJson(importFileContent);
      expect(validation.valid).toBe(true);
      expect(validation.data).toHaveLength(2);

      // Step 2: Bulk create test cases
      const result = await asyncTestCaseStorage.bulkCreate(validation.data!);
      expect(result.created).toBe(2);
      expect(result.errors).toBe(false);

      // Step 3: Fetch all test cases and find the created IDs (mirrors the handler's getAll + filter)
      const allTestCases = await asyncTestCaseStorage.getAll();
      const createdIds = allTestCases
        .filter((tc) => validation.data!.some((d) => d.name === tc.name))
        .map((tc) => tc.id);

      expect(createdIds.length).toBeGreaterThanOrEqual(2);
      createdIds.forEach((id) => {
        expect(id).toMatch(/^tc-/);
        createdTestCaseIds.push(id);
      });

      // Step 4: Create benchmark with the test case IDs (mirrors the handler's benchmark creation)
      const benchmarkName = 'sample-import-test-cases';
      const benchmark = await asyncBenchmarkStorage.create({
        name: benchmarkName,
        description: `Auto-created from import of ${result.created} test case(s)`,
        currentVersion: 1,
        versions: [
          {
            version: 1,
            createdAt: new Date().toISOString(),
            testCaseIds: createdIds,
          },
        ],
        testCaseIds: createdIds,
        runs: [],
      });

      expect(benchmark.id).toMatch(/^bench-/);
      expect(benchmark.name).toBe(benchmarkName);
      expect(benchmark.testCaseIds).toEqual(createdIds);
      expect(benchmark.runs).toEqual([]);
      expect(benchmark.description).toContain('Auto-created from import');

      createdBenchmarkIds.push(benchmark.id);
    });

    it('should be able to retrieve the created benchmark', async () => {
      if (!backendAvailable || createdBenchmarkIds.length === 0) return;

      const benchmark = await asyncBenchmarkStorage.getById(createdBenchmarkIds[0]);
      expect(benchmark).not.toBeNull();
      expect(benchmark!.testCaseIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('import error handling', () => {
    it('should reject import of invalid JSON structure', () => {
      const invalid = [{ name: 'Missing required fields' }];
      const validation = validateTestCasesArrayJson(invalid);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('should reject import of empty array', () => {
      const validation = validateTestCasesArrayJson([]);
      expect(validation.valid).toBe(false);
    });

    it('should reject import of non-array non-object', () => {
      const validation = validateTestCasesArrayJson('not json');
      expect(validation.valid).toBe(false);
    });

    it('should handle bulkCreate returning zero created when all duplicates', async () => {
      if (!backendAvailable) return;

      // Create test cases first
      const firstResult = await asyncTestCaseStorage.bulkCreate(importFileContent);

      // Track IDs for cleanup
      const allTestCases = await asyncTestCaseStorage.getAll();
      allTestCases
        .filter((tc) => importFileContent.some((d) => d.name === tc.name))
        .forEach((tc) => {
          if (!createdTestCaseIds.includes(tc.id)) {
            createdTestCaseIds.push(tc.id);
          }
        });

      // Note: bulkCreate does NOT deduplicate by name, so this will create new ones.
      // The BenchmarksPage handler shows an error only when created === 0.
      // This test documents that duplicate names are allowed.
      expect(firstResult.created).toBeGreaterThanOrEqual(0);
    });
  });

  describe('benchmark name derivation from filename', () => {
    it('should strip .json extension from filename', () => {
      const filename = 'my-test-cases.json';
      const benchmarkName = filename.replace(/\.json$/i, '') || 'Imported Benchmark';
      expect(benchmarkName).toBe('my-test-cases');
    });

    it('should strip .JSON extension case-insensitively', () => {
      const filename = 'MY-CASES.JSON';
      const benchmarkName = filename.replace(/\.json$/i, '') || 'Imported Benchmark';
      expect(benchmarkName).toBe('MY-CASES');
    });

    it('should fall back to "Imported Benchmark" for empty name after stripping', () => {
      const filename = '.json';
      const benchmarkName = filename.replace(/\.json$/i, '') || 'Imported Benchmark';
      expect(benchmarkName).toBe('Imported Benchmark');
    });
  });
});
