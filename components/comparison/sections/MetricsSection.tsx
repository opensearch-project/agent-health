/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EvaluationReport, BenchmarkRun } from '@/types';

interface MetricsSectionProps {
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  useCaseId: string;
}

/**
 * MetricsSection - Previously displayed per-use-case charts
 *
 * Charts have been removed because:
 * 1. MetricsRadarChart used deprecated metrics (faithfulness, trajectory, latency_score)
 * 2. TokenUsageChart showed judge tokens, not agent tokens (misleading)
 * 3. LatencyComparisonChart was redundant with trace-based duration
 *
 * The aggregate metrics chart now shows a normalized radar comparison at the top level,
 * and the per-use-case table provides detailed status/accuracy comparisons.
 */
export const MetricsSection: React.FC<MetricsSectionProps> = () => {
  // Per-use-case charts have been removed in favor of:
  // 1. Aggregate normalized radar chart (at page level)
  // 2. Per-use-case comparison table (shows status + accuracy per run)
  return null;
};
