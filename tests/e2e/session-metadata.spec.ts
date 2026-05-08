/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe.configure({ mode: 'serial' });

const testAgent = 'claude-code';
const testSessionId = `e2e-test-${Date.now()}`;

test.describe('Session Metadata API E2E', () => {
  test('GET metadata for non-existent session returns null', async ({ request }) => {
    const response = await request.get(
      `/api/coding-agents/sessions/${testAgent}/nonexistent-e2e-session/metadata`
    );
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data).toBeNull();
  });

  test('PUT creates session metadata', async ({ request }) => {
    const payload = {
      status: 'interesting',
      annotations: [{ id: 'ann-1', text: 'E2E test annotation', tags: ['e2e'] }],
      bookmarked: true,
    };

    const response = await request.put(
      `/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`,
      { data: payload }
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.agentKind).toBe(testAgent);
    expect(data.sessionId).toBe(testSessionId);
    expect(data.status).toBe('interesting');
    expect(data.bookmarked).toBe(true);
    expect(data.annotations).toHaveLength(1);
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  test('PUT merges with existing metadata', async ({ request }) => {
    const response = await request.put(
      `/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`,
      { data: { rating: 5, status: 'problematic' } }
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.bookmarked).toBe(true); // preserved from first PUT
    expect(data.rating).toBe(5);
    expect(data.status).toBe('problematic');
  });

  test('PUT rejects non-object body', async ({ request }) => {
    const response = await request.put(
      `/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`,
      { data: [1, 2, 3] }
    );
    expect(response.status()).toBe(400);
  });

  test('GET returns previously stored metadata', async ({ request }) => {
    const response = await request.get(
      `/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.agentKind).toBe(testAgent);
    expect(data.sessionId).toBe(testSessionId);
    expect(data.status).toBe('problematic');
    expect(data.bookmarked).toBe(true);
    expect(data.rating).toBe(5);
  });

  test('GET list includes the test session', async ({ request }) => {
    const response = await request.get('/api/coding-agents/sessions/metadata');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.items).toBeDefined();
    expect(data.total).toBeGreaterThanOrEqual(1);

    const found = data.items.find((i: any) => i.sessionId === testSessionId);
    expect(found).toBeDefined();
  });
});
