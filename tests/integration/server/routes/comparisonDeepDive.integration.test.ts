/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for POST /api/comparison/deep-dive.
 *
 * Exercises the real HTTP route against a running backend. These assertions are
 * DETERMINISTIC — they cover request validation and missing-report handling,
 * which run before any LLM/trace-cluster work, so no AWS creds or seeded data
 * are required. (The actual narrative generation is covered by the service unit
 * tests + manual/e2e checks, since it needs a model + the obs cluster.)
 *
 * Requirements: backend running (npm run dev:server). Skips gracefully if down.
 *
 * Run: npm run test:integration -- --testPathPatterns=comparisonDeepDive.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();
const URL = `${BASE_URL}/api/comparison/deep-dive`;

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

describe('Comparison Deep-Dive Route Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available at', BASE_URL, '- skipping comparison deep-dive route tests');
    }
  }, TEST_TIMEOUT);

  describe('POST /api/comparison/deep-dive - request validation (400)', () => {
    const badBodies: Array<[string, unknown]> = [
      ['reportIds missing', {}],
      ['reportIds not an array', { reportIds: 'a,b' }],
      ['reportIds has 1 id', { reportIds: ['only-one'] }],
      ['reportIds has 3 ids', { reportIds: ['a', 'b', 'c'] }],
      ['reportIds elements not strings', { reportIds: [1, 2] }],
    ];

    it.each(badBodies)(
      'returns 400 when %s',
      async (_label, body) => {
        if (!backendAvailable) return;
        const res = await post(body);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/reportIds/);
        expect(data.error).toMatch(/exactly 2/);
      },
      TEST_TIMEOUT
    );
  });

  describe('POST /api/comparison/deep-dive - missing reports (404)', () => {
    it(
      'returns 404 when both report ids do not exist',
      async () => {
        if (!backendAvailable) return;
        const res = await post({
          reportIds: ['report-does-not-exist-aaaa', 'report-does-not-exist-bbbb'],
        });
        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toMatch(/not found/i);
        // Echoes which id(s) were missing so the caller can debug.
        expect(data.error).toMatch(/report-does-not-exist-aaaa/);
      },
      TEST_TIMEOUT
    );
  });

  describe('POST /api/comparison/deep-dive - systemPrompt validation (400) [Change 4]', () => {
    const badSystemPrompts: Array<[string, unknown]> = [
      ['systemPrompt is not a string', { reportIds: ['a', 'b'], systemPrompt: 12345 }],
      ['systemPrompt is empty', { reportIds: ['a', 'b'], systemPrompt: '' }],
      ['systemPrompt is only whitespace', { reportIds: ['a', 'b'], systemPrompt: '   \n\t  ' }],
      ['systemPrompt exceeds the length cap', { reportIds: ['a', 'b'], systemPrompt: 'x'.repeat(20001) }],
    ];

    it.each(badSystemPrompts)(
      'returns 400 when %s',
      async (_label, body) => {
        if (!backendAvailable) return;
        const res = await post(body);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toMatch(/systemPrompt/);
      },
      TEST_TIMEOUT
    );

    it(
      'accepts a well-formed systemPrompt and proceeds past validation (404 for the fake report ids, not 400)',
      async () => {
        if (!backendAvailable) return;
        const res = await post({
          reportIds: ['report-does-not-exist-aaaa', 'report-does-not-exist-bbbb'],
          systemPrompt: 'A perfectly reasonable custom system prompt.',
        });
        // Validation passed (didn't 400 on systemPrompt) -- falls through to the
        // normal missing-report 404 path, proving the field is plumbed through
        // request validation rather than rejected outright.
        expect(res.status).toBe(404);
      },
      TEST_TIMEOUT
    );
  });

  describe('GET /api/comparison/deep-dive/system-prompt [Change 4]', () => {
    it(
      'returns the built-in default system prompt',
      async () => {
        if (!backendAvailable) return;
        const res = await fetch(`${BASE_URL}/api/comparison/deep-dive/system-prompt`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(typeof data.systemPrompt).toBe('string');
        expect(data.systemPrompt.length).toBeGreaterThan(100);
        // Sanity: matches a stable, distinctive phrase from the real prompt
        // (services/comparisonDeepDiveService.ts SYSTEM_PROMPT) without
        // duplicating the whole string in the test.
        expect(data.systemPrompt).toMatch(/span:<runId>:<spanId>/);
      },
      TEST_TIMEOUT
    );
  });
});
