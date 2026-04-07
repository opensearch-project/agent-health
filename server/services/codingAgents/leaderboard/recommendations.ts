/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 4: Learning recommendations and team insights.
 * Analyzes patterns from top performers and generates actionable recommendations.
 * All data computed live via OpenSearch aggregations.
 */

import type { Client } from '@opensearch-project/opensearch';
import type { DateRange } from '../types';
import type { Recommendation, TeamInsight } from './types';
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
 * Generate personalized recommendations for a user based on team comparison.
 */
export async function getRecommendations(
  client: Client,
  teamId: string,
  userId: string,
  range?: DateRange,
): Promise<Recommendation[]> {
  const filters = [
    { term: { team_id: teamId } },
    ...dateRangeFilter(range),
  ];

  // Get team-wide stats and user-specific stats in one query
  const result = await client.search({
    index: USAGE_EVENTS_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        // Team-wide aggregates
        team_avg_cost: { avg: { field: 'estimated_cost' } },
        team_avg_duration: { avg: { field: 'duration_minutes' } },
        team_avg_tool_success: { avg: { field: 'tool_success_rate' } },
        team_total_cache_creation: { sum: { field: 'cache_creation_tokens' } },
        team_total_cache_read: { sum: { field: 'cache_read_tokens' } },

        // Per-user breakdown for percentile comparison
        by_user: {
          terms: { field: 'user_id', size: 1000 },
          aggs: {
            total_cost: { sum: { field: 'estimated_cost' } },
            completed: { filter: { term: { session_completed: true } } },
            avg_duration: { avg: { field: 'duration_minutes' } },
            total_tool_calls: { sum: { field: 'total_tool_calls' } },
            total_tool_errors: { sum: { field: 'total_tool_errors' } },
            total_cache_creation: { sum: { field: 'cache_creation_tokens' } },
            total_cache_read: { sum: { field: 'cache_read_tokens' } },
            unique_agents: { cardinality: { field: 'agent' } },
            // Tool category distribution
            tool_categories: { terms: { field: 'tool_categories', size: 20 } },
            // Model distribution
            models: { terms: { field: 'model', size: 10 } },
          },
        },
      },
    },
  });

  const aggs = result.body.aggregations as any;
  const userBuckets = aggs.by_user?.buckets ?? [];

  // Find the current user's bucket
  const userBucket = userBuckets.find((b: any) => b.key === userId);
  if (!userBucket) return [];

  const recommendations: Recommendation[] = [];

  // Compute user metrics
  const userSessions = userBucket.doc_count;
  const userCompleted = userBucket.completed?.doc_count ?? 0;
  const userCost = userBucket.total_cost?.value ?? 0;
  const userAvgDuration = userBucket.avg_duration?.value ?? 0;
  const userToolCalls = userBucket.total_tool_calls?.value ?? 0;
  const userToolErrors = userBucket.total_tool_errors?.value ?? 0;
  const userCacheCreation = userBucket.total_cache_creation?.value ?? 0;
  const userCacheRead = userBucket.total_cache_read?.value ?? 0;
  const userAgentCount = userBucket.unique_agents?.value ?? 0;

  // Compute team averages from all users
  const teamUsers = userBuckets.length;
  if (teamUsers < 2) return []; // Need at least 2 users for comparison

  // Top 25% performers (by completion rate)
  const userStats = userBuckets.map((b: any) => {
    const total = b.doc_count;
    const completed = b.completed?.doc_count ?? 0;
    return {
      userId: b.key,
      sessions: total,
      completionRate: total > 0 ? completed / total : 0,
      costPerSession: total > 0 ? (b.total_cost?.value ?? 0) / total : 0,
      avgDuration: b.avg_duration?.value ?? 0,
      toolSuccessRate: (b.total_tool_calls?.value ?? 0) > 0
        ? ((b.total_tool_calls?.value ?? 0) - (b.total_tool_errors?.value ?? 0)) / (b.total_tool_calls?.value ?? 0)
        : 1,
      cacheHitRate: ((b.total_cache_creation?.value ?? 0) + (b.total_cache_read?.value ?? 0)) > 0
        ? (b.total_cache_read?.value ?? 0) / ((b.total_cache_creation?.value ?? 0) + (b.total_cache_read?.value ?? 0))
        : 0,
      agentCount: b.unique_agents?.value ?? 0,
    };
  });

  // Sort by completion rate to find top performers
  const sorted = [...userStats].sort((a, b) => b.completionRate - a.completionRate);
  const topPerformerCount = Math.max(1, Math.floor(sorted.length * 0.25));
  const topPerformers = sorted.slice(0, topPerformerCount);

  const teamAvg = (field: (s: typeof userStats[0]) => number) =>
    userStats.reduce((sum, s) => sum + field(s), 0) / userStats.length;

  const topAvg = (field: (s: typeof userStats[0]) => number) =>
    topPerformers.reduce((sum, s) => sum + field(s), 0) / topPerformers.length;

  // 1. Tool Pattern recommendation
  const userToolSuccess = userToolCalls > 0 ? (userToolCalls - userToolErrors) / userToolCalls : 1;
  const teamAvgToolSuccess = teamAvg(s => s.toolSuccessRate);
  const topAvgToolSuccess = topAvg(s => s.toolSuccessRate);

  if (userToolSuccess < teamAvgToolSuccess - 0.05) {
    recommendations.push({
      type: 'tool_pattern',
      title: 'Improve tool success rate',
      description: `Your tool success rate (${(userToolSuccess * 100).toFixed(0)}%) is below the team average (${(teamAvgToolSuccess * 100).toFixed(0)}%). Top performers achieve ${(topAvgToolSuccess * 100).toFixed(0)}%. Review which tools are failing and consider breaking complex operations into smaller steps.`,
      your_value: userToolSuccess,
      team_avg: teamAvgToolSuccess,
      top_performer_avg: topAvgToolSuccess,
    });
  }

  // 2. Session Hygiene recommendation
  const teamAvgDuration = teamAvg(s => s.avgDuration);
  const topAvgDuration = topAvg(s => s.avgDuration);

  if (userAvgDuration > teamAvgDuration * 1.5 && userAvgDuration > 30) {
    const potentialTimeSaved = (userAvgDuration - topAvgDuration) * userSessions;
    recommendations.push({
      type: 'session_hygiene',
      title: 'Shorten session duration',
      description: `Your average session is ${userAvgDuration.toFixed(0)} min vs team average ${teamAvgDuration.toFixed(0)} min. Teammates with shorter sessions (${topAvgDuration.toFixed(0)} min) have higher completion rates. Try breaking large tasks into focused sessions.`,
      your_value: userAvgDuration,
      team_avg: teamAvgDuration,
      top_performer_avg: topAvgDuration,
      potential_savings: potentialTimeSaved,
    });
  }

  // 3. Cache Optimization recommendation
  const userTotalCache = userCacheCreation + userCacheRead;
  const userCacheHitRate = userTotalCache > 0 ? userCacheRead / userTotalCache : 0;
  const teamAvgCacheRate = teamAvg(s => s.cacheHitRate);
  const topAvgCacheRate = topAvg(s => s.cacheHitRate);

  if (userCacheHitRate < teamAvgCacheRate - 0.1 && userTotalCache > 0) {
    recommendations.push({
      type: 'cache_optimization',
      title: 'Improve cache hit rate',
      description: `Your cache hit rate is ${(userCacheHitRate * 100).toFixed(0)}% vs team average ${(teamAvgCacheRate * 100).toFixed(0)}%. Top performers achieve ${(topAvgCacheRate * 100).toFixed(0)}%. Longer sessions with stable context improve caching. Avoid frequent context switches.`,
      your_value: userCacheHitRate,
      team_avg: teamAvgCacheRate,
      top_performer_avg: topAvgCacheRate,
    });
  }

  // 4. Model Selection recommendation
  const userCostPerSession = userSessions > 0 ? userCost / userSessions : 0;
  const teamAvgCostPerSession = teamAvg(s => s.costPerSession);
  const topAvgCostPerSession = topAvg(s => s.costPerSession);

  if (userCostPerSession > teamAvgCostPerSession * 1.5) {
    const potentialSavings = (userCostPerSession - topAvgCostPerSession) * userSessions;
    recommendations.push({
      type: 'model_selection',
      title: 'Optimize model usage for cost',
      description: `Your average cost per session ($${userCostPerSession.toFixed(3)}) is significantly above team average ($${teamAvgCostPerSession.toFixed(3)}). Consider using lighter models for simple tasks — teammates using efficient models save ${((1 - topAvgCostPerSession / userCostPerSession) * 100).toFixed(0)}%.`,
      your_value: userCostPerSession,
      team_avg: teamAvgCostPerSession,
      top_performer_avg: topAvgCostPerSession,
      potential_savings: potentialSavings,
    });
  }

  // 5. Agent Diversity recommendation
  const teamAvgAgents = teamAvg(s => s.agentCount);
  const topAvgAgents = topAvg(s => s.agentCount);

  if (userAgentCount < teamAvgAgents - 0.5 && teamAvgAgents >= 2) {
    recommendations.push({
      type: 'agent_diversity',
      title: 'Try more coding agents',
      description: `You use ${userAgentCount} agent(s) while the team averages ${teamAvgAgents.toFixed(1)}. Top performers use ${topAvgAgents.toFixed(1)} agents. Different agents excel at different tasks — try matching the agent to the task type.`,
      your_value: userAgentCount,
      team_avg: teamAvgAgents,
      top_performer_avg: topAvgAgents,
    });
  }

  return recommendations;
}

/**
 * Generate team-level insights.
 */
export async function getTeamInsights(
  client: Client,
  teamId: string,
  range?: DateRange,
): Promise<TeamInsight[]> {
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
        unique_users: { cardinality: { field: 'user_id' } },
        total_cost: { sum: { field: 'estimated_cost' } },
        avg_completion: { avg: { field: 'session_completed' } },
        avg_duration: { avg: { field: 'duration_minutes' } },
        unique_agents: { cardinality: { field: 'agent' } },
        agents: { terms: { field: 'agent', size: 10 } },
        mcp_users: {
          filter: { term: { uses_mcp: true } },
          aggs: { unique: { cardinality: { field: 'user_id' } } },
        },
        // Weekly trend for growth detection
        weekly: {
          date_histogram: {
            field: 'start_time',
            calendar_interval: 'week',
            format: 'yyyy-MM-dd',
            min_doc_count: 0,
          },
          aggs: {
            users: { cardinality: { field: 'user_id' } },
            cost: { sum: { field: 'estimated_cost' } },
          },
        },
      },
    },
  });

  const aggs = result.body.aggregations as any;
  const totalSessions = (result.body.hits.total as any)?.value ?? 0;
  const totalUsers = aggs.unique_users?.value ?? 0;
  const totalCost = aggs.total_cost?.value ?? 0;
  const avgCompletion = aggs.avg_completion?.value ?? 0;
  const mcpUsers = aggs.mcp_users?.unique?.value ?? 0;
  const weeklyBuckets = aggs.weekly?.buckets ?? [];

  const insights: TeamInsight[] = [];

  // Adoption insight
  if (totalUsers > 0) {
    insights.push({
      type: 'adoption',
      title: 'Team AI adoption',
      description: `${totalUsers} team members have used AI coding tools, generating ${totalSessions} total sessions.`,
      metric_value: totalUsers,
    });
  }

  // MCP adoption
  if (totalUsers > 0) {
    const mcpRate = mcpUsers / totalUsers;
    if (mcpRate < 0.5 && mcpUsers > 0) {
      insights.push({
        type: 'adoption',
        title: 'MCP adoption opportunity',
        description: `Only ${mcpUsers} of ${totalUsers} users (${(mcpRate * 100).toFixed(0)}%) are using MCP tools. MCP enables richer agent interactions with external services.`,
        metric_value: mcpRate,
      });
    }
  }

  // Cost insight
  if (totalUsers > 0 && totalCost > 0) {
    const avgCostPerUser = totalCost / totalUsers;
    insights.push({
      type: 'cost',
      title: 'Cost per team member',
      description: `Average cost per user is $${avgCostPerUser.toFixed(2)}. Total team spend: $${totalCost.toFixed(2)}.`,
      metric_value: avgCostPerUser,
    });
  }

  // Completion rate insight
  if (totalSessions > 10) {
    if (avgCompletion < 0.7) {
      insights.push({
        type: 'efficiency',
        title: 'Low completion rate',
        description: `Team completion rate is ${(avgCompletion * 100).toFixed(0)}%. Sessions that don't complete may indicate unclear prompts or overly ambitious tasks. Consider prompt engineering training.`,
        metric_value: avgCompletion,
      });
    } else if (avgCompletion >= 0.9) {
      insights.push({
        type: 'efficiency',
        title: 'High completion rate',
        description: `Team completion rate is ${(avgCompletion * 100).toFixed(0)}% — well above typical. The team is using AI tools effectively.`,
        metric_value: avgCompletion,
      });
    }
  }

  // Growth/decline trend
  if (weeklyBuckets.length >= 3) {
    const recent = weeklyBuckets.slice(-2);
    const earlier = weeklyBuckets.slice(-4, -2);

    if (recent.length >= 2 && earlier.length >= 1) {
      const recentAvgSessions = recent.reduce((s: number, b: any) => s + b.doc_count, 0) / recent.length;
      const earlierAvgSessions = earlier.reduce((s: number, b: any) => s + b.doc_count, 0) / earlier.length;

      if (earlierAvgSessions > 0) {
        const growthRate = (recentAvgSessions - earlierAvgSessions) / earlierAvgSessions;
        if (growthRate > 0.2) {
          insights.push({
            type: 'trend',
            title: 'Usage growing',
            description: `AI tool usage is up ${(growthRate * 100).toFixed(0)}% over the past 2 weeks. Team adoption is accelerating.`,
            metric_value: growthRate,
          });
        } else if (growthRate < -0.2) {
          insights.push({
            type: 'trend',
            title: 'Usage declining',
            description: `AI tool usage is down ${(Math.abs(growthRate) * 100).toFixed(0)}% over the past 2 weeks. Consider checking in with the team about blockers.`,
            metric_value: growthRate,
          });
        }
      }
    }
  }

  return insights;
}
