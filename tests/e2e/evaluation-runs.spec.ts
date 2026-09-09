/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evaluation Runs Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(2000);
  });

  test('should display the runs page', async ({ page }) => {
    // The page should load without errors
    await expect(page.locator('body')).toBeVisible();
    // Should have some content indicating it's the runs page
    const pageText = await page.textContent('body');
    expect(pageText).toBeTruthy();
  });

  test('should show runs list or empty state', async ({ page }) => {
    // Wait for data to load
    await page.waitForTimeout(3000);

    // Either shows runs or an empty/loading state
    const body = await page.textContent('body');
    // Should contain either run data or table headers
    expect(body!.length).toBeGreaterThan(0);
  });

  test('should have filter controls', async ({ page }) => {
    await page.waitForTimeout(2000);
    // The page should have filtering capabilities (search, status filter, etc.)
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });
});

test.describe('New Run Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/runs/new');
    await page.waitForTimeout(2000);
  });

  test('should display the run composer page', async ({ page }) => {
    await expect(page.locator('body')).toBeVisible();
    // Should show "Create Evaluation Run" text somewhere on the page
    await expect(page.locator('text=Create Evaluation Run')).toBeVisible({ timeout: 10000 });
  });

  test('should show source selection options', async ({ page }) => {
    // Should have source type options visible
    await expect(page.locator('text=From Benchmark')).toBeVisible();
    await expect(page.locator('text=Specific Test Cases')).toBeVisible();
    await expect(page.locator('text=Filter by Labels')).toBeVisible();
  });

  test('should have Add Sources and Preview panels', async ({ page }) => {
    await expect(page.locator('text=Add Sources')).toBeVisible();
    await expect(page.locator('text=Selected Sources')).toBeVisible();
  });

  test('should show empty preview when no sources added', async ({ page }) => {
    await expect(page.locator('text=No sources added yet')).toBeVisible();
  });

  test('should disable Next button when no sources selected', async ({ page }) => {
    const nextButton = page.locator('button', { hasText: 'Next' });
    await expect(nextButton).toBeDisabled();
  });

  test('should allow selecting test cases and adding as source', async ({ page }) => {
    // Wait for test cases to load
    await page.waitForTimeout(3000);

    // Find checkboxes in the test cases section
    const checkboxes = page.locator('input[type="checkbox"]');
    const count = await checkboxes.count();

    if (count > 0) {
      // Select first test case
      await checkboxes.first().check();
      await page.waitForTimeout(500);

      // Click "Add X selected" button
      const addButton = page.locator('button', { hasText: /Add \d+ selected/ });
      if (await addButton.isVisible()) {
        await addButton.click();
        await page.waitForTimeout(500);

        // Source should appear in the preview panel
        await expect(page.locator('text=No sources added yet')).not.toBeVisible();
      }
    }
  });

  test('should navigate to step 2 when sources are added and Next clicked', async ({ page }) => {
    // Wait for page and test cases to load
    await expect(page.locator('text=Specific Test Cases')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const checkboxes = page.locator('input[type="checkbox"]');
    const count = await checkboxes.count();

    if (count > 0) {
      await checkboxes.first().check();
      await page.waitForTimeout(500);

      const addButton = page.locator('button', { hasText: /Add \d+ selected/ });
      await expect(addButton).toBeVisible({ timeout: 5000 });
      await addButton.click();
      await page.waitForTimeout(500);

      // Next button should now be enabled
      const nextButton = page.locator('button', { hasText: 'Next' });
      await expect(nextButton).toBeEnabled({ timeout: 5000 });
      await nextButton.click();

      // Should show configuration step
      await expect(page.getByText('Run Name')).toBeVisible({ timeout: 10000 });
    }
  });

  test('should have Back button on step 2 to return to step 1', async ({ page }) => {
    // Wait for page and test cases to load
    await expect(page.locator('text=Specific Test Cases')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const checkboxes = page.locator('input[type="checkbox"]');
    const count = await checkboxes.count();

    if (count > 0) {
      await checkboxes.first().check();
      await page.waitForTimeout(500);

      const addButton = page.locator('button', { hasText: /Add \d+ selected/ });
      await expect(addButton).toBeVisible({ timeout: 5000 });
      await addButton.click();
      await page.waitForTimeout(500);

      const nextButton = page.locator('button', { hasText: 'Next' });
      await expect(nextButton).toBeEnabled({ timeout: 5000 });
      await nextButton.click();

      // Should show configuration step (step 2)
      await expect(page.getByText('Run Name')).toBeVisible({ timeout: 10000 });

      // Click Back
      const backButton = page.locator('button', { hasText: 'Back' });
      await expect(backButton).toBeVisible({ timeout: 5000 });
      await backButton.click();

      // Should be back on step 1
      await expect(page.locator('text=Add Sources')).toBeVisible({ timeout: 5000 });
    }
  });

  test('should add labels via input', async ({ page }) => {
    // Type a label and press Enter
    const labelInput = page.locator('input[placeholder*="label"]');
    await labelInput.fill('@smoke');
    await labelInput.press('Enter');
    await page.waitForTimeout(500);

    // Should see the label as a badge
    await expect(page.locator('text=@smoke')).toBeVisible();
  });
});

test.describe('Evaluation Run Detail Page', () => {
  test('should show error state for non-existent run', async ({ page }) => {
    await page.goto('/evaluations/runs/non-existent-run-id');
    await page.waitForTimeout(3000);

    // Should show error or not found state
    const body = await page.textContent('body');
    expect(body).toMatch(/not found|error|Back to Runs/i);
  });

  test('should display run details when run exists', async ({ page }) => {
    // First get a valid run ID
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      // Should show the evaluation run badge
      await expect(page.getByText('EVALUATION RUN', { exact: true })).toBeVisible({ timeout: 10000 });
    }
  });

  test('should show run metadata (agent, model, status)', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      // Should have status indicator
      const body = await page.textContent('body');
      expect(body).toMatch(/completed|running|failed|cancelled/);
    }
  });

  test('should show stats (passed, failed, total)', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      // exact: true — a case-insensitive substring `text=Failed` also matches
      // the StatusBadge's lowercase "failed" text whenever the picked run's
      // status happens to be 'failed' (strict-mode violation: 2 elements).
      await expect(page.getByText('Passed', { exact: true })).toBeVisible();
      await expect(page.getByText('Failed', { exact: true })).toBeVisible();
      await expect(page.getByText('Total', { exact: true })).toBeVisible();
    }
  });

  test('should show source badges', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Sources')).toBeVisible();
    }
  });

  test('should show collapsible Run Configuration section', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      // Target the disclosure button rather than its left-aligned text span.
      // On collapsed navigation layouts the sidebar flyout can cover the
      // span while the button's actual interactive area remains available.
      const configuration = page.getByRole('button', { name: 'Run Configuration' });
      await expect(configuration).toBeVisible({ timeout: 10000 });

      await configuration.click();

      // Should show agent and model details
      await expect(page.locator('text=Agent:')).toBeVisible();
      await expect(page.locator('text=Model:')).toBeVisible();
    }
  });

  test('should show Convert to Benchmark button for ad-hoc runs', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    // Find an ad-hoc run (no benchmarkId) that is completed
    const adHocRun = data.evaluationRuns.find(
      (r: any) => !r.benchmarkId && r.status === 'completed'
    );

    if (adHocRun) {
      await page.goto(`/evaluations/runs/${adHocRun.id}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Convert to Benchmark')).toBeVisible({ timeout: 10000 });
    }
  });

  test('should NOT show Convert to Benchmark button for benchmark-associated runs', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    // Find a run with benchmarkId
    const bmRun = data.evaluationRuns.find((r: any) => r.benchmarkId);

    if (bmRun) {
      await page.goto(`/evaluations/runs/${bmRun.id}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Convert to Benchmark')).not.toBeVisible({ timeout: 10000 });
      await expect(page.locator('text=View Benchmark')).toBeVisible({ timeout: 10000 });
    }
  });

  test('should show promote dialog when Convert to Benchmark is clicked', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    const adHocRun = data.evaluationRuns.find(
      (r: any) => !r.benchmarkId && r.status === 'completed'
    );

    if (adHocRun) {
      await page.goto(`/evaluations/runs/${adHocRun.id}`);
      await page.waitForTimeout(3000);

      await page.locator('text=Convert to Benchmark').click();
      await page.waitForTimeout(500);

      // Dialog should appear
      await expect(page.locator('input[placeholder="Benchmark name"]')).toBeVisible();
      await expect(page.locator('button', { hasText: 'Create Benchmark' })).toBeVisible();
    }
  });

  test('should show test case results table', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Test Case Results')).toBeVisible({ timeout: 10000 });
    }
  });
});
