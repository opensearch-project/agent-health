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

  test('chip is LABELLED "config" everywhere (a bare 12-hex reads as a commit SHA), and the inspector shows an explicit "not recorded" chip for a legacy run', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');
    const chip = page.locator(`[data-testid="run-row-fingerprint-${RUN_OLD}"]`);
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toContainText('config');
    await expect(chip).toContainText(FP_OLD.slice(0, 12));

    await page.goto(`/evaluations/runs/${RUN_LEGACY}/inspect`);
    const missing = page.locator('[data-testid="inspector-fingerprint-chip-missing"]');
    await expect(missing).toBeVisible({ timeout: 15000 });
    await expect(missing).toContainText('not recorded');
    await expect(page.locator('[data-testid="inspector-fingerprint-chip"]')).toHaveCount(0);
  });

  test('clicking the chip opens a details popover: what the hash is, what was hashed, the recorded config file + repo commit, and the CLI to recompute it', async ({ page }) => {
    await page.goto(`/evaluations/runs/${RUN_OLD}/inspect`);
    const chip = page.locator('[data-testid="inspector-fingerprint-chip"]');
    await expect(chip).toBeVisible({ timeout: 15000 });
    await chip.click();
    const details = page.locator('[data-testid="inspector-fingerprint-chip-details"]');
    await expect(details).toBeVisible();
    await expect(details).toContainText('not a git commit');
    await expect(details.locator('[data-testid="inspector-fingerprint-chip-details-fingerprint"]')).toContainText(FP_OLD);
    await expect(details.locator('[data-testid="inspector-fingerprint-chip-details-prompt-hash"]')).toContainText(PH_OLD);
    await expect(details.locator('[data-testid="inspector-fingerprint-chip-details-agent-key"]')).toHaveText('agent-alpha');
    await expect(details.locator('[data-testid="inspector-fingerprint-chip-details-config-path"]')).toHaveText('/cfg/agent-health.config.ts');
    await expect(details.locator('[data-testid="inspector-fingerprint-chip-details-config-sha"]')).toContainText('cafe0000cafe0000cafe0000cafe0000cafe0000');
    // Every hashed input is listed (connector config, model, endpoint, hooks, header names, auth shape, …).
    const inputs = details.locator('[data-testid="inspector-fingerprint-chip-details-inputs"] li');
    expect(await inputs.count()).toBeGreaterThanOrEqual(10);
    await expect(details.locator('[data-input-key="connectorConfig"]')).toBeVisible();
    await expect(details.locator('[data-input-key="hooks"]')).toBeVisible();
    await expect(details).toContainText('The inputs themselves are not stored on the run');
    await expect(details.locator('[data-testid="inspector-fingerprint-chip-details-cli"]')).toContainText('npx @opensearch-project/agent-health fingerprint agent-alpha');
    await expect(details).toContainText('GET /api/agents/agent-alpha/fingerprint');
  });

  test('"Compare with this server\'s current config" hits the REAL /api/agents/:key/fingerprint: matches for a run stamped with the live fingerprint, differs otherwise, unknown for an agent not in the config', async ({ page, request, testData }) => {
    // Real current fingerprint of the bundled demo agent, from the server under test.
    const liveRes = await request.get('/api/agents/demo/fingerprint');
    expect(liveRes.ok()).toBeTruthy();
    const live = await liveRes.json();
    expect(live.agentFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const RUN_LIVE = `eval-run-e2e-fp-live-${STAMP}`;
    const RUN_STALE = `eval-run-e2e-fp-stale-${STAMP}`;
    const docs = [
      evalRunDoc(RUN_LIVE, `E2E FP Live Demo ${STAMP}`, 'demo', {
        agentFingerprint: live.agentFingerprint, agentFingerprintShort: live.agentFingerprintShort, ...(live.agentPromptHash ? { agentPromptHash: live.agentPromptHash } : {}),
      }),
      evalRunDoc(RUN_STALE, `E2E FP Stale Demo ${STAMP}`, 'demo', {
        agentFingerprint: FP_OLD, agentFingerprintShort: FP_OLD.slice(0, 12), agentPromptHash: PH_OLD,
      }),
    ];
    // Tracked (not a `finally`): a test timeout abandons the body, so a
    // hand-rolled finally never runs and the docs leak; the fixture cleans up regardless.
    for (const doc of docs) {
      expect((await request.put(`/api/storage/evaluation-runs/${doc.id}`, { data: doc })).ok()).toBeTruthy();
      testData.evaluationRun(doc.id);
    }
    {
      const compare = async (runId: string) => {
        await page.goto(`/evaluations/runs/${runId}/inspect`);
        await page.locator('[data-testid="inspector-fingerprint-chip"]').click();
        await page.locator('[data-testid="inspector-fingerprint-chip-details-compare"]').click();
        const result = page.locator('[data-testid="inspector-fingerprint-chip-details-compare-result"]');
        await expect(result).not.toHaveAttribute('data-state', /idle|loading/, { timeout: 15000 });
        return result;
      };
      await expect(await compare(RUN_LIVE)).toContainText('matches the current config');
      const stale = await compare(RUN_STALE);
      await expect(stale).toContainText('current config differs');
      await expect(stale).toContainText(live.agentFingerprintShort);
      // agent-alpha is a synthetic key that no server config carries.
      await expect(await compare(RUN_OLD)).toContainText('is not in this server');
    }
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
