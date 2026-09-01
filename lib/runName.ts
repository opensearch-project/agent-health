/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validation for renaming an evaluation run (PATCH /api/storage/evaluation-runs/:id
 * `{ name }`). This is the server route's authoritative check.
 *
 * Rename is intentionally narrow: it only ever touches `name`. No version bump,
 * no stats recompute — this file has no opinion on anything but the string.
 */

/** Renamed evaluation runs are capped at this length (arbitrary but generous —
 *  long enough for any real run name, short enough to keep list/table UIs sane). */
export const MAX_RUN_NAME_LENGTH = 200;

export type RunNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate + normalize a candidate evaluation-run name.
 *
 * - Must be a string.
 * - Trimmed value must be non-empty.
 * - Trimmed value must be at most {@link MAX_RUN_NAME_LENGTH} characters.
 *
 * Returns the trimmed value on success so callers persist a normalized name
 * (no leading/trailing whitespace) rather than the raw input.
 */
export function validateRunNameUpdate(name: unknown): RunNameValidation {
  if (typeof name !== 'string') {
    return { ok: false, error: 'name must be a string' };
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: 'name must not be empty' };
  }
  if (trimmed.length > MAX_RUN_NAME_LENGTH) {
    return { ok: false, error: `name must be ${MAX_RUN_NAME_LENGTH} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}
