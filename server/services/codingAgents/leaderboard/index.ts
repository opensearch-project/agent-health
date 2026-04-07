/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Barrel exports for the enterprise leaderboard feature.
 */

// Phase 1: Ingestion
export { USAGE_EVENTS_INDEX, sessionToEvent, ensureIndex, syncSessions, getSyncStatus } from './ingestion';

// Phase 2: Team Analytics
export { getTeamStats, getUserStats, getProjectStats, getTrends } from './teamAnalytics';

// Phase 3: Rankings & Badges
export { getRankings } from './rankings';
export { getBadgeDefinitions, getBadgesByCategory, getUserBadges } from './badges';

// Phase 4: Recommendations
export { getRecommendations, getTeamInsights } from './recommendations';

// Types
export type {
  LeaderboardConfig,
  UsageEvent,
  SyncStatus,
  SyncResult,
  TeamStats,
  UserStats,
  ProjectStats,
  TrendPoint,
  RankingMetric,
  RankedUser,
  BadgeDefinition,
  BadgeCategory,
  EarnedBadge,
  Recommendation,
  RecommendationType,
  TeamInsight,
} from './types';
