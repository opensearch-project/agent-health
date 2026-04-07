/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types for the enterprise leaderboard feature.
 * All aggregations are computed live via OpenSearch PPL — no materialized views.
 */

import type { AgentKind } from '../types';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface LeaderboardConfig {
  enabled: boolean;
  userId: string;
  teamId: string;
}

// ─── Usage Event (OpenSearch document) ──────────────────────────────────────

export interface UsageEvent {
  user_id: string;
  team_id: string;
  session_id: string;
  agent: AgentKind;
  model: string;
  project_hash: string;
  project_display: string;
  start_time: string;
  duration_minutes: number;
  user_message_count: number;
  assistant_message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  estimated_cost: number;
  total_tool_calls: number;
  total_tool_errors: number;
  tool_success_rate: number;
  top_tools: string[];
  tool_categories: string[];
  uses_mcp: boolean;
  session_completed: boolean;
  synced_at: string;
  source_server: string;
}

// ─── Sync ───────────────────────────────────────────────────────────────────

export interface SyncStatus {
  last_sync_at: string | null;
  total_events: number;
  user_id: string;
  team_id: string;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
}

// ─── Team Analytics ─────────────────────────────────────────────────────────

export interface TeamStats {
  team_id: string;
  total_sessions: number;
  total_cost: number;
  total_users: number;
  avg_cost_per_user: number;
  avg_completion_rate: number;
  avg_tool_success_rate: number;
  top_agents: Array<{ agent: AgentKind; sessions: number }>;
  top_projects: Array<{ project: string; sessions: number; cost: number }>;
}

export interface UserStats {
  user_id: string;
  total_sessions: number;
  completed_sessions: number;
  completion_rate: number;
  total_cost: number;
  cost_per_completion: number;
  total_tool_calls: number;
  total_tool_errors: number;
  tool_success_rate: number;
  agents_used: AgentKind[];
  active_days: number;
  avg_duration_minutes: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cache_hit_rate: number;
}

export interface ProjectStats {
  project_hash: string;
  project_display: string;
  total_sessions: number;
  total_cost: number;
  total_users: number;
  completion_rate: number;
  agents: AgentKind[];
}

export interface TrendPoint {
  date: string;
  sessions: number;
  cost: number;
  users: number;
  completion_rate: number;
}

// ─── Leaderboard ────────────────────────────────────────────────────────────

export type RankingMetric =
  | 'sessions'
  | 'cost'
  | 'completion_rate'
  | 'efficiency'
  | 'tool_success'
  | 'active_days';

export interface RankedUser {
  rank: number;
  user_id: string;
  metric_value: number;
  total_sessions: number;
  completion_rate: number;
  total_cost: number;
  tool_success_rate: number;
}

// ─── Badges ─────────────────────────────────────────────────────────────────

export type BadgeCategory = 'efficiency' | 'volume' | 'diversity' | 'consistency' | 'quality' | 'pattern' | 'adoption';

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  category: BadgeCategory;
  icon: string;
}

export interface EarnedBadge {
  badge: BadgeDefinition;
  earned_at: string;
  metric_value: number;
}

// ─── Recommendations ────────────────────────────────────────────────────────

export type RecommendationType = 'tool_pattern' | 'model_selection' | 'session_hygiene' | 'cache_optimization' | 'agent_diversity';

export interface Recommendation {
  type: RecommendationType;
  title: string;
  description: string;
  your_value: number;
  team_avg: number;
  top_performer_avg: number;
  potential_savings?: number;
}

export interface TeamInsight {
  type: 'adoption' | 'cost' | 'efficiency' | 'trend';
  title: string;
  description: string;
  metric_value: number;
}
