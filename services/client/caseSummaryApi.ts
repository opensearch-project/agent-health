/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client for the case TL;DR endpoint (`POST /api/storage/runs/:id/summary`).
 * See server/services/caseSummaryService.ts for the contract.
 */

import type { CaseSummary } from '@/types';

export interface CaseSummaryResponse {
  summary: CaseSummary;
  /** True when the stored summary was returned without a model call. */
  cached: boolean;
}

/**
 * Ask the model for a summary (the card's Summarize / Regenerate buttons —
 * the only callers). `generate: true` is the explicit opt-in the server
 * requires before it spends a model call (#618); `force` bypasses a current
 * cached summary.
 */
export async function fetchCaseSummary(
  reportId: string,
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<CaseSummaryResponse> {
  const response = await fetch(`/api/storage/runs/${encodeURIComponent(reportId)}/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generate: true, force: options.force === true }),
    signal: options.signal,
  });
  if (!response.ok) {
    let message = `Case summary request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return response.json();
}
