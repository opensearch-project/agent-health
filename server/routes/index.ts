/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routes Aggregator - Combines all route modules
 */

import { Router } from 'express';
import healthRoutes from './health';
import judgeRoutes from './judge';
import agentRoutes from './agent';
import tracesRoutes from './traces';
import metricsRoutes from './metrics';
import logsRoutes from './logs';
import storageRoutes from './storage';
import observabilityRoutes from './observability';
import configRoutes from './config';
import evaluationRoutes from './evaluation';

const router = Router();

// Log ALL incoming requests
router.use((req, res, next) => {
  console.log(`[Router] ${req.method} ${req.path}`);
  next();
});

// Mount all routes
router.use(healthRoutes);        // /health
router.use(judgeRoutes);         // /api/judge
router.use(agentRoutes);         // /api/agent
router.use(tracesRoutes);        // /api/traces, /api/traces/health
router.use(metricsRoutes);       // /api/metrics/*
router.use(logsRoutes);          // /api/logs, /api/opensearch/logs
router.use(storageRoutes);       // /api/storage/*
router.use(observabilityRoutes); // /api/observability/*
router.use(configRoutes);        // /api/agents, /api/models
router.use(evaluationRoutes);    // /api/evaluate

export default router;
