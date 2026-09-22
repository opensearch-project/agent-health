/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which catalog models an AGENT can be run on (as opposed to judge-only
 * pseudo-models). Shared by the server's run-model resolution
 * (server/services/runModelResolution.ts) and the client's Agent Model
 * dropdowns so both sides agree on what counts as an agent model.
 */

/**
 * Catalog providers an agent can be invoked through. Judge-only pseudo
 * providers (`demo`, `claude-code`, `agentic`, …) are never a sensible agent
 * default and are hidden from Agent Model pickers.
 */
export const AGENT_MODEL_PROVIDERS: ReadonlySet<string> = new Set(['bedrock', 'openai-compatible', 'litellm']);

/**
 * The catalog key used when a catalog-model agent is run without a model —
 * the long-standing UI default. Callers fall back to the first
 * {@link AGENT_MODEL_PROVIDERS} entry when a custom catalog doesn't define it.
 */
export const DEFAULT_AGENT_MODEL_ID = 'claude-sonnet-4.5';
