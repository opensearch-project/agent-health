/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API routes for the enterprise leaderboard feature.
 * All endpoints require OpenSearch storage to be configured (via storageClientMiddleware).
 * Aggregations are computed live — no materialized views.
 */

import { Router, Request, Response } from 'express';
import { storageClientMiddleware, requireStorageClient } from '../middleware/storageClient';
import { codingAgentRegistry as _registry } from '../services/codingAgents';
import type { DateRange } from '../services/codingAgents/types';
import type { RankingMetric, LeaderboardConfig } from '../services/codingAgents/leaderboard/types';
import { syncSessions, getSyncStatus } from '../services/codingAgents/leaderboard/ingestion';
import { getTeamStats, getUserStats, getProjectStats, getTrends } from '../services/codingAgents/leaderboard/teamAnalytics';
import { getRankings } from '../services/codingAgents/leaderboard/rankings';
import { getBadgeDefinitions, getUserBadges } from '../services/codingAgents/leaderboard/badges';
import { getRecommendations, getTeamInsights } from '../services/codingAgents/leaderboard/recommendations';

const router = Router();

// All leaderboard routes require OpenSearch storage
router.use('/api/coding-agents/leaderboard', storageClientMiddleware);

/** Extract date range from query params */
function parseDateRange(req: Request): DateRange | undefined {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  if (!from && !to) return undefined;
  return { from, to };
}

/** Extract leaderboard config from query params */
function parseConfig(req: Request): LeaderboardConfig {
  return {
    enabled: true,
    userId: req.query.user_id as string ?? 'anonymous',
    teamId: req.query.team_id as string ?? 'default',
  };
}

// ─── Phase 1: Sync ─────────────────────────────────────────────────────────

/**
 * POST /api/coding-agents/leaderboard/sync
 * Sync local sessions to OpenSearch.
 */
router.post('/api/coding-agents/leaderboard/sync', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const config = parseConfig(req);
    const range = parseDateRange(req);

    // Get sessions from the registry (guaranteed non-null since codingAnalyticsEnabled)
    const registry = _registry!;
    const sessions = await registry.getAllSessions(range);

    const result = await syncSessions(client, sessions, config);
    res.json(result);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured. Set OPENSEARCH_STORAGE_* environment variables.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/leaderboard/sync-status
 * Last sync time and total event count.
 */
router.get('/api/coding-agents/leaderboard/sync-status', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const config = parseConfig(req);
    const status = await getSyncStatus(client, config);
    res.json(status);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── Phase 2: Team Analytics ────────────────────────────────────────────────

/**
 * GET /api/coding-agents/leaderboard/team-stats
 * Aggregate stats by team.
 */
router.get('/api/coding-agents/leaderboard/team-stats', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const range = parseDateRange(req);
    const stats = await getTeamStats(client, teamId, range);
    res.json(stats);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/leaderboard/user-stats
 * Per-user stats (opt-in). Pass user_id to filter to one user.
 */
router.get('/api/coding-agents/leaderboard/user-stats', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const userId = req.query.user_id as string | undefined;
    const range = parseDateRange(req);
    const stats = await getUserStats(client, teamId, range, userId);
    res.json(stats);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/leaderboard/project-stats
 * Per-project stats for a team.
 */
router.get('/api/coding-agents/leaderboard/project-stats', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const range = parseDateRange(req);
    const stats = await getProjectStats(client, teamId, range);
    res.json(stats);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/leaderboard/trends
 * Daily/weekly/monthly cost and usage trends.
 */
router.get('/api/coding-agents/leaderboard/trends', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const range = parseDateRange(req);
    const period = (req.query.period as string ?? 'daily') as 'daily' | 'weekly' | 'monthly';
    const trends = await getTrends(client, teamId, range, period);
    res.json(trends);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── Phase 3: Rankings & Badges ─────────────────────────────────────────────

/**
 * GET /api/coding-agents/leaderboard/rankings
 * Ranked users by configurable metric.
 */
router.get('/api/coding-agents/leaderboard/rankings', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const metric = (req.query.metric as RankingMetric) ?? 'sessions';
    const range = parseDateRange(req);
    const limit = parseInt(req.query.limit as string) || 25;
    const rankings = await getRankings(client, teamId, metric, range, limit);
    res.json(rankings);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/leaderboard/badges/definitions
 * All available badge definitions.
 */
router.get('/api/coding-agents/leaderboard/badges/definitions', async (_req: Request, res: Response) => {
  res.json(getBadgeDefinitions());
});

/**
 * GET /api/coding-agents/leaderboard/badges
 * Badges earned by a specific user.
 */
router.get('/api/coding-agents/leaderboard/badges', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const userId = req.query.user_id as string;
    if (!userId) {
      res.status(400).json({ error: 'user_id query parameter is required' });
      return;
    }
    const range = parseDateRange(req);
    const badges = await getUserBadges(client, teamId, userId, range);
    res.json(badges);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── Phase 4: Recommendations ───────────────────────────────────────────────

/**
 * GET /api/coding-agents/leaderboard/recommendations
 * Personalized recommendations for a user.
 */
router.get('/api/coding-agents/leaderboard/recommendations', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const userId = req.query.user_id as string;
    if (!userId) {
      res.status(400).json({ error: 'user_id query parameter is required' });
      return;
    }
    const range = parseDateRange(req);
    const recommendations = await getRecommendations(client, teamId, userId, range);
    res.json(recommendations);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/leaderboard/team-insights
 * Team-level insights and trends.
 */
router.get('/api/coding-agents/leaderboard/team-insights', async (req: Request, res: Response) => {
  try {
    const client = requireStorageClient(req);
    const teamId = req.query.team_id as string ?? 'default';
    const range = parseDateRange(req);
    const insights = await getTeamInsights(client, teamId, range);
    res.json(insights);
  } catch (error: any) {
    if (error.message === 'Storage not configured') {
      res.status(503).json({ error: 'OpenSearch storage not configured.' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

export default router;
