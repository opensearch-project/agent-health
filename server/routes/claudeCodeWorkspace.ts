/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API routes for coding agent workspace features.
 * Claude Code: Memory viewer/editor, plans, tasks, settings, skills, plugins, active sessions.
 * Kiro: Settings, MCP servers, agents, powers, extensions, recent commands.
 */

import { Router, Request, Response } from 'express';
import {
  getMemoryFiles,
  updateMemoryFile,
  getPlans,
  getTasks,
  getSettings,
  getActiveSessions,
} from '../services/codingAgents/readers/claudeCodeWorkspace';
import { getKiroWorkspace } from '../services/codingAgents/readers/kiroWorkspace';

const router = Router();

/** GET /api/coding-agents/claude-code/memory */
router.get('/api/coding-agents/claude-code/memory', async (_req: Request, res: Response) => {
  try {
    const data = await getMemoryFiles();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** PUT /api/coding-agents/claude-code/memory */
router.put('/api/coding-agents/claude-code/memory', async (req: Request, res: Response) => {
  try {
    const { filePath, content } = req.body;
    if (!filePath || typeof content !== 'string') {
      res.status(400).json({ error: 'filePath and content are required' });
      return;
    }
    const ok = await updateMemoryFile(filePath, content);
    if (!ok) {
      res.status(403).json({ error: 'Invalid file path. Only memory files under ~/.claude/projects/ are writable.' });
      return;
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/coding-agents/claude-code/plans */
router.get('/api/coding-agents/claude-code/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await getPlans();
    res.json({ plans });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/coding-agents/claude-code/tasks */
router.get('/api/coding-agents/claude-code/tasks', async (_req: Request, res: Response) => {
  try {
    const tasks = await getTasks();
    res.json({ tasks });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/coding-agents/claude-code/settings */
router.get('/api/coding-agents/claude-code/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/coding-agents/claude-code/active-sessions */
router.get('/api/coding-agents/claude-code/active-sessions', async (_req: Request, res: Response) => {
  try {
    const sessions = await getActiveSessions();
    res.json({ sessions, count: sessions.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/coding-agents/kiro/workspace */
router.get('/api/coding-agents/kiro/workspace', async (_req: Request, res: Response) => {
  try {
    const data = await getKiroWorkspace();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
