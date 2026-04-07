/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 2: Team analytics via OpenSearch DSL aggregations.
 * All stats computed live — no materialized views.
 */

import type { Client } from '@opensearch-project/opensearch';
import type { DateRange, AgentKind } from '../types';
import type { TeamStats, UserStats, ProjectStats, TrendPoint } from './types';
import { USAGE_EVENTS_INDEX } from './ingestion';

/** Build a date range filter clause for OpenSearch queries */
function dateRangeFilter(range?: DateRange): any[] {
  const filters: any[] = [];
  if (range?.from || range?.to) {
    const rangeClause: any = {};
    if (range.from) rangeClause.gte = range.from;
    if (range.to) rangeClause.lte = range.to;
    filters.push({ range: { start_time: rangeClause } });
  }
  return filters;
}

/** Get team-level aggregate stats */
export async function getTeamStats(
  client: Client,
  teamId: string,
  range?: DateRange,
): Promise<TeamStats> {
  const filters = [
    { term: { team_id: teamId } },
    ...dateRangeFilter(range),
  ];

  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        total_cost: { sum: { field: 'estimated_cost' } },
        unique_users: { cardinality: { field: 'user_id' } },
        avg_completion: { avg: { field: 'session_completed' } },
        avg_tool_success: { avg: { field: 'tool_success_rate' } },
        by_agent: {
          terms: { field: 'agent', size: 10 },
        },
        by_project: {
          terms: { field: 'project_display', size: 10, order: { total_cost: 'desc' } },
          aggs: {
            total_cost: { sum: { field: 'estimated_cost' } },
          },
        },
        by_user: {
          terms: { field: 'user_id', size: 1000 },
          aggs: {
            cost: { sum: { field: 'estimated_cost' } },
          },
        },
      },
    },
  });

  const aggs = result.body.aggregations as any;
  const totalSessions = (result.body.hits.total as any)?.value ?? 0;
  const totalUsers = aggs.unique_users?.value ?? 0;

  return {
    team_id: teamId,
    total_sessions: totalSessions,
    total_cost: aggs.total_cost?.value ?? 0,
    total_users: totalUsers,
    avg_cost_per_user: totalUsers > 0 ? (aggs.total_cost?.value ?? 0) / totalUsers : 0,
    avg_completion_rate: aggs.avg_completion?.value ?? 0,
    avg_tool_success_rate: aggs.avg_tool_success?.value ?? 0,
    top_agents: (aggs.by_agent?.buckets ?? []).map((b: any) => ({
      agent: b.key as AgentKind,
      sessions: b.doc_count,
    })),
    top_projects: (aggs.by_project?.buckets ?? []).map((b: any) => ({
      project: b.key,
      sessions: b.doc_count,
      cost: b.total_cost?.value ?? 0,
    })),
  };
}

/** Get per-user stats for a team */
export async function getUserStats(
  client: Client,
  teamId: string,
  range?: DateRange,
  userId?: string,
): Promise<UserStats[]> {
  const filters: any[] = [
    { term: { team_id: teamId } },
    ...dateRangeFilter(range),
  ];
  if (userId) filters.push({ term: { user_id: userId } });

  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        by_user: {
          terms: { field: 'user_id', size: 1000 },
          aggs: {
            completed: { filter: { term: { session_completed: true } } },
            total_cost: { sum: { field: 'estimated_cost' } },
            total_tool_calls: { sum: { field: 'total_tool_calls' } },
            total_tool_errors: { sum: { field: 'total_tool_errors' } },
            avg_tool_success: { avg: { field: 'tool_success_rate' } },
            agents: { terms: { field: 'agent', size: 10 } },
            active_days: { cardinality: { field: 'start_time', precision_threshold: 100 } },
            avg_duration: { avg: { field: 'duration_minutes' } },
            total_input: { sum: { field: 'input_tokens' } },
            total_output: { sum: { field: 'output_tokens' } },
            total_cache_creation: { sum: { field: 'cache_creation_tokens' } },
            total_cache_read: { sum: { field: 'cache_read_tokens' } },
          },
        },
      },
    },
  });

  return ((result.body.aggregations as any).by_user?.buckets ?? []).map((b: any) => {
    const total = b.doc_count;
    const completed = b.completed?.doc_count ?? 0;
    const totalToolCalls = b.total_tool_calls?.value ?? 0;
    const totalToolErrors = b.total_tool_errors?.value ?? 0;
    const totalCost = b.total_cost?.value ?? 0;
    const cacheCreation = b.total_cache_creation?.value ?? 0;
    const cacheRead = b.total_cache_read?.value ?? 0;
    const totalCache = cacheCreation + cacheRead;

    return {
      user_id: b.key,
      total_sessions: total,
      completed_sessions: completed,
      completion_rate: total > 0 ? completed / total : 0,
      total_cost: totalCost,
      cost_per_completion: completed > 0 ? totalCost / completed : 0,
      total_tool_calls: totalToolCalls,
      total_tool_errors: totalToolErrors,
      tool_success_rate: totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1,
      agents_used: (b.agents?.buckets ?? []).map((a: any) => a.key as AgentKind),
      active_days: b.active_days?.value ?? 0,
      avg_duration_minutes: b.avg_duration?.value ?? 0,
      total_input_tokens: b.total_input?.value ?? 0,
      total_output_tokens: b.total_output?.value ?? 0,
      cache_hit_rate: totalCache > 0 ? cacheRead / totalCache : 0,
    };
  });
}

/** Get per-project stats for a team */
export async function getProjectStats(
  client: Client,
  teamId: string,
  range?: DateRange,
): Promise<ProjectStats[]> {
  const filters = [
    { term: { team_id: teamId } },
    ...dateRangeFilter(range),
  ];

  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        by_project: {
          terms: { field: 'project_hash', size: 100 },
          aggs: {
            display: { terms: { field: 'project_display', size: 1 } },
            total_cost: { sum: { field: 'estimated_cost' } },
            unique_users: { cardinality: { field: 'user_id' } },
            completion: { avg: { field: 'session_completed' } },
            agents: { terms: { field: 'agent', size: 10 } },
          },
        },
      },
    },
  });

  return ((result.body.aggregations as any).by_project?.buckets ?? []).map((b: any) => ({
    project_hash: b.key,
    project_display: b.display?.buckets?.[0]?.key ?? b.key,
    total_sessions: b.doc_count,
    total_cost: b.total_cost?.value ?? 0,
    total_users: b.unique_users?.value ?? 0,
    completion_rate: b.completion?.value ?? 0,
    agents: (b.agents?.buckets ?? []).map((a: any) => a.key as AgentKind),
  }));
}

/** Get daily/weekly trends for a team */
export async function getTrends(
  client: Client,
  teamId: string,
  range?: DateRange,
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
): Promise<TrendPoint[]> {
  const filters = [
    { term: { team_id: teamId } },
    ...dateRangeFilter(range),
  ];

  const interval = period === 'monthly' ? 'month' : period === 'weekly' ? 'week' : 'day';

  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        by_period: {
          date_histogram: {
            field: 'start_time',
            calendar_interval: interval,
            format: 'yyyy-MM-dd',
          },
          aggs: {
            cost: { sum: { field: 'estimated_cost' } },
            users: { cardinality: { field: 'user_id' } },
            completion: { avg: { field: 'session_completed' } },
          },
        },
      },
    },
  });

  return ((result.body.aggregations as any).by_period?.buckets ?? []).map((b: any) => ({
    date: b.key_as_string,
    sessions: b.doc_count,
    cost: b.cost?.value ?? 0,
    users: b.users?.value ?? 0,
    completion_rate: b.completion?.value ?? 0,
  }));
}
