/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-side Storage Services
 *
 * Core OpenSearch operations extracted from routes.
 * Used by both routes and server-side code like experimentRunner.
 *
 * Storage is optional - when OpenSearch is not configured, these functions
 * throw errors. Routes should check isStorageConfigured() first and use
 * sample data when storage is unavailable.
 */

import { getOpenSearchClient, INDEXES, isStorageConfigured } from '../opensearchClient.js';
import type { Client } from '@opensearch-project/opensearch';

// Re-export for convenience
export { isStorageConfigured };

// ==================== Test Cases ====================

/**
 * Get all test cases (latest versions) with an explicit client
 * Used by code that has the client from middleware or passed as parameter
 */
export async function getAllTestCasesWithClient(client: Client): Promise<any[]> {
  const result = await client.search({
    index: INDEXES.testCases,
    body: {
      size: 0,
      aggs: {
        test_cases: {
          terms: { field: 'id', size: 10000 },
          aggs: {
            latest: {
              top_hits: { size: 1, sort: [{ version: { order: 'desc' } }] },
            },
          },
        },
      },
    },
  });

  return (
    (result.body.aggregations?.test_cases as any)?.buckets?.map(
      (bucket: any) => bucket.latest.hits.hits[0]._source
    ) || []
  );
}

/**
 * Get all test cases (latest versions)
 * Throws if storage is not configured
 * @deprecated Use getAllTestCasesWithClient with request-scoped client
 */
export async function getAllTestCases(): Promise<any[]> {
  const client = getOpenSearchClient();
  if (!client) {
    throw new Error('Storage not configured');
  }
  return getAllTestCasesWithClient(client);
}

/**
 * Get test case by ID (latest version)
 * Throws if storage is not configured
 */
export async function getTestCaseById(id: string): Promise<any | null> {
  const client = getOpenSearchClient();
  if (!client) {
    throw new Error('Storage not configured');
  }

  const result = await client.search({
    index: INDEXES.testCases,
    body: {
      size: 1,
      sort: [{ version: { order: 'desc' } }],
      query: { term: { id } },
    },
  });

  return result.body.hits?.hits?.[0]?._source || null;
}

// ==================== Runs ====================

/**
 * Create a run with an explicit client
 * Used by routes that have the client from middleware
 */
export async function createRunWithClient(client: Client, run: any): Promise<any> {
  const id = run.id || generateId('run');
  const createdAt = new Date().toISOString();

  const doc = {
    ...run,
    id,
    createdAt,
    annotations: run.annotations || [],
  };

  await client.index({
    index: INDEXES.runs,
    id,
    body: doc,
    refresh: true,
  });

  // Write analytics (non-blocking)
  writeAnalyticsRecordWithClient(client, doc).catch((e) =>
    console.warn('[StorageService] Analytics write failed:', e.message)
  );

  return doc;
}

/**
 * Create a run
 * Throws if storage is not configured
 * @deprecated Use createRunWithClient with request-scoped client
 */
export async function createRun(run: any): Promise<any> {
  const client = getOpenSearchClient();
  if (!client) {
    throw new Error('Storage not configured');
  }
  return createRunWithClient(client, run);
}

/**
 * Get run by ID with an explicit client
 * Used by routes that have the client from middleware
 */
export async function getRunByIdWithClient(client: Client, id: string): Promise<any | null> {
  try {
    const result = await client.get({ index: INDEXES.runs, id });
    return result.body.found ? result.body._source : null;
  } catch (error: any) {
    if (error.meta?.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Get run by ID
 * Throws if storage is not configured
 * @deprecated Use getRunByIdWithClient with request-scoped client
 */
export async function getRunById(id: string): Promise<any | null> {
  const client = getOpenSearchClient();
  if (!client) {
    throw new Error('Storage not configured');
  }
  return getRunByIdWithClient(client, id);
}

/**
 * Partial update of a run with an explicit client
 * Used by routes that have the client from middleware
 */
export async function updateRunWithClient(client: Client, id: string, updates: any): Promise<any> {
  await client.update({
    index: INDEXES.runs,
    id,
    body: { doc: updates },
    refresh: true,
  });

  const result = await client.get({ index: INDEXES.runs, id });
  return result.body._source;
}

/**
 * Partial update of a run
 * Throws if storage is not configured
 * @deprecated Use updateRunWithClient with request-scoped client
 */
export async function updateRun(id: string, updates: any): Promise<any> {
  const client = getOpenSearchClient();
  if (!client) {
    throw new Error('Storage not configured');
  }
  return updateRunWithClient(client, id, updates);
}

/**
 * Save an evaluation report with an explicit client
 * Used by code that has the client from middleware or passed as parameter
 */
export async function saveReportWithClient(
  client: Client,
  report: any,
  options?: { experimentId?: string; experimentRunId?: string; iteration?: number }
): Promise<any> {
  const storageData: any = {
    experimentId: options?.experimentId || '',
    experimentRunId: options?.experimentRunId || '',
    testCaseId: report.testCaseId,
    testCaseVersionId: `${report.testCaseId}-v${report.testCaseVersion || 1}`,
    agentId: report.agentKey || report.agentName,
    modelId: report.modelId || report.modelName,
    iteration: options?.iteration || 1,
    status: report.status,
    passFailStatus: report.passFailStatus,
    traceId: report.runId,
    tags: [],
    actualOutcomes: [],
    llmJudgeReasoning: report.llmJudgeReasoning,
    metrics: report.metrics,
    trajectory: report.trajectory,
    rawEvents: report.rawEvents || [], // Ensure empty array if null/undefined
    logs: report.logs || report.openSearchLogs,
    improvementStrategies: report.improvementStrategies,
  };

  // Add trace-mode fields if present
  if (report.metricsStatus !== undefined) storageData.metricsStatus = report.metricsStatus;
  if (report.traceFetchAttempts !== undefined) storageData.traceFetchAttempts = report.traceFetchAttempts;
  if (report.lastTraceFetchAt !== undefined) storageData.lastTraceFetchAt = report.lastTraceFetchAt;
  if (report.traceError !== undefined) storageData.traceError = report.traceError;
  if (report.spans !== undefined) storageData.spans = report.spans;
  if (report.connectorProtocol !== undefined) storageData.connectorProtocol = report.connectorProtocol;

  const created = await createRunWithClient(client, storageData);

  // Return in app format
  return {
    ...report,
    id: created.id,
    timestamp: created.createdAt,
    experimentId: created.experimentId || undefined,
    experimentRunId: created.experimentRunId || undefined,
  };
}

/**
 * Save an evaluation report (converts from app format to storage format)
 * Throws if storage is not configured
 * @deprecated Use saveReportWithClient with request-scoped client
 */
export async function saveReport(
  report: any,
  options?: { experimentId?: string; experimentRunId?: string; iteration?: number }
): Promise<any> {
  const client = getOpenSearchClient();
  if (!client) {
    throw new Error('Storage not configured');
  }
  return saveReportWithClient(client, report, options);
}

// ==================== Helpers ====================

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Write analytics record with explicit client
 */
async function writeAnalyticsRecordWithClient(client: Client, run: any): Promise<void> {
  const analyticsDoc: any = {
    analyticsId: `analytics-${run.id}`,
    runId: run.id,
    experimentId: run.experimentId,
    experimentRunId: run.experimentRunId,
    testCaseId: run.testCaseId,
    testCaseVersionId: run.testCaseVersionId,
    traceId: run.traceId,
    agentId: run.agentId,
    modelId: run.modelId,
    iteration: run.iteration || 1,
    tags: run.tags || [],
    passFailStatus: run.passFailStatus,
    status: run.status,
    createdAt: run.createdAt,
    author: run.author,
  };

  if (run.metrics) {
    for (const [key, value] of Object.entries(run.metrics)) {
      analyticsDoc[`metric_${key}`] = value;
    }
  }

  await client.index({
    index: INDEXES.analytics,
    id: analyticsDoc.analyticsId,
    body: analyticsDoc,
    refresh: true,
  });
}

/**
 * @deprecated Use writeAnalyticsRecordWithClient with request-scoped client
 */
async function writeAnalyticsRecord(run: any): Promise<void> {
  const client = getOpenSearchClient();
  if (!client) return; // Skip analytics if no storage
  return writeAnalyticsRecordWithClient(client, run);
}
