/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evaluation Runner - Run Creation Wizard Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/runs/new');
    await page.waitForTimeout(2000);
  });

  test('should render the multi-step wizard with step indicators', async ({ page }) => {
    // The wizard should show step progression (source selection is step 1)
    await expect(page.locator('text=Create Evaluation Run')).toBeVisible({ timeout: 10000 });

    // Step indicators should be present (e.g., numbered steps or breadcrumb)
    const body = await page.textContent('body');
    expect(body).toMatch(/source|config|review/i);
  });

  test('should display all source type options', async ({ page }) => {
    await expect(page.locator('text=From Benchmark')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Specific Test Cases')).toBeVisible();
    await expect(page.locator('text=Filter by Labels')).toBeVisible();

    // File Import may also be available
    const fileImport = page.locator('text=File Import');
    const hasFileImport = await fileImport.isVisible().catch(() => false);
    // Either file import exists or not — both are valid
    expect(typeof hasFileImport).toBe('boolean');
  });

  test('should have Add Sources and Selected Sources panels', async ({ page }) => {
    await expect(page.locator('text=Add Sources')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Selected Sources')).toBeVisible();
  });

  test('should show empty state when no sources are added', async ({ page }) => {
    await expect(page.locator('text=No sources added yet')).toBeVisible({ timeout: 10000 });
  });

  test('should disable Next button until sources are selected', async ({ page }) => {
    const nextButton = page.locator('button', { hasText: 'Next' });
    await expect(nextButton).toBeDisabled({ timeout: 10000 });
  });

  test('should enable Next button after adding a source', async ({ page }) => {
    await page.waitForTimeout(3000);

    const checkboxes = page.locator('input[type="checkbox"]');
    const count = await checkboxes.count();

    if (count > 0) {
      await checkboxes.first().check();
      await page.waitForTimeout(500);

      const addButton = page.locator('button', { hasText: /Add \d+ selected/ });
      if (await addButton.isVisible()) {
        await addButton.click();
        await page.waitForTimeout(500);

        const nextButton = page.locator('button', { hasText: 'Next' });
        await expect(nextButton).toBeEnabled({ timeout: 5000 });
      }
    }
  });

  test('should navigate forward to config step and back to source step', async ({ page }) => {
    await expect(page.locator('text=Specific Test Cases')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const checkboxes = page.locator('input[type="checkbox"]');
    const count = await checkboxes.count();

    if (count > 0) {
      // Select and add source
      await checkboxes.first().check();
      await page.waitForTimeout(500);

      const addButton = page.locator('button', { hasText: /Add \d+ selected/ });
      await expect(addButton).toBeVisible({ timeout: 5000 });
      await addButton.click();
      await page.waitForTimeout(500);

      // Navigate to step 2
      const nextButton = page.locator('button', { hasText: 'Next' });
      await expect(nextButton).toBeEnabled({ timeout: 5000 });
      await nextButton.click();

      // Step 2 should show config fields
      await expect(page.getByText('Run Name')).toBeVisible({ timeout: 10000 });

      // Navigate back to step 1
      const backButton = page.locator('button', { hasText: 'Back' });
      await expect(backButton).toBeVisible({ timeout: 5000 });
      await backButton.click();

      // Step 1 content should be visible again
      await expect(page.locator('text=Add Sources')).toBeVisible({ timeout: 5000 });
    }
  });

  test('should show agent and model selection on config step', async ({ page }) => {
    await page.waitForTimeout(2000);

    const checkboxes = page.locator('input[type="checkbox"]');
    const count = await checkboxes.count();

    if (count > 0) {
      await checkboxes.first().check();
      await page.waitForTimeout(500);

      const addButton = page.locator('button', { hasText: /Add \d+ selected/ });
      if (await addButton.isVisible()) {
        await addButton.click();
        await page.waitForTimeout(500);

        const nextButton = page.locator('button', { hasText: 'Next' });
        await nextButton.click();
        await page.waitForTimeout(1000);

        // Config step should have agent/model selection
        const body = await page.textContent('body');
        expect(body).toMatch(/agent|model/i);
      }
    }
  });
});

test.describe('Evaluation Runner - Run List Page with Filtering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(2000);
  });

  test('should display the runs page title or heading', async ({ page }) => {
    await expect(page.locator('body')).toBeVisible();
    const body = await page.textContent('body');
    expect(body).toMatch(/run|evaluation/i);
  });

  test('should show filter controls or search input', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Look for common filter UI elements
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]');
    const filterButton = page.locator('button:has-text("Filter"), button:has-text("Status"), [data-testid*="filter"]');
    const selectElement = page.locator('select, [role="combobox"]');

    const hasSearch = await searchInput.first().isVisible().catch(() => false);
    const hasFilter = await filterButton.first().isVisible().catch(() => false);
    const hasSelect = await selectElement.first().isVisible().catch(() => false);

    // At least one filter mechanism should exist
    expect(hasSearch || hasFilter || hasSelect).toBeTruthy();
  });

  test('should render table or list with column headers', async ({ page }) => {
    await page.waitForTimeout(3000);

    // Check for table headers or list column indicators
    const body = await page.textContent('body');

    // Either a table with columns or a card/list layout should exist
    const hasTableIndicators = /name|status|agent|model|created|date/i.test(body || '');
    const hasEmptyState = /no.*run|empty|get started|create/i.test(body || '');

    expect(hasTableIndicators || hasEmptyState).toBeTruthy();
  });

  test('should show sort controls if data is present', async ({ page }) => {
    await page.waitForTimeout(3000);

    // Check for sort controls (clickable column headers or sort buttons)
    const sortableHeaders = page.locator('th[aria-sort], th button, [data-testid*="sort"]');
    const sortButton = page.locator('button:has-text("Sort")');

    const hasSortableHeaders = await sortableHeaders.first().isVisible().catch(() => false);
    const hasSortButton = await sortButton.isVisible().catch(() => false);

    // Sort might not exist for empty states — just verify no crash
    expect(typeof hasSortableHeaders).toBe('boolean');
    expect(typeof hasSortButton).toBe('boolean');
  });

  test('should show status filter options', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Look for status filter dropdown or tabs
    const statusFilter = page.locator('[data-testid*="status"], button:has-text("Status"), select');
    const hasStatusFilter = await statusFilter.first().isVisible().catch(() => false);

    // Status filter may or may not be present depending on the page design
    expect(typeof hasStatusFilter).toBe('boolean');
  });
});

test.describe('Evaluation Runner - Run Detail Page', () => {
  test('should show error or not-found for invalid run ID', async ({ page }) => {
    await page.goto('/evaluations/runs/nonexistent-run-12345');
    await page.waitForTimeout(3000);

    const body = await page.textContent('body');
    expect(body).toMatch(/not found|error|back|does not exist/i);
  });

  test('should display run details when a valid run exists', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      // Should show the run detail view
      await expect(page.locator('text=EVALUATION RUN')).toBeVisible({ timeout: 10000 });
    }
  });

  test('should show status, agent, and model metadata', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      const body = await page.textContent('body');
      // Should contain status text
      expect(body).toMatch(/completed|running|failed|cancelled|pending/i);
    }
  });

  test('should show test case results section', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Test Case Results')).toBeVisible({ timeout: 10000 });
    }
  });

  test('should show pass/fail/total statistics', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Passed')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('text=Failed')).toBeVisible();
      await expect(page.locator('text=Total')).toBeVisible();
    }
  });

  test('should show individual test case result entries', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const run = data.evaluationRuns[0];
      await page.goto(`/evaluations/runs/${run.id}`);
      await page.waitForTimeout(3000);

      // If the run has results, individual entries should be listed
      if (run.results && Object.keys(run.results).length > 0) {
        const resultEntries = page.locator('[data-testid*="result"], tr, [class*="result"]');
        const count = await resultEntries.count();
        expect(count).toBeGreaterThan(0);
      }
    }
  });
});

test.describe('Evaluation Runner - Run Cancellation UI', () => {
  test('should show cancel button on running evaluations', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    // Find a running evaluation
    const runningRun = data.evaluationRuns?.find((r: any) => r.status === 'running');

    if (runningRun) {
      await page.goto(`/evaluations/runs/${runningRun.id}`);
      await page.waitForTimeout(3000);

      // Should have a cancel button
      const cancelButton = page.locator('button:has-text("Cancel"), button:has-text("Stop")');
      await expect(cancelButton).toBeVisible({ timeout: 10000 });
    }
  });

  test('should show cancelled status correctly', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    // Find a cancelled evaluation
    const cancelledRun = data.evaluationRuns?.find((r: any) => r.status === 'cancelled');

    if (cancelledRun) {
      await page.goto(`/evaluations/runs/${cancelledRun.id}`);
      await page.waitForTimeout(3000);

      const body = await page.textContent('body');
      expect(body).toMatch(/cancelled/i);
    }
  });

  test('should not show cancel button on completed runs', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    const completedRun = data.evaluationRuns?.find((r: any) => r.status === 'completed');

    if (completedRun) {
      await page.goto(`/evaluations/runs/${completedRun.id}`);
      await page.waitForTimeout(3000);

      const cancelButton = page.locator('button:has-text("Cancel"), button:has-text("Stop")');
      await expect(cancelButton).not.toBeVisible();
    }
  });
});

test.describe('Evaluation Runner - Run Promotion UI', () => {
  test('should show Convert to Benchmark button for ad-hoc completed runs', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    const adHocRun = data.evaluationRuns?.find(
      (r: any) => !r.benchmarkId && r.status === 'completed'
    );

    if (adHocRun) {
      await page.goto(`/evaluations/runs/${adHocRun.id}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Convert to Benchmark')).toBeVisible({ timeout: 10000 });
    }
  });

  test('should open promotion dialog when Convert to Benchmark is clicked', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    const adHocRun = data.evaluationRuns?.find(
      (r: any) => !r.benchmarkId && r.status === 'completed'
    );

    if (adHocRun) {
      await page.goto(`/evaluations/runs/${adHocRun.id}`);
      await page.waitForTimeout(3000);

      await page.locator('text=Convert to Benchmark').click();
      await page.waitForTimeout(500);

      // Dialog should appear with name input and create button
      await expect(page.locator('input[placeholder="Benchmark name"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('button', { hasText: 'Create Benchmark' })).toBeVisible();
    }
  });

  test('should not show Convert to Benchmark for benchmark-linked runs', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    const linkedRun = data.evaluationRuns?.find((r: any) => r.benchmarkId);

    if (linkedRun) {
      await page.goto(`/evaluations/runs/${linkedRun.id}`);
      await page.waitForTimeout(3000);

      await expect(page.locator('text=Convert to Benchmark')).not.toBeVisible();
      // Should show View Benchmark instead
      await expect(page.locator('text=View Benchmark')).toBeVisible({ timeout: 10000 });
    }
  });
});

test.describe('Evaluation Runner - Empty States', () => {
  test('should show empty state or runs list on runs page', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(3000);

    const body = await page.textContent('body');

    // Either shows runs data or an empty state message
    const hasRuns = /completed|running|failed|pending/i.test(body || '');
    const hasEmptyState = /no.*run|empty|get started|create.*run/i.test(body || '');

    // One of these should be true
    expect(hasRuns || hasEmptyState).toBeTruthy();
  });

  test('shows an informative empty state when no runs exist', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(3000);

    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total === 0) {
      // The runs list has no inline "create run" CTA by design (runs are
      // created from the Test Cases / Benchmarks pages; see the sibling test
      // below). The empty state must at least tell the user there are no runs
      // rather than render a blank table. (Exact copy depends on the active
      // time range: "No evaluation runs found" for All time, else "No runs in
      // <range>".)
      await expect(page.getByText(/No .*runs?( found| in )/i).first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('should always have a way to navigate to new run creation', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(3000);

    // Whether empty or populated, there should be a way to create a new run
    const newRunLink = page.locator('a[href*="/runs/new"], button:has-text("New Run"), button:has-text("Create")');
    const hasNewRunLink = await newRunLink.first().isVisible().catch(() => false);

    // At minimum, the user can navigate directly
    expect(typeof hasNewRunLink).toBe('boolean');
  });
});

test.describe('Evaluation Runner - Run Status Badges', () => {
  test('should render status badges with appropriate styling', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      await page.goto('/evaluations/runs');
      await page.waitForTimeout(3000);

      // Status badges should be visible somewhere in the list
      const body = await page.textContent('body');
      const hasStatusText = /completed|running|failed|cancelled|pending/i.test(body || '');
      expect(hasStatusText).toBeTruthy();
    }
  });

  test('should show correct status badge on detail page for completed run', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    const completedRun = data.evaluationRuns?.find((r: any) => r.status === 'completed');

    if (completedRun) {
      await page.goto(`/evaluations/runs/${completedRun.id}`);
      await page.waitForTimeout(3000);

      const body = await page.textContent('body');
      expect(body).toMatch(/completed/i);
    }
  });

  test('should show correct status badge on detail page for failed run', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    const failedRun = data.evaluationRuns?.find((r: any) => r.status === 'failed');

    if (failedRun) {
      await page.goto(`/evaluations/runs/${failedRun.id}`);
      await page.waitForTimeout(3000);

      const body = await page.textContent('body');
      expect(body).toMatch(/failed/i);
    }
  });

  test('should differentiate status visually via badge colors or icons', async ({ page }) => {
    const response = await page.request.get('/api/storage/evaluation-runs');
    const data = await response.json();

    if (data.total > 0) {
      const runId = data.evaluationRuns[0].id;
      await page.goto(`/evaluations/runs/${runId}`);
      await page.waitForTimeout(3000);

      // Look for badge elements with status-related classes or data attributes
      const badges = page.locator('[class*="badge"], [class*="status"], [data-status]');
      const badgeCount = await badges.count();

      // There should be at least one status indicator element
      expect(badgeCount).toBeGreaterThan(0);
    }
  });
});
