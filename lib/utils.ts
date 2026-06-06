/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { Difficulty, DateFormatVariant } from "@/types"
import { DEFAULT_CONFIG } from "@/lib/constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ==================== Label Styling ====================

// Special colors for difficulty labels only
// Light mode: subtle backgrounds with darker text
// Dark mode: darker backgrounds with lighter text
const DIFFICULTY_LABEL_COLORS: Record<string, string> = {
  'difficulty:Easy': 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-opensearch-blue dark:border-blue-800',
  'difficulty:Medium': 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800',
  'difficulty:Hard': 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
};

// Generic label color palette (used for all other labels, hash-based)
// OpenSearch UI inspired colors for light mode
const LABEL_COLOR_PALETTE = [
  'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-700',
  'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800',
  'bg-cyan-100 text-cyan-800 border-cyan-300 dark:bg-cyan-900/30 dark:text-cyan-400 dark:border-cyan-800',
  'bg-pink-100 text-pink-800 border-pink-300 dark:bg-pink-900/30 dark:text-pink-400 dark:border-pink-800',
  'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800',
  'bg-teal-100 text-teal-800 border-teal-300 dark:bg-teal-900/30 dark:text-teal-400 dark:border-teal-800',
  'bg-indigo-100 text-indigo-800 border-indigo-300 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800',
  'bg-gray-100 text-gray-800 border-gray-300 dark:bg-muted dark:text-muted-foreground dark:border-border',
];

/**
 * Returns Tailwind classes for styling label badges
 * Only difficulty:Easy/Medium/Hard get special colors; all others use hash-based palette
 */
export const getLabelColor = (label: string): string => {
  // Check exact match for difficulty labels
  if (DIFFICULTY_LABEL_COLORS[label]) {
    return DIFFICULTY_LABEL_COLORS[label];
  }

  // All other labels use hash-based color assignment for consistency
  const hash = label.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return LABEL_COLOR_PALETTE[hash % LABEL_COLOR_PALETTE.length];
};

// Mapping from difficulty value to full label for backward compat
const DIFFICULTY_VALUE_COLORS: Record<string, string> = {
  'Easy': 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-opensearch-blue dark:border-blue-800',
  'Medium': 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800',
  'Hard': 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
};

/**
 * Returns Tailwind classes for styling difficulty badges
 * @deprecated Use getLabelColor with difficulty: prefixed labels instead
 */
export const getDifficultyColor = (difficulty: Difficulty): string => {
  return DIFFICULTY_VALUE_COLORS[difficulty] || DIFFICULTY_VALUE_COLORS['Medium'];
};

// ==================== Date Formatting ====================

/**
 * Formats a timestamp string to a localized date string
 * @param timestamp - ISO timestamp string
 * @param variant - 'date' (date only), 'datetime' (default, with time), 'detailed' (with seconds)
 */
export const formatDate = (
  timestamp: string,
  variant: DateFormatVariant = 'datetime'
): string => {
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };

  if (variant === 'datetime' || variant === 'detailed') {
    options.hour = '2-digit';
    options.minute = '2-digit';
  }
  if (variant === 'detailed') {
    options.second = '2-digit';
  }

  return date.toLocaleString('en-US', options);
};

/**
 * Formats a timestamp to relative time (e.g., "5m ago", "2h ago")
 * Falls back to formatDate for timestamps older than 7 days
 */
export const formatRelativeTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(timestamp);
};

// ==================== Model Utilities ====================

/**
 * Gets the display name for a model ID from config
 */
export const getModelName = (modelId: string): string => {
  const model = DEFAULT_CONFIG.models[modelId];
  return model?.display_name || modelId;
};

// ==================== Run Utilities ====================

/**
 * Returns a short, stable suffix for a TestCaseRun id, suitable for embedding
 * in an auto-generated run name. Run ids are shaped
 * `report-<timestamp>-<random>` (file adapter) or arbitrary keys (OpenSearch),
 * so we take the trailing 6 characters which gives a recognizable yet compact
 * label without exposing the full id. Falls back to the full id for very short
 * ids (e.g. legacy data).
 */
export const getRunShortId = (runId: string): string => {
  if (!runId) return '';
  return runId.length > 6 ? runId.slice(-6) : runId;
};

/**
 * Resolves the display name for a TestCaseRun.
 *
 * Prefers the persisted `name` field (set from the run config dialog or
 * auto-generated server-side). Falls back to `Run <short-id>` for older
 * runs that pre-date the field, so every row in the runs list has a
 * recognizable label instead of a raw id slice.
 */
export const getRunDisplayName = (run: { id: string; name?: string }): string => {
  if (run.name && run.name.trim()) return run.name.trim();
  return `Run ${getRunShortId(run.id)}`;
};

/**
 * Computes a single "overall score" percentage to display next to a run in
 * a list, from whatever metrics that run happens to carry.
 *
 * Why this is non-trivial:
 *   - Only the *RCA Default* system evaluator emits a metric named `accuracy`.
 *     Other system evaluators (Factuality, Tool Use, Reasoning, Safety) and
 *     any custom evaluator emit completely different metric names like
 *     `tool_selection_accuracy`, `reasoning_coherence`, `bias_detection`, etc.
 *   - The runs list used to hardcode `run.metrics?.accuracy ?? 0`, which made
 *     every non-RCA run display `0%` even when the judge had passed it.
 *
 * The fix is to take the **arithmetic mean of all populated numeric metrics**
 * on the run. This works for any evaluator without having to look up its
 * `scoringConfig`, gives a reasonable summary number, and degrades to `null`
 * (rendered as `—`) when no metrics are present — the only honest answer
 * for runs whose judge call hasn't completed or which were never scored.
 *
 * Returns `null` when there are no numeric metrics; otherwise an integer
 * percentage rounded to the nearest whole number.
 */
export const getRunOverallScore = (
  metrics: Record<string, number | undefined> | undefined | null,
): number | null => {
  if (!metrics) return null;
  const values: number[] = [];
  for (const v of Object.values(metrics)) {
    if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round(sum / values.length);
};

// ==================== Status Colors ====================

/**
 * Returns theme-aware Tailwind classes for pass rate badges
 * Light mode: More saturated backgrounds with darker text for better visibility
 * Dark mode: Lighter text on dark backgrounds
 */
export const getPassRateColor = (passRate: number): string => {
  if (passRate >= 80) {
    // Success/Pass - Green with more saturated background
    return 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800';
  } else if (passRate >= 50) {
    // Warning - Amber with more saturated background
    return 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800';
  } else {
    // Danger/Fail - Red with more saturated background
    return 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800';
  }
};

/**
 * Returns theme-aware Tailwind classes for status indicators
 * Used for success/error/warning/info states
 * Light mode: More saturated backgrounds (100 shade) for better visibility
 * Dark mode: Semi-transparent darker backgrounds with lighter text
 */
export const getStatusColor = (status: 'success' | 'error' | 'warning' | 'info' | 'neutral'): string => {
  const colors = {
    success: 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800',
    error: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
    warning: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
    info: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
    neutral: 'bg-gray-100 text-gray-800 border-gray-300 dark:bg-gray-800/30 dark:text-gray-400 dark:border-gray-700',
  };
  return colors[status];
};

/**
 * Returns theme-aware text color classes for metrics
 * Used for displaying metric values in stats cards
 * Light mode: Darker colors for WCAG AA compliance (4.5:1 contrast ratio)
 * Dark mode: Lighter colors for visibility on dark backgrounds
 */
export const getMetricTextColor = (type: 'primary' | 'success' | 'error' | 'warning' | 'info' | 'secondary'): string => {
  const colors = {
    primary: 'text-blue-700 dark:text-blue-400',
    success: 'text-green-700 dark:text-green-400',
    error: 'text-red-700 dark:text-red-400',
    warning: 'text-amber-700 dark:text-amber-400',
    info: 'text-purple-700 dark:text-purple-400',
    secondary: 'text-cyan-700 dark:text-cyan-400',
  };
  return colors[type];
};

// ==================== Text Utilities ====================

/**
 * Truncates text to a specified length with ellipsis
 */
export const truncate = (text: string, length: number): string => {
  if (text.length <= length) return text;
  return text.substring(0, length).trim() + '...';
};
