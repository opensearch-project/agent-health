/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 3: Badge definitions and earning logic.
 * Badges are computed live from OpenSearch aggregations — not stored.
 */

import type { Client } from '@opensearch-project/opensearch';
import type { DateRange } from '../types';
import type { BadgeDefinition, EarnedBadge, BadgeCategory } from './types';
import { USAGE_EVENTS_INDEX } from './ingestion';

/** All available badge definitions */
export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  {
    id: 'cost_optimizer',
    name: 'Cost Optimizer',
    description: 'Bottom 25th percentile cost per completion on the team',
    category: 'efficiency',
    icon: '💰',
  },
  {
    id: 'power_user',
    name: 'Power User',
    description: '100+ AI coding sessions',
    category: 'volume',
    icon: '⚡',
  },
  {
    id: 'multi_agent',
    name: 'Multi-Agent',
    description: 'Used 3 or more different coding agents',
    category: 'diversity',
    icon: '🔀',
  },
  {
    id: 'streak_master',
    name: 'Streak Master',
    description: '7+ consecutive days with at least one session',
    category: 'consistency',
    icon: '🔥',
  },
  {
    id: 'tool_expert',
    name: 'Tool Expert',
    description: '95%+ tool success rate across all sessions',
    category: 'quality',
    icon: '🛠️',
  },
  {
    id: 'night_owl',
    name: 'Night Owl',
    description: '50%+ sessions started between 10pm and 4am',
    category: 'pattern',
    icon: '🦉',
  },
  {
    id: 'early_bird',
    name: 'Early Bird',
    description: '50%+ sessions started between 5am and 9am',
    category: 'pattern',
    icon: '🐦',
  },
  {
    id: 'mcp_pioneer',
    name: 'MCP Pioneer',
    description: 'Used MCP tools in 10+ sessions',
    category: 'adoption',
    icon: '🔌',
  },
  {
    id: 'completionist',
    name: 'Completionist',
    description: '90%+ session completion rate with 20+ sessions',
    category: 'quality',
    icon: '✅',
  },
  {
    id: 'cache_champion',
    name: 'Cache Champion',
    description: '80%+ cache hit rate across all sessions',
    category: 'efficiency',
    icon: '🎯',
  },
];

/** Get all badge definitions */
export function getBadgeDefinitions(): BadgeDefinition[] {
  return BADGE_DEFINITIONS;
}

/** Get badge definitions filtered by category */
export function getBadgesByCategory(category: BadgeCategory): BadgeDefinition[] {
  return BADGE_DEFINITIONS.filter(b => b.category === category);
}

/**
 * Compute earned badges for a user.
 * All badge criteria are evaluated via OpenSearch aggregations.
 */
export async function getUserBadges(
  client: Client,
  teamId: string,
  userId: string,
  range?: DateRange,
): Promise<EarnedBadge[]> {
  const filters: any[] = [
    { term: { team_id: teamId } },
    { term: { user_id: userId } },
  ];
  if (range?.from || range?.to) {
    const clause: any = {};
    if (range.from) clause.gte = range.from;
    if (range.to) clause.lte = range.to;
    filters.push({ range: { start_time: clause } });
  }

  // Single query to get all the data we need for badge evaluation
  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        total_sessions: { value_count: { field: 'session_id' } },
        completed: { filter: { term: { session_completed: true } } },
        total_cost: { sum: { field: 'estimated_cost' } },
        total_tool_calls: { sum: { field: 'total_tool_calls' } },
        total_tool_errors: { sum: { field: 'total_tool_errors' } },
        unique_agents: { cardinality: { field: 'agent' } },
        agents_list: { terms: { field: 'agent', size: 10 } },
        mcp_sessions: { filter: { term: { uses_mcp: true } } },
        total_cache_creation: { sum: { field: 'cache_creation_tokens' } },
        total_cache_read: { sum: { field: 'cache_read_tokens' } },
        // For streak calculation: get unique dates
        session_dates: {
          date_histogram: {
            field: 'start_time',
            calendar_interval: 'day',
            format: 'yyyy-MM-dd',
            min_doc_count: 1,
          },
        },
        // For time-of-day patterns: bucket by hour
        hourly: {
          histogram: {
            script: {
              source: "doc['start_time'].value.getHour()",
              lang: 'painless',
            },
            interval: 1,
            min_doc_count: 0,
          },
        },
        // For cost optimizer: get team-wide cost percentiles
        latest_sync: { max: { field: 'synced_at' } },
      },
    },
  });

  const aggs = result.body.aggregations as any;
  const totalSessions = aggs.total_sessions?.value ?? 0;
  const completedSessions = aggs.completed?.doc_count ?? 0;
  const totalToolCalls = aggs.total_tool_calls?.value ?? 0;
  const totalToolErrors = aggs.total_tool_errors?.value ?? 0;
  const uniqueAgents = aggs.unique_agents?.value ?? 0;
  const mcpSessions = aggs.mcp_sessions?.doc_count ?? 0;
  const cacheCreation = aggs.total_cache_creation?.value ?? 0;
  const cacheRead = aggs.total_cache_read?.value ?? 0;
  const latestSync = aggs.latest_sync?.value_as_string ?? new Date().toISOString();

  const earned: EarnedBadge[] = [];
  const badgeMap = new Map(BADGE_DEFINITIONS.map(b => [b.id, b]));

  // Power User: 100+ sessions
  if (totalSessions >= 100) {
    earned.push({
      badge: badgeMap.get('power_user')!,
      earned_at: latestSync,
      metric_value: totalSessions,
    });
  }

  // Multi-Agent: 3+ different agents
  if (uniqueAgents >= 3) {
    earned.push({
      badge: badgeMap.get('multi_agent')!,
      earned_at: latestSync,
      metric_value: uniqueAgents,
    });
  }

  // Tool Expert: 95%+ tool success rate
  if (totalToolCalls > 0) {
    const successRate = (totalToolCalls - totalToolErrors) / totalToolCalls;
    if (successRate >= 0.95) {
      earned.push({
        badge: badgeMap.get('tool_expert')!,
        earned_at: latestSync,
        metric_value: successRate,
      });
    }
  }

  // MCP Pioneer: 10+ sessions with MCP
  if (mcpSessions >= 10) {
    earned.push({
      badge: badgeMap.get('mcp_pioneer')!,
      earned_at: latestSync,
      metric_value: mcpSessions,
    });
  }

  // Completionist: 90%+ completion rate with 20+ sessions
  if (totalSessions >= 20) {
    const completionRate = completedSessions / totalSessions;
    if (completionRate >= 0.9) {
      earned.push({
        badge: badgeMap.get('completionist')!,
        earned_at: latestSync,
        metric_value: completionRate,
      });
    }
  }

  // Cache Champion: 80%+ cache hit rate
  const totalCache = cacheCreation + cacheRead;
  if (totalCache > 0) {
    const cacheHitRate = cacheRead / totalCache;
    if (cacheHitRate >= 0.8) {
      earned.push({
        badge: badgeMap.get('cache_champion')!,
        earned_at: latestSync,
        metric_value: cacheHitRate,
      });
    }
  }

  // Streak Master: 7+ consecutive days
  const dateBuckets = aggs.session_dates?.buckets ?? [];
  const maxStreak = computeMaxStreak(dateBuckets.map((b: any) => b.key_as_string));
  if (maxStreak >= 7) {
    earned.push({
      badge: badgeMap.get('streak_master')!,
      earned_at: latestSync,
      metric_value: maxStreak,
    });
  }

  // Night Owl / Early Bird: based on hourly distribution
  const hourBuckets = aggs.hourly?.buckets ?? [];
  if (totalSessions > 0) {
    const hourCounts = new Map<number, number>();
    for (const b of hourBuckets) {
      hourCounts.set(b.key, b.doc_count);
    }

    // Night Owl: 10pm (22) to 4am (3)
    let nightSessions = 0;
    for (const h of [22, 23, 0, 1, 2, 3]) {
      nightSessions += hourCounts.get(h) ?? 0;
    }
    if (nightSessions / totalSessions >= 0.5) {
      earned.push({
        badge: badgeMap.get('night_owl')!,
        earned_at: latestSync,
        metric_value: nightSessions / totalSessions,
      });
    }

    // Early Bird: 5am to 9am
    let earlySessions = 0;
    for (const h of [5, 6, 7, 8]) {
      earlySessions += hourCounts.get(h) ?? 0;
    }
    if (earlySessions / totalSessions >= 0.5) {
      earned.push({
        badge: badgeMap.get('early_bird')!,
        earned_at: latestSync,
        metric_value: earlySessions / totalSessions,
      });
    }
  }

  // Cost Optimizer: bottom 25th percentile cost/completion on the team
  if (completedSessions > 0) {
    const userCostPerCompletion = (aggs.total_cost?.value ?? 0) / completedSessions;
    const isOptimizer = await checkCostOptimizer(client, teamId, userCostPerCompletion, range);
    if (isOptimizer) {
      earned.push({
        badge: badgeMap.get('cost_optimizer')!,
        earned_at: latestSync,
        metric_value: userCostPerCompletion,
      });
    }
  }

  return earned;
}

/** Compute the maximum consecutive-day streak from a sorted list of date strings */
function computeMaxStreak(dates: string[]): number {
  if (dates.length === 0) return 0;

  let maxStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

    if (Math.abs(diffDays - 1) < 0.1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }

  return maxStreak;
}

/** Check if user's cost/completion is in the bottom 25th percentile of the team */
async function checkCostOptimizer(
  client: Client,
  teamId: string,
  userCostPerCompletion: number,
  range?: DateRange,
): Promise<boolean> {
  const filters: any[] = [{ term: { team_id: teamId } }];
  if (range?.from || range?.to) {
    const clause: any = {};
    if (range?.from) clause.gte = range.from;
    if (range?.to) clause.lte = range.to;
    filters.push({ range: { start_time: clause } });
  }

  // Get cost/completion for all team members
  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        by_user: {
          terms: { field: 'user_id', size: 1000 },
          aggs: {
            total_cost: { sum: { field: 'estimated_cost' } },
            completed: { filter: { term: { session_completed: true } } },
          },
        },
      },
    },
  });

  const buckets = (result.body.aggregations as any).by_user?.buckets ?? [];
  const costPerCompletions: number[] = [];

  for (const b of buckets) {
    const completed = b.completed?.doc_count ?? 0;
    if (completed > 0) {
      costPerCompletions.push((b.total_cost?.value ?? 0) / completed);
    }
  }

  if (costPerCompletions.length < 2) return false;

  costPerCompletions.sort((a, b) => a - b);
  const p25Index = Math.floor(costPerCompletions.length * 0.25);
  const p25Value = costPerCompletions[p25Index];

  return userCostPerCompletion <= p25Value;
}
