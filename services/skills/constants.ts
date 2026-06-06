/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared constants for the skills evaluator.
 *
 * Single source of truth for values that previously lived as duplicated
 * literals in evalGenerator.ts and improver.ts (per Claude Code skills
 * authoring guidance — keep skill-related metadata in one place).
 */

/**
 * Default Bedrock model used for skill eval generation and improvement
 * proposals when the caller does not supply a `modelId`.
 *
 * Update here only — both `evalGenerator` and `improver` import this.
 */
export const DEFAULT_SKILL_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';

/**
 * Frontmatter validation limits per Claude Code skills spec.
 */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Soft thresholds — surface as warnings, not errors.
 *
 * - Description shorter than this likely lacks a "use when…" trigger clause,
 *   which is the single most-cited authoring rule in Claude Code's skills
 *   docs (the description is what the loader matches against, not the body).
 * - Body token estimate above this means the skill exceeds Claude Code's
 *   "lean instructions" guidance and should be split or trimmed.
 */
export const SKILL_DESCRIPTION_MIN_RECOMMENDED_LENGTH = 30;
export const SKILL_BODY_TOKEN_WARN_THRESHOLD = 5000;
