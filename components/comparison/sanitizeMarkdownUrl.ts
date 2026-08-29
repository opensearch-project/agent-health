/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { sanitizeCitationUrl } from '@/lib/citations';

/**
 * Sanitize hrefs in the LLM-authored comparison deep-dive markdown before they
 * reach the DOM. The deep-dive narrative is model output, so a compromised /
 * prompt-injected model could emit `javascript:`/`data:`/`vbscript:` URLs.
 *
 * Used as ReactMarkdown's `urlTransform` (which otherwise would have to be
 * disabled entirely to let our custom `span:` scheme through — that disabling
 * was the XSS hole flagged by the PR Code-Diff-Analyzer):
 *   - the custom `span:<runId>:<spanId>` scheme passes through untouched
 *     (SpanAnchor turns it into a deep-link button, never an `<a href>`);
 *   - http/https/mailto and relative (`/`, `#`, `./`, `../`) URLs are allowed;
 *   - everything else (notably `javascript:`) is dropped to '' so no dangerous
 *     scheme can ever reach an anchor.
 *
 * Kept dependency-free (no react / react-markdown imports) so it is unit
 * testable under jest without pulling in ESM-only deps.
 */
export function sanitizeMarkdownUrl(url: string): string {
  return sanitizeCitationUrl(url);
}
