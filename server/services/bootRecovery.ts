/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Boot Recovery — shared post-listen recovery hooks.
 *
 * Historically these hooks lived only in server/index.ts, so they ran under
 * `node server/dist/index.js` (dev) but NEVER under the CLI (`agent-health
 * serve`), which imports app.js and listens itself. Every entry point that
 * listens should call this exactly once, after listen(), because the trace
 * poller makes HTTP self-calls to the local API.
 */

import { getStorageModule } from '../adapters/index.js';
import { resumePendingTracePollsSafely } from './traceRecoveryOnBoot.js';
import { recoverOrphanBenchmarkRunsSafely } from './benchmarkRunRecoveryOnBoot.js';
import { recoverOrphanEvaluationRunsSafely } from './evaluationRunRecoveryOnBoot.js';

/**
 * Fire-and-forget: must never block startup or throw.
 * Call once per process, after the HTTP server is listening.
 */
export function runBootRecoverySafely(): void {
  try {
    const storage = getStorageModule();
    if (!storage) return;
    resumePendingTracePollsSafely(storage);
    recoverOrphanBenchmarkRunsSafely(storage);
    recoverOrphanEvaluationRunsSafely(storage);
  } catch (err: any) {
    console.warn(`[bootRecovery] Could not start: ${err?.message || err}`);
  }
}
