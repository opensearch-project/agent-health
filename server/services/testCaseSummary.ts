/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test-case "summary" projection — the lightweight shape list views ask for
 * via `GET /api/storage/test-cases?fields=summary`.
 *
 * Two layers share this contract so they can never drift apart:
 *
 *  1. The storage adapters apply {@link TEST_CASE_SUMMARY_EXCLUDED_FIELDS}
 *     when the caller asks for `projection: 'summary'` — the OpenSearch
 *     adapter as a `_source.excludes` on the search itself, so the heavy
 *     fields never leave the cluster, and the file adapter by dropping them
 *     after reading each JSON document.
 *  2. The route runs every item through {@link toTestCaseSummary} to pin the
 *     response shape (empty arrays for the stripped collections, truncated
 *     prompt) regardless of which backend produced it.
 *
 * Before (1) existed the route fetched every test case in full and trimmed
 * it in Node: on a corpus where a few hundred code-imported cases carry a
 * ~400 KB `sourceCode` each, that made the 1.7 MB summary response take as
 * long as the 213 MB full one (issue #591).
 */

/** Longest `initialPrompt` a summary record carries; the rest is elided. */
export const SUMMARY_PROMPT_MAX_CHARS = 200;

/**
 * Fields a summary never needs and that dominate document size. Order is
 * irrelevant; the list is the single source of truth for both adapters.
 *
 *  - `sourceCode`      — whole eval-file text captured at import (hundreds of KB)
 *  - `definition`      — per-test SDK capture (options + evaluate body text)
 *  - `versions`        — the full immutable history, each entry a copy of the content
 *  - `context`         — AG-UI context items (can embed whole documents)
 *  - `expectedOutcomes`— judge rubric text
 *
 * Deliberately NOT excluded: `version` / `currentVersion` (the adapters pick
 * the latest version per id from them), `sourceFile` / `sourceFileName` /
 * `sourceHash` / `sourceLanguage` / `describePath` (list views show
 * provenance), `initialPrompt` (truncated below — OpenSearch `_source`
 * filtering can drop a field but not shorten it).
 */
export const TEST_CASE_SUMMARY_EXCLUDED_FIELDS: readonly string[] = Object.freeze([
  'sourceCode',
  'definition',
  'versions',
  'context',
  'expectedOutcomes',
]);

/** Projection a test-case list reader can ask the storage adapter for. */
export type TestCaseProjection = 'full' | 'summary';

/**
 * Drop the summary-excluded fields from an already-loaded document (the file
 * adapter's equivalent of the OpenSearch `_source.excludes`). Returns a new
 * object; the input is not mutated.
 */
export function stripTestCaseSummaryFields<T extends Record<string, unknown>>(doc: T): T {
  const out: Record<string, unknown> = { ...doc };
  for (const field of TEST_CASE_SUMMARY_EXCLUDED_FIELDS) {
    delete out[field];
  }
  return out as T;
}

/**
 * Convert a (full or already-projected) test case to the summary shape the
 * list API returns: heavy collections pinned to `[]`, `sourceCode` /
 * `definition` absent, `initialPrompt` truncated to
 * {@link SUMMARY_PROMPT_MAX_CHARS}. Idempotent, so running it over a document
 * the adapter already projected is a cheap no-op on the heavy fields.
 */
export function toTestCaseSummary(doc: any): any {
  return {
    ...doc,
    initialPrompt: typeof doc?.initialPrompt === 'string' && doc.initialPrompt.length > SUMMARY_PROMPT_MAX_CHARS
      ? doc.initialPrompt.slice(0, SUMMARY_PROMPT_MAX_CHARS) + '...'
      : doc?.initialPrompt,
    context: [],
    expectedOutcomes: [],
    versions: [],
    // The full eval-file source can be many KB; list views only need to
    // know a code-imported test case HAS a source (sourceFile / sourceHash
    // / sourceFileName / sourceLanguage stay), not its full text. The Test
    // Case detail page fetches the full (non-summary) record via getById.
    sourceCode: undefined,
    // Same reasoning for the per-test definition capture (options + evaluate
    // body text): only the selected row's detail view needs it.
    definition: undefined,
  };
}
