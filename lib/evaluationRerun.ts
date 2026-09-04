/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure, isomorphic helpers for "re-run an evaluation run" (duplicate the
 * source run's config into a brand-new run, linked back via `rerunOf`).
 *
 * Split out from the route/service layer so both the server (which owns the
 * real duplication + creation) and the UI (which renders a name preview in
 * the confirm dialog before the user commits) can share the exact same
 * naming logic without an extra network round-trip. No storage/IO here.
 */

import type { EvaluationRun, TestCaseSource } from '@/types';

const DEFAULT_RUN_NAME = 'Evaluation Run';

/**
 * Matches a trailing "(re-run)" or "(re-run N)" suffix, case-insensitively,
 * capturing the base name and the optional numeric suffix.
 */
const RERUN_SUFFIX_RE = /^(.*?)\s*\(re-run(?:\s+(\d+))?\)$/i;

/**
 * Compute the name for a new run being created as a re-run of `sourceName`.
 *
 * - "My Run"            -> "My Run (re-run)"
 * - "My Run (re-run)"   -> "My Run (re-run 2)"
 * - "My Run (re-run 2)" -> "My Run (re-run 3)"
 * - undefined/empty     -> "Evaluation Run (re-run)"
 */
export function computeRerunName(sourceName: string | undefined | null): string {
  const trimmed = (sourceName || '').trim();
  const base = trimmed || DEFAULT_RUN_NAME;

  const match = base.match(RERUN_SUFFIX_RE);
  if (!match) {
    return `${base} (re-run)`;
  }

  const [, rawBaseName, suffixNumber] = match;
  // A source named literally "(re-run)" / "(re-run 2)" (no prefix) captures
  // an empty baseName — fall back to the default rather than emitting a
  // leading-space name like " (re-run 2)".
  const baseName = rawBaseName.trim() || DEFAULT_RUN_NAME;
  const nextNumber = suffixNumber ? parseInt(suffixNumber, 10) + 1 : 2;
  return `${baseName} (re-run ${nextNumber})`;
}

/**
 * Fields duplicated onto the new run when re-running a source run. Mirrors
 * the subset of {@link EvaluationRun} that `POST /api/storage/evaluation-runs`
 * accepts as input (see server/routes/storage/evaluationRuns.ts) — i.e. the
 * "config" as opposed to results/stats/timestamps, which are always fresh.
 */
export interface RerunConfig {
  sources: TestCaseSource[];
  agentKey: string;
  /** Fallback modelId if the agent's own config can't resolve one (legacy). */
  modelId: string;
  judgeModelId?: string;
  evaluatorId?: string;
  headers?: Record<string, string>;
  concurrency?: number;
  agentEndpoint?: string;
  description?: string;
  benchmarkId?: string;
  benchmarkVersion?: number;
}

export interface BuildRerunConfigResult {
  config: RerunConfig;
  /**
   * Human-readable notes on which fields were missing on the source run and
   * what explicit default was substituted (empty when the source run's
   * config was fully populated). Surfaced back to the caller (API response
   * -> UI) so a legacy run's best-effort re-run isn't a silent guess.
   */
  defaultsApplied: string[];
}

export interface BuildRerunConfigError {
  error: string;
}

/**
 * User-supplied tweaks to a rerun's config, applied on top of the source
 * run's duplicated config (see {@link applyRerunOverrides}). Every field is
 * optional — an omitted field keeps the source run's value untouched.
 * `null` explicitly clears an optional field back to "use default"
 * (distinct from `undefined`, which means "no change").
 */
export interface RerunOverrides {
  agentKey?: string;
  judgeModelId?: string | null;
  evaluatorId?: string | null;
  concurrency?: number;
  /**
   * Swap the test-case source to a different benchmark's current test case
   * list. `null` clears the benchmark association (falls back to the
   * source run's original `sources`). Setting this REPLACES `sources` with
   * a single `{type:'benchmark'}` source — the rerun dialog's "tweak test
   * cases" affordance is scoped to swapping benchmarks, not the full
   * multi-source composer (see NewRunPage for that).
   */
  benchmarkId?: string | null;
}

export interface ApplyRerunOverridesResult {
  config: RerunConfig;
  /** True when at least one override changed the effective config. */
  modified: boolean;
}

/**
 * Apply user-supplied overrides on top of a duplicated rerun config. Pure
 * function — returns a new config object plus whether anything actually
 * changed (used to decide whether the new run should be flagged
 * `modified: true` in addition to recording `rerunOf`).
 *
 * Only compares fields that are actually present in `overrides` (`in`
 * check, not just truthiness) so "no overrides object at all" and "an
 * overrides object whose fields happen to equal the source" both correctly
 * report `modified: false`.
 */
export function applyRerunOverrides(
  config: RerunConfig,
  overrides?: RerunOverrides | null
): ApplyRerunOverridesResult {
  if (!overrides) return { config, modified: false };

  let modified = false;
  const next: RerunConfig = { ...config };

  if (overrides.agentKey !== undefined && overrides.agentKey !== config.agentKey) {
    next.agentKey = overrides.agentKey;
    modified = true;
  }

  if ('judgeModelId' in overrides) {
    const val = overrides.judgeModelId === null ? undefined : overrides.judgeModelId;
    if (val !== config.judgeModelId) {
      next.judgeModelId = val;
      modified = true;
    }
  }

  if ('evaluatorId' in overrides) {
    const val = overrides.evaluatorId === null ? undefined : overrides.evaluatorId;
    if (val !== config.evaluatorId) {
      next.evaluatorId = val;
      modified = true;
    }
  }

  if (overrides.concurrency !== undefined && overrides.concurrency !== config.concurrency) {
    next.concurrency = overrides.concurrency;
    modified = true;
  }

  if ('benchmarkId' in overrides) {
    const val = overrides.benchmarkId === null ? undefined : overrides.benchmarkId;
    if (val !== config.benchmarkId) {
      next.benchmarkId = val;
      next.benchmarkVersion = undefined; // pinned version no longer applies once the benchmark itself changes
      next.sources = val ? [{ type: 'benchmark', benchmarkId: val }] : config.sources;
      modified = true;
    }
  }

  return { config: next, modified };
}

/**
 * Duplicate a source run's execution config for a re-run, applying explicit,
 * reported defaults for fields missing on legacy run documents. Pure
 * function — no storage access (benchmark-existence checks live in
 * services/evaluationRerun.ts, which needs the storage module).
 *
 * Returns `{ error }` only when the source run is missing a field with no
 * safe default (nothing to run, or no agent to run it against).
 */
export function buildRerunConfig(
  sourceRun: EvaluationRun
): BuildRerunConfigResult | BuildRerunConfigError {
  const defaultsApplied: string[] = [];

  if (!sourceRun.agentKey) {
    return { error: 'Source run is missing agentKey; cannot determine which agent to re-run.' };
  }

  let sources = sourceRun.sources;
  if (!sources || sources.length === 0) {
    const snapshotIds = (sourceRun.testCaseSnapshots || []).map(s => s.id);
    if (snapshotIds.length === 0) {
      return {
        error: 'Source run has no test cases to re-run (missing both sources and testCaseSnapshots).',
      };
    }
    sources = [{ type: 'test-case-ids', ids: snapshotIds }];
    defaultsApplied.push(
      `sources -> derived from testCaseSnapshots (${snapshotIds.length} test case id(s); legacy run had no sources recorded)`
    );
  }

  let concurrency = sourceRun.concurrency;
  if (concurrency == null) {
    concurrency = 1;
    defaultsApplied.push('concurrency -> 1 (default; not set on source run)');
  }

  const config: RerunConfig = {
    sources,
    agentKey: sourceRun.agentKey,
    modelId: sourceRun.modelId || '',
    judgeModelId: sourceRun.judgeModelId,
    evaluatorId: sourceRun.evaluatorId,
    headers: sourceRun.headers,
    concurrency,
    agentEndpoint: sourceRun.agentEndpoint,
    description: sourceRun.description,
    benchmarkId: sourceRun.benchmarkId,
    benchmarkVersion: sourceRun.benchmarkVersion,
  };

  // NOTE: evaluatorId/judgeModelId/agentEndpoint/headers/description are
  // legitimately optional on ANY run (not just legacy ones), so leaving them
  // `undefined` is normal behavior, not a legacy-config gap — they are NOT
  // reported in `defaultsApplied` (that list is reserved for cases where we
  // had to fabricate a value because the source run's config was
  // incomplete).

  return { config, defaultsApplied };
}
