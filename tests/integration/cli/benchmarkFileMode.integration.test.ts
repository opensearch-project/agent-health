/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for benchmark command file mode.
 *
 * Tests the full flow: load JSON file → validate → bulk create → create benchmark.
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=benchmarkFileMode.integration
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ApiClient } from '@/cli/utils/apiClient';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';

const TEST_TIMEOUT = 30000;
const BASE_URL = process.env.TEST_BACKEND_URL || 'http://localhost:4001';

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('Benchmark File Mode Integration', () => {
  let backendAvailable = false;
  let client: ApiClient;
  let tempDir: string;
  const createdBenchmarkIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
    }
    client = new ApiClient(BASE_URL);
    tempDir = join(tmpdir(), `benchmark-file-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Clean up temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    // Clean up created benchmarks (test cases are left for cleanup by the server)
    if (!backendAvailable) return;
    for (const id of createdBenchmarkIds) {
      try {
        await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  }, TEST_TIMEOUT);

  // --- File loading and validation (no backend needed) ---

  describe('loadAndValidateTestCasesFile logic', () => {
    it('should validate the bundled OTEL benchmark file', () => {
      const filePath = join(__dirname, '../../../cli/demo/otel-benchmark-test-cases.json');
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = validateTestCasesArrayJson(parsed);

      expect(result.valid).toBe(true);
      expect(result.data!.length).toBe(3);
      expect(result.data!.map(tc => tc.difficulty)).toEqual(['Easy', 'Medium', 'Hard']);
    });

    it('should validate a custom test cases file written to temp dir', () => {
      const testCases = [
        {
          name: 'Custom Observability Test',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Investigate the alert',
          expectedOutcomes: ['Check logs', 'Find root cause'],
        },
      ];
      const filePath = join(tempDir, 'custom-test-cases.json');
      writeFileSync(filePath, JSON.stringify(testCases, null, 2));

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = validateTestCasesArrayJson(parsed);

      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should reject a file with invalid schema', () => {
      const invalid = [{ title: 'Wrong field names', priority: 'High' }];
      const filePath = join(tempDir, 'invalid-test-cases.json');
      writeFileSync(filePath, JSON.stringify(invalid));

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = validateTestCasesArrayJson(parsed);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should auto-wrap a single object from file', () => {
      const single = {
        name: 'Single Test Case',
        category: 'Alerts',
        difficulty: 'Medium',
        initialPrompt: 'Check alert severity',
        expectedOutcomes: ['Classify alert'],
      };
      const filePath = join(tempDir, 'single-test-case.json');
      writeFileSync(filePath, JSON.stringify(single));

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = validateTestCasesArrayJson(parsed);

      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].name).toBe('Single Test Case');
    });
  });

  // --- Full flow with backend (bulk create + benchmark creation) ---

  describe('file mode end-to-end (requires backend)', () => {
    it('should bulk-create test cases and create benchmark from a file', async () => {
      if (!backendAvailable) return;

      // 1. Read and validate test cases from file
      const testCases = [
        {
          name: `IntegTest: Service Latency ${Date.now()}`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Investigate p99 latency spike in checkout-service',
          context: [
            { description: 'Cluster', value: 'prod-us-east-1' },
          ],
          expectedOutcomes: [
            'Query trace data for high-latency spans',
            'Identify bottleneck service',
          ],
        },
        {
          name: `IntegTest: Error Rate Spike ${Date.now()}`,
          category: 'RCA',
          difficulty: 'Medium',
          initialPrompt: 'Error rate for payment-service jumped from 0.1% to 15%',
          expectedOutcomes: [
            'Query error spans in payment-service',
            'Find root cause of errors',
          ],
        },
      ];

      const filePath = join(tempDir, 'integ-test-cases.json');
      writeFileSync(filePath, JSON.stringify(testCases, null, 2));

      // Validate
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const validation = validateTestCasesArrayJson(parsed);
      expect(validation.valid).toBe(true);

      // 2. Bulk create via API
      const bulkResult = await client.bulkCreateTestCases(validation.data!);
      expect(bulkResult.created).toBe(2);
      expect(bulkResult.testCases).toHaveLength(2);
      expect(bulkResult.testCases[0].id).toBeTruthy();
      expect(bulkResult.testCases[1].id).toBeTruthy();

      // 3. Create benchmark from returned IDs
      try {
        const benchmark = await client.createBenchmark({
          name: `File Mode IntegTest ${Date.now()}`,
          description: 'Created by integration test',
          testCaseIds: bulkResult.testCases.map(tc => tc.id),
        });

        expect(benchmark.id).toBeTruthy();
        expect(benchmark.testCaseIds).toHaveLength(2);
        createdBenchmarkIds.push(benchmark.id);
      } catch (err) {
        // Benchmark index may be write-blocked in some environments
        if (String(err).includes('cluster_block_exception')) {
          console.warn('Benchmark index write-blocked, skipping benchmark creation assertion');
        } else {
          throw err;
        }
      }
    }, TEST_TIMEOUT);

    it('should handle the bundled OTEL demo file end-to-end', async () => {
      if (!backendAvailable) return;

      // Read the bundled sample file
      const filePath = join(__dirname, '../../../cli/demo/otel-benchmark-test-cases.json');
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Validate
      const validation = validateTestCasesArrayJson(parsed);
      expect(validation.valid).toBe(true);

      // Bulk create
      const bulkResult = await client.bulkCreateTestCases(validation.data!);
      expect(bulkResult.created).toBe(3);
      expect(bulkResult.testCases).toHaveLength(3);

      // Create benchmark
      try {
        const benchmark = await client.createBenchmark({
          name: `OTEL Demo IntegTest ${Date.now()}`,
          description: 'OTEL demo test cases imported from file',
          testCaseIds: bulkResult.testCases.map(tc => tc.id),
        });

        expect(benchmark.id).toBeTruthy();
        expect(benchmark.testCaseIds).toHaveLength(3);
        createdBenchmarkIds.push(benchmark.id);
      } catch (err) {
        if (String(err).includes('cluster_block_exception')) {
          console.warn('Benchmark index write-blocked, skipping benchmark creation assertion');
        } else {
          throw err;
        }
      }
    }, TEST_TIMEOUT);

    it('should return test cases with server-assigned IDs from bulk create', async () => {
      if (!backendAvailable) return;

      const testCases = [
        {
          name: `ID Test ${Date.now()}`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Test prompt',
          expectedOutcomes: ['Outcome'],
        },
      ];

      const bulkResult = await client.bulkCreateTestCases(testCases);

      // Verify server assigned an ID (the test case didn't have one)
      expect(bulkResult.testCases[0].id).toBeTruthy();
      expect(bulkResult.testCases[0].id).not.toBe('');

      // Verify the ID follows expected pattern
      expect(bulkResult.testCases[0].id).toMatch(/^tc-/);

      // Verify we can list and find the created test case
      const allTestCases = await client.listTestCases();
      const found = allTestCases.find(tc => tc.id === bulkResult.testCases[0].id);
      expect(found).toBeTruthy();
    }, TEST_TIMEOUT);
  });
});
