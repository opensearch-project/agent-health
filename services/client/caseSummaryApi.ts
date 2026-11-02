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

export async function fetchCaseSummary(
  reportId: string,
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<CaseSummaryResponse> {
  const response = await fetch(`/api/storage/runs/${encodeURIComponent(reportId)}/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: options.force === true }),
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
