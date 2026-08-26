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
          // EvaluationRun (docType: 'evaluation-run') is stored as a top-level
          // doc in this same index, discriminated by docType (see
          // OpenSearchEvaluationRunOperations). Its `results` map is keyed by
          // testCaseId, so without an explicit non-dynamic mapping every
          // distinct testCaseId across every run ever created adds ~2-5 new
          // mapped fields (`results.<id>.reportId`, `.status`, `.keyword`
          // sub-fields, ...) to this index's *shared* field-count budget.
          // A single few-hundred-case run can add 1000+ fields; real incident
          // 2026-08-26 crashed mid-run at 243/400 test cases with
          // "Limit of total fields [5000] has been exceeded".
          //
          // `enabled: false` treats the whole subtree as an opaque blob:
          // still stored/returned in _source (reads/writes/painless partial
          // updates via `ctx._source.results.put(...)` are unaffected — see
          // OpenSearchEvaluationRunOperations.updateResult), just never
          // parsed into the mapping. This is a real trade-off, not a free
          // lunch: it permanently forfeits OpenSearch-side filter/sort/
          // aggregate on any `results.*` subfield for this index — that's
          // fine *today* because no query anywhere does that (all consumers
          // read the whole `results` object out of `_source` in JS and
          // filter/aggregate in application code), but a future feature
          // that wants to e.g. search across reportIds would need a
          // different field (or a reindex to a `flattened`/nested shape),
          // not a query against this one.
          //
          // Existing installs: OpenSearch rejects `enabled` changes on a
          // field that was already dynamically mapped with real sub-properties
          // (`mapper_exception: the [enabled] parameter can't be updated for
          // the object mapping [results]`), so `ensureIndexes()`'s best-effort
          // putMapping on an already-poisoned index (e.g. the shared cluster,
          // which already has 800+ dynamically-mapped results.* fields) fails
          // safely (caught, surfaced as a warning) and leaves the existing
          // mapping/data untouched — no crash, no reindex required. It fully
          // protects fresh indexes and any existing index that hasn't been
          // poisoned yet. Verified against a local disposable OpenSearch
          // 2.17.0 container (not the shared cluster): fresh index + 500
          // synthetic results stayed at 3 mapped fields; painless
          // `results.put()` partial updates and `docType.keyword` term
          // queries both continued to work unchanged.
          results: { type: 'object', enabled: false },
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
              status: { type: 'keyword' },
              error: { type: 'text' },
              agentEndpoint: { type: 'keyword' },
              concurrency: { type: 'long' },
              benchmarkVersion: { type: 'integer' },
              results: { type: 'object', enabled: false },
              testCaseSnapshots: { type: 'object', enabled: false },
              stats: { type: 'object', enabled: false },
              performanceMetrics: { type: 'object', enabled: false },
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
          sessionId: { type: 'keyword' },
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
          // Per-matcher verdicts captured by the SDK during the test body.
          // Stored as a nested array so we can filter / aggregate by
          // matcher.method or matcher.pass when needed.
          matcherResults: {
            type: 'nested',
            properties: {
              description: { type: 'text' },
              pass: { type: 'boolean' },
              method: { type: 'keyword' },
              durationMs: { type: 'integer' },
              actual: { type: 'object', enabled: false },
              expected: { type: 'object', enabled: false },
              errorMessage: { type: 'text' },
              score: { type: 'float' },
              reasoning: { type: 'text' },
              model: { type: 'keyword' },
              // llm-judge enriched fields (per-call equivalents of the
              // legacy report-level `improvementStrategies` and the rest
              // of `metrics`). See lib/matchers/types.ts.
              improvementStrategies: {
                type: 'nested',
                properties: {
                  category: { type: 'keyword' },
                  issue: { type: 'text' },
                  recommendation: { type: 'text' },
                  priority: { type: 'keyword' },
                },
              },
              judgeMetrics: {
                properties: {
                  accuracy: { type: 'float' },
                  faithfulness: { type: 'float' },
                  latency_score: { type: 'float' },
                  trajectory_alignment_score: { type: 'float' },
                },
              },
            },
          },
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
    [STORAGE_CONFIG.indexes.evaluators]: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 1,
      },
      mappings: {
        properties: {
          id: { type: 'keyword' },
          name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          description: { type: 'text' },
          isSystem: { type: 'boolean' },
          tags: { type: 'keyword' },
          currentVersion: { type: 'integer' },
          author: { type: 'keyword' },
          createdAt: { type: 'date' },
          updatedAt: { type: 'date' },
          systemPrompt: { type: 'text' },
          scoringConfig: {
            properties: {
              metrics: {
                type: 'nested',
                properties: {
                  name: { type: 'keyword' },
                  description: { type: 'text' },
                  weight: { type: 'float' },
                  scale: { type: 'float' },
                },
              },
              passThreshold: { type: 'float' },
              scale: { type: 'float' },
            },
          },
          inferenceConfig: {
            properties: {
              provider: { type: 'keyword' },
              modelId: { type: 'keyword' },
              temperature: { type: 'float' },
              maxTokens: { type: 'integer' },
            },
          },
          versions: {
            type: 'nested',
            properties: {
              version: { type: 'integer' },
              createdAt: { type: 'date' },
              systemPrompt: { type: 'text' },
              scoringConfig: { type: 'object', enabled: false },
              inferenceConfig: { type: 'object', enabled: false },
            },
          },
        },
      },
    },
  };
}

// Export as constant for convenience
export const INDEX_MAPPINGS = getIndexMappings();

export default INDEX_MAPPINGS;
