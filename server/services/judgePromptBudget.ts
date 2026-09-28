/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge prompt size budget.
 *
 * `compactTrajectory()` caps each step's `content` (50k chars) and
 * `toolOutput` (100k chars) INDIVIDUALLY, but nothing bounds the whole
 * prompt: a 14-step trajectory whose tool results are each ~40k chars
 * renders to a ~525k-char user prompt (~150k tokens) — past a 200k-token
 * model's window once the system prompt and the judge's own tool results are
 * added. Bedrock then rejects the call with "Input is too long for requested
 * model", deterministically, on every retry.
 *
 * {@link fitTrajectoryToBudget} shrinks a trajectory until the rendered
 * prompt fits a character budget by repeatedly truncating the LARGEST step's
 * largest text field (the pathological tool result), leaving an explicit
 * marker so the judge knows what it isn't seeing. Small steps — the user's
 * prompt, the final response, the reasoning — are never touched first, so
 * the judge keeps what matters for a verdict.
 */

import type { TrajectoryStep } from '@/types';

/**
 * Chars-per-token for the JSON-heavy evaluation prompt on Claude-class
 * tokenizers. Measured on real judge calls: a 120k-char prompt (trajectory
 * JSON + system prompt) billed 47,960 input tokens ≈ 2.5 chars/token — far
 * denser than the ~4 chars/token rule of thumb for prose, because serialized
 * tool outputs are mostly punctuation, ids and numbers.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 2.5;

/**
 * Fraction of the model's context window the rendered USER prompt may use.
 * The rest is headroom for the system prompt, the judge's trace-tool results
 * (which the pi SDK appends to the same context) and the verdict itself.
 */
export const DEFAULT_PROMPT_BUDGET_FRACTION = 0.5;

/** Assumed window when the provider does not tell us (Claude-class default). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** Never shrink a single field below this many chars (keeps a useful excerpt). */
const MIN_FIELD_CHARS = 400;

export interface TruncatedStepInfo {
  id?: string;
  type?: string;
  field: 'content' | 'toolOutput';
  fromChars: number;
  toChars: number;
}

export interface FitResult {
  trajectory: TrajectoryStep[];
  prompt: string;
  /** Rendered prompt before any truncation. */
  originalChars: number;
  /** Per-field truncations applied, largest first. Empty when nothing was cut. */
  truncated: TruncatedStepInfo[];
  /** True when the budget could not be met even after cutting everything to the floor. */
  exceedsBudget: boolean;
}

/** Estimate tokens from chars. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Resolve the prompt budget in chars.
 *   - `AH_JUDGE_PROMPT_BUDGET_TOKENS` (env) wins when set to a positive integer.
 *   - else `contextWindowTokens * DEFAULT_PROMPT_BUDGET_FRACTION`.
 */
export function resolvePromptBudgetChars(contextWindowTokens?: number): number {
  const envTokens = Number.parseInt(process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS ?? '', 10);
  const tokens = Number.isFinite(envTokens) && envTokens > 0
    ? envTokens
    : Math.floor((contextWindowTokens && contextWindowTokens > 0 ? contextWindowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS) * DEFAULT_PROMPT_BUDGET_FRACTION);
  return Math.floor(tokens * CHARS_PER_TOKEN_ESTIMATE);
}

function fieldText(step: TrajectoryStep, field: 'content' | 'toolOutput'): string | undefined {
  const v = (step as any)[field];
  if (v == null) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function truncationMarker(removed: number): string {
  return `\n…[truncated ${removed} chars to fit the judge's context budget]`;
}

const MARKER_RE = /\n…\[truncated (\d+) chars to fit the judge's context budget\]$/;

/** Split an already-marked field into its kept text and the chars removed so far. */
function splitMarker(text: string): { kept: string; removed: number } {
  const m = MARKER_RE.exec(text);
  if (!m) return { kept: text, removed: 0 };
  return { kept: text.slice(0, m.index), removed: Number(m[1]) };
}

/**
 * Shrink `trajectory` until `render(trajectory).length <= maxChars`.
 *
 * Strategy: each round, pick the step+field with the most characters and cut
 * it to max(half its size, MIN_FIELD_CHARS) with a marker appended. Rounds
 * are bounded; if every field is already at the floor and the prompt still
 * does not fit, return `exceedsBudget: true` and let the caller decide
 * (the callers here throw a classified `context_overflow` rather than send a
 * request that is certain to be rejected).
 */
export function fitTrajectoryToBudget(
  trajectory: TrajectoryStep[],
  render: (steps: TrajectoryStep[]) => string,
  maxChars: number,
): FitResult {
  let steps = trajectory.map((s) => ({ ...s }));
  let prompt = render(steps);
  const originalChars = prompt.length;
  const truncated: TruncatedStepInfo[] = [];
  if (prompt.length <= maxChars) {
    return { trajectory: steps, prompt, originalChars, truncated, exceedsBudget: false };
  }

  const MAX_ROUNDS = 200;
  for (let round = 0; round < MAX_ROUNDS && prompt.length > maxChars; round++) {
    // Find the largest field across all steps.
    let bestIdx = -1;
    let bestField = 'content' as 'content' | 'toolOutput';
    let bestLen = MIN_FIELD_CHARS; // must strictly exceed the floor to be a candidate
    steps.forEach((s, i) => {
      for (const f of ['toolOutput', 'content'] as const) {
        const t = fieldText(s, f);
        // Measure the KEPT text (minus any marker from an earlier round) so a
        // field already cut to the floor is not re-selected forever.
        const keptLen = t ? splitMarker(t).kept.length : 0;
        if (t && keptLen > bestLen) {
          bestLen = keptLen;
          bestIdx = i;
          bestField = f;
        }
      }
    });
    if (bestIdx === -1) break; // everything is at the floor

    const step = steps[bestIdx];
    const text = fieldText(step, bestField)!;
    const { kept, removed: alreadyRemoved } = splitMarker(text);
    // Cut by the overshoot when that is enough, else halve — converges fast on
    // one pathological field without over-cutting a modest one.
    const overshoot = prompt.length - maxChars;
    const target = Math.max(MIN_FIELD_CHARS, Math.min(Math.floor(kept.length / 2), kept.length - overshoot - 80));
    const removed = alreadyRemoved + (kept.length - target);
    const next = kept.slice(0, target) + truncationMarker(removed);
    // Connectors often mirror a tool result on BOTH `content` and `toolOutput`;
    // cut the twin too or the rendered size barely moves.
    const otherField: 'content' | 'toolOutput' = (bestField as string) === 'toolOutput' ? 'content' : 'toolOutput';
    const twin = fieldText(step, otherField) === text;
    steps = steps.map((s, i) =>
      i === bestIdx ? { ...s, [bestField]: next, ...(twin ? { [otherField]: next } : {}) } : s,
    );
    truncated.push({ id: step.id, type: step.type, field: bestField, fromChars: text.length, toChars: next.length });
    prompt = render(steps);
  }

  return { trajectory: steps, prompt, originalChars, truncated, exceedsBudget: prompt.length > maxChars };
}

/** One-line operator-facing summary of a fit result (for debug logs / judgeDebug). */
export function describeFit(fit: FitResult, maxChars: number): string {
  if (fit.truncated.length === 0) return `prompt ${fit.originalChars} chars (~${estimateTokens(fit.originalChars)} tokens) within budget ${maxChars} chars`;
  return (
    `prompt ${fit.originalChars} → ${fit.prompt.length} chars (~${estimateTokens(fit.prompt.length)} tokens) after truncating ` +
    `${fit.truncated.length} field(s) to fit budget ${maxChars} chars (~${estimateTokens(maxChars)} tokens)` +
    (fit.exceedsBudget ? ' — STILL over budget' : '')
  );
}
