/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { TrajectoryStep } from '@/types';

/**
 * Represents an aligned step in the diff view
 */
export interface AlignedStep {
  type: 'matched' | 'added' | 'removed' | 'modified';
  index: number;
  baselineStep?: TrajectoryStep;
  comparisonStep?: TrajectoryStep;
  similarity?: number; // 0-1 score for 'modified' type
}

/**
 * JSON diff result for comparing objects
 */
export interface JsonDiff {
  added: string[];
  removed: string[];
  modified: Array<{
    key: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}

/**
 * Calculate similarity between two trajectory steps
 * Returns a score from 0-1 where 1 is identical
 */
export function calculateStepSimilarity(
  step1: TrajectoryStep,
  step2: TrajectoryStep
): number {
  let score = 0;

  // Tool name exact match: 0.4 weight
  if (step1.toolName && step2.toolName && step1.toolName === step2.toolName) {
    score += 0.4;
  }

  // Step type match: 0.2 weight
  if (step1.type === step2.type) {
    score += 0.2;
  }

  // Arguments similarity: 0.2 weight (basic comparison)
  if (step1.toolArgs && step2.toolArgs) {
    const args1Keys = Object.keys(step1.toolArgs);
    const args2Keys = Object.keys(step2.toolArgs);
    const commonKeys = args1Keys.filter(k => args2Keys.includes(k));
    if (args1Keys.length > 0 || args2Keys.length > 0) {
      const similarity = commonKeys.length / Math.max(args1Keys.length, args2Keys.length);
      score += similarity * 0.2;
    }
  } else if (!step1.toolArgs && !step2.toolArgs) {
    score += 0.2;
  }

  // Content similarity: 0.2 weight (simple check)
  if (step1.content && step2.content) {
    if (step1.content === step2.content) {
      score += 0.2;
    } else {
      // Partial match based on common words
      const words1 = new Set(step1.content.toLowerCase().split(/\s+/));
      const words2 = new Set(step2.content.toLowerCase().split(/\s+/));
      const common = [...words1].filter(w => words2.has(w)).length;
      const total = Math.max(words1.size, words2.size);
      if (total > 0) {
        score += (common / total) * 0.2;
      }
    }
  } else if (!step1.content && !step2.content) {
    score += 0.2;
  }

  return score;
}

/**
 * Align two trajectory arrays using an LCS-based algorithm
 * Returns aligned steps with type annotations (matched, added, removed, modified)
 */
export function alignTrajectories(
  baseline: TrajectoryStep[],
  comparison: TrajectoryStep[]
): AlignedStep[] {
  const MATCH_THRESHOLD = 0.6;
  const MODIFIED_THRESHOLD = 0.4;

  // Handle edge cases
  if (baseline.length === 0 && comparison.length === 0) {
    return [];
  }
  if (baseline.length === 0) {
    return comparison.map((step, index) => ({
      type: 'added' as const,
      index,
      comparisonStep: step,
    }));
  }
  if (comparison.length === 0) {
    return baseline.map((step, index) => ({
      type: 'removed' as const,
      index,
      baselineStep: step,
    }));
  }

  // Build similarity matrix
  const n = baseline.length;
  const m = comparison.length;
  const similarity: number[][] = [];

  for (let i = 0; i < n; i++) {
    similarity[i] = [];
    for (let j = 0; j < m; j++) {
      similarity[i][j] = calculateStepSimilarity(baseline[i], comparison[j]);
    }
  }

  // Use dynamic programming to find optimal alignment (LCS variant)
  // dp[i][j] = best score aligning baseline[0..i-1] with comparison[0..j-1]
  const dp: number[][] = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));
  const path: Array<Array<'match' | 'skip_base' | 'skip_comp'>> =
    Array(n + 1).fill(null).map(() => Array(m + 1).fill('skip_base'));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const matchScore = similarity[i - 1][j - 1];

      // Option 1: Match these steps
      const matchOption = dp[i - 1][j - 1] + (matchScore >= MATCH_THRESHOLD ? matchScore : -0.5);

      // Option 2: Skip baseline step (mark as removed)
      const skipBaseOption = dp[i - 1][j] - 0.1;

      // Option 3: Skip comparison step (mark as added)
      const skipCompOption = dp[i][j - 1] - 0.1;

      if (matchOption >= skipBaseOption && matchOption >= skipCompOption) {
        dp[i][j] = matchOption;
        path[i][j] = 'match';
      } else if (skipBaseOption >= skipCompOption) {
        dp[i][j] = skipBaseOption;
        path[i][j] = 'skip_base';
      } else {
        dp[i][j] = skipCompOption;
        path[i][j] = 'skip_comp';
      }
    }
  }

  // Backtrack to construct alignment
  const result: AlignedStep[] = [];
  let i = n, j = m;
  let index = 0;

  const tempResult: AlignedStep[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && path[i][j] === 'match') {
      const sim = similarity[i - 1][j - 1];
      if (sim >= MATCH_THRESHOLD) {
        // Check if it's a true match or modified
        const baseStep = baseline[i - 1];
        const compStep = comparison[j - 1];
        const isExactMatch =
          baseStep.toolName === compStep.toolName &&
          JSON.stringify(baseStep.toolArgs) === JSON.stringify(compStep.toolArgs);

        tempResult.push({
          type: isExactMatch ? 'matched' : 'modified',
          index,
          baselineStep: baseStep,
          comparisonStep: compStep,
          similarity: sim,
        });
      } else if (sim >= MODIFIED_THRESHOLD) {
        tempResult.push({
          type: 'modified',
          index,
          baselineStep: baseline[i - 1],
          comparisonStep: comparison[j - 1],
          similarity: sim,
        });
      } else {
        // Too different, treat as removed + added
        tempResult.push({
          type: 'removed',
          index,
          baselineStep: baseline[i - 1],
        });
        index++;
        tempResult.push({
          type: 'added',
          index,
          comparisonStep: comparison[j - 1],
        });
      }
      i--;
      j--;
    } else if (i > 0 && (j === 0 || path[i][j] === 'skip_base')) {
      tempResult.push({
        type: 'removed',
        index,
        baselineStep: baseline[i - 1],
      });
      i--;
    } else {
      tempResult.push({
        type: 'added',
        index,
        comparisonStep: comparison[j - 1],
      });
      j--;
    }
    index++;
  }

  // Reverse since we backtracked
  tempResult.reverse();

  // Re-index
  return tempResult.map((step, idx) => ({ ...step, index: idx }));
}

/**
 * Compare two JSON objects and return the differences
 */
export function compareJsonObjects(
  obj1: Record<string, unknown> | null | undefined,
  obj2: Record<string, unknown> | null | undefined
): JsonDiff {
  const result: JsonDiff = {
    added: [],
    removed: [],
    modified: [],
  };

  const o1 = obj1 || {};
  const o2 = obj2 || {};
  const keys1 = new Set(Object.keys(o1));
  const keys2 = new Set(Object.keys(o2));

  // Find removed keys (in obj1 but not obj2)
  for (const key of keys1) {
    if (!keys2.has(key)) {
      result.removed.push(key);
    }
  }

  // Find added keys (in obj2 but not obj1)
  for (const key of keys2) {
    if (!keys1.has(key)) {
      result.added.push(key);
    }
  }

  // Find modified keys (in both but different values)
  for (const key of keys1) {
    if (keys2.has(key)) {
      const val1 = JSON.stringify(o1[key]);
      const val2 = JSON.stringify(o2[key]);
      if (val1 !== val2) {
        result.modified.push({
          key,
          oldValue: o1[key],
          newValue: o2[key],
        });
      }
    }
  }

  return result;
}

/**
 * Calculate diff statistics from aligned steps
 */
export interface DiffStats {
  baselineSteps: number;
  comparisonSteps: number;
  matchedCount: number;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  baselineLatencyMs: number;
  comparisonLatencyMs: number;
}

/**
 * One-line summary of where two trajectories first disagree.
 * Returned to the comparison table so the user sees the *gist* of why a case
 * regressed without expanding the row.
 *
 * `index` is the position in the aligned trajectory (not the raw step index)
 * of the first non-`matched` step. `null` when the trajectories align fully.
 */
export interface DivergencePreview {
  /** Aligned-step index where divergence begins */
  index: number;
  /** What kind of divergence — drives icon/styling at the call site */
  type: 'added' | 'removed' | 'modified';
  /** Short description of the baseline (loser) step at the divergence */
  baselineSummary?: string;
  /** Short description of the comparison (winner) step at the divergence */
  comparisonSummary?: string;
}

const truncate = (text: string, max = 80): string => {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const summarizeStep = (step: TrajectoryStep | undefined): string | undefined => {
  if (!step) return undefined;
  if (step.toolName) {
    const argHint = step.toolArgs ? Object.keys(step.toolArgs).slice(0, 2).join(',') : '';
    return argHint ? `${step.toolName}(${argHint})` : `${step.toolName}()`;
  }
  if (step.content) {
    return truncate(step.content);
  }
  return step.type;
};

/**
 * Find the first divergence between two trajectories using the existing
 * `alignTrajectories` LCS-style alignment so the result respects shifts
 * (a longer winner trajectory doesn't claim divergence at every offset step).
 *
 * Returns `null` when the trajectories align identically.
 */
export function extractFirstDivergence(
  baseline: TrajectoryStep[],
  comparison: TrajectoryStep[]
): DivergencePreview | null {
  if (baseline.length === 0 && comparison.length === 0) return null;

  const aligned = alignTrajectories(baseline, comparison);
  const firstDivergent = aligned.find(s => s.type !== 'matched');
  if (!firstDivergent) return null;

  return {
    index: firstDivergent.index,
    type: firstDivergent.type as 'added' | 'removed' | 'modified',
    baselineSummary: summarizeStep(firstDivergent.baselineStep),
    comparisonSummary: summarizeStep(firstDivergent.comparisonStep),
  };
}

export function calculateDiffStats(
  alignedSteps: AlignedStep[],
  baseline: TrajectoryStep[],
  comparison: TrajectoryStep[]
): DiffStats {
  const stats: DiffStats = {
    baselineSteps: baseline.length,
    comparisonSteps: comparison.length,
    matchedCount: 0,
    addedCount: 0,
    removedCount: 0,
    modifiedCount: 0,
    baselineLatencyMs: baseline.reduce((sum, s) => sum + (s.latencyMs || 0), 0),
    comparisonLatencyMs: comparison.reduce((sum, s) => sum + (s.latencyMs || 0), 0),
  };

  for (const step of alignedSteps) {
    switch (step.type) {
      case 'matched':
        stats.matchedCount++;
        break;
      case 'added':
        stats.addedCount++;
        break;
      case 'removed':
        stats.removedCount++;
        break;
      case 'modified':
        stats.modifiedCount++;
        break;
    }
  }

  return stats;
}
