/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge identity — "which judge KIND ran, and which LLM was actually behind it".
 *
 * Two fields, deliberately distinct:
 *
 *   - `judgeModelId` — the CONFIGURED judge (the run dialog / CLI
 *     `--judge-model` value). For plain providers this is a real model id
 *     (`us.anthropic.claude-sonnet-4-6`). For the agent (trace) judge it is
 *     `agent-trace-judge`, which names a PROVIDER whose underlying model is
 *     chosen at runtime from the pi registry — NOT a model.
 *   - `judgeModel`   — the UNDERLYING LLM the verdict actually came from, as
 *     the provider resolved it at judge time. Pre-fix this existed only on
 *     `llmJudgeResponse.judgeDebug.modelId`, which is `undefined` unless
 *     `AH_JUDGE_DEBUG=1`, so every agent-trace-judge report on the cluster
 *     said `agent-trace-judge` twice and never which LLM judged it.
 *
 * These helpers are the single place both persistence paths (the classic
 * runner, the benchmark runner, the trace-mode polled judge, retry-judgement,
 * browser recovery) and the UI derive the fields from, so a report can never
 * carry the provider name where a model id belongs — or vice versa.
 */

/** Judge-kind ids that name a provider rather than an LLM. */
const PROVIDER_PSEUDO_MODEL_IDS = new Set([
  'agent-trace-judge',
  'pi-judge',
  'agentic-claude-code',
  'agentic-custom',
  'claude-code-judge',
]);

/** True when `id` names a judge provider/kind (e.g. `agent-trace-judge`) rather than an LLM. */
export function isJudgeProviderPseudoModelId(id: string | undefined | null): boolean {
  return !!id && PROVIDER_PSEUDO_MODEL_IDS.has(id);
}

/** The subset of a judge result the identity fields are derived from. */
export interface JudgeIdentitySource {
  judgeModel?: string;
  judgeProvider?: string;
}

/**
 * The `judgeModel` to persist on a report: the provider's resolved LLM when
 * it reported one, else — for plain providers whose configured id IS the
 * model — the configured `judgeModelId` itself. For a provider pseudo-id
 * with no resolution (an old `/api/judge` build, or an agentic backend that
 * doesn't report its model) returns `undefined`: the field must not lie.
 */
export function resolveJudgeModelForReport(
  judgment: JudgeIdentitySource | undefined,
  judgeModelId: string | undefined
): string | undefined {
  const resolved = judgment?.judgeModel?.trim();
  if (resolved) return resolved;
  if (judgeModelId && !isJudgeProviderPseudoModelId(judgeModelId)) return judgeModelId;
  return undefined;
}

/**
 * Report-level identity patch, spread into the persisted report alongside
 * `judgeModelId`: `{ judgeModel }` when known (never an explicit `undefined`
 * key, so partial-update merges don't clobber an earlier value).
 */
export function buildJudgeIdentityPatch(
  judgment: JudgeIdentitySource | undefined,
  judgeModelId: string | undefined
): { judgeModel?: string } {
  const judgeModel = resolveJudgeModelForReport(judgment, judgeModelId);
  return judgeModel ? { judgeModel } : {};
}

/**
 * The `modelId` / `judgeProvider` pair for `LLMJudgeResponse`. `modelId`
 * is the REAL model when known (falls back to the configured id so the
 * field is never empty — old readers key on it), and `judgeProvider` keeps
 * the judge kind so nothing is lost by putting a real LLM id there.
 */
export function buildLlmJudgeResponseIdentity(
  judgment: JudgeIdentitySource | undefined,
  judgeModelId: string | undefined
): { modelId: string; judgeProvider?: string } {
  const modelId = resolveJudgeModelForReport(judgment, judgeModelId) ?? judgeModelId ?? '';
  const judgeProvider =
    judgment?.judgeProvider?.trim() ||
    // Infer the kind from a provider pseudo-id when the service didn't say.
    (judgeModelId === 'agent-trace-judge'
      ? 'agent'
      : judgeModelId === 'pi-judge'
        ? 'pi'
        : judgeModelId?.startsWith('agentic-')
          ? 'agentic'
          : undefined);
  return { modelId, ...(judgeProvider ? { judgeProvider } : {}) };
}

/**
 * Display helper: the judge model to SHOW for a report/run. Prefers the
 * recorded underlying LLM, falls back to the configured judge id (old
 * reports). Also says whether the fallback is a provider pseudo-id whose
 * real model was never recorded — the UI renders that as
 * "model not recorded — auto-picked at run time" rather than pretending
 * the provider name is a model.
 */
export function describeJudgeModel(run: { judgeModel?: string | null; judgeModelId?: string | null } | undefined | null): {
  /** Configured judge kind/id (`agent-trace-judge`, a Bedrock id, …) or undefined. */
  judgeModelId?: string;
  /** Underlying LLM when recorded. */
  judgeModel?: string;
  /** True when judgeModelId is a provider and the underlying model was never persisted. */
  modelNotRecorded: boolean;
} {
  const judgeModelId = run?.judgeModelId || undefined;
  const judgeModel = run?.judgeModel || undefined;
  return {
    judgeModelId,
    judgeModel,
    modelNotRecorded: !judgeModel && isJudgeProviderPseudoModelId(judgeModelId),
  };
}

/**
 * Short human label for a provider-qualified pi-registry id:
 * `amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0` →
 * `claude-sonnet-4-5`. Non-Claude / unrecognised ids are returned with only
 * the provider prefix stripped.
 */
export function shortJudgeModelLabel(judgeModel: string): string {
  const withoutProvider = judgeModel.includes('/') ? judgeModel.slice(judgeModel.indexOf('/') + 1) : judgeModel;
  const m = /claude-([a-z]+-\d+(?:-\d+)?)/i.exec(withoutProvider);
  if (m) return `claude-${m[1]}`;
  return withoutProvider;
}
