/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for JSON import functionality
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=import.integration
 */

import { asyncTestCaseStorage } from '@/services/storage/asyncTestCaseStorage';
import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { storageAdmin } from '@/services/storage/opensearchClient';
import { validateTestCasesArrayJson, validateTestCaseJson } from '@/lib/testCaseValidation';

// Skip tests if backend is not running
const checkBackend = async (): Promise<boolean> => {
  try {
    const health = await storageAdmin.health();
    return health.status === 'connected';
  } catch {
    return false;
  }
};

describe('Test Case Import Integration', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdBenchmarkIds: string[] = [];

  // Sample test cases matching the JSON schema
  const sampleTestCases = [
    {
      name: 'Import Test: Checkout Service',
      description: 'Integration test case 1',
      category: 'RCA',
      difficulty: 'Easy' as const,
      initialPrompt: 'Test prompt for checkout service investigation',
      context: [
        {
          description: 'Test Context',
          value: 'Sample context value',
        },
      ],
      expectedOutcomes: ['Expected outcome 1', 'Expected outcome 2'],
    },
    {
      name: 'Import Test: Latency Spike',
      description: 'Integration test case 2',
      category: 'RCA',
      difficulty: 'Medium' as const,
      initialPrompt: 'Test prompt for latency investigation',
      context: [],
      expectedOutcomes: ['Expected outcome for latency'],
    },
  ];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
    }
  });

  afterAll(async () => {
    if (!backendAvailable) return;

    // Cleanup: delete created test cases and benchmarks by tracked ID
    for (const id of createdTestCaseIds) {
      try {
        await asyncTestCaseStorage.delete(id);
      } catch {
        // Ignore cleanup errors
      }
    }

    for (const id of createdBenchmarkIds) {
      try {
        await asyncBenchmarkStorage.delete(id);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Fallback: clean up leftovers from previous failed runs by name
    try {
      const testCaseNames = [
        ...sampleTestCases.map(tc => tc.name),
        'Single Import Test',
        'Benchmark Import Test',
        'Multi Test 1',
        'Multi Test 2',
        'Multi Test 3',
        'Duplicate Name Test',
      ];
      const allTestCases = await asyncTestCaseStorage.getAll();
      for (const tc of allTestCases) {
        if (testCaseNames.includes(tc.name)) {
          await asyncTestCaseStorage.delete(tc.id).catch(() => {});
        }
      }
      const benchmarkNames = [
        'OTEL Demo Benchmark (Import Test)',
        'Multi Test Case Benchmark',
      ];
      const allBenchmarks = await asyncBenchmarkStorage.getAll();
      for (const b of allBenchmarks) {
        if (benchmarkNames.includes(b.name)) {
          await asyncBenchmarkStorage.delete(b.id).catch(() => {});
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('validateTestCasesArrayJson', () => {
    it('should validate valid test case array', () => {
      const result = validateTestCasesArrayJson(sampleTestCases);
      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    it('should reject test case missing required category field', () => {
      const invalid = [
        {
          name: 'Missing category',
          difficulty: 'Easy',
          initialPrompt: 'Test',
          expectedOutcomes: ['Outcome'],
        },
      ];
      const result = validateTestCasesArrayJson(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject test case missing required difficulty field', () => {
      const invalid = [
        {
          name: 'Missing difficulty',
          category: 'RCA',
          initialPrompt: 'Test',
          expectedOutcomes: ['Outcome'],
        },
      ];
      const result = validateTestCasesArrayJson(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject test case with invalid difficulty value', () => {
      const invalid = [
        {
          name: 'Invalid difficulty',
          category: 'RCA',
          difficulty: 'SuperHard', // Invalid value
          initialPrompt: 'Test',
          expectedOutcomes: ['Outcome'],
        },
      ];
      const result = validateTestCasesArrayJson(invalid);
      expect(result.valid).toBe(false);
    });

    it('should accept single object and wrap in array', () => {
      const single = sampleTestCases[0];
      const result = validateTestCasesArrayJson(single);
      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should validate all three difficulty levels', () => {
      const difficulties = ['Easy', 'Medium', 'Hard'] as const;
      difficulties.forEach((difficulty) => {
        const testCase = {
          name: `Test ${difficulty}`,
          category: 'RCA',
          difficulty,
          initialPrompt: 'Test',
          expectedOutcomes: ['Outcome'],
        };
        const result = validateTestCasesArrayJson([testCase]);
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('validateTestCaseJson (single)', () => {
    it('should validate single test case', () => {
      const result = validateTestCaseJson(sampleTestCases[0]);
      expect(result.valid).toBe(true);
      expect(result.data?.name).toBe('Import Test: Checkout Service');
    });

    it('should return error for array input (should use bulk import)', () => {
      const arrayInput = [sampleTestCases[0]];
      const result = validateTestCaseJson(arrayInput);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Bulk Import');
    });

    it('accepts test cases with no non-empty expected outcomes (cross-surface parity)', () => {
      // Cross-surface parity (commit fd984c9e): SDK code-only tests have no
      // `expectedOutcomes` and UI-form mirrors of those tests must be allowed
      // to persist with the same shape. See lib/testCaseValidation.ts.
      const testCaseWithEmptyOutcomes = {
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy' as const,
        initialPrompt: 'Test',
        expectedOutcomes: ['', '   '],
      };
      const result = validateTestCaseJson(testCaseWithEmptyOutcomes);
      expect(result.valid).toBe(true);

      const omittedOutcomes = {
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy' as const,
        initialPrompt: 'Test',
      };
      const result2 = validateTestCaseJson(omittedOutcomes);
      expect(result2.valid).toBe(true);
    });
  });

  describe('bulkCreate test cases', () => {
    it('should create multiple test cases via API', async () => {
      if (!backendAvailable) return;

      const result = await asyncTestCaseStorage.bulkCreate(sampleTestCases);

      expect(result.created).toBe(2);
      expect(result.errors).toBe(false);

      // Track created test cases for cleanup by matching names
      const allTestCases = await asyncTestCaseStorage.getAll();
      allTestCases
        .filter((tc) => sampleTestCases.some((d) => d.name === tc.name))
        .forEach((tc) => {
          if (!createdTestCaseIds.includes(tc.id)) {
            createdTestCaseIds.push(tc.id);
          }
        });
    });

    it('should create test case with tc- prefix ID', async () => {
      if (!backendAvailable) return;

      // Use individual create to get the ID
      const testCase = await asyncTestCaseStorage.create({
        name: 'Single Import Test',
        category: 'RCA',
        difficulty: 'Easy' as const,
        initialPrompt: 'Test prompt',
        context: [],
        expectedOutcomes: ['Expected outcome'],
      });

      expect(testCase.id).toMatch(/^tc-/);
      createdTestCaseIds.push(testCase.id);
    });
  });

  describe('benchmark creation from imported test cases', () => {
    it('should create benchmark with test case IDs', async () => {
      if (!backendAvailable) return;

      // Create test case using individual create to get ID
      const testCase = await asyncTestCaseStorage.create({
        name: 'Benchmark Import Test',
        category: 'RCA',
        difficulty: 'Hard' as const,
        initialPrompt: 'Test prompt for benchmark',
        context: [],
        expectedOutcomes: ['Expected outcome'],
      });

      createdTestCaseIds.push(testCase.id);

      // Create benchmark with that test case ID
      const benchmark = await asyncBenchmarkStorage.create({
        name: 'OTEL Demo Benchmark (Import Test)',
        description: 'Auto-created from import integration test',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            createdAt: new Date().toISOString(),
            testCaseIds: [testCase.id],
          },
        ],
        testCaseIds: [testCase.id],
        runs: [],
      });

      expect(benchmark.id).toMatch(/^bench-/);
      expect(benchmark.name).toBe('OTEL Demo Benchmark (Import Test)');
      expect(benchmark.testCaseIds).toEqual([testCase.id]);

      createdBenchmarkIds.push(benchmark.id);
    });

    it('should create benchmark with multiple test cases', async () => {
      if (!backendAvailable) return;

      // Create multiple test cases individually to get IDs
      const testCaseIds: string[] = [];

      const tc1 = await asyncTestCaseStorage.create({
        name: 'Multi Test 1',
        category: 'RCA',
        difficulty: 'Easy' as const,
        initialPrompt: 'Prompt 1',
        context: [],
        expectedOutcomes: ['Outcome 1'],
      });
      testCaseIds.push(tc1.id);
      createdTestCaseIds.push(tc1.id);

      const tc2 = await asyncTestCaseStorage.create({
        name: 'Multi Test 2',
        category: 'Alerts',
        difficulty: 'Medium' as const,
        initialPrompt: 'Prompt 2',
        context: [],
        expectedOutcomes: ['Outcome 2'],
      });
      testCaseIds.push(tc2.id);
      createdTestCaseIds.push(tc2.id);

      const tc3 = await asyncTestCaseStorage.create({
        name: 'Multi Test 3',
        category: 'RCA',
        difficulty: 'Hard' as const,
        initialPrompt: 'Prompt 3',
        context: [],
        expectedOutcomes: ['Outcome 3'],
      });
      testCaseIds.push(tc3.id);
      createdTestCaseIds.push(tc3.id);

      // Create benchmark
      const benchmark = await asyncBenchmarkStorage.create({
        name: 'Multi Test Case Benchmark',
        description: 'Benchmark with multiple test cases',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            createdAt: new Date().toISOString(),
            testCaseIds,
          },
        ],
        testCaseIds,
        runs: [],
      });

      expect(benchmark.testCaseIds).toHaveLength(3);
      createdBenchmarkIds.push(benchmark.id);
    });
  });

  describe('import does not deduplicate', () => {
    it('should create new test cases even with same name', async () => {
      if (!backendAvailable) return;

      const testCaseData = {
        name: 'Duplicate Name Test',
        category: 'RCA',
        difficulty: 'Easy' as const,
        initialPrompt: 'Test prompt',
        context: [],
        expectedOutcomes: ['Expected outcome'],
      };

      // Create same test case twice using individual create
      const tc1 = await asyncTestCaseStorage.create(testCaseData);
      const tc2 = await asyncTestCaseStorage.create(testCaseData);

      // Both should create successfully with different IDs
      expect(tc1.id).not.toBe(tc2.id);
      expect(tc1.id).toMatch(/^tc-/);
      expect(tc2.id).toMatch(/^tc-/);

      createdTestCaseIds.push(tc1.id, tc2.id);
    });
  });
});
