/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: POST /api/evaluate, judge provider 'agent' (the
 * agent-trace-judge, judgeModelId: 'agent-trace-judge'), verifying that
 * improvement strategies + custom output fields the evaluator's prompt asked
 * for survive the full persisted-report path.
 *
 * Regression for the bug where server/services/piAgenticJudgeService.ts
 * unconditionally forced `improvementStrategies: []` even when the model
 * emitted `improvement_strategies` — dropping them silently on the agentic
 * trace judge while every other provider (bedrock, openai-compatible,
 * litellm, claude-code, pi, agentic) kept them.
 *
 * Only the model-driving boundary (`evaluateWithPiAgenticTrace`, which would
 * otherwise spin up the pi SDK and need real model credentials) is mocked —
 * the same module-boundary-mocking pattern
 * tests/integration/server/routes/judgeAgentProviderHints.integration.test.ts
 * already uses for this exact service. Everything downstream of that mock
 * (services/evaluation's report building, the storage adapter — real
 * FileStorageModule, no OpenSearch required — judgeAccessor's
 * buildJudgeMatcherEntry, and the final GET) is real, over real HTTP
 * (supertest against a hand-built express app mounting the real judge +
 * evaluation + storage routers) — so this test is the regression lock for
 * the "extraFields / improvementStrategies survive every hop" plumbing audit
 * as well as the agent-judge-specific fix.
 *
 * This mounts only the specific routers needed (judge, evaluation,
 * evaluators, runs) rather than the full `server/app.ts` — `createApp()`
 * transitively imports `server/middleware/index.ts`, which uses
 * `import.meta.url` and duplicate-declares `__filename` under ts-jest's CJS
 * transform (see the repo's existing `__mocks__/@/server/services/*.ts`
 * shims for the same class of issue). Individual route modules don't hit
 * that path, matching how judgeAgentProviderHints.integration.test.ts
 * already avoids it.
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=agentJudgeImprovementStrategies.integration
 */

import express from 'express';
import request from 'supertest';
import { rmSync } from 'node:fs';
import path from 'node:path';

const mockEvaluateWithPiAgenticTrace = jest.fn();
jest.mock('@/server/services/piAgenticJudgeService', () => ({
  evaluateWithPiAgenticTrace: (...args: any[]) => mockEvaluateWithPiAgenticTrace(...args),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const TEST_TIMEOUT = 30000;

// Isolated file-storage data dir for this test file so it never touches the
// shared OpenSearch cluster and cleans up trivially (no OPENSEARCH_* env
// vars are set in this worktree, so the default FileStorageModule is used).
const DATA_DIR = path.join(process.cwd(), '.agent-health-test-data', 'agentJudgeImprovementStrategies');

describe('POST /api/evaluate — agent trace judge keeps improvement strategies + custom fields (integration)', () => {
  let app: express.Express;

  beforeAll(async () => {
    process.env.AGENT_HEALTH_DATA_DIR = DATA_DIR;
    // callBedrockJudge (services/evaluation/bedrockJudge.ts) is invoked
    // in-process by runSingleUseCase and self-dials `/api/judge` over real
    // HTTP via AH_PORT — point it at THIS test's supertest server.
    const judgeRoutes = (await import('@/server/routes/judge')).default;
    const evaluationRoutes = (await import('@/server/routes/evaluation')).default;
    const evaluatorRoutes = (await import('@/server/routes/storage/evaluators')).default;
    const runRoutes = (await import('@/server/routes/storage/runs')).default;

    app = express();
    app.use(express.json());
    app.use(judgeRoutes);
    app.use(evaluationRoutes);
    app.use(evaluatorRoutes);
    app.use(runRoutes);

    // Bind a real listener (not just supertest(app) per-request) so the
    // in-process HTTP self-call from callBedrockJudge → AH_PORT resolves to
    // an address that's actually listening.
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as any).port;
    process.env.AH_PORT = String(port);
  }, TEST_TIMEOUT);

  let server: import('http').Server;

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it(
    'persists report.improvementStrategies and matcherResults[0].improvementStrategies for judgeModelId=agent-trace-judge',
    async () => {
      // Simulates what the FIXED evaluateWithPiAgenticTrace returns when the
      // model emitted `improvement_strategies` + a custom `failure_tags` key
      // in response to the evaluator's Output Format instructions — i.e. the
      // shape parseJudgeResponse() produces post-fix (parser-level
      // regression coverage of the fix itself lives in
      // tests/unit/server/services/piAgenticJudgeService.test.ts).
      mockEvaluateWithPiAgenticTrace.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 92, faithfulness: 90, latency_score: 88, trajectory_alignment_score: 85 },
        llmJudgeReasoning: 'Verified against real spans; agent correctly identified the root cause.',
        improvementStrategies: [
          {
            category: 'reliability',
            issue: 'retry storm observed in spans',
            recommendation: 'add exponential backoff to the retry loop',
            priority: 'high',
          },
        ],
        extraFields: { failure_tags: ['none-observed'] },
        judgeMode: 'trace-tools',
        duration: 1234,
      });

      // 1. Create an evaluator whose inferenceConfig routes to the agent
      // (trace) judge provider — mirrors a saved evaluator whose prompt asks
      // the model for `improvement_strategies` (RCA Output Format contract).
      const evalRes = await request(app)
        .post('/api/storage/evaluators')
        .send({
          name: 'ahtest-agent-trace-strategies-eval',
          description: 'Integration test evaluator for the agent trace judge',
          systemPrompt: 'You are an RCA judge. Emit improvement_strategies for any failed run.',
          scoringConfig: { metrics: ['accuracy'], weights: { accuracy: 1 } },
          inferenceConfig: { provider: 'agent' },
        });
      expect(evalRes.status).toBe(201);
      const evaluator = evalRes.body;

      // 2. Run an evaluation against the built-in mock connector agent with
      // judgeModelId='agent-trace-judge' (the UI-facing judge-model id for
      // this provider) and the evaluator created above.
      const evalReqRes = await request(app)
        .post('/api/evaluate')
        .send({
          testCase: {
            id: 'ahtest-agent-judge-tc',
            name: 'ahtest-agent-judge-tc',
            initialPrompt: 'Diagnose the CPU spike.',
            expectedOutcomes: ['Identifies the CPU spike root cause'],
          },
          agentKey: 'demo',
          modelId: 'demo-model',
          judgeModelId: 'agent-trace-judge',
          evaluatorId: evaluator.id,
        });
      expect(evalReqRes.status).toBe(200);

      // Drain the SSE stream to completion.
      const text: string = evalReqRes.text;
      const completedLine = text
        .split('\n')
        .find((l) => l.startsWith('data: ') && l.includes('"type":"completed"'));
      expect(completedLine).toBeDefined();
      const completedEvent = JSON.parse(completedLine!.slice(6));
      const reportId = completedEvent.reportId as string;
      expect(reportId).toBeTruthy();

      expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalled();

      // 3. Fetch the PERSISTED report and assert the fix + full plumbing.
      const reportRes = await request(app).get(`/api/storage/runs/${encodeURIComponent(reportId)}`);
      expect(reportRes.status).toBe(200);
      const report = reportRes.body;

      expect(report.improvementStrategies).toEqual([
        {
          category: 'reliability',
          issue: 'retry storm observed in spans',
          recommendation: 'add exponential backoff to the retry loop',
          priority: 'high',
        },
      ]);
      expect(Array.isArray(report.matcherResults)).toBe(true);
      expect(report.matcherResults.length).toBeGreaterThan(0);
      expect(report.matcherResults[0].improvementStrategies).toEqual([
        {
          category: 'reliability',
          issue: 'retry storm observed in spans',
          recommendation: 'add exponential backoff to the retry loop',
          priority: 'high',
        },
      ]);

      // Custom output field plumbing (the "ALSO CHECK" audit): the
      // evaluator-declared extraFields key must survive into the persisted
      // llmJudgeResponse sidecar too.
      expect(report.llmJudgeResponse?.extraFields).toEqual({ failure_tags: ['none-observed'] });

      // Cleanup — delete what this test created.
      await request(app).delete(`/api/storage/runs/${encodeURIComponent(reportId)}`);
      await request(app).delete(`/api/storage/evaluators/${encodeURIComponent(evaluator.id)}`);
    },
    TEST_TIMEOUT
  );
});
