/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

const MOBILE = { width: 390, height: 844 };

test.describe('Mobile responsive shell', () => {
  test.use({ viewport: MOBILE });

  test('uses an accessible modal navigation drawer', async ({ page }) => {
    await page.goto('/evaluations/runs');

    const open = page.getByRole('button', { name: 'Open navigation' });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    // Radix unmounts the closed Sheet, so none of its links can receive focus.
    await expect(page.getByTestId('mobile-navigation')).toHaveCount(0);
    await expect(page.getByTestId('nav-overview')).toBeHidden();

    await open.click();
    const drawer = page.getByTestId('mobile-navigation');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(page.locator('body')).toHaveCSS('pointer-events', 'none');

    // Tab repeatedly: focus must remain within the modal navigation.
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('Tab');
    await expect(drawer).toContainText('Overview');
    expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(open).toHaveAttribute('aria-expanded', 'false');
  });

  test('closes the drawer after mobile navigation and keeps page width bounded', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.getByRole('button', { name: 'Open navigation' }).click();

    await page.getByTestId('mobile-navigation').getByTestId('nav-evals3-benchmarks').click();
    await expect(page).toHaveURL(/\/evaluations\/benchmarks$/);
    await expect(page.getByTestId('mobile-navigation')).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  });
});

test('desktop keeps the persistent sidebar and hides the mobile toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/evaluations/runs');

  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  await expect(page.getByTestId('sidebar-hover-zone')).toBeVisible();
  await expect(page.getByTestId('mobile-navigation')).toHaveCount(0);
});
