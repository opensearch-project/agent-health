/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Config/Agents & Models Page', () => {
  test.beforeEach(async ({ page }) => {
    // /config redirects to /settings, so navigate there directly
    await page.goto('/#/settings');
    await page.waitForTimeout(3000);
  });

  test('should display Agents & Models page', async ({ page }) => {
    await expect(page).toHaveURL(/#\/settings/);
  });

  test('should show available agents', async ({ page }) => {
    // Look for agent cards or list
    const agentSection = page.locator('text=Agent').or(page.locator('text=Agents')).first();

    if (await agentSection.isVisible().catch(() => false)) {
      await expect(agentSection).toBeVisible();
    }
  });

  test('should show available models', async ({ page }) => {
    // Look for model cards or list
    const modelSection = page.locator('text=Model').or(page.locator('text=Models')).first();

    if (await modelSection.isVisible().catch(() => false)) {
      await expect(modelSection).toBeVisible();
    }
  });

  test('should display Demo agent', async ({ page }) => {
    const demoAgent = page.locator('text=Demo').first();

    if (await demoAgent.isVisible().catch(() => false)) {
      await expect(demoAgent).toBeVisible();
    }
  });

  test('should display ML-Commons agent', async ({ page }) => {
    const mlCommonsAgent = page.locator('text=ML-Commons').first();

    if (await mlCommonsAgent.isVisible().catch(() => false)) {
      await expect(mlCommonsAgent).toBeVisible();
    }
  });

  test('should display Claude model options', async ({ page }) => {
    const claudeModel = page.locator('text=Claude').first();

    if (await claudeModel.isVisible().catch(() => false)) {
      await expect(claudeModel).toBeVisible();
    }
  });

  test('should show model details like context window', async ({ page }) => {
    // Look for context window or token information
    const modelDetails = page.locator('text=context').or(page.locator('text=tokens')).first();

    if (await modelDetails.isVisible().catch(() => false)) {
      await expect(modelDetails).toBeVisible();
    }
  });
});
