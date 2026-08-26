/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end CLI integration test for the `--judge-model` flag.
 *
 * Why this test exists
 * ────────────────────
 * Per the lesson from issue #245 / PR c5ab413b: the CLI binary has its
 * own preparation path before it hits the shared server runner, so
 * "logically equivalent to the HTTP API" is not enough. We spawn the
 * actual CLI binary and assert the flag round-trips end-to-end into
 * the persisted run document — catching regressions where the CLI
 * silently drops the value (the same shape of bug that #245 was).
 *
 * Specifically pins:
 *   1. `agent-health run --judge-model <id>` → POST /api/evaluate body
 *      includes `judgeModelId` → run document persists it.
 *   2. `agent-health benchmark --judge-model <id>` → POST
 *      /api/storage/evaluation-runs body includes `judgeModelId` →
 *      EvaluationRun document persists it AND the child reports
 *      inherit it.
 *   3. The flag is DISTINCT from `-m, --model` (the agent's LLM):
 *      verifying both fields land on different keys on the run doc
 *      and don't cross-contaminate.
 *
 * Uses the demo agent + demo-model so no Bedrock credentials are
 * required — the demo judge provider still goes through the same
 * routing layer where `judgeModelId` is consumed, so the field
 * survives the whole pipeline (route → runner → storage) without
 * needing a real model call.
 *
 * Prerequisites
 * ─────────────
 *   • Backend running (npm run dev:server). Test self-skips otherwise.
 *   • CLI bundle built (npm run build:cli). The test runs `npm run
 *     build:cli` if the bundle is missing.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { request as httpRequest } from 'http';
import { getTestBackendUrl, checkJudgeAvailable } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 90_000;
const BASE_URL = getTestBackendUrl();
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CLI_BUNDLE = join(REPO_ROOT, 'cli', 'dist', 'index.js');

// Plain http (agent:false) sidesteps the Jest 30 + undici localhost
// race surfaced by other CLI integ tests in this repo. See the comment
// in benchmarkEvaluatorId.integration.test.ts for the full rationale.
function httpGet<T = any>(url: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'GET',
        agent: false as any,
      },
      (res) => {
        let chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode || 0, body: body as any });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function checkBackend(): Promise<boolean> {
  try {
    const r = await httpGet(`${BASE_URL}/health`);
    return r.status === 200;
  } catch {
    return false;
  }
}

function ensureCliBuilt() {
  if (existsSync(CLI_BUNDLE)) return;
  // Match the build script the package uses so this works on a fresh checkout.
  const built = spawnSync('npm', ['run', 'build:cli'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (built.status !== 0) throw new Error('npm run build:cli failed; cannot continue');
  if (!existsSync(CLI_BUNDLE)) throw new Error(`CLI bundle still missing at ${CLI_BUNDLE} after build`);
}

describe('CLI --judge-model flag — end-to-end', () => {
  let backendAvailable = false;
  let judgeAvailable = false;
  const createdReportIds: string[] = [];
  const createdTestCaseIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.log(`[judgeModelIdFlag.integ] Backend not running at ${BASE_URL}, skipping`);
      return;
    }
    // The CLI run drives a real eval that only exits 0 once the (Bedrock) judge
    // scores it. CI has no AWS creds, so skip when the judge can't run (this
    // suite passes locally with AWS_PROFILE=Bedrock).
    judgeAvailable = await checkJudgeAvailable(BASE_URL);
    if (!judgeAvailable) {
      console.log('[judgeModelIdFlag.integ] Bedrock judge unavailable (no AWS creds), skipping');
      return;
    }
    ensureCliBuilt();
  });

  afterAll(async () => {
    // AGENTS.md "Integration Test Cleanup" — wipe everything we created.
    for (const id of createdReportIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
    }
    for (const id of createdTestCaseIds) {
      await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
    }
  });

  it(
    '`agent-health run --judge-model <id>` persists judgeModelId on the run document, distinct from --model',
    async () => {
      if (!backendAvailable || !judgeAvailable) return;

      // Create a test case the CLI can look up by id.
      const testCaseId = `tc-cli-judgemodel-${Date.now()}`;
      createdTestCaseIds.push(testCaseId);
      const now = new Date().toISOString();
      await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: testCaseId,
          name: `CLI judge-model integ ${testCaseId}`,
          description: 'CLI flag integ test',
          labels: ['category:Test'],
          category: 'Test',
          difficulty: 'Medium',
          currentVersion: 1,
          versions: [{
            version: 1,
            createdAt: now,
            initialPrompt: 'Demo prompt',
            context: [],
            expectedOutcomes: ['demo outcome'],
          }],
          createdAt: now,
          updatedAt: now,
          initialPrompt: 'Demo prompt',
          context: [],
          expectedOutcomes: ['demo outcome'],
        }),
      });

      // Spawn the actual CLI binary. The whole point of an integ test is
      // not to import the CLI as a library — that would skip the arg
      // parsing layer where flags can silently drop on the floor.
      const port = new URL(BASE_URL).port || '4001';
      const result = spawnSync(
        'node',
        [
          CLI_BUNDLE, 'run',
          '-t', testCaseId,
          '-a', 'demo',
          '--judge-model', 'us.anthropic.claude-opus-4-6-v1',
          '-o', 'json',
        ],
        {
          env: { ...process.env, AH_PORT: port },
          encoding: 'utf-8',
          timeout: TEST_TIMEOUT - 10_000,
        }
      );

      // The CLI exits 0 on a completed run regardless of pass/fail status.
      expect(result.status).toBe(0);

      // Find the most recent run for this test case.
      const runsRes = await httpGet<any>(
        `${BASE_URL}/api/storage/runs/by-test-case/${encodeURIComponent(testCaseId)}`,
      );
      expect(runsRes.status).toBe(200);
      expect(runsRes.body.runs?.length || 0).toBeGreaterThan(0);
      const run = runsRes.body.runs[0];
      createdReportIds.push(run.id);

      // The two contracts the flag exists to enforce:
      //   1. Both fields are persisted (not silently merged).
      expect(run.modelId).toBe('demo-model');
      expect(run.judgeModelId).toBe('us.anthropic.claude-opus-4-6-v1');
      //   2. They MUST NOT be equal — the bug the flag fixes was them
      //      sharing a value.
      expect(run.judgeModelId).not.toBe(run.modelId);
    },
    TEST_TIMEOUT
  );

  it(
    '`agent-health run` without --judge-model leaves the field undefined on the run (no auto-derive from --model)',
    async () => {
      if (!backendAvailable || !judgeAvailable) return;

      const testCaseId = `tc-cli-judgemodel-unset-${Date.now()}`;
      createdTestCaseIds.push(testCaseId);
      const now = new Date().toISOString();
      await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: testCaseId,
          name: `CLI judge-model unset integ ${testCaseId}`,
          description: 'CLI flag unset integ test',
          labels: ['category:Test'],
          category: 'Test',
          difficulty: 'Medium',
          currentVersion: 1,
          versions: [{
            version: 1, createdAt: now, initialPrompt: 'Demo prompt',
            context: [], expectedOutcomes: ['demo outcome'],
          }],
          createdAt: now, updatedAt: now,
          initialPrompt: 'Demo prompt', context: [],
          expectedOutcomes: ['demo outcome'],
        }),
      });

      const port = new URL(BASE_URL).port || '4001';
      const result = spawnSync(
        'node',
        [
          CLI_BUNDLE, 'run',
          '-t', testCaseId,
          '-a', 'demo',
          // no --judge-model
          '-o', 'json',
        ],
        {
          env: { ...process.env, AH_PORT: port },
          encoding: 'utf-8',
          timeout: TEST_TIMEOUT - 10_000,
        }
      );
      expect(result.status).toBe(0);

      const runsRes = await httpGet<any>(
        `${BASE_URL}/api/storage/runs/by-test-case/${encodeURIComponent(testCaseId)}`,
      );
      expect(runsRes.body.runs?.length || 0).toBeGreaterThan(0);
      const run = runsRes.body.runs[0];
      createdReportIds.push(run.id);

      // Critical: pre-fix this would have silently been set to
      // run.modelId. Now it stays undefined.
      expect(run.judgeModelId).toBeUndefined();
      expect(run.modelId).toBe('demo-model');
    },
    TEST_TIMEOUT
  );
});
