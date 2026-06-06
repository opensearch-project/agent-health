/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Cluster Route
 *
 * POST /api/comparison/cluster-failures
 *
 * Body:
 *   {
 *     loserLabel: string,         // e.g. "Claude — run #3"
 *     winnerLabel: string,        // e.g. "Kiro — run #2"
 *     cases: FailureCaseEvidence[]
 *     force?: boolean             // bypass cache
 *   }
 *
 * Returns: ClusterFailuresResult
 *
 * The route is intentionally stateless w.r.t. benchmarks/runs — the caller
 * (frontend) is responsible for collecting the regressed-case evidence from
 * already-loaded reports and passing it in. This keeps the route fast and
 * cache-friendly: same evidence in → same clusters out.
 */

import { Request, Response, Router } from 'express';
import {
  clusterFailures,
  getClusterById,
  FailureCaseEvidence,
} from '../services/failureClusterService';
import { debug } from '@/lib/debug';

const router = Router();

router.post('/api/comparison/cluster-failures', async (req: Request, res: Response) => {
  const { loserLabel, winnerLabel, cases, force, modelId } = req.body || {};

  if (typeof loserLabel !== 'string' || !loserLabel) {
    return res.status(400).json({ error: '`loserLabel` is required' });
  }
  if (typeof winnerLabel !== 'string' || !winnerLabel) {
    return res.status(400).json({ error: '`winnerLabel` is required' });
  }
  if (!Array.isArray(cases)) {
    return res.status(400).json({ error: '`cases` must be an array' });
  }
  if (cases.length === 0) {
    return res.json({ clusters: [], totalFailures: 0, modelId: '' });
  }

  // Light shape validation — service does the rest.
  const sanitized: FailureCaseEvidence[] = [];
  for (const c of cases) {
    if (!c || typeof c.caseId !== 'string' || !c.caseId) continue;
    sanitized.push({
      caseId: c.caseId,
      caseName: typeof c.caseName === 'string' ? c.caseName : undefined,
      judgeReasoning: typeof c.judgeReasoning === 'string' ? c.judgeReasoning : undefined,
      improvementStrategies: Array.isArray(c.improvementStrategies)
        ? c.improvementStrategies
        : undefined,
      firstDivergence: c.firstDivergence && typeof c.firstDivergence === 'object'
        ? c.firstDivergence
        : undefined,
    });
  }
  if (sanitized.length === 0) {
    return res.status(400).json({ error: 'No valid `cases` after sanitization' });
  }

  try {
    const result = await clusterFailures(
      { loserLabel, winnerLabel, cases: sanitized },
      { force: !!force, modelId: typeof modelId === 'string' ? modelId : undefined }
    );
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug('ComparisonCluster', `failed: ${message}`);
    return res.status(500).json({ error: message });
  }
});

/**
 * GET /api/comparison/clusters/:clusterId
 *
 * Look up a cluster previously returned from /cluster-failures by its
 * stable content-hash id. Used by receiving pages (Skills, Settings,
 * QuickRun, TestCases) to read cluster context without the URL carrying
 * full state.
 *
 * Returns 404 if the process restarted (in-memory cache lost) or the id
 * was never produced. Receiving pages handle 404 by rendering the
 * generic page (no banner, no pre-fill) so the UX degrades gracefully.
 */
router.get('/api/comparison/clusters/:clusterId', (req: Request, res: Response) => {
  const { clusterId } = req.params;
  if (!clusterId || typeof clusterId !== 'string') {
    return res.status(400).json({ error: '`clusterId` path parameter is required' });
  }
  const cluster = getClusterById(clusterId);
  if (!cluster) {
    return res.status(404).json({ error: `Cluster ${clusterId} not found (cache may have expired)` });
  }
  return res.json(cluster);
});

export default router;
