/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 3: Leaderboard rankings computed live via OpenSearch aggregations.
 */

import type { Client } from '@opensearch-project/opensearch';
import type { DateRange } from '../types';
import type { RankingMetric, RankedUser } from './types';
import { USAGE_EVENTS_INDEX } from './ingestion';

/** Build date range filter */
function dateRangeFilter(range?: DateRange): any[] {
  const filters: any[] = [];
  if (range?.from || range?.to) {
    const clause: any = {};
    if (range.from) clause.gte = range.from;
    if (range.to) clause.lte = range.to;
    filters.push({ range: { start_time: clause } });
  }
  return filters;
}

/**
 * Get ranked users by a given metric.
 * All rankings computed live from raw events — no rollup tables.
 */
export async function getRankings(
  client: Client,
  teamId: string,
  metric: RankingMetric = 'sessions',
  range?: DateRange,
  limit: number = 25,
): Promise<RankedUser[]> {
  const filters = [
    { term: { team_id: teamId } },
    ...dateRangeFilter(range),
  ];

  // Build sort-determining aggregation based on metric
  const metricAgg = getMetricAggregation(metric);
  const sortField = metricAgg.sortField;

  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        by_user: {
          terms: {
            field: 'user_id',
            size: limit,
            order: { [sortField]: metricAgg.sortOrder },
          },
          aggs: {
            total_cost: { sum: { field: 'estimated_cost' } },
            completed: { filter: { term: { session_completed: true } } },
            total_tool_calls: { sum: { field: 'total_tool_calls' } },
            total_tool_errors: { sum: { field: 'total_tool_errors' } },
            active_days: { cardinality: { field: 'start_time', precision_threshold: 100 } },
            ...metricAgg.extraAggs,
          },
        },
      },
    },
  });

  const buckets = (result.body.aggregations as any).by_user?.buckets ?? [];

  return buckets.map((b: any, index: number) => {
    const total = b.doc_count;
    const completed = b.completed?.doc_count ?? 0;
    const totalCost = b.total_cost?.value ?? 0;
    const totalToolCalls = b.total_tool_calls?.value ?? 0;
    const totalToolErrors = b.total_tool_errors?.value ?? 0;

    let metricValue: number;
    switch (metric) {
      case 'sessions':
        metricValue = total;
        break;
      case 'cost':
        metricValue = totalCost;
        break;
      case 'completion_rate':
        metricValue = total > 0 ? completed / total : 0;
        break;
      case 'efficiency':
        metricValue = completed > 0 ? totalCost / completed : Infinity;
        break;
      case 'tool_success':
        metricValue = totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1;
        break;
      case 'active_days':
        metricValue = b.active_days?.value ?? 0;
        break;
      default:
        metricValue = total;
    }

    return {
      rank: index + 1,
      user_id: b.key,
      metric_value: metricValue,
      total_sessions: total,
      completion_rate: total > 0 ? completed / total : 0,
      total_cost: totalCost,
      tool_success_rate: totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1,
    };
  });
}

/** Map metric names to OpenSearch aggregation config */
function getMetricAggregation(metric: RankingMetric): {
  sortField: string;
  sortOrder: 'asc' | 'desc';
  extraAggs: Record<string, any>;
} {
  switch (metric) {
    case 'sessions':
      return { sortField: '_count', sortOrder: 'desc', extraAggs: {} };
    case 'cost':
      return { sortField: 'total_cost', sortOrder: 'desc', extraAggs: {} };
    case 'completion_rate':
      return {
        sortField: 'completion_pct',
        sortOrder: 'desc',
        extraAggs: {
          completion_pct: {
            bucket_script: {
              buckets_path: { completed: 'completed._count', total: '_count' },
              script: 'params.total > 0 ? params.completed / params.total : 0',
            },
          },
        },
      };
    case 'efficiency':
      // Lower cost per completion is better
      return {
        sortField: 'cost_per_completion',
        sortOrder: 'asc',
        extraAggs: {
          cost_per_completion: {
            bucket_script: {
              buckets_path: { cost: 'total_cost', completed: 'completed._count' },
              script: 'params.completed > 0 ? params.cost / params.completed : 999999',
            },
          },
        },
      };
    case 'tool_success':
      return {
        sortField: 'success_pct',
        sortOrder: 'desc',
        extraAggs: {
          success_pct: {
            bucket_script: {
              buckets_path: { calls: 'total_tool_calls', errors: 'total_tool_errors' },
              script: 'params.calls > 0 ? (params.calls - params.errors) / params.calls : 1',
            },
          },
        },
      };
    case 'active_days':
      return { sortField: 'active_days', sortOrder: 'desc', extraAggs: {} };
    default:
      return { sortField: '_count', sortOrder: 'desc', extraAggs: {} };
  }
}
