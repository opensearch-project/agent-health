/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Health Check Route
 */

import { Request, Response, Router } from 'express';
import { readEnv } from '@/lib/envCompat';
import { getVersion } from '../utils/version';
import { codingAnalyticsEnabled } from '../services/codingAgents';
import { listActiveRuns } from '../services/runCancellation';

const router = Router();

// Process start time, derived from uptime at first import. Lets clients tell
// two instances of the same version apart (e.g. CLI reuse-vs-foreign checks).
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

// The instance block carries absolute cwd + pid, which are sensitive when the
// server binds 0.0.0.0 and /health is reachable off-host. Only expose it to
// loopback peers — the CLI ownership check always dials over localhost, so it
// keeps working; remote callers (e.g. the browser in prod) get status/features
// only. Uses the real socket address, not a spoofable X-Forwarded-For header.
// The in-flight run list (run ids) is gated the same way.
function isLoopback(req: Request): boolean {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Cap the ids listed on /health; `count` always carries the true total. */
const ACTIVE_RUNS_LISTED_MAX = 20;

/**
 * Omitted (not `count: 0`) when a registry could not answer: the CLI must
 * treat "don't know" as "not safe to restart", never as "idle".
 */
function summarizeActiveRuns(): { count: number; runs: Array<{ id: string; kind: string }> } | undefined {
  const { runs, complete } = listActiveRuns();
  if (!complete) return undefined;
  return { count: runs.length, runs: runs.slice(0, ACTIVE_RUNS_LISTED_MAX) };
}

/**
 * GET /health - Simple health check endpoint
 * Includes feature flags so the frontend can conditionally render UI, plus
 * an instance identity block (pid / cwd / port / startedAt) so callers — in
 * particular the CLI's `ensureServer` reuse logic — can tell *which* server
 * answered. Without this, every instance on the box looks identical and a
 * CLI run can silently reuse (or worse, kill) a foreign server such as the
 * live demo. See AGENTS.md → "server is always brought up from main".
 *
 * `activeRuns` is what THIS process is executing right now (benchmark /
 * evaluation runs, retry-judgement jobs), read from the in-memory executor
 * registries — never from storage, whose `running` docs can be stale
 * leftovers of a crashed process. The CLI consults it before restarting a
 * version-mismatched server so an upgrade cannot kill a run mid-flight (#612).
 */
router.get('/health', (req: Request, res: Response) => {
  console.log('[Health] Health check requested');
  res.json({
    status: 'ok',
    version: getVersion(),
    service: 'agent-health',
    features: {
      codingAgentAnalytics: codingAnalyticsEnabled,
    },
    // Instance identity — used for ownership checks; loopback-only (see above).
    // `port` reflects the *actual* bound port (AH_PORT is rewritten to the
    // listening port after auto-increment), not the originally requested one.
    ...(isLoopback(req)
      ? {
          instance: {
            pid: process.pid,
            cwd: process.cwd(),
            port: Number(readEnv('AH_PORT', 'AGENT_HEALTH_PORT')) || undefined,
            startedAt: STARTED_AT,
          },
          activeRuns: summarizeActiveRuns(),
        }
      : {}),
  });
});

export default router;
