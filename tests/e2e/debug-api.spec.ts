/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

// Run these tests serially to avoid race conditions with shared debug state
test.describe.configure({ mode: 'serial' });

test.describe('Debug API E2E', () => {
  test.beforeEach(async ({ request }) => {
    // Reset debug state before each test
    await request.post('/api/debug', {
      data: { enabled: false },
    });
    // Small delay to ensure state is settled
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  test.afterEach(async ({ request }) => {
    // Reset debug state after each test
    await request.post('/api/debug', {
      data: { enabled: false },
    });
  });

  test('GET /api/debug should return current state', async ({ request }) => {
    const response = await request.get('/api/debug');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(typeof data.enabled).toBe('boolean');
  });

  test('POST /api/debug should enable debug mode', async ({ request }) => {
    const response = await request.post('/api/debug', {
      data: { enabled: true },
    });
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.enabled).toBe(true);

    // Wait a moment for state to persist
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify via GET
    const getResponse = await request.get('/api/debug');
    const getData = await getResponse.json();
    expect(getData.enabled).toBe(true);
  });

  test('POST /api/debug should disable debug mode', async ({ request }) => {
    // Enable first
    await request.post('/api/debug', { data: { enabled: true } });

    // Disable
    const response = await request.post('/api/debug', {
      data: { enabled: false },
    });
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.enabled).toBe(false);
  });

  test('POST /api/debug should return 400 for invalid input', async ({ request }) => {
    const response = await request.post('/api/debug', {
      data: { enabled: 'yes' },
    });
    expect(response.status()).toBe(400);

    const data = await response.json();
    expect(data.error).toBe('enabled must be a boolean');
  });

  test('Settings page toggle should sync debug state to server', async ({ page, request }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });

    // Get initial server state
    const initialResponse = await request.get('/api/debug');
    const initialData = await initialResponse.json();

    // Find and click the verbose logging toggle
    const toggle = page.locator('button[role="switch"]').first();
    await expect(toggle).toBeVisible();

    // Click toggle to change state
    await toggle.click();
    await page.waitForTimeout(1000);

    // Verify server state changed
    const afterResponse = await request.get('/api/debug');
    const afterData = await afterResponse.json();
    expect(afterData.enabled).toBe(!initialData.enabled);
  });
});
