/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { TrajectoryStep } from '@/types';

/**
 * Legacy prefix stamped by older producers (services/traces/spansToTrajectory.ts,
 * pre owner-papercut fix) that echoed the user's prompt as a `thinking` step
 * instead of giving it its own `'user'` step type. Producers no longer emit
 * this shape, but old persisted reports still have it.
 */
const LEGACY_USER_PREFIX = 'User: ';

/**
 * Re-derive the intended `user` step for one specific, unambiguous legacy
 * shape: a `thinking` step whose content starts with the literal `User: `
 * echo prefix. We can't retroactively rewrite stored reports, so every
 * surface that renders or compares trajectories (the Test Case Output tab,
 * side-by-side comparison views, and the trajectory diff/similarity engine)
 * calls this at read time instead of leaving old reports permanently
 * mislabeled — and, just as importantly, so an old-shape report and a
 * freshly-run new-shape report showing the identical prompt don't register
 * as a false "modified"/"added+removed" diff purely because of the step's
 * `type` and `content` prefix.
 *
 * Deliberately NOT restricted to index 0: the old producers emitted this
 * shape for every user turn in a multi-turn session, not just the opening
 * one, so restricting the check to the first step would leave later turns
 * in old reports mislabeled. The exact-prefix match is a strong, specific
 * signal (a real chain-of-thought paragraph starting with the literal
 * string "User: ") so the false-positive risk of checking every step is
 * low and no worse than the risk already accepted for the first step.
 */
export function normalizeLegacyUserStep(step: TrajectoryStep): TrajectoryStep {
  if (step.type === 'thinking' && typeof step.content === 'string' && step.content.startsWith(LEGACY_USER_PREFIX)) {
    return { ...step, type: 'user', content: step.content.slice(LEGACY_USER_PREFIX.length) };
  }
  return step;
}

/** Shown in place of a step body when the step carries no renderable text. */
export const NO_STEP_TEXT_PLACEHOLDER = '(no text)';

/**
 * `JSON.stringify` that never throws and always returns a string: circular
 * input, a hostile `toJSON`, or a value JSON can't represent (`undefined`,
 * functions) all fall back to a best-effort `String()` and finally to a fixed
 * marker. Used for every structured value a trajectory step can carry
 * (`content` objects, `toolArgs`) so a single bad value can't take a render
 * down.
 */
export function safeStringify(value: unknown, indent = 2): string {
  try {
    const json = JSON.stringify(value, null, indent);
    if (typeof json === 'string') return json;
  } catch {
    /* circular / hostile toJSON — fall through */
  }
  try {
    return String(value);
  } catch {
    return '[unserializable value]';
  }
}

/**
 * True when the persisted `content` is structured data (object / array)
 * rather than text — callers render it monospace instead of as markdown.
 */
export function stepContentIsStructured(step: Pick<TrajectoryStep, 'content'> | null | undefined): boolean {
  const content: unknown = step?.content;
  return typeof content === 'object' && content !== null;
}

/**
 * Coerce a persisted step's `content` into a string for rendering.
 *
 * `TrajectoryStep.content` is typed `string`, but reports are written by many
 * producers (connectors, the code SDK, `POST /api/storage/runs` from any
 * client, older schema versions) and nothing on the write path enforces the
 * type. A `tool_call`/`action` step with no text — only `toolName` +
 * `toolArgs` — or one whose producer stuffed the arguments object straight
 * into `content` is a real shape. Reading `.length` / `.startsWith` /
 * `.split` on it throws inside the React render, and because the trajectory
 * list has no error boundary that blanked the whole Run inspector.
 *
 * Rules:
 * - string → as-is
 * - `null` / `undefined` (or a null/undefined step) → `''` (callers render
 *   {@link NO_STEP_TEXT_PLACEHOLDER})
 * - object / array → pretty-printed JSON via {@link safeStringify} (this is
 *   what producers meant: the serialized tool arguments)
 * - any other primitive → `String()`
 */
export function stepContentText(step: Pick<TrajectoryStep, 'content'> | null | undefined): string {
  const content: unknown = step?.content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (typeof content === 'object') return safeStringify(content);
  return safeStringify(content);
}

/** Apply {@link normalizeLegacyUserStep} across a full trajectory. */
export function normalizeTrajectorySteps(steps: TrajectoryStep[]): TrajectoryStep[] {
  return steps.map(normalizeLegacyUserStep);
}
