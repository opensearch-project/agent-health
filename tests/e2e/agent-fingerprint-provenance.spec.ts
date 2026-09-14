/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-configuration provenance (lib/agentFingerprint.ts) — the three
 * rendered surfaces, against the real backend:
 *
 *   1. Runs list: a fingerprinted run shows a mono 12-hex chip under the
 *      agent name (tooltip: full hash + prompt hash + config sha); a legacy
 *      run shows none.
 *   2. Run inspector header: same chip.
 *   3. Comparison scoreboard: two runs of the SAME agent with DIFFERENT
 *      fingerprints show the amber "config changed between runs" badge
 *      (prompt kind); two runs of DIFFERENT agents do not.
 *
 * Seeds evaluation-run docs directly (PUT upsert) with fixed fingerprints —
 * this spec asserts the UI contract, not the hashing (unit) or the
 * create-path persistence (integration).
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RUN_OLD = `eval-run-e2e-fp-old-${STAMP}`;
const RUN_NEW = `eval-run-e2e-fp-new-${STAMP}`;
const RUN_OTHER_AGENT = `eval-run-e2e-fp-other-${STAMP}`;
const RUN_LEGACY = `eval-run-e2e-fp-legacy-${STAMP}`;
const TC = `tc-e2e-fp-${STAMP}`;

const FP_OLD = 'a1b2c3d4e5f6'.padEnd(64, '0');
const FP_NEW = 'f6e5d4c3b2a1'.padEnd(64, '0');
const PH_OLD = '1'.repeat(64);
const PH_NEW = '2'.repeat(64);

function evalRunDoc(id: string, name: string, agentKey: string, provenance: Record<string, unknown> = {}) {
  return {
    id,
    docType: 'evaluation-run',
    name,
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [{ id: TC, version: 1, name: TC }],
    results: { [TC]: { reportId: `report-${id}`, status: 'completed', passFailStatus: 'passed' } },
    stats: { passed: 1, failed: 0, total: 1 },
    ...provenance,
  };
}

test.describe('Agent-configuration provenance — fingerprint chip + config-changed badge', () => {
  test.beforeAll(async ({ request }) => {
    const docs = [
      evalRunDoc(RUN_OLD, `E2E FP Old Prompt ${STAMP}`, 'agent-alpha', {
        agentFingerprint: FP_OLD, agentFingerprintShort: FP_OLD.slice(0, 12), agentPromptHash: PH_OLD,
        agentConfigSource: { path: '/cfg/agent-health.config.ts', gitSha: 'cafe0000cafe0000cafe0000cafe0000cafe0000' },
      }),
      evalRunDoc(RUN_NEW, `E2E FP New Prompt ${STAMP}`, 'agent-alpha', {
        agentFingerprint: FP_NEW, agentFingerprintShort: FP_NEW.slice(0, 12), agentPromptHash: PH_NEW,
      }),
      evalRunDoc(RUN_OTHER_AGENT, `E2E FP Other Agent ${STAMP}`, 'agent-beta', {
        agentFingerprint: FP_NEW, agentFingerprintShort: FP_NEW.slice(0, 12), agentPromptHash: PH_NEW,
      }),
      evalRunDoc(RUN_LEGACY, `E2E FP Legacy ${STAMP}`, 'agent-alpha'),
    ];
    for (const doc of docs) {
      const r = await request.put(`/api/storage/evaluation-runs/${doc.id}`, { data: doc });
      expect(r.ok()).toBeTruthy();
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of [RUN_OLD, RUN_NEW, RUN_OTHER_AGENT, RUN_LEGACY]) {
      await request.delete(`/api/storage/evaluation-runs/${id}`).catch(() => {});
    }
  });

  test('runs list shows the mono fingerprint chip for a fingerprinted run and none for a legacy run', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');

    const row = page.locator('[data-testid="run-row"]', { hasText: `E2E FP Old Prompt ${STAMP}` });
    await expect(row).toBeVisible({ timeout: 15000 });
    const chip = row.locator(`[data-testid="run-row-fingerprint-${RUN_OLD}"]`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(new RegExp(FP_OLD.slice(0, 12)));
    await expect(chip).toHaveAttribute('data-fingerprint', FP_OLD);
    const title = await chip.getAttribute('title');
    expect(title).toContain(FP_OLD);
    expect(title).toContain(PH_OLD);
    expect(title).toContain('/cfg/agent-health.config.ts @ cafe0000cafe');

    const legacyRow = page.locator('[data-testid="run-row"]', { hasText: `E2E FP Legacy ${STAMP}` });
    await expect(legacyRow).toBeVisible();
    await expect(legacyRow.locator('[data-testid^="run-row-fingerprint-"]')).toHaveCount(0);
  });

  test('run detail page header shows the fingerprint chip (+ the Run Configuration panel row)', async ({ page }) => {
    await page.goto(`/evaluations/runs/${RUN_NEW}`);
    const chip = page.locator('[data-testid="inspector-fingerprint-chip"]');
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toHaveText(new RegExp(FP_NEW.slice(0, 12)));
    expect(await chip.getAttribute('title')).toContain(FP_NEW);
  });

  test('run inspector header shows the fingerprint chip', async ({ page }) => {
    await page.goto(`/evaluations/runs/${RUN_NEW}/inspect`);
    const chip = page.locator('[data-testid="inspector-fingerprint-chip"]');
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toHaveText(new RegExp(FP_NEW.slice(0, 12)));
    expect(await chip.getAttribute('title')).toContain(FP_NEW);
  });

  test('a re-run whose fingerprint differs from its source shows "config changed since source run"', async ({ page }) => {
    const RERUN = `eval-run-e2e-fp-rerun-${STAMP}`;
    const doc = evalRunDoc(RERUN, `E2E FP Re-run ${STAMP}`, 'agent-alpha', {
      rerunOf: RUN_OLD,
      agentFingerprint: FP_NEW, agentFingerprintShort: FP_NEW.slice(0, 12), agentPromptHash: PH_NEW,
    });
    const r = await page.request.put(`/api/storage/evaluation-runs/${RERUN}`, { data: doc });
    expect(r.ok()).toBeTruthy();
    try {
      await page.goto(`/evaluations/runs/${RERUN}/inspect`);
      const badge = page.locator('[data-testid="rerun-config-changed-badge"]');
      await expect(badge).toBeVisible({ timeout: 15000 });
      await expect(badge).toContainText('config changed since source run');
      await expect(badge).toHaveAttribute('data-diff-kind', 'prompt');
    } finally {
      await page.request.delete(`/api/storage/evaluation-runs/${RERUN}`).catch(() => {});
    }
  });

  test('comparison scoreboard warns "config changed between runs · prompt" for the SAME agent with different fingerprints', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_OLD},${RUN_NEW}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    await expect(page.locator(`[data-testid="scoreboard-fingerprint-${RUN_OLD}"]`)).toHaveText(new RegExp(FP_OLD.slice(0, 12)));
    await expect(page.locator(`[data-testid="scoreboard-fingerprint-${RUN_NEW}"]`)).toHaveText(new RegExp(FP_NEW.slice(0, 12)));

    const badge = page.locator('[data-testid="scoreboard-config-changed-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('config changed between runs');
    await expect(badge).toHaveAttribute('data-diff-kind', 'prompt');
    const title = await badge.getAttribute('title');
    expect(title).toContain('system prompt changed');
    expect(title).toContain(FP_OLD);
    expect(title).toContain(FP_NEW);
  });

  test('comparison scoreboard shows NO config-changed badge for two DIFFERENT agents', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_OLD},${RUN_OTHER_AGENT}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });
    await expect(page.locator(`[data-testid="scoreboard-fingerprint-${RUN_OTHER_AGENT}"]`)).toBeVisible();
    await expect(page.locator('[data-testid="scoreboard-config-changed-badge"]')).toHaveCount(0);
  });
});
