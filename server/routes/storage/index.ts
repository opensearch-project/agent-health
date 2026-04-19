/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage Routes - Combines all entity routes
 * Uses OpenSearch JS SDK for all operations
 */

import { Router } from 'express';
import adminRoutes from './admin';
import testCasesRoutes from './testCases';
import benchmarksRoutes from './benchmarks';
import runsRoutes from './runs';
import analyticsRoutes from './analytics';
import reportsRoutes from './reports';
import evaluatorsRoutes from './evaluators';

const router = Router();

router.use(adminRoutes);
router.use(testCasesRoutes);
router.use(benchmarksRoutes);
router.use(runsRoutes);
router.use(analyticsRoutes);
router.use(reportsRoutes);
router.use(evaluatorsRoutes);

export default router;
