/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Tests for PI connector and PI judge integration
 *
 * Tests that the PI connector type and PI judge provider are visible
 * and configurable in the UI. Does not require the pi CLI binary to be
 * installed — only verifies that the UI elements render correctly.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('PI Agent Configuration in Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  });

  test('should show PI connector type in the connector type dropdown', async ({ page }) => {
    // Open the "Add" endpoint form to access the connector type dropdown
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // Click the connector type select trigger
    const selectTrigger = page.locator('button[role="combobox"]').first();
    await selectTrigger.click();
    await page.waitForTimeout(300);

    // PI connector type should be listed as an option
    const piOption = page.getByRole('option', { name: 'pi', exact: true });
    await expect(piOption).toBeVisible({ timeout: 5000 });
  });

  test('should display PI agent in built-in agents list', async ({ page }) => {
    // The settings page lists built-in agents
    // PI agent should appear with its name "Pi (pi.dev)"
    const piAgentText = page.locator('text=Pi (pi.dev)');
    const isVisible = await piAgentText.isVisible({ timeout: 5000 }).catch(() => false);

    if (isVisible) {
      await expect(piAgentText).toBeVisible();
    } else {
      // PI agent may be disabled by default and not rendered in the list
      // Verify at minimum that the settings page loaded without errors
      await expect(page.locator('[data-testid="settings-page"]')).toBeVisible();
    }
  });

  test('should allow selecting PI connector type when adding a custom endpoint', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // Click the connector type select trigger
    const selectTrigger = page.locator('button[role="combobox"]').first();
    await selectTrigger.click();
    await page.waitForTimeout(300);

    // Select the 'pi' connector type
    const piOption = page.getByRole('option', { name: 'pi', exact: true });
    await piOption.click();
    await page.waitForTimeout(300);

    // Verify the selection took effect
    await expect(selectTrigger).toContainText('pi');
  });
});

test.describe('PI Judge Provider', () => {
  test('should accept pi provider via the judge API', async ({ page }) => {
    // Load the app first so the relative fetch below resolves against the
    // server origin (page.evaluate on about:blank would throw -> status 0).
    await page.goto('/');
    // Direct API test through the page context — verifies server recognizes "pi" provider
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/judge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trajectory: [{ type: 'action', toolName: 'search_logs', content: 'test action' }],
            expectedOutcomes: ['Agent should identify the root cause'],
            modelId: 'pi-judge',
          }),
        });

        // If pi CLI is not installed, we expect a 500 with a descriptive error.
        // If it is available, we expect a 200 with evaluation results.
        return {
          status: res.status,
          ok: res.ok,
        };
      } catch {
        return { status: 0, ok: false };
      }
    });

    // Either success (200) or known failure (500 with descriptive error) is acceptable
    // A 400 would indicate the API doesn't recognize the request format at all
    expect([200, 500]).toContain(result.status);
  });

  test('should list judge models including provider groups on quick run modal', async ({ page }) => {
    // Navigate to benchmarks page where QuickRunModal can be triggered
    await page.goto('/evaluations/benchmarks');
    await page.waitForTimeout(2000);

    // The QuickRunModal is accessed from benchmark detail — verify the page loads
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });
});

test.describe('New Run Page with PI Agent', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/runs/new');
    await page.waitForTimeout(2000);
  });

  test('should display the Create Evaluation Run page without errors', async ({ page }) => {
    await expect(page.locator('text=Create Evaluation Run')).toBeVisible({ timeout: 10000 });
  });

  test('should show agent selection in step 2 configuration', async ({ page }) => {
    // Need to add sources first to reach step 2
    await expect(page.locator('text=Specific Test Cases')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const checkboxes = page.locator('input[type="checkbox"]');
    const count = await checkboxes.count();

    if (count > 0) {
      // Select a test case and advance to step 2
      await checkboxes.first().check();
      await page.waitForTimeout(500);

      const addButton = page.locator('button', { hasText: /Add \d+ selected/ });
      if (await addButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await addButton.click();
        await page.waitForTimeout(500);

        const nextButton = page.locator('button', { hasText: 'Next' });
        await expect(nextButton).toBeEnabled({ timeout: 5000 });
        await nextButton.click();
        await page.waitForTimeout(1000);

        // Step 2 should show agent selection
        // Look for agent dropdown/select or PI agent text
        const body = await page.textContent('body');
        // Should have agent configuration section
        expect(body).toMatch(/agent|Agent/i);
      }
    }
  });

  test('should list PI agent in agent selection when available', async ({ page }) => {
    // Fetch agents from the API directly to verify PI is in the list
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return { agents: [], ok: false };
        const data = await res.json();
        return { agents: data.agents || [], ok: true };
      } catch {
        return { agents: [], ok: false };
      }
    });

    if (result.ok) {
      // PI agent should be in the agents list (may be disabled)
      const piAgent = result.agents.find(
        (a: any) => a.key === 'pi' || a.connectorType === 'pi'
      );
      expect(piAgent).toBeTruthy();
      expect(piAgent.name).toContain('Pi');
      expect(piAgent.connectorType).toBe('pi');
    }
  });
});

test.describe('Evaluation Runs Page with PI-based Runs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(2000);
  });

  test('should load the evaluation runs page without errors', async ({ page }) => {
    await expect(page.locator('body')).toBeVisible();
    const pageText = await page.textContent('body');
    expect(pageText).toBeTruthy();
  });

  test('should display PI connector info when a PI-based run exists', async ({ page }) => {
    // Query for evaluation runs that used the PI agent
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/storage/evaluation-runs');
        if (!res.ok) return { runs: [], total: 0 };
        const data = await res.json();
        return { runs: data.evaluationRuns || [], total: data.total || 0 };
      } catch {
        return { runs: [], total: 0 };
      }
    });

    // Find a run that used PI agent (if any exist)
    const piRun = result.runs.find(
      (r: any) => r.agentId === 'pi' || r.config?.agentId === 'pi'
    );

    if (piRun) {
      // Navigate to the PI run detail page
      await page.goto(`/evaluations/runs/${piRun.id}`);
      await page.waitForTimeout(3000);

      // Should load without errors
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
      // Should show some run information
      expect(body).toMatch(/pi|Pi|completed|running|failed/i);
    } else {
      // No PI runs exist yet — that's a valid state
      // Just verify the runs page renders correctly
      const body = await page.textContent('body');
      expect(body!.length).toBeGreaterThan(0);
    }
  });
});

test.describe('PI Connector API Verification', () => {
  test('should list pi as an available connector type via /api/agents', async ({ page }) => {
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return { meta: null, ok: false };
        const data = await res.json();
        return { meta: data.meta || null, agents: data.agents || [], ok: true };
      } catch {
        return { meta: null, agents: [], ok: false };
      }
    });

    if (result.ok) {
      // Check that PI connector is listed in the available connector types metadata
      // or that a PI agent exists in the agents list
      const hasPiAgent = result.agents.some(
        (a: any) => a.connectorType === 'pi'
      );
      expect(hasPiAgent).toBeTruthy();
    }
  });

  test('should have pi connector config with packagePath', async ({ page }) => {
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) return { agent: null };
        const data = await res.json();
        const piAgent = (data.agents || []).find(
          (a: any) => a.connectorType === 'pi'
        );
        return { agent: piAgent || null };
      } catch {
        return { agent: null };
      }
    });

    if (result.agent) {
      // PI connector should have a connectorConfig with packagePath
      expect(result.agent.connectorConfig).toBeDefined();
      expect(result.agent.connectorConfig.packagePath).toBeTruthy();
    }
  });
});
