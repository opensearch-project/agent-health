/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stateless insights engine — analyses combined stats and efficiency data
 * to produce a prioritised list of actionable insights for the dashboard.
 */

import type { AgentStats, EfficiencyAnalytics, Insight, AdvancedAnalytics } from './types';

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'kiro': 'Kiro',
  'codex': 'Codex CLI',
};

function label(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function cost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function generateInsights(
  agentStats: AgentStats[],
  efficiency: EfficiencyAnalytics,
  wastedCost?: number,
  abandonedSessions?: number,
  advanced?: AdvancedAnalytics,
): Insight[] {
  const insights: Insight[] = [];

  // ── Warnings ──────────────────────────────────────────────────────────────

  // Wasted cost on abandoned sessions
  if (wastedCost && wastedCost > 0.50 && abandonedSessions && abandonedSessions >= 2) {
    const totalSessions = agentStats.reduce((s, a) => s + a.totalSessions, 0);
    const abandonRate = totalSessions > 0 ? abandonedSessions / totalSessions : 0;
    insights.push({
      type: 'warning',
      title: `${cost(wastedCost)} spent on ${abandonedSessions} abandoned sessions`,
      description: `${pct(abandonRate)} of sessions don't complete. Try smaller, focused prompts to reduce wasted spend.`,
      linkTab: 'sessions',
    });
  }

  // Low tool success rate per agent
  for (const a of efficiency.agents) {
    if (a.totalToolCalls >= 10 && a.toolSuccessRate < 0.90) {
      insights.push({
        type: 'warning',
        title: `${label(a.agent)} tool success rate is ${pct(a.toolSuccessRate)}`,
        description: `${a.totalToolErrors} of ${a.totalToolCalls} tool calls are failing. Check which tools error most in the Tools tab.`,
        agent: a.agent,
        linkTab: 'tools',
      });
    }
  }

  // Low completion rate
  for (const a of efficiency.agents) {
    if (a.totalSessions >= 5 && a.completionRate < 0.60) {
      insights.push({
        type: 'warning',
        title: `${label(a.agent)} session completion rate is ${pct(a.completionRate)}`,
        description: `Only ${a.completedSessions} of ${a.totalSessions} sessions completed. Consider breaking complex tasks into smaller prompts.`,
        agent: a.agent,
        linkTab: 'sessions',
      });
    }
  }

  // ── Tips ───────────────────────────────────────────────────────────────────

  // Cost comparison between agents
  const agentsWithCost = efficiency.agents.filter(a => a.costPerCompletion > 0 && a.completedSessions >= 3);
  if (agentsWithCost.length >= 2) {
    const sorted = [...agentsWithCost].sort((a, b) => a.costPerCompletion - b.costPerCompletion);
    const cheapest = sorted[0];
    const most = sorted[sorted.length - 1];
    if (most.costPerCompletion > cheapest.costPerCompletion * 2) {
      insights.push({
        type: 'tip',
        title: `${label(most.agent)} costs ${cost(most.costPerCompletion)}/completion vs ${cost(cheapest.costPerCompletion)} for ${label(cheapest.agent)}`,
        description: `Consider ${label(cheapest.agent)} for simpler tasks to reduce costs.`,
        linkTab: 'costs',
      });
    }
  }

  // Most-used agent with low completion
  const byUsage = [...efficiency.agents].sort((a, b) => b.totalSessions - a.totalSessions);
  if (byUsage.length > 0 && byUsage[0].totalSessions >= 5 && byUsage[0].completionRate < 0.70) {
    const a = byUsage[0];
    // Avoid duplicate if we already warned about this
    const alreadyWarned = insights.some(i => i.agent === a.agent && i.linkTab === 'sessions');
    if (!alreadyWarned) {
      insights.push({
        type: 'tip',
        title: `You use ${label(a.agent)} most but only ${pct(a.completionRate)} of sessions complete`,
        description: 'Try breaking complex tasks into smaller, focused prompts for better results.',
        agent: a.agent,
        linkTab: 'sessions',
      });
    }
  }

  // Cache utilisation tip for Claude Code
  for (const s of agentStats) {
    if (s.agent === 'claude-code' && s.totalInputTokens > 100_000) {
      const cacheHitRate = s.totalCacheSavings > 0
        ? s.totalCacheSavings / (s.totalCost + s.totalCacheSavings)
        : 0;
      if (cacheHitRate < 0.1 && s.totalSessions >= 5) {
        insights.push({
          type: 'tip',
          title: 'Low cache utilisation in Claude Code',
          description: 'Consider longer sessions to benefit from prompt caching and reduce costs.',
          agent: 'claude-code',
          linkTab: 'costs',
        });
      }
    }
  }

  // ── Info ────────────────────────────────────────────────────────────────────

  // Cache savings highlight
  for (const s of agentStats) {
    if (s.totalCacheSavings > 1) {
      insights.push({
        type: 'info',
        title: `${label(s.agent)} saved ${cost(s.totalCacheSavings)} through prompt caching`,
        description: 'Prompt caching reuses previous context, reducing token costs on long sessions.',
        agent: s.agent,
        linkTab: 'costs',
      });
    }
  }

  // Multi-agent usage
  const active = agentStats.filter(a => a.totalSessions > 0);
  if (active.length >= 2) {
    const names = active.map(a => label(a.agent)).join(', ');
    insights.push({
      type: 'info',
      title: `${active.length} agents detected: ${names}`,
      description: 'Compare efficiency across agents in the Efficiency tab.',
      linkTab: 'efficiency',
    });
  }

  // ── Success ────────────────────────────────────────────────────────────────

  // High tool success rate
  if (efficiency.combined.toolSuccessRate >= 0.95 && efficiency.agents.some(a => a.totalToolCalls >= 20)) {
    insights.push({
      type: 'success',
      title: `Overall tool success rate is ${pct(efficiency.combined.toolSuccessRate)}`,
      description: 'Your agents are executing tools reliably with minimal errors.',
      linkTab: 'tools',
    });
  }

  // High completion rate
  if (efficiency.combined.completionRate >= 0.85 && agentStats.some(a => a.totalSessions >= 10)) {
    insights.push({
      type: 'success',
      title: `${pct(efficiency.combined.completionRate)} session completion rate`,
      description: 'Most sessions complete successfully across your agents.',
      linkTab: 'sessions',
    });
  }

  // ── Advanced insights (Phase 3) ──────────────────────────────────────────

  if (advanced) {
    // MCP server error rate
    for (const server of advanced.mcp.servers) {
      if (server.total_calls >= 5 && server.success_rate < 0.85) {
        insights.push({
          type: 'warning',
          title: `MCP server "${server.server}" has ${pct(1 - server.success_rate)} error rate`,
          description: `${server.error_count} errors across ${server.total_calls} calls. Check server configuration.`,
          agent: server.agent,
          linkTab: 'tools',
        });
      }
    }

    // Peak productivity hours
    const effective = advanced.hourly_effectiveness.filter(h => h.total_sessions >= 3);
    if (effective.length > 0) {
      const bestHour = effective.reduce((a, b) => a.completion_rate > b.completion_rate ? a : b);
      const worstHour = effective.reduce((a, b) => a.completion_rate < b.completion_rate ? a : b);
      if (bestHour.completion_rate - worstHour.completion_rate > 0.2) {
        insights.push({
          type: 'tip',
          title: `Sessions at ${bestHour.hour}:00 complete ${pct(bestHour.completion_rate)} vs ${pct(worstHour.completion_rate)} at ${worstHour.hour}:00`,
          description: 'Schedule complex agent tasks during your most productive hours.',
          linkTab: 'activity',
        });
      }
    }

    // Conversation depth
    const depth = advanced.conversation_depth;
    if (depth.high_backforth_sessions >= 3 && depth.high_backforth_completion_rate < depth.low_backforth_completion_rate - 0.15) {
      insights.push({
        type: 'tip',
        title: `Sessions with 5+ turns only complete ${pct(depth.high_backforth_completion_rate)} of the time`,
        description: `Simpler sessions complete at ${pct(depth.low_backforth_completion_rate)}. Break complex tasks into smaller prompts.`,
        linkTab: 'sessions',
      });
    }

    // Duration distribution
    const longBuckets = advanced.duration_distribution.filter(b => b.min_minutes >= 30 && b.session_count >= 2);
    const shortBuckets = advanced.duration_distribution.filter(b => b.max_minutes <= 15 && b.session_count >= 2);
    if (longBuckets.length > 0 && shortBuckets.length > 0) {
      const longRate = longBuckets.reduce((s, b) => s + b.completed_count, 0) / longBuckets.reduce((s, b) => s + b.session_count, 0);
      const shortRate = shortBuckets.reduce((s, b) => s + b.completed_count, 0) / shortBuckets.reduce((s, b) => s + b.session_count, 0);
      const longAvgCost = longBuckets.reduce((s, b) => s + b.total_cost, 0) / longBuckets.reduce((s, b) => s + b.session_count, 0);
      const shortAvgCost = shortBuckets.reduce((s, b) => s + b.total_cost, 0) / shortBuckets.reduce((s, b) => s + b.session_count, 0);
      if (longAvgCost > shortAvgCost * 3 && longRate < shortRate - 0.1) {
        insights.push({
          type: 'tip',
          title: `Sessions >30m cost ${cost(longAvgCost)} avg but only complete ${pct(longRate)}`,
          description: `Short sessions (<15m) average ${cost(shortAvgCost)} with ${pct(shortRate)} completion. Consider shorter, focused sessions.`,
          linkTab: 'sessions',
        });
      }
    }
  }

  // ── Prioritise and cap at 8 ──────────────────────────────────────────────

  const priority: Record<Insight['type'], number> = { warning: 0, tip: 1, info: 2, success: 3 };
  insights.sort((a, b) => priority[a.type] - priority[b.type]);
  return insights.slice(0, 8);
}
