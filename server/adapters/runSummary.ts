/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EvaluationRun, TestCaseRun } from '../../types/index.js';

/**
 * The only report fields that list/table endpoints may return. Detail endpoints
 * use the separate projections below so their first paint can retain richer
 * report metadata without serializing multi-megabyte execution payloads.
 */
export const RUN_SUMMARY_FIELDS = [
  'id',
  'name',
  'description',
  'runId',
  'traceId',
  'sessionId',
  'testCaseId',
  'testCaseVersion',
  'testCaseVersionId',
  'experimentId',
  'experimentRunId',
  'timestamp',
  'createdAt',
  'updatedAt',
  'completedAt',
  'status',
  'passFailStatus',
  'metricsStatus',
  'traceStatus',
  'score',
  'iteration',
  'agentId',
  'agentName',
  'agentKey',
  'agentConfig',
  'modelId',
  'modelName',
  'judgeModelId',
  'evaluatorId',
  'metrics',
  'performanceMetrics',
  'matcherResults',
  'annotations',
  'tags',
] as const;

const RUN_SUMMARY_FIELD_SET = new Set<string>(RUN_SUMMARY_FIELDS);
const MATCHER_REASONING_MAX_CHARS = 500;
const MATCHER_TEXT_MAX_CHARS = 1_000;

function truncate(value: unknown, maxChars: number): unknown {
  return typeof value === 'string' && value.length > maxChars
    ? `${value.slice(0, maxChars)}…`
    : value;
}

/** Keep matcher verdicts useful in tables without carrying judge payloads. */
function summarizeMatcherResults(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((matcher: any) => ({
    description: truncate(matcher?.description, MATCHER_TEXT_MAX_CHARS),
    pass: matcher?.pass,
    method: matcher?.method,
    role: matcher?.role,
    errored: matcher?.errored,
    durationMs: matcher?.durationMs,
    score: matcher?.score,
    reasoning: truncate(matcher?.reasoning, MATCHER_REASONING_MAX_CHARS),
    errorMessage: truncate(matcher?.errorMessage, MATCHER_REASONING_MAX_CHARS),
    model: matcher?.model,
    judgeMetrics: matcher?.judgeMetrics,
  }));
}

/**
 * Clamp a caller-provided projection to the list-safe allow-list. `id` is
 * always present so clients can still link a summary to its detail endpoint.
 */
export function getRunSummaryFields(requested?: readonly string[]): string[] {
  if (!requested?.length) return [...RUN_SUMMARY_FIELDS];
  return ['id', ...requested.filter((field, index) =>
    field !== 'id' && RUN_SUMMARY_FIELD_SET.has(field) && requested.indexOf(field) === index
  )];
}

/**
 * OpenSearch stores the connector run id as traceId on some legacy reports.
 * Fetch traceId whenever runId is requested so the route can normalize it.
 */
export function getRunSummarySourceFields(requested?: readonly string[]): string[] {
  const fields = getRunSummaryFields(requested);
  if (fields.includes('runId') && !fields.includes('traceId')) fields.push('traceId');
  return fields;
}

export type RunDetailInclude = 'core' | 'full' | 'trajectory' | 'rawEvents' | 'judgeRawResponse';

export const RUN_DETAIL_INCLUDES = new Set<RunDetailInclude>([
  'core',
  'full',
  'trajectory',
  'rawEvents',
  'judgeRawResponse',
]);

/**
 * Project a report detail response. `core` deliberately keeps every ordinary
 * field (including matcher verdicts and judge reasoning) and removes only the
 * three expensive payloads. Targeted projections let the UI hydrate those
 * payloads when their tab is opened. `full` returns the original object so
 * export/CLI callers retain byte-for-byte field compatibility.
 */
export function toRunDetail(
  run: TestCaseRun & Record<string, any>,
  include: RunDetailInclude,
): Partial<TestCaseRun> & { id: string } {
  if (include === 'full') return run;
  if (include === 'trajectory') return { id: run.id, trajectory: run.trajectory };
  if (include === 'rawEvents') return { id: run.id, rawEvents: run.rawEvents };
  if (include === 'judgeRawResponse') {
    return {
      id: run.id,
      ...(run.llmJudgeResponse?.rawResponse === undefined
        ? {}
        : { llmJudgeResponse: { rawResponse: run.llmJudgeResponse.rawResponse } as any }),
    };
  }

  const { rawEvents: _rawEvents, trajectory: _trajectory, ...core } = run;
  if (!run.llmJudgeResponse || run.llmJudgeResponse.rawResponse === undefined) return core;

  const { rawResponse: _rawResponse, ...judgeCore } = run.llmJudgeResponse;
  return { ...core, llmJudgeResponse: judgeCore } as any;
}

export function toRunSummary(
  run: Partial<TestCaseRun> & Record<string, any>,
  requested?: readonly string[],
): TestCaseRun {
  const fields = getRunSummaryFields(requested);
  const summary: Record<string, unknown> = { id: run.id };

  for (const field of fields) {
    if (field === 'id') continue;
    let value = run[field];
    if (field === 'runId' && value === undefined) value = run.traceId;
    if (field === 'matcherResults') value = summarizeMatcherResults(value);
    if (value !== undefined) summary[field] = value;
  }

  return summary as unknown as TestCaseRun;
}

/** Evaluation-run list rows contain references/stats, never embedded reports. */
export function toEvaluationRunSummary(run: EvaluationRun): EvaluationRun {
  const {
    id,
    docType,
    name,
    description,
    createdAt,
    completedAt,
    status,
    error,
    agentKey,
    modelId,
    judgeModelId,
    evaluatorId,
    concurrency,
    trigger,
    sources,
    testCaseSnapshots,
    results,
    stats,
    performanceMetrics,
    benchmarkId,
    benchmarkVersion,
    imageDigest,
  } = run;

  return {
    id,
    docType,
    name,
    description,
    createdAt,
    completedAt,
    status,
    error,
    agentKey,
    modelId,
    judgeModelId,
    evaluatorId,
    concurrency,
    trigger,
    sources,
    testCaseSnapshots,
    results,
    stats,
    performanceMetrics,
    benchmarkId,
    benchmarkVersion,
    imageDigest,
  };
}
