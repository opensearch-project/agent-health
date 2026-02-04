/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Benchmark for Demo Mode
 *
 * Pre-configured benchmark with a completed run showcasing evaluation results.
 * Always visible alongside real benchmarks - IDs prefixed with 'demo-'.
 */

import type { Benchmark } from '../../types/index.js';

export const SAMPLE_BENCHMARKS: Benchmark[] = [
  {
    id: 'demo-exp-001',
    name: 'RCA Agent Evaluation - Demo',
    description: 'Pre-loaded demo benchmark showcasing 5 RCA scenarios with a completed baseline run.',
    createdAt: '2024-01-15T10:00:00.000Z',
    updatedAt: '2024-01-15T10:30:00.000Z',
    currentVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: '2024-01-15T10:00:00.000Z',
        testCaseIds: [
          'demo-otel-001',
          'demo-otel-002',
          'demo-otel-003',
          'demo-otel-004',
          'demo-otel-005',
        ],
      },
    ],
    testCaseIds: [
      'demo-otel-001',
      'demo-otel-002',
      'demo-otel-003',
      'demo-otel-004',
      'demo-otel-005',
    ],
    runs: [
      {
        id: 'demo-run-001',
        name: 'Baseline Run',
        description: 'Initial evaluation with Claude 3.5 Sonnet',
        createdAt: '2024-01-15T10:05:00.000Z',
        status: 'completed',
        benchmarkVersion: 1,
        testCaseSnapshots: [
          { id: 'demo-otel-001', version: 1, name: 'Service Latency Spike Analysis' },
          { id: 'demo-otel-002', version: 1, name: 'Database Connection Pool Exhaustion' },
          { id: 'demo-otel-003', version: 1, name: 'Memory Leak Detection' },
          { id: 'demo-otel-004', version: 1, name: 'API Gateway Timeout Investigation' },
          { id: 'demo-otel-005', version: 1, name: 'Distributed Tracing Gap Analysis' },
        ],
        agentKey: 'ml-commons',
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        results: {
          'demo-otel-001': { reportId: 'demo-report-001', status: 'completed' },
          'demo-otel-002': { reportId: 'demo-report-002', status: 'completed' },
          'demo-otel-003': { reportId: 'demo-report-003', status: 'completed' },
          'demo-otel-004': { reportId: 'demo-report-004', status: 'completed' },
          'demo-otel-005': { reportId: 'demo-report-005', status: 'completed' },
        },
      },
    ],
  },
  // Alias benchmark with simpler name for CLI usage
  {
    id: 'demo-baseline',
    name: 'Baseline',
    description: 'Quick baseline benchmark with 3 core RCA scenarios for agent comparison.',
    createdAt: '2024-01-15T10:00:00.000Z',
    updatedAt: '2024-01-15T10:00:00.000Z',
    currentVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: '2024-01-15T10:00:00.000Z',
        testCaseIds: [
          'demo-otel-001',
          'demo-otel-002',
          'demo-otel-003',
        ],
      },
    ],
    testCaseIds: [
      'demo-otel-001',
      'demo-otel-002',
      'demo-otel-003',
    ],
    runs: [],
  },
];

/**
 * Get a sample benchmark by ID
 */
export function getSampleBenchmark(id: string): Benchmark | undefined {
  return SAMPLE_BENCHMARKS.find(bench => bench.id === id);
}

/**
 * Get all sample benchmarks
 */
export function getAllSampleBenchmarks(): Benchmark[] {
  return [...SAMPLE_BENCHMARKS];
}

/**
 * Check if an ID is a sample benchmark
 */
export function isSampleBenchmarkId(id: string): boolean {
  return id.startsWith('demo-exp-') || id.startsWith('demo-run-') || id.startsWith('demo-bench-');
}

// Backwards compatibility aliases
/** @deprecated Use SAMPLE_BENCHMARKS instead */
export const SAMPLE_EXPERIMENTS = SAMPLE_BENCHMARKS;
/** @deprecated Use getSampleBenchmark instead */
export const getSampleExperiment = getSampleBenchmark;
/** @deprecated Use getAllSampleBenchmarks instead */
export const getAllSampleExperiments = getAllSampleBenchmarks;
/** @deprecated Use isSampleBenchmarkId instead */
export const isSampleExperimentId = isSampleBenchmarkId;
