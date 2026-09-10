/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Required 375x812 mobile gate. This focused suite runs only in Playwright's
 * mobile-chromium project; the desktop project ignores it so the full E2E
 * suite is not duplicated. Assertions deliberately use rendered geometry,
 * not screenshots or documentElement overflow (which can be masked by the
 * shell's overflow-x:hidden rule).
 */

import { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/test-fixtures';
import { TestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const VIEWPORT_WIDTH = 375;
const LONG_BENCHMARK_PREFIX = 'Mobile readability benchmark with an intentionally long name';
const LONG_RUN_PREFIX = 'CLI Run - mobile-readability-baseline-with-a-long-descriptive-name';
const AGENTS = [
  'mobile-agent-alpha-with-readable-name',
  'mobile-agent-beta-with-readable-name',
  'mobile-agent-gamma-with-readable-name',
];
const MODEL_ID = 'mobile-e2e-model';

interface MobileSeed {
  benchmarkId: string;
  benchmarkName: string;
  benchmarkRunId: string;
  benchmarkRunName: string;
  evaluationRunId: string;
  evaluationRunName: string;
}

async function seedMobileData(request: APIRequestContext, tracker: TestDataTracker): Promise<MobileSeed> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const testCases = Array.from({ length: 3 }, (_, index) => ({
    name: uniqueTestName(`mobile-gate-case-${index + 1}`),
    description: 'Mobile gate fixture',
    category: 'Mobile',
    difficulty: 'Easy',
    initialPrompt: `Investigate mobile fixture ${index + 1}`,
    context: [],
    expectedOutcomes: ['A readable result'],
    expectedTrajectory: [],
  }));
  const testCaseResponse = await request.post('/api/storage/test-cases/bulk', { data: { testCases } });
  expect(testCaseResponse.ok(), `test case seed status ${testCaseResponse.status()}`).toBeTruthy();
  const testCaseBody = await testCaseResponse.json();
  const testCaseIds: string[] = (testCaseBody.testCases ?? []).map((item: { id: string }) => item.id);
  expect(testCaseIds).toHaveLength(testCases.length);
  tracker.testCases(testCaseIds);

  const benchmarkName = uniqueTestName(`${LONG_BENCHMARK_PREFIX}-${stamp}`);
  expect(benchmarkName.length).toBeGreaterThanOrEqual(40);
  const now = Date.now();
  const benchmarkRunId = `mobile-gate-benchmark-run-${stamp}`;
  const benchmarkRunName = `${LONG_RUN_PREFIX} - alpha - ${stamp}`;
  const benchmarkRuns = [
    {
      id: benchmarkRunId,
      name: benchmarkRunName,
      agentKey: AGENTS[0],
      modelId: MODEL_ID,
      createdAt: new Date(now).toISOString(),
      status: 'completed',
      results: {},
      stats: { passed: 2, failed: 1, pending: 0, total: 3 },
    },
    {
      id: `mobile-gate-benchmark-run-beta-${stamp}`,
      name: `${LONG_RUN_PREFIX} - beta - ${stamp}`,
      agentKey: AGENTS[1],
      modelId: MODEL_ID,
      createdAt: new Date(now - 60_000).toISOString(),
      status: 'completed',
      results: {},
      stats: { passed: 1, failed: 2, pending: 0, total: 3 },
    },
    {
      id: `mobile-gate-benchmark-run-gamma-${stamp}`,
      name: `${LONG_RUN_PREFIX} - gamma - ${stamp}`,
      agentKey: AGENTS[2],
      modelId: MODEL_ID,
      createdAt: new Date(now - 120_000).toISOString(),
      status: 'completed',
      results: {},
      stats: { passed: 3, failed: 0, pending: 0, total: 3 },
    },
  ];
  for (const run of benchmarkRuns) expect(run.name.length).toBeGreaterThanOrEqual(60);
  const benchmarkResponse = await request.post('/api/storage/benchmarks', {
    data: {
      name: benchmarkName,
      description: 'Seeded by the required mobile geometry gate',
      testCaseIds,
      currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date(now).toISOString(), testCaseIds }],
      runs: benchmarkRuns,
    },
  });
  expect(benchmarkResponse.ok(), `benchmark seed status ${benchmarkResponse.status()}`).toBeTruthy();
  const benchmarkBody = await benchmarkResponse.json();
  const benchmarkId: string = benchmarkBody.id || benchmarkBody.benchmark?.id;
  expect(benchmarkId).toBeTruthy();
  tracker.benchmark(benchmarkId);

  const evaluationRunId = `mobile-gate-evaluation-run-${stamp}`;
  const evaluationRunName = `Mobile inspect run ${stamp}`;
  const evaluationRunResponse = await request.put(`/api/storage/evaluation-runs/${evaluationRunId}`, {
    data: {
      id: evaluationRunId,
      name: evaluationRunName,
      status: 'completed',
      agentKey: AGENTS[0],
      modelId: MODEL_ID,
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
      createdAt: new Date(now).toISOString(),
    },
  });
  expect(evaluationRunResponse.ok(), `evaluation run seed status ${evaluationRunResponse.status()}`).toBeTruthy();
  tracker.evaluationRun(evaluationRunId);

  return { benchmarkId, benchmarkName, benchmarkRunId, benchmarkRunName, evaluationRunId, evaluationRunName };
}

async function expectInsideViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, 'element should have rendered geometry').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORT_WIDTH + 1);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.locator('main.mobile-responsive-content').evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth, 'main scrollWidth should fit its clientWidth').toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectSelectChevronsInsideTriggers(page: Page): Promise<void> {
  const triggers = page.locator('[role="combobox"]:visible');
  for (let index = 0; index < await triggers.count(); index++) {
    const trigger = triggers.nth(index);
    const chevron = trigger.locator(':scope > svg').last();
    const triggerBox = await trigger.boundingBox();
    const chevronBox = await chevron.boundingBox();
    expect(triggerBox, `combobox ${index} should have geometry`).not.toBeNull();
    expect(chevronBox, `combobox ${index} chevron should have geometry`).not.toBeNull();
    expect(triggerBox!.height, `combobox ${index} should remain touch-sized, not wrap taller`).toBeLessThanOrEqual(44);
    expect(chevronBox!.x).toBeGreaterThanOrEqual(triggerBox!.x - 0.5);
    expect(chevronBox!.y).toBeGreaterThanOrEqual(triggerBox!.y - 0.5);
    expect(chevronBox!.x + chevronBox!.width).toBeLessThanOrEqual(triggerBox!.x + triggerBox!.width + 0.5);
    expect(chevronBox!.y + chevronBox!.height).toBeLessThanOrEqual(triggerBox!.y + triggerBox!.height + 0.5);
  }
}

function rectanglesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test.describe('required mobile readability gate', () => {
  test('Overview keeps long selects, chart labels, improvement rows, and recent-run fields readable', async ({ page, request, testData }) => {
    const seed = await seedMobileData(request, testData);
    await page.goto('/');

    const heading = page.getByTestId('dashboard-title');
    await expect(heading).toHaveText('Leaderboard Overview', { timeout: 30_000 });

    const benchmarkSelect = page.getByTestId('agent-trends-benchmark-select');
    await expect(benchmarkSelect).toBeVisible({ timeout: 30_000 });
    await benchmarkSelect.click();
    await page.getByRole('option', { name: seed.benchmarkName, exact: true }).click();
    await expect(benchmarkSelect).toContainText(seed.benchmarkName);

    await expectInsideViewport(heading);
    await expectSelectChevronsInsideTriggers(page);
    await expectNoHorizontalOverflow(page);

    const trendsCard = page.getByTestId('agent-trends-band');
    const history = page.getByTestId('agent-trends-agents-toggle');
    const [cardBox, historyBox] = await Promise.all([trendsCard.boundingBox(), history.boundingBox()]);
    expect(cardBox).not.toBeNull();
    expect(historyBox).not.toBeNull();
    expect(historyBox!.x + historyBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width - 12);
    await history.click();
    await expect(page.getByTestId('agent-trends-agents-menu')).toBeVisible();
    await history.click();

    const ticks = page.getByTestId('agent-dot-plot-ticks').locator('span:visible');
    await expect(ticks).toHaveCount(3);
    await expect(ticks.nth(0)).toContainText(/^0/);
    await expect(ticks.nth(1)).toContainText(/^50/);
    await expect(ticks.nth(2)).toContainText(/^100/);
    for (let index = 0; index < await ticks.count(); index++) await expectInsideViewport(ticks.nth(index));

    const plotRows = page.locator('[data-testid^="agent-dot-plot-row-"]');
    await expect(plotRows).toHaveCount(AGENTS.length);
    const nameBoxes: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>[] = [];
    for (let index = 0; index < await plotRows.count(); index++) {
      const row = plotRows.nth(index);
      const name = row.locator(':scope > span');
      const bar = row.locator(':scope > div');
      const latestDot = row.locator('[data-testid^="agent-dot-plot-latest-"]');
      const nameBox = await name.boundingBox();
      const barBox = await bar.boundingBox();
      const dotBox = await latestDot.boundingBox();
      expect(nameBox).not.toBeNull();
      expect(barBox).not.toBeNull();
      expect(dotBox).not.toBeNull();
      expect(rectanglesOverlap(nameBox!, barBox!), `agent label ${index} must not overlap its bar`).toBe(false);
      expect(dotBox!.height, `agent dot ${index} must not inherit the shell's 40px button height`).toBeLessThanOrEqual(16);
      nameBoxes.push(nameBox!);
      await expectInsideViewport(name);
    }
    for (let left = 0; left < nameBoxes.length; left++) {
      for (let right = left + 1; right < nameBoxes.length; right++) {
        expect(rectanglesOverlap(nameBoxes[left], nameBoxes[right]), `agent labels ${left}/${right} must not overlap`).toBe(false);
      }
    }

    const improvementRow = page.getByTestId('needs-improvement-card').getByRole('button', { name: new RegExp(AGENTS[0]) });
    await expect(improvementRow).toContainText(AGENTS[0]);
    await expectInsideViewport(improvementRow);
    const improvementBadge = improvementRow.getByTestId('improvement-row-badge');
    const improvementBadgeBox = await improvementBadge.boundingBox();
    expect(improvementBadgeBox, 'improvement badge should have rendered geometry').not.toBeNull();
    expect(improvementBadgeBox!.height, 'improvement badge must stay on one line').toBeLessThanOrEqual(18);
    const improvementBadgeHeight = await improvementBadge.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(improvementBadgeHeight.scrollHeight, 'improvement badge content must fit its height').toBeLessThanOrEqual(improvementBadgeHeight.clientHeight + 1);

    const recentRow = page.locator(`[data-testid="recent-run-row"][data-run-id="${seed.benchmarkRunId}"]`);
    await expect(recentRow).toBeVisible();
    await expect(recentRow.getByTestId('recent-run-name')).toHaveText(seed.benchmarkRunName);
    await expect(recentRow.getByTestId('recent-run-benchmark')).toHaveText(seed.benchmarkName);
    await expect(recentRow.getByTestId('recent-run-agent')).toHaveText(AGENTS[0]);
    await expect(recentRow.getByTestId('recent-run-model')).toContainText(MODEL_ID);
    await expect(recentRow.getByTestId('recent-run-pass-rate')).toContainText('67%');
    await expect(recentRow.getByTestId('recent-run-time')).not.toHaveText('');
    await expectInsideViewport(recentRow);

    await page.setViewportSize({ width: 1440, height: 900 });
    const desktopRecentRows = page.locator('[data-testid="recent-run-row"]');
    const desktopRowCount = await desktopRecentRows.count();
    expect(desktopRowCount).toBeGreaterThanOrEqual(3);
    const desktopRowBoxes: Array<{ top: number; bottom: number; contentBottom: number }> = [];
    for (let index = 0; index < desktopRowCount; index++) {
      const row = desktopRecentRows.nth(index);
      const [rowBox, nameBox, benchmarkBox] = await Promise.all([
        row.boundingBox(),
        row.getByTestId('recent-run-name').boundingBox(),
        row.getByTestId('recent-run-benchmark').boundingBox(),
      ]);
      expect(rowBox, `desktop recent row ${index} should have geometry`).not.toBeNull();
      expect(nameBox, `desktop recent row ${index} name should have geometry`).not.toBeNull();
      expect(benchmarkBox, `desktop recent row ${index} benchmark should have geometry`).not.toBeNull();
      expect(rowBox!.height, `desktop recent row ${index} must stay compact`).toBeLessThanOrEqual(28);
      desktopRowBoxes.push({
        top: rowBox!.y,
        bottom: rowBox!.y + rowBox!.height,
        contentBottom: Math.max(nameBox!.y + nameBox!.height, benchmarkBox!.y + benchmarkBox!.height),
      });
    }
    for (let index = 0; index < desktopRowBoxes.length - 1; index++) {
      expect(desktopRowBoxes[index].bottom, `desktop recent row ${index} must not overlap row ${index + 1}`).toBeLessThanOrEqual(desktopRowBoxes[index + 1].top + 0.5);
      expect(desktopRowBoxes[index].contentBottom, `desktop recent row ${index} content must not bleed into row ${index + 1}`).toBeLessThanOrEqual(desktopRowBoxes[index + 1].top + 0.5);
    }
    expect(desktopRowBoxes.at(-1)!.contentBottom, 'last desktop recent row content must fit its row').toBeLessThanOrEqual(desktopRowBoxes.at(-1)!.bottom + 0.5);

    await page.setViewportSize({ width: 375, height: 812 });
    const runsAction = page.getByTestId('stats-runs');
    await expectInsideViewport(runsAction);
    await runsAction.click();
    await expect(page).toHaveURL(/\/evaluations\/runs$/);
  });

  test('benchmark Cases page keeps its heading and Add/Edit primary actions in reach', async ({ page, request, testData }) => {
    const seed = await seedMobileData(request, testData);
    await page.goto(`/evaluations/benchmarks/${encodeURIComponent(seed.benchmarkId)}`);

    const heading = page.getByRole('heading', { name: seed.benchmarkName, exact: true });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    await expectInsideViewport(heading);
    await expect(page.getByRole('tab', { name: /Cases/ })).toHaveAttribute('aria-selected', 'true');
    await expectSelectChevronsInsideTriggers(page);
    await expectNoHorizontalOverflow(page);

    const addRun = page.getByRole('button', { name: 'Add Run' });
    const edit = page.getByTestId('edit-benchmark-button');
    await expectInsideViewport(addRun);
    await expectInsideViewport(edit);

    await addRun.click();
    const runDialog = page.getByTestId('run-config-dialog');
    await expect(runDialog).toBeVisible();
    await expectSelectChevronsInsideTriggers(page);
    await runDialog.getByRole('button', { name: 'Cancel' }).click();

    await edit.click();
    await expect(page.getByText('Edit Benchmark', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).last().click();
  });

  test('run inspector keeps its title and Re-run/Edit actions visible and clickable', async ({ page, request, testData }) => {
    const seed = await seedMobileData(request, testData);
    await page.goto(`/evaluations/runs/${encodeURIComponent(seed.evaluationRunId)}/inspect`);

    const heading = page.getByTestId('run-inspector-rename-text');
    await expect(heading).toHaveText(seed.evaluationRunName, { timeout: 30_000 });
    await expectInsideViewport(heading);
    await expectSelectChevronsInsideTriggers(page);
    await expectNoHorizontalOverflow(page);

    const edit = page.getByTestId('run-inspector-rename-edit-btn');
    await expectInsideViewport(edit);
    await edit.click();
    const input = page.getByTestId('run-inspector-rename-input');
    await expectInsideViewport(input);
    await input.press('Escape');

    const rerun = page.getByTestId('inspector-rerun-btn');
    await expect(rerun).toBeEnabled();
    await expectInsideViewport(rerun);
    await rerun.click();
    await expect(page.getByTestId('rerun-confirm-dialog')).toBeVisible();
  });
});
