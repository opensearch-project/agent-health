/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Stats Computation
 *
 * Computes benchmark run statistics from reports.
 * Used by both the benchmarks route and the storage service.
 */

import { INDEXES } from '../opensearchClient.js';
import type { Client } from '@opensearch-project/opensearch';

export interface RunStats {
  passed: number;
  failed: number;
  pending: number;
  /** Evaluator could not produce a verdict (issue #242). Excluded from passed/failed. */
  errored?: number;
  total: number;
}

/**
 * Compute stats for a benchmark run by fetching its reports.
 *
 * Logic:
 * - When reports exist, fetches them and counts by passFailStatus.
 * - Results with status 'failed'/'cancelled' count as failed.
 * - Results with status 'pending'/'running' count as pending.
 * - Completed results without a matching report count as pending.
 * - When no reports exist, iterates results by status
 *   (failed/cancelled → failed, everything else → pending).
 */
export async function computeStatsForRun(
  client: Client,
  run: { results?: Record<string, { reportId: string; status: string }> }
): Promise<RunStats> {
  const reportIds = Object.values(run.results || {})
    .map(r => r.reportId)
    .filter(Boolean);

  let passed = 0;
  let failed = 0;
  let pending = 0;
  let errored = 0;
  const total = Object.keys(run.results || {}).length;

  if (reportIds.length > 0) {
    try {
      const reportsResult = await client.search({
        index: INDEXES.runs,
        body: {
          size: reportIds.length,
          query: {
            terms: { 'id': reportIds },
          },
          _source: ['id', 'passFailStatus', 'metricsStatus', 'status'],
        },
      });

      const reportsMap = new Map<string, any>();
      (reportsResult.body.hits?.hits || []).forEach((hit: any) => {
        reportsMap.set(hit._source.id, hit._source);
      });

      Object.values(run.results || {}).forEach((result) => {
        if (result.status === 'pending' || result.status === 'running') {
          pending++;
          return;
        }

        if (result.status === 'failed' || result.status === 'cancelled') {
          failed++;
          return;
        }

        if (result.status === 'completed' && result.reportId) {
          const report = reportsMap.get(result.reportId);
          if (!report) {
            pending++;
            return;
          }

          if (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating') {
            pending++;
            return;
          }

          // Evaluator never produced a verdict (issue #242). Bucket separately.
          if (report.metricsStatus === 'error') {
            errored++;
            return;
          }

          if (report.passFailStatus === 'passed') {
            passed++;
          } else {
            failed++;
          }
        } else {
          pending++;
        }
      });
    } catch (e: any) {
      console.warn('[StatsComputation] Failed to fetch reports for stats computation:', e.message);
      Object.values(run.results || {}).forEach((result) => {
        if (result.status === 'completed') {
          pending++;
        } else if (result.status === 'failed' || result.status === 'cancelled') {
          failed++;
        } else {
          pending++;
        }
      });
    }
  } else {
    // No reports yet — count by result status
    Object.values(run.results || {}).forEach((result) => {
      if (result.status === 'failed' || result.status === 'cancelled') {
        failed++;
      } else {
        pending++;
      }
    });
  }

  return { passed, failed, pending, errored, total };
}
