/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A run's `judgeModelId` is stored either as a model KEY (`claude-sonnet-4.5`,
 * what the UI pickers emit) or as the provider's full model id
 * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`, what the CLI / classic
 * benchmark path records). The judge routes accept both
 * (server/routes/judge.ts resolves `config.models[id]` then
 * `find(m => m.model_id === id)`), but the `JudgeModelSelect` lists keys, so a
 * full id seeded into a picker rendered as an EMPTY select even though the run
 * had a judge model (seen on a legacy run's Retry-judgement / Re-run dialogs).
 * Map a known full id back to its key for display; anything unknown is
 * returned unchanged (the server still understands it).
 */
export function toJudgeModelKey(
  judgeModelId: string | null | undefined,
  models: Record<string, { model_id?: string }>
): string {
  if (!judgeModelId) return '';
  if (models[judgeModelId]) return judgeModelId;
  const match = Object.entries(models).find(([, m]) => m?.model_id === judgeModelId);
  return match ? match[0] : judgeModelId;
}
