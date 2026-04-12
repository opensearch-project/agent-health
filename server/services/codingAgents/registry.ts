/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Registry that auto-detects available coding agents and provides
 * unified access to their data through the CodingAgentReader interface.
 */

import type {
  CodingAgentReader,
  AgentKind,
  AgentSession,
  AgentStats,
  CombinedStats,
  DailyActivity,
  DateRange,
  DailyCost,
  CostAnalytics,
  ProjectCost,
  ModelCostBreakdown,
  ActivityData,
  ToolsAnalytics,
  ToolSummary,
  EfficiencyAnalytics,
  SessionDetail,
  ProjectAnalytics,
  AdvancedAnalytics,
  McpAnalytics,
  McpServerSummary,
  HourlyEffectiveness,
  DurationBucket,
  ConversationDepthStats,
  FailurePattern,
  ExportData,
  TeamAnalytics,
  UserStats,
} from './types';
import { categorizeTool, isMcpTool, parseMcpTool } from './toolCategories';
import { generateInsights } from './insights';
import { ClaudeCodeReader } from './readers/claudeCode';
import { KiroReader } from './readers/kiro';
import { CodexReader } from './readers/codex';
import { SessionCacheManager } from './cache';

/**
 * Extract unix username from a project path.
 * Handles macOS (/Users/X/...) and Linux (/home/X/...).
 * Returns AGENT_HEALTH_USERNAME env var if set, overriding detection.
 */
export function extractUsername(projectPath: string): string {
  const override = process.env.AGENT_HEALTH_USERNAME;
  if (override) return override;

  const parts = projectPath.split('/');
  const usersIdx = parts.indexOf('Users');
  if (usersIdx !== -1 && parts.length > usersIdx + 1) return parts[usersIdx + 1];
  const homeIdx = parts.indexOf('home');
  if (homeIdx !== -1 && parts.length > homeIdx + 1) return parts[homeIdx + 1];
  return 'unknown';
}

/** Format a Date as YYYY-MM-DD in local timezone (NOT UTC). */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Filter sessions by date range */
function filterByDate(sessions: AgentSession[], range?: DateRange): AgentSession[] {
  if (!range?.from && !range?.to) return sessions;
  return sessions.filter(s => {
    const date = s.start_time.slice(0, 10);
    if (range.from && date < range.from) return false;
    if (range.to && date > range.to) return false;
    return true;
  });
}

/** Compute AgentStats from a list of sessions for a given agent */
function computeStatsFromSessions(sessions: AgentSession[], agent: AgentKind): AgentStats {
  const dailyMap = new Map<string, DailyActivity>();
  let totalCost = 0;
  let totalCacheSavings = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;
  let totalToolErrors = 0;
  let totalDuration = 0;
  let completedSessions = 0;

  for (const s of sessions) {
    totalCost += s.estimated_cost;
    totalCacheSavings += s.cache_read_input_tokens > 0 ? s.estimated_cost * 0.1 : 0; // approximate
    totalInputTokens += s.input_tokens;
    totalOutputTokens += s.output_tokens;
    totalDuration += s.duration_minutes;
    totalToolErrors += s.total_tool_errors;
    if (s.session_completed) completedSessions++;
    const toolCallCount = Object.values(s.tool_counts).reduce((a, b) => a + b, 0);
    totalToolCalls += toolCallCount;

    const date = s.start_time.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const existing = dailyMap.get(date) ?? { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
      existing.messageCount += s.user_message_count + s.assistant_message_count;
      existing.sessionCount += 1;
      existing.toolCallCount += toolCallCount;
      dailyMap.set(date, existing);
    }
  }

  const dailyActivity = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    agent,
    totalSessions: sessions.length,
    totalCost,
    totalCacheSavings,
    totalInputTokens,
    totalOutputTokens,
    totalToolCalls,
    totalToolErrors,
    toolSuccessRate: totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1,
    completedSessions,
    costPerCompletion: completedSessions > 0 ? totalCost / completedSessions : 0,
    activeDays: dailyActivity.length,
    avgSessionMinutes: sessions.length > 0 ? totalDuration / sessions.length : 0,
    dailyActivity,
  };
}

export class CodingAgentRegistry {
  private readers: CodingAgentReader[] = [
    new ClaudeCodeReader(),
    new KiroReader(),
    new CodexReader(),
  ];
  private cacheManager: SessionCacheManager;

  constructor() {
    this.cacheManager = new SessionCacheManager(this.readers);
    this.cacheManager.warmup();
    this.cacheManager.startBackgroundRefresh(30_000);
  }

  /** Wait for initial fast pass to complete so first requests have data. */
  async waitForReady(): Promise<void> {
    await this.cacheManager.waitForFastPass();
  }

  /** Whether historical data is still loading in the background. */
  isBackfilling(): boolean {
    return this.cacheManager.isBackfilling();
  }

  /** How many days of data have been loaded so far. */
  loadedDays(): number {
    return this.cacheManager.loadedDays();
  }

  /** Stop background refresh timers (for graceful shutdown). */
  stopBackgroundRefresh(): void {
    this.cacheManager.stopBackgroundRefresh();
  }

  /** Get all readers whose data directories exist on this machine */
  async getAvailableReaders(): Promise<CodingAgentReader[]> {
    const checks = await Promise.all(
      this.readers.map(async r => ({ reader: r, available: await r.isAvailable() }))
    );
    return checks.filter(c => c.available).map(c => c.reader);
  }

  /** Get reader by agent name */
  getReader(agent: AgentKind): CodingAgentReader | undefined {
    return this.readers.find(r => r.agentName === agent);
  }

  /** Get all sessions from all available agents, optionally filtered by date range.
   *  Results are served from an in-memory cache that refreshes on directory changes
   *  and periodically re-reads active sessions in the background.
   *  Each session is enriched with a `username` field. */
  async getAllSessions(range?: DateRange): Promise<AgentSession[]> {
    const merged = await this.cacheManager.getAllSessionsCached();
    // Enrich with username
    const enriched = merged.map(s => ({
      ...s,
      username: s.username || extractUsername(s.project_path),
    }));
    return filterByDate(enriched, range);
  }

  /** Get combined stats from all available agents, optionally filtered by date range */
  async getCombinedStats(range?: DateRange): Promise<CombinedStats> {
    const sessions = await this.getAllSessions(range);

    // Group sessions by agent and compute stats per agent
    const byAgent = new Map<AgentKind, AgentSession[]>();
    for (const s of sessions) {
      const list = byAgent.get(s.agent) ?? [];
      list.push(s);
      byAgent.set(s.agent, list);
    }

    const allStats: AgentStats[] = [];
    for (const [agent, agentSessions] of byAgent) {
      allStats.push(computeStatsFromSessions(agentSessions, agent));
    }

    // Merge daily activity across agents
    const dailyMap = new Map<string, DailyActivity>();
    for (const stats of allStats) {
      for (const d of stats.dailyActivity) {
        const existing = dailyMap.get(d.date) ?? { date: d.date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
        existing.messageCount += d.messageCount;
        existing.sessionCount += d.sessionCount;
        existing.toolCallCount += d.toolCallCount;
        dailyMap.set(d.date, existing);
      }
    }
    const dailyActivity = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Wasted cost: cost on abandoned sessions
    let wastedCost = 0;
    let abandonedSessions = 0;
    for (const s of sessions) {
      if (!s.session_completed && s.estimated_cost > 0) {
        wastedCost += s.estimated_cost;
        abandonedSessions++;
      }
    }

    const efficiency = this.computeEfficiency(allStats);
    const advanced: AdvancedAnalytics = {
      mcp: this.computeMcpAnalytics(sessions),
      hourly_effectiveness: this.computeHourlyEffectiveness(sessions),
      duration_distribution: this.computeDurationDistribution(sessions),
      conversation_depth: this.computeConversationDepth(sessions),
    };
    const insights = generateInsights(allStats, efficiency, wastedCost, abandonedSessions, advanced);

    return {
      agents: allStats,
      dailyActivity,
      totalCost: allStats.reduce((s, a) => s + a.totalCost, 0),
      totalSessions: allStats.reduce((s, a) => s + a.totalSessions, 0),
      totalTokens: allStats.reduce((s, a) => s + a.totalInputTokens + a.totalOutputTokens, 0),
      wastedCost,
      abandonedSessions,
      insights,
    };
  }

  /** Get cost analytics across all agents */
  async getCostAnalytics(range?: DateRange): Promise<CostAnalytics> {
    const sessions = await this.getAllSessions(range);

    // Group by agent+model for model breakdown
    const modelMap = new Map<string, ModelCostBreakdown>();
    for (const s of sessions) {
      const modelKey = `${s.agent}:${s.model ?? 'default'}`;
      const existing = modelMap.get(modelKey) ?? {
        agent: s.agent,
        model: s.model ?? 'default',
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        estimated_cost: 0,
        cache_savings: 0,
      };
      existing.input_tokens += s.input_tokens;
      existing.output_tokens += s.output_tokens;
      existing.cache_write_tokens += s.cache_creation_input_tokens;
      existing.cache_read_tokens += s.cache_read_input_tokens;
      existing.estimated_cost += s.estimated_cost;
      modelMap.set(modelKey, existing);
    }

    // Group by project
    const projectMap = new Map<string, ProjectCost>();
    for (const s of sessions) {
      const key = `${s.agent}:${s.project_path}`;
      const existing = projectMap.get(key) ?? {
        agent: s.agent,
        project_path: s.project_path,
        display_name: s.project_path.split('/').pop() || s.project_path,
        estimated_cost: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
      existing.estimated_cost += s.estimated_cost;
      existing.input_tokens += s.input_tokens;
      existing.output_tokens += s.output_tokens;
      projectMap.set(key, existing);
    }

    // Daily cost breakdown by agent
    const dailyCostMap = new Map<string, DailyCost>();
    for (const s of sessions) {
      const date = s.start_time.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const key = `${date}:${s.agent}`;
      const existing = dailyCostMap.get(key) ?? { date, cost: 0, agent: s.agent };
      existing.cost += s.estimated_cost;
      dailyCostMap.set(key, existing);
    }

    const models = Array.from(modelMap.values()).sort((a, b) => b.estimated_cost - a.estimated_cost);
    const by_project = Array.from(projectMap.values())
      .sort((a, b) => b.estimated_cost - a.estimated_cost)
      .slice(0, 20);
    const daily_costs = Array.from(dailyCostMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    return {
      total_cost: models.reduce((s, m) => s + m.estimated_cost, 0),
      total_savings: models.reduce((s, m) => s + m.cache_savings, 0),
      models,
      by_project,
      daily_costs,
    };
  }

  /** Get activity data (streaks, day-of-week, hourly) */
  async getActivityData(range?: DateRange): Promise<ActivityData> {
    const sessions = await this.getAllSessions(range);

    const activeDates = new Set<string>();
    const dowCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun=0..Sat=6
    const hourCounts = new Array(24).fill(0);

    for (const s of sessions) {
      if (!s.start_time) continue;
      const d = new Date(s.start_time);
      if (isNaN(d.getTime())) continue;
      activeDates.add(s.start_time.slice(0, 10));
      dowCounts[d.getDay()]++;
      hourCounts[d.getHours()]++;
    }

    // Compute streaks
    const sorted = [...activeDates].sort();
    let longest = sorted.length > 0 ? 1 : 0;
    let streak = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1]);
      const curr = new Date(sorted[i]);
      const diff = (curr.getTime() - prev.getTime()) / 86_400_000;
      if (diff === 1) {
        streak++;
        if (streak > longest) longest = streak;
      } else {
        streak = 1;
      }
    }

    const today = localDateStr(new Date());
    let current = 0;
    const dateIter = new Date();
    while (activeDates.has(localDateStr(dateIter))) {
      current++;
      dateIter.setDate(dateIter.getDate() - 1);
    }

    // Build daily activity from sessions
    const dailyMap = new Map<string, DailyActivity>();
    for (const s of sessions) {
      const date = s.start_time.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const existing = dailyMap.get(date) ?? { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
      existing.messageCount += s.user_message_count + s.assistant_message_count;
      existing.sessionCount += 1;
      existing.toolCallCount += Object.values(s.tool_counts).reduce((a, b) => a + b, 0);
      dailyMap.set(date, existing);
    }

    return {
      daily_activity: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      hour_counts: hourCounts.map((count, hour) => ({ hour, count })),
      dow_counts: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({ day, count: dowCounts[i] })),
      streaks: { current, longest },
      total_active_days: activeDates.size,
    };
  }

  /** Get tool usage analytics (with error counts and success rates) */
  async getToolsAnalytics(range?: DateRange): Promise<ToolsAnalytics> {
    const sessions = await this.getAllSessions(range);

    const toolMap = new Map<string, { total: number; errors: number; sessions: Set<string>; agent: AgentKind }>();
    for (const s of sessions) {
      for (const [tool, count] of Object.entries(s.tool_counts)) {
        const key = `${s.agent}:${tool}`;
        const existing = toolMap.get(key) ?? { total: 0, errors: 0, sessions: new Set(), agent: s.agent };
        existing.total += count;
        existing.errors += s.tool_error_counts[tool] ?? 0;
        existing.sessions.add(s.session_id);
        toolMap.set(key, existing);
      }
    }

    let totalToolErrors = 0;
    const tools: ToolSummary[] = Array.from(toolMap.entries())
      .map(([key, data]) => {
        const name = key.split(':').slice(1).join(':');
        totalToolErrors += data.errors;
        return {
          agent: data.agent,
          name,
          category: categorizeTool(name),
          total_calls: data.total,
          session_count: data.sessions.size,
          error_count: data.errors,
          success_rate: data.total > 0 ? (data.total - data.errors) / data.total : 1,
        };
      })
      .sort((a, b) => b.total_calls - a.total_calls);

    return {
      tools,
      total_tool_calls: tools.reduce((s, t) => s + t.total_calls, 0),
      total_tool_errors: totalToolErrors,
    };
  }

  /** Get efficiency analytics for cross-agent comparison */
  async getEfficiencyAnalytics(range?: DateRange): Promise<EfficiencyAnalytics> {
    const sessions = await this.getAllSessions(range);
    const byAgent = new Map<AgentKind, AgentSession[]>();
    for (const s of sessions) {
      const list = byAgent.get(s.agent) ?? [];
      list.push(s);
      byAgent.set(s.agent, list);
    }
    const allStats: AgentStats[] = [];
    for (const [agent, agentSessions] of byAgent) {
      allStats.push(computeStatsFromSessions(agentSessions, agent));
    }
    return this.computeEfficiency(allStats);
  }

  /** Internal: compute efficiency from pre-fetched stats */
  private computeEfficiency(allStats: AgentStats[]): EfficiencyAnalytics {
    const agents = allStats.map(s => ({
      agent: s.agent,
      toolSuccessRate: s.toolSuccessRate,
      completedSessions: s.completedSessions,
      totalSessions: s.totalSessions,
      completionRate: s.totalSessions > 0 ? s.completedSessions / s.totalSessions : 0,
      costPerCompletion: s.costPerCompletion,
      totalToolErrors: s.totalToolErrors,
      totalToolCalls: s.totalToolCalls,
    }));

    const totalCalls = agents.reduce((s, a) => s + a.totalToolCalls, 0);
    const totalErrors = agents.reduce((s, a) => s + a.totalToolErrors, 0);
    const totalSessions = agents.reduce((s, a) => s + a.totalSessions, 0);
    const totalCompleted = agents.reduce((s, a) => s + a.completedSessions, 0);
    const totalCostForCompleted = allStats
      .filter(s => s.completedSessions > 0)
      .reduce((sum, s) => sum + s.totalCost, 0);

    return {
      agents,
      combined: {
        toolSuccessRate: totalCalls > 0 ? (totalCalls - totalErrors) / totalCalls : 1,
        completionRate: totalSessions > 0 ? totalCompleted / totalSessions : 0,
        avgCostPerCompletion: totalCompleted > 0 ? totalCostForCompleted / totalCompleted : 0,
      },
    };
  }

  // ─── Phase 2: Session Detail ────────────────────────────────────────────────

  /** Get detail for a specific session (conversation messages) */
  async getSessionDetail(agent: AgentKind, sessionId: string, _serverName?: string): Promise<SessionDetail | null> {
    const reader = this.getReader(agent);
    if (!reader?.getSessionDetail) return null;
    return reader.getSessionDetail(sessionId);
  }

  // ─── Phase 2: Project Analytics ─────────────────────────────────────────────

  /** Get per-project analytics across all agents */
  async getProjectAnalytics(range?: DateRange): Promise<ProjectAnalytics[]> {
    const sessions = await this.getAllSessions(range);

    const projectMap = new Map<string, {
      agents: Set<AgentKind>;
      sessions: AgentSession[];
    }>();

    for (const s of sessions) {
      const key = s.project_path;
      const entry = projectMap.get(key) ?? { agents: new Set(), sessions: [] };
      entry.agents.add(s.agent);
      entry.sessions.push(s);
      projectMap.set(key, entry);
    }

    return Array.from(projectMap.entries())
      .map(([projectPath, data]) => {
        const completed = data.sessions.filter(s => s.session_completed).length;
        const totalCost = data.sessions.reduce((s, sess) => s + sess.estimated_cost, 0);
        const wastedCost = data.sessions
          .filter(s => !s.session_completed)
          .reduce((s, sess) => s + sess.estimated_cost, 0);
        const totalToolCalls = data.sessions.reduce((s, sess) =>
          s + Object.values(sess.tool_counts).reduce((a, b) => a + b, 0), 0);
        const totalToolErrors = data.sessions.reduce((s, sess) => s + sess.total_tool_errors, 0);
        const totalDuration = data.sessions.reduce((s, sess) => s + sess.duration_minutes, 0);

        // Daily cost for this project
        const dailyCostMap = new Map<string, DailyCost>();
        for (const s of data.sessions) {
          const date = s.start_time.slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          const key = `${date}:${s.agent}`;
          const existing = dailyCostMap.get(key) ?? { date, cost: 0, agent: s.agent };
          existing.cost += s.estimated_cost;
          dailyCostMap.set(key, existing);
        }

        return {
          project_path: projectPath,
          display_name: projectPath.split('/').pop() || projectPath,
          agents: [...data.agents],
          total_sessions: data.sessions.length,
          completed_sessions: completed,
          completion_rate: data.sessions.length > 0 ? completed / data.sessions.length : 0,
          total_cost: totalCost,
          wasted_cost: wastedCost,
          total_tool_calls: totalToolCalls,
          total_tool_errors: totalToolErrors,
          avg_session_minutes: data.sessions.length > 0 ? totalDuration / data.sessions.length : 0,
          daily_costs: Array.from(dailyCostMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
        };
      })
      .sort((a, b) => b.total_sessions - a.total_sessions);
  }

  // ─── Phase 3: Advanced Analytics ────────────────────────────────────────────

  /** Get MCP server-level analytics */
  private computeMcpAnalytics(sessions: AgentSession[]): McpAnalytics {
    const serverMap = new Map<string, {
      agent: AgentKind;
      tools: Map<string, { calls: number; errors: number }>;
      sessions: Set<string>;
    }>();

    for (const s of sessions) {
      for (const [toolName, count] of Object.entries(s.tool_counts)) {
        if (!isMcpTool(toolName)) continue;
        const parsed = parseMcpTool(toolName);
        if (!parsed) continue;

        const key = `${s.agent}:${parsed.server}`;
        const entry = serverMap.get(key) ?? {
          agent: s.agent,
          tools: new Map(),
          sessions: new Set(),
        };
        const tool = entry.tools.get(parsed.tool) ?? { calls: 0, errors: 0 };
        tool.calls += count;
        tool.errors += s.tool_error_counts[toolName] ?? 0;
        entry.tools.set(parsed.tool, tool);
        entry.sessions.add(s.session_id);
        serverMap.set(key, entry);
      }
    }

    let totalCalls = 0;
    let totalErrors = 0;
    const servers: McpServerSummary[] = Array.from(serverMap.entries()).map(([key, data]) => {
      const server = key.split(':').slice(1).join(':');
      const tools = Array.from(data.tools.entries()).map(([name, t]) => ({
        name, calls: t.calls, errors: t.errors,
      })).sort((a, b) => b.calls - a.calls);
      const serverCalls = tools.reduce((s, t) => s + t.calls, 0);
      const serverErrors = tools.reduce((s, t) => s + t.errors, 0);
      totalCalls += serverCalls;
      totalErrors += serverErrors;
      return {
        server,
        agent: data.agent,
        total_calls: serverCalls,
        error_count: serverErrors,
        success_rate: serverCalls > 0 ? (serverCalls - serverErrors) / serverCalls : 1,
        tools,
        session_count: data.sessions.size,
      };
    }).sort((a, b) => b.total_calls - a.total_calls);

    return { servers, total_mcp_calls: totalCalls, total_mcp_errors: totalErrors };
  }

  /** Hourly effectiveness: completion rate and cost by hour of day */
  private computeHourlyEffectiveness(sessions: AgentSession[]): HourlyEffectiveness[] {
    const hours: Array<{ total: number; completed: number; totalCost: number }> =
      Array.from({ length: 24 }, () => ({ total: 0, completed: 0, totalCost: 0 }));

    for (const s of sessions) {
      const d = new Date(s.start_time);
      if (isNaN(d.getTime())) continue;
      const h = d.getHours();
      hours[h].total++;
      if (s.session_completed) hours[h].completed++;
      hours[h].totalCost += s.estimated_cost;
    }

    return hours.map((data, hour) => ({
      hour,
      total_sessions: data.total,
      completed_sessions: data.completed,
      completion_rate: data.total > 0 ? data.completed / data.total : 0,
      avg_cost: data.total > 0 ? data.totalCost / data.total : 0,
    }));
  }

  /** Session duration distribution */
  private computeDurationDistribution(sessions: AgentSession[]): DurationBucket[] {
    const buckets: Array<{ label: string; min: number; max: number; sessions: AgentSession[] }> = [
      { label: '<5m', min: 0, max: 5, sessions: [] },
      { label: '5-15m', min: 5, max: 15, sessions: [] },
      { label: '15-30m', min: 15, max: 30, sessions: [] },
      { label: '30-60m', min: 30, max: 60, sessions: [] },
      { label: '60m+', min: 60, max: Infinity, sessions: [] },
    ];

    for (const s of sessions) {
      const d = s.duration_minutes;
      const bucket = buckets.find(b => d >= b.min && d < b.max) ?? buckets[buckets.length - 1];
      bucket.sessions.push(s);
    }

    return buckets.map(b => {
      const completed = b.sessions.filter(s => s.session_completed).length;
      const totalCost = b.sessions.reduce((s, sess) => s + sess.estimated_cost, 0);
      return {
        label: b.label,
        min_minutes: b.min,
        max_minutes: b.max === Infinity ? 999 : b.max,
        session_count: b.sessions.length,
        completed_count: completed,
        completion_rate: b.sessions.length > 0 ? completed / b.sessions.length : 0,
        avg_cost: b.sessions.length > 0 ? totalCost / b.sessions.length : 0,
        total_cost: totalCost,
      };
    });
  }

  /** Conversation depth (back-and-forth intensity) */
  private computeConversationDepth(sessions: AgentSession[]): ConversationDepthStats {
    const depths: Array<{ depth: number; completed: boolean; cost: number }> = [];
    for (const s of sessions) {
      if (s.user_message_count === 0) continue;
      depths.push({
        depth: s.user_message_count,
        completed: s.session_completed,
        cost: s.estimated_cost,
      });
    }

    const avgDepth = depths.length > 0 ? depths.reduce((s, d) => s + d.depth, 0) / depths.length : 0;
    const high = depths.filter(d => d.depth >= 5);
    const low = depths.filter(d => d.depth < 5);

    const depthBuckets = [
      { label: '1-2 turns', min: 1, max: 3 },
      { label: '3-5 turns', min: 3, max: 6 },
      { label: '6-10 turns', min: 6, max: 11 },
      { label: '10+ turns', min: 11, max: Infinity },
    ].map(b => {
      const inBucket = depths.filter(d => d.depth >= b.min && d.depth < b.max);
      const completed = inBucket.filter(d => d.completed).length;
      const totalCost = inBucket.reduce((s, d) => s + d.cost, 0);
      return {
        label: b.label,
        session_count: inBucket.length,
        completion_rate: inBucket.length > 0 ? completed / inBucket.length : 0,
        avg_cost: inBucket.length > 0 ? totalCost / inBucket.length : 0,
      };
    });

    return {
      avg_depth: avgDepth,
      high_backforth_sessions: high.length,
      high_backforth_completion_rate: high.length > 0 ? high.filter(d => d.completed).length / high.length : 0,
      low_backforth_completion_rate: low.length > 0 ? low.filter(d => d.completed).length / low.length : 0,
      depth_buckets: depthBuckets,
    };
  }

  /** Get all Phase 3 advanced analytics in one call */
  async getAdvancedAnalytics(range?: DateRange): Promise<AdvancedAnalytics> {
    const sessions = await this.getAllSessions(range);
    return {
      mcp: this.computeMcpAnalytics(sessions),
      hourly_effectiveness: this.computeHourlyEffectiveness(sessions),
      duration_distribution: this.computeDurationDistribution(sessions),
      conversation_depth: this.computeConversationDepth(sessions),
    };
  }

  // ─── Phase 4: Failure Patterns ──────────────────────────────────────────────

  /** Detect recurring tool failure patterns */
  async getFailurePatterns(range?: DateRange): Promise<FailurePattern[]> {
    const sessions = await this.getAllSessions(range);
    const patternMap = new Map<string, { tool: string; agent: AgentKind; occurrences: number; sessions: Set<string> }>();

    for (const s of sessions) {
      for (const [tool, errorCount] of Object.entries(s.tool_error_counts)) {
        if (errorCount === 0) continue;
        const key = `${s.agent}:${tool}`;
        const entry = patternMap.get(key) ?? { tool, agent: s.agent, occurrences: 0, sessions: new Set() };
        entry.occurrences += errorCount;
        entry.sessions.add(s.session_id);
        patternMap.set(key, entry);
      }
    }

    return Array.from(patternMap.values())
      .filter(p => p.occurrences >= 2)
      .map(p => ({
        tool: p.tool,
        error_snippet: `${p.tool} failed ${p.occurrences} times across ${p.sessions.size} sessions`,
        occurrences: p.occurrences,
        sessions: p.sessions.size,
        agent: p.agent,
      }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 20);
  }

  // ─── Team Analytics ─────────────────────────────────────────────────────────

  /** Get per-user analytics for team view. Only meaningful with multiple users. */
  async getTeamAnalytics(range?: DateRange): Promise<TeamAnalytics> {
    const sessions = await this.getAllSessions(range);

    const userMap = new Map<string, AgentSession[]>();
    for (const s of sessions) {
      const username = s.username || 'unknown';
      const list = userMap.get(username) ?? [];
      list.push(s);
      userMap.set(username, list);
    }

    const users: UserStats[] = Array.from(userMap.entries()).map(([username, userSessions]) => {
      const completed = userSessions.filter(s => s.session_completed).length;
      const totalCost = userSessions.reduce((s, sess) => s + sess.estimated_cost, 0);
      const wastedCost = userSessions.filter(s => !s.session_completed).reduce((s, sess) => s + sess.estimated_cost, 0);
      const totalToolCalls = userSessions.reduce((s, sess) =>
        s + Object.values(sess.tool_counts).reduce((a, b) => a + b, 0), 0);
      const totalToolErrors = userSessions.reduce((s, sess) => s + sess.total_tool_errors, 0);
      const totalDuration = userSessions.reduce((s, sess) => s + sess.duration_minutes, 0);
      const agents = [...new Set(userSessions.map(s => s.agent))];
      const activeDates = new Set(userSessions.map(s => s.start_time.slice(0, 10)));

      // Top 3 projects by session count
      const projectCounts = new Map<string, number>();
      for (const s of userSessions) {
        projectCounts.set(s.project_path, (projectCounts.get(s.project_path) ?? 0) + 1);
      }
      const topProjects = [...projectCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p]) => p.split('/').pop() || p);

      return {
        username,
        total_sessions: userSessions.length,
        completed_sessions: completed,
        completion_rate: userSessions.length > 0 ? completed / userSessions.length : 0,
        total_cost: totalCost,
        wasted_cost: wastedCost,
        total_tool_calls: totalToolCalls,
        total_tool_errors: totalToolErrors,
        tool_success_rate: totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1,
        avg_session_minutes: userSessions.length > 0 ? totalDuration / userSessions.length : 0,
        agents_used: agents,
        active_days: activeDates.size,
        top_projects: topProjects,
      };
    }).sort((a, b) => b.total_sessions - a.total_sessions);

    return {
      users,
      total_users: users.length,
      is_multi_user: users.length > 1,
    };
  }

  // ─── Phase 4: Export ────────────────────────────────────────────────────────

  /** Export all data for a given range */
  async exportData(range?: DateRange): Promise<ExportData> {
    const sessions = await this.getAllSessions(range);
    const stats = await this.getCombinedStats(range);
    return {
      exported_at: new Date().toISOString(),
      range,
      sessions,
      stats,
    };
  }
}

