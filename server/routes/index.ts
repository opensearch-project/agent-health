/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routes Aggregator - Combines all route modules
 */

import { Router } from 'express';
import { debug } from '../../lib/debug';
import healthRoutes from './health';
import serverInfoRoutes from './serverInfo';
import judgeRoutes from './judge';
import agentRoutes from './agent';
import tracesRoutes from './traces';
import metricsRoutes from './metrics';
import logsRoutes from './logs';
import storageRoutes from './storage';
import observabilityRoutes from './observability';
import configRoutes from './config';
import evaluationRoutes from './evaluation';
import debugRoutes from './debug';
import codingAgentsRoutes from './codingAgents';
import claudeCodeWorkspaceRoutes from './claudeCodeWorkspace';
import sessionAnnotationsRoutes from './sessionAnnotations';
import { codingAnalyticsEnabled } from '../services/codingAgents';
import assistantRoutes from './assistant';
import skillsRoutes from './skills';
import comparisonClusterRoutes from './comparisonCluster';

const router = Router();

// Log ALL incoming requests
router.use((req, res, next) => {
  debug('Router', req.method, req.path);
  next();
});

// Mount all routes
router.use(healthRoutes);        // /health
router.use(serverInfoRoutes);    // /api/server-info
router.use(judgeRoutes);         // /api/judge
router.use(agentRoutes);         // /api/agent
router.use(tracesRoutes);        // /api/traces, /api/traces/health
router.use(metricsRoutes);       // /api/metrics/*
router.use(logsRoutes);          // /api/logs, /api/opensearch/logs
router.use(storageRoutes);       // /api/storage/*
router.use(observabilityRoutes); // /api/observability/*
router.use(configRoutes);        // /api/agents, /api/models
router.use(evaluationRoutes);    // /api/evaluate
router.use(debugRoutes);         // /api/debug
router.use(assistantRoutes);     // /api/assistant/*
router.use(skillsRoutes);        // /api/skills/*
router.use(comparisonClusterRoutes); // /api/comparison/cluster-failures

// Coding Agent Analytics — only mount when feature is enabled
if (codingAnalyticsEnabled) {
  router.use(codingAgentsRoutes);  // /api/coding-agents/*
  router.use(claudeCodeWorkspaceRoutes);  // /api/coding-agents/claude-code/*
  router.use(sessionAnnotationsRoutes);  // /api/coding-agents/sessions/*/metadata
}

export default router;
