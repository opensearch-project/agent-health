/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run-lifecycle control (#612):
 *
 *   GET  /api/runs/in-flight   — leased runs (any executor) ∪ this process's
 *                                in-memory executors; see services/inFlightRuns.ts.
 *   POST /api/server/drain     — stop starting new runs / leases here (503),
 *                                report what is still in flight.
 */

import { Router, Request, Response } from 'express';
import { getStorageModule } from '../adapters/index.js';
import { listInFlightRuns } from '../services/inFlightRuns.js';
import { drainState, startDrain } from '../services/serverDrain.js';

const router = Router();

router.get('/api/runs/in-flight', async (_req: Request, res: Response) => {
  try {
    const inFlight = await listInFlightRuns(getStorageModule());
    res.json({ ...inFlight, ...drainState() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? String(error) });
  }
});

router.post('/api/server/drain', async (_req: Request, res: Response) => {
  const state = startDrain();
  try {
    const inFlight = await listInFlightRuns(getStorageModule());
    res.json({ ...state, inFlight: { count: inFlight.count, runs: inFlight.runs, complete: inFlight.complete } });
  } catch (error: any) {
    // Draining took effect even if storage could not be listed.
    res.json({ ...state, inFlight: undefined, warning: error?.message ?? String(error) });
  }
});

export default router;
