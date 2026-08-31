/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for POST /api/metrics/batch's `sessionIds` validation
 * (Strategy-D correlator map, round 2 of the comparison-ui-declutter work).
 *
 * These assertions are DETERMINISTIC — request validation runs before any
 * OpenSearch/observability work, so no trace cluster or seeded data is
 * required. Requires the backend running (npm run dev:server); skips
 * gracefully if down.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();
const URL = `${BASE_URL}/api/metrics/batch`;

const post = (body: unknown) =>
  fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const checkBackend = async (): Promise<boolean> => {
  try {
    return (await fetch(`${BASE_URL}/health`)).ok;
  } catch {
    return false;
  }
};

describe('POST /api/metrics/batch — sessionIds validation (Strategy D)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available at', BASE_URL, '- skipping metrics batch route tests');
    }
  }, TEST_TIMEOUT);

  it(
    'returns 400 when runIds is missing/not an array',
    async () => {
      if (!backendAvailable) return;
      const res = await post({});
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/runIds must be an array/);
    },
    TEST_TIMEOUT
  );

  const badSessionIds: Array<[string, unknown]> = [
    ['sessionIds is a string', 'not-an-object'],
    ['sessionIds is an array', ['a', 'b']],
    ['sessionIds is null', null],
  ];

  it.each(badSessionIds)(
    'returns 400 when %s',
    async (_label, sessionIds) => {
      if (!backendAvailable) return;
      const res = await post({ runIds: ['run-1'], sessionIds });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/sessionIds/);
    },
    TEST_TIMEOUT
  );

  it(
    'accepts an empty runIds array with no sessionIds (200, empty results)',
    async () => {
      if (!backendAvailable) return;
      const res = await post({ runIds: [] });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.metrics).toEqual([]);
    },
    TEST_TIMEOUT
  );

  it(
    'accepts a well-formed sessionIds map and proceeds past validation (200, not 400)',
    async () => {
      if (!backendAvailable) return;
      const res = await post({
        runIds: ['run-1', 'run-2'],
        sessionIds: { 'run-1': 'session-aaa' },
      });
      // Whether or not an observability cluster is configured in this test
      // environment, a well-formed request must clear validation (never 400)
      // — it either 200s with per-run metrics/errors, or the route's own
      // "Observability data source not configured" per-run error shape.
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.metrics)).toBe(true);
      expect(data.metrics).toHaveLength(2);
    },
    TEST_TIMEOUT
  );

  it(
    'silently drops non-string sessionId values rather than 400ing (defensive sanitization)',
    async () => {
      if (!backendAvailable) return;
      const res = await post({
        runIds: ['run-1'],
        sessionIds: { 'run-1': 12345 },
      });
      expect(res.status).toBe(200);
    },
    TEST_TIMEOUT
  );
});
