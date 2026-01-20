/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenSearch Index Mappings
 * Defines the schema for all storage indexes
 */

import { STORAGE_CONFIG } from '../config';

// ============================================================================
// Type Definitions for Index Mappings
// ============================================================================

interface IndexMapping {
  settings?: {
    number_of_shards?: number;
    number_of_replicas?: number;
    'index.mapping.total_fields.limit'?: number;
  };
  mappings: {
    dynamic_templates?: Array<{
      [key: string]: {
        match_pattern?: string;
        match?: string;
        mapping?: any;
      };
    }>;
    properties: Record<string, any>;
  };
}

type IndexMappings = Record<string, IndexMapping>;

// ============================================================================
// Index Mappings
// ============================================================================

/**
 * Get all index mappings for OpenSearch storage
 * Keys are dynamically generated from STORAGE_CONFIG.indexes
 */
export function getIndexMappings(): IndexMappings {
  return {
    [STORAGE_CONFIG.indexes.testCases]: {
      mappings: {
        properties: {
          id: { type: 'keyword' },
          name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          version: { type: 'integer' },
          initialPrompt: { type: 'text' },
          tools: { type: 'object', enabled: false },
          messages: { type: 'object', enabled: false },
          context: { type: 'object', enabled: false },
          forwardedProps: { type: 'object', enabled: false },
          expectedOutcome: { type: 'text' },
          expectedTrajectory: { type: 'object', enabled: false },
          category: { type: 'keyword' },
          difficulty: { type: 'keyword' },
          tags: { type: 'keyword' },
          author: { type: 'keyword' },
          createdAt: { type: 'date' },
          updatedAt: { type: 'date' },
        },
      },
    },
    [STORAGE_CONFIG.indexes.benchmarks]: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.mapping.total_fields.limit': 5000, // Increased for dynamic testCaseSnapshots and results fields
      },
      mappings: {
        properties: {
          id: { type: 'keyword' },
          name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          description: { type: 'text' },
          author: { type: 'keyword' },
          createdAt: { type: 'date' },
          llmJudgePrompt: { type: 'text' },
          testCaseIds: { type: 'keyword' },
          runs: {
            type: 'nested',
            properties: {
              id: { type: 'keyword' },
              name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
              description: { type: 'text' },
              agentId: { type: 'keyword' },
              modelId: { type: 'keyword' },
              headers: { type: 'object', enabled: false },
              iterationCount: { type: 'integer' },
              createdAt: { type: 'date' },
            },
          },
        },
      },
    },
    [STORAGE_CONFIG.indexes.runs]: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
        'index.mapping.total_fields.limit': 2000, // Increase from default 1000 for complex reports
      },
      mappings: {
        properties: {
          id: { type: 'keyword' },
          name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          description: { type: 'text' },
          // Note: Field names experimentId and experimentRunId preserved for data compatibility.
          // These store benchmark/benchmarkRun IDs but use legacy field names in OpenSearch.
          experimentId: { type: 'keyword' },
          experimentRunId: { type: 'keyword' },
          testCaseId: { type: 'keyword' },
          testCaseVersionId: { type: 'keyword' },
          agentId: { type: 'keyword' },
          modelId: { type: 'keyword' },
          iteration: { type: 'integer' },
          author: { type: 'keyword' },
          createdAt: { type: 'date' },
          status: { type: 'keyword' },
          passFailStatus: { type: 'keyword' },
          traceId: { type: 'keyword' },
          tags: { type: 'keyword' },
          actualOutcomes: { type: 'object', enabled: false },
          llmJudgeReasoning: { type: 'text' },
          metrics: {
            properties: {
              accuracy: { type: 'float' },
              faithfulness: { type: 'float' },
              latency_score: { type: 'float' },
              trajectory_alignment_score: { type: 'float' },
            },
          },
          annotations: {
            type: 'nested',
            properties: {
              id: { type: 'keyword' },
              text: { type: 'text' },
              createdAt: { type: 'date' },
              updatedAt: { type: 'date' },
              tags: { type: 'keyword' },
              author: { type: 'keyword' },
            },
          },
          trajectory: { type: 'object', enabled: false },
          logs: { type: 'object', enabled: false },
          rawEvents: { type: 'object', enabled: false },
          improvementStrategies: { type: 'object', enabled: false },
          spans: { type: 'object', enabled: false },
          metricsStatus: { type: 'keyword' },
          traceFetchAttempts: { type: 'integer' },
          lastTraceFetchAt: { type: 'date' },
          traceError: { type: 'text' },
        },
      },
    },
    [STORAGE_CONFIG.indexes.analytics]: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
      },
      mappings: {
        dynamic_templates: [
          {
            metrics_template: {
              match_pattern: 'regex',
              match: '^metric_.*',
              mapping: { type: 'double' },
            },
          },
        ],
        properties: {
          analyticsId: { type: 'keyword' },
          runId: { type: 'keyword' },
          experimentId: { type: 'keyword' },
          experimentRunId: { type: 'keyword' },
          testCaseId: { type: 'keyword' },
          testCaseVersionId: { type: 'keyword' },
          traceId: { type: 'keyword' },
          experimentName: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
          testCaseName: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
          testCaseCategory: { type: 'keyword' },
          testCaseDifficulty: { type: 'keyword' },
          agentId: { type: 'keyword' },
          modelId: { type: 'keyword' },
          iteration: { type: 'integer' },
          tags: { type: 'keyword' },
          passFailStatus: { type: 'keyword' },
          status: { type: 'keyword' },
          createdAt: { type: 'date' },
          author: { type: 'keyword' },
          inputsSnapshot: { type: 'object', enabled: false },
          outputsSnapshot: { type: 'object', enabled: false },
        },
      },
    },
  };
}

// Export as constant for convenience
export const INDEX_MAPPINGS = getIndexMappings();

export default INDEX_MAPPINGS;
