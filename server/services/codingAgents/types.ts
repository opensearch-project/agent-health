/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified types for coding agent analytics.
 * All agent readers normalize their data into these common types
 * so the frontend can render them uniformly.
 */

// ─── Common Session ──────────────────────────────────────────────────────────

export interface AgentSession {
  agent: AgentKind;
  session_id: string;
  project_path: string;
  start_time: string;
  duration_minutes: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_counts: Record<string, number>;
  tool_error_counts: Record<string, number>;
  total_tool_errors: number;
  session_completed: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  first_prompt: string;
  estimated_cost: number;
  uses_mcp: boolean;
  model?: string;
  /** Unix username extracted from project_path or overridden via AGENT_HEALTH_USERNAME env var. */
  username?: string;
  /** Server name for multi-server aggregation ("local" or remote server name). */
  server_name?: string;
  /** @internal Source file path, used by cache layer. Stripped from API responses. */
  _filePath?: string;
}

export type AgentKind = 'claude-code' | 'kiro' | 'codex';

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface AgentStats {
  agent: AgentKind;
  totalSessions: number;
  totalCost: number;
  totalCacheSavings: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  totalToolErrors: number;
  toolSuccessRate: number;
  completedSessions: number;
  costPerCompletion: number;
  activeDays: number;
  avgSessionMinutes: number;
  dailyActivity: DailyActivity[];
}

export interface CombinedStats {
  agents: AgentStats[];
  dailyActivity: DailyActivity[];
  totalCost: number;
  totalSessions: number;
  totalTokens: number;
  wastedCost: number;
  abandonedSessions: number;
  insights: Insight[];
}

/** Date range filter for API queries */
export interface DateRange {
  from?: string; // ISO date string (YYYY-MM-DD)
  to?: string;   // ISO date string (YYYY-MM-DD)
}

export interface DailyCost {
  date: string;
  cost: number;
  agent: AgentKind;
}

// ─── Efficiency ─────────────────────────────────────────────────────────────

export interface EfficiencyAnalytics {
  agents: Array<{
    agent: AgentKind;
    toolSuccessRate: number;
    completedSessions: number;
    totalSessions: number;
    completionRate: number;
    costPerCompletion: number;
    totalToolErrors: number;
    totalToolCalls: number;
  }>;
  combined: {
    toolSuccessRate: number;
    completionRate: number;
    avgCostPerCompletion: number;
  };
}

// ─── Insights ───────────────────────────────────────────────────────────────

export interface Insight {
  type: 'warning' | 'tip' | 'info' | 'success';
  title: string;
  description: string;
  agent?: AgentKind;
  linkTab?: string;
}

// ─── Costs ───────────────────────────────────────────────────────────────────

export interface ModelCostBreakdown {
  agent: AgentKind;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  estimated_cost: number;
  cache_savings: number;
}

export interface ProjectCost {
  agent: AgentKind;
  project_path: string;
  display_name: string;
  estimated_cost: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CostAnalytics {
  total_cost: number;
  total_savings: number;
  models: ModelCostBreakdown[];
  by_project: ProjectCost[];
  daily_costs: DailyCost[];
}

// ─── Activity ────────────────────────────────────────────────────────────────

export interface ActivityData {
  daily_activity: DailyActivity[];
  hour_counts: Array<{ hour: number; count: number }>;
  dow_counts: Array<{ day: string; count: number }>;
  streaks: { current: number; longest: number };
  total_active_days: number;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export interface ToolSummary {
  agent: AgentKind;
  name: string;
  category: string;
  total_calls: number;
  session_count: number;
  error_count: number;
  success_rate: number;
}

export interface ToolsAnalytics {
  tools: ToolSummary[];
  total_tool_calls: number;
  total_tool_errors: number;
}

// ─── Session Detail (Phase 2) ───────────────────────────────────────────────

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool_result';
  text: string;
  timestamp?: string;
  toolName?: string;
  isError?: boolean;
}

export interface SessionDetail {
  session: AgentSession;
  messages: SessionMessage[];
}

// ─── Project Analytics (Phase 2) ────────────────────────────────────────────

export interface ProjectAnalytics {
  project_path: string;
  display_name: string;
  agents: AgentKind[];
  total_sessions: number;
  completed_sessions: number;
  completion_rate: number;
  total_cost: number;
  wasted_cost: number;
  total_tool_calls: number;
  total_tool_errors: number;
  avg_session_minutes: number;
  daily_costs: DailyCost[];
}

// ─── MCP Analytics (Phase 3) ────────────────────────────────────────────────

export interface McpServerSummary {
  server: string;
  agent: AgentKind;
  total_calls: number;
  error_count: number;
  success_rate: number;
  tools: Array<{ name: string; calls: number; errors: number }>;
  session_count: number;
}

export interface McpAnalytics {
  servers: McpServerSummary[];
  total_mcp_calls: number;
  total_mcp_errors: number;
}

// ─── Peak Productivity (Phase 3) ────────────────────────────────────────────

export interface HourlyEffectiveness {
  hour: number;
  total_sessions: number;
  completed_sessions: number;
  completion_rate: number;
  avg_cost: number;
}

// ─── Duration Distribution (Phase 3) ────────────────────────────────────────

export interface DurationBucket {
  label: string;
  min_minutes: number;
  max_minutes: number;
  session_count: number;
  completed_count: number;
  completion_rate: number;
  avg_cost: number;
  total_cost: number;
}

// ─── Conversation Depth (Phase 3) ───────────────────────────────────────────

export interface ConversationDepthStats {
  avg_depth: number;
  high_backforth_sessions: number;
  high_backforth_completion_rate: number;
  low_backforth_completion_rate: number;
  depth_buckets: Array<{
    label: string;
    session_count: number;
    completion_rate: number;
    avg_cost: number;
  }>;
}

// ─── Advanced Analytics (Phase 3 combined response) ─────────────────────────

export interface AdvancedAnalytics {
  mcp: McpAnalytics;
  hourly_effectiveness: HourlyEffectiveness[];
  duration_distribution: DurationBucket[];
  conversation_depth: ConversationDepthStats;
}

// ─── Failure Patterns (Phase 4) ─────────────────────────────────────────────

export interface FailurePattern {
  tool: string;
  error_snippet: string;
  occurrences: number;
  sessions: number;
  agent: AgentKind;
}

// ─── Export (Phase 4) ───────────────────────────────────────────────────────

export interface ExportData {
  exported_at: string;
  range?: DateRange;
  sessions: AgentSession[];
  stats: CombinedStats;
}

// ─── Team Analytics ─────────────────────────────────────────────────────────

export interface UserStats {
  username: string;
  total_sessions: number;
  completed_sessions: number;
  completion_rate: number;
  total_cost: number;
  wasted_cost: number;
  total_tool_calls: number;
  total_tool_errors: number;
  tool_success_rate: number;
  avg_session_minutes: number;
  agents_used: AgentKind[];
  active_days: number;
  top_projects: string[];
}

export interface TeamAnalytics {
  users: UserStats[];
  total_users: number;
  is_multi_user: boolean;
}

// ─── Reader Interface ────────────────────────────────────────────────────────

export interface CodingAgentReader {
  readonly agentName: AgentKind;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  getSessions(sinceMs?: number): Promise<AgentSession[]>;
  getStats(): Promise<AgentStats>;
  getSessionDetail?(sessionId: string): Promise<SessionDetail | null>;
  /** Re-read a single session from its file path. Used by cache for incremental refresh. */
  rereadSession?(filePath: string): Promise<AgentSession | null>;
}
