/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cooperative cancellation for long-running evaluation work.
 *
 * The unified evaluation-runs runner (`services/evaluationRunner.ts`) checks
 * `isCancelled` between test cases; the evaluation-runs route keeps one token
 * per in-flight run so `POST .../cancel` and the delete paths can stop it.
 */

/**
 * Cancellation token for stopping execution
 */
export interface CancellationToken {
  isCancelled: boolean;
  cancel(): void;
}

/**
 * Create a new cancellation token
 */
export function createCancellationToken(): CancellationToken {
  const token = {
    isCancelled: false,
    cancel() {
      this.isCancelled = true;
    },
  };
  return token;
}
