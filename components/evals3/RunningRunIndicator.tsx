/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { BenchmarkRun, EvaluationRun } from '@/types';

type ProgressRun = Pick<BenchmarkRun | EvaluationRun, 'results' | 'testCaseSnapshots'>;

/**
 * Return persisted execution progress for a run.
 *
 * A running result is not complete yet. Older writers only persist terminal
 * results, while newer writers may also persist pending/running placeholders,
 * so count terminal entries rather than blindly using Object.keys(results).
 */
export function getRunningRunProgress(run: ProgressRun): { completed: number; total: number } {
  const results = Object.values(run.results || {});
  const completed = results.filter(result => result.status !== 'pending' && result.status !== 'running').length;
  const snapshotCount = run.testCaseSnapshots?.length ?? 0;
  return {
    completed,
    total: snapshotCount > 0 ? snapshotCount : results.length,
  };
}

/** Shared running badge + case progress used by both run-list surfaces. */
export function RunningRunIndicator({ completed, total }: { completed: number; total: number }) {
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      data-testid="running-run-indicator"
      aria-label={`Running, ${completed} of ${total} cases complete`}
    >
      <Badge className="text-[10px] px-1.5 py-0 bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30">
        <Loader2 size={10} className="mr-1 animate-spin" aria-hidden="true" /> Running
      </Badge>
      <span className="text-[10px] font-medium text-blue-700 dark:text-blue-400 whitespace-nowrap">
        {completed} of {total} cases
      </span>
    </span>
  );
}
