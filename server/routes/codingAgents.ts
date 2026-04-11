/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API routes for coding agent analytics.
 * Provides unified access to Claude Code, Kiro, and Codex session data.
 *
 * All data endpoints accept optional `from` and `to` query params (YYYY-MM-DD)
 * for date range filtering.
 */

import { Router, Request, Response } from 'express';
import { codingAgentRegistry as _registry } from '../services/codingAgents';
import type { DateRange, AgentKind } from '../services/codingAgents/types';
import { RemoteAggregator } from '../services/codingAgents/remoteAggregator';

// Routes are only mounted when codingAnalyticsEnabled is true (see routes/index.ts),
// so the registry is guaranteed to be non-null here. Defensive check prevents a crash
// if initialization order ever changes.
if (!_registry) {
  throw new Error('codingAgentRegistry is null — coding agent routes should not be mounted when analytics is disabled');
}
const codingAgentRegistry = _registry;

const router = Router();

/** Extract date range from query params */
function parseDateRange(req: Request): DateRange | undefined {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  if (!from && !to) return undefined;
  return { from, to };
}

/**
 * GET /api/coding-agents/available
 * Returns which coding agents are detected on this machine.
 */
router.get('/api/coding-agents/available', async (_req: Request, res: Response) => {
  try {
    const readers = await codingAgentRegistry.getAvailableReaders();
    const remoteServers = codingAgentRegistry instanceof RemoteAggregator
      ? codingAgentRegistry.getRemoteServerNames()
      : [];
    res.json({
      agents: readers.map(r => ({
        name: r.agentName,
        displayName: r.displayName,
      })),
      remoteServers,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/stats
 * Returns combined stats from all available coding agents.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/stats', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const stats = await codingAgentRegistry.getCombinedStats(range);
    res.json({
      ...stats,
      warming: codingAgentRegistry.isBackfilling(),
      loadedDays: Math.min(codingAgentRegistry.loadedDays(), 99999),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/sessions
 * Returns all sessions from all available agents, merged and sorted.
 * Query params:
 *   - agent: filter by agent name (claude-code, kiro, codex)
 *   - limit: max number of sessions to return (default 100)
 *   - offset: pagination offset (default 0)
 *   - search: search first_prompt content
 *   - completed: filter by completion status (true/false)
 *   - project: filter by project path substring
 *   - from, to: date range (YYYY-MM-DD)
 */
router.get('/api/coding-agents/sessions', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    let sessions = await codingAgentRegistry.getAllSessions(range);

    const agentFilter = req.query.agent as string | undefined;
    if (agentFilter) {
      sessions = sessions.filter(s => s.agent === agentFilter);
    }

    const search = req.query.search as string | undefined;
    if (search) {
      const lower = search.toLowerCase();
      sessions = sessions.filter(s => s.first_prompt.toLowerCase().includes(lower));
    }

    const completedFilter = req.query.completed as string | undefined;
    if (completedFilter === 'true') {
      sessions = sessions.filter(s => s.session_completed);
    } else if (completedFilter === 'false') {
      sessions = sessions.filter(s => !s.session_completed);
    }

    const projectFilter = req.query.project as string | undefined;
    if (projectFilter) {
      const lower = projectFilter.toLowerCase();
      sessions = sessions.filter(s => s.project_path.toLowerCase().includes(lower));
    }

    const total = sessions.length;
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 100;
    sessions = sessions.slice(offset, offset + limit);

    res.json({ sessions, total, offset, limit });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/sessions/:agent/:sessionId
 * Returns detailed conversation data for a specific session.
 */
router.get('/api/coding-agents/sessions/:agent/:sessionId', async (req: Request, res: Response) => {
  try {
    const agent = req.params.agent as AgentKind;
    const sessionId = req.params.sessionId;
    const serverName = req.query.server as string | undefined;
    const detail = await codingAgentRegistry.getSessionDetail(agent, sessionId, serverName);
    if (!detail) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(detail);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/costs
 * Returns cost analytics across all agents.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/costs', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const costs = await codingAgentRegistry.getCostAnalytics(range);
    res.json(costs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/activity
 * Returns activity data (streaks, heatmap, hourly/dow patterns).
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/activity', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const activity = await codingAgentRegistry.getActivityData(range);
    res.json(activity);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/tools
 * Returns tool usage analytics across all agents.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/tools', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const tools = await codingAgentRegistry.getToolsAnalytics(range);
    res.json(tools);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/efficiency
 * Returns per-agent efficiency comparison (tool success, completion, cost/completion).
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/efficiency', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const efficiency = await codingAgentRegistry.getEfficiencyAnalytics(range);
    res.json(efficiency);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/projects
 * Returns per-project analytics across all agents.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/projects', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const projects = await codingAgentRegistry.getProjectAnalytics(range);
    res.json({ projects });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/advanced
 * Returns advanced analytics: MCP, hourly effectiveness, duration distribution, conversation depth.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/advanced', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const advanced = await codingAgentRegistry.getAdvancedAnalytics(range);
    res.json(advanced);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/failure-patterns
 * Returns recurring tool failure patterns.
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/failure-patterns', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const patterns = await codingAgentRegistry.getFailurePatterns(range);
    res.json({ patterns });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/export
 * Export all session data as JSON.
 * Query params: from, to (YYYY-MM-DD), format (json)
 */
router.get('/api/coding-agents/export', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const data = await codingAgentRegistry.exportData(range);
    const format = req.query.format as string | undefined;

    if (format === 'csv') {
      const header = 'agent,session_id,project_path,start_time,duration_minutes,user_messages,assistant_messages,input_tokens,output_tokens,estimated_cost,session_completed,first_prompt\n';
      const rows = data.sessions.map(s =>
        [s.agent, s.session_id, `"${s.project_path}"`, s.start_time, s.duration_minutes.toFixed(1),
         s.user_message_count, s.assistant_message_count, s.input_tokens, s.output_tokens,
         s.estimated_cost.toFixed(4), s.session_completed, `"${s.first_prompt.replace(/"/g, '""').slice(0, 200)}"`
        ].join(',')
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=coding-agents-export.csv');
      res.send(header + rows);
      return;
    }

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/coding-agents/team
 * Returns per-user analytics for team view.
 * Only meaningful when multiple users are detected (remote aggregation or shared machine).
 * Query params: from, to (YYYY-MM-DD)
 */
router.get('/api/coding-agents/team', async (req: Request, res: Response) => {
  try {
    const range = parseDateRange(req);
    const team = await codingAgentRegistry.getTeamAnalytics(range);
    res.json(team);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
