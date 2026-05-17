/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluation Routes - Run single test case evaluations
 *
 * This endpoint allows CLI commands to run evaluations through the server
 * instead of calling agent/judge/storage directly.
 * Follows the server-mediated architecture pattern.
 */

import { Router, Request, Response } from 'express';
import { getStorageModule } from '@/server/adapters';
import { SAMPLE_TEST_CASES } from '../../cli/demo/sampleTestCases';
import { runSingleUseCase } from '@/services/benchmarkRunner';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { debug } from '@/lib/debug';
import type { BenchmarkRun, TestCase, TestCaseRun } from '@/types';

const router = Router();

/**
 * Validate evaluation request body
 *
 * Supports two modes:
 * 1. By reference: { testCaseId, agentKey, modelId } — looks up test case from storage/samples
 * 2. Inline: { testCase, agentKey, modelId } — uses provided test case object directly (for ad-hoc runs)
 */
function validateRequest(body: any): string | null {
  if (!body || typeof body !== 'object') {
    return 'Request body must be a valid object';
  }
  if (!body.testCaseId && !body.testCase) {
    return 'Either testCaseId or testCase is required';
  }
  if (body.testCase && typeof body.testCase !== 'object') {
    return 'testCase must be a valid object when provided';
  }
  if (body.testCase && !body.testCase.initialPrompt) {
    return 'testCase.initialPrompt is required';
  }
  if (!body.agentKey || typeof body.agentKey !== 'string') {
    return 'agentKey is required and must be a string';
  }
  if (!body.modelId || typeof body.modelId !== 'string') {
    return 'modelId is required and must be a string';
  }
  return null;
}

/**
 * Convert sample test case to full TestCase format
 */
function toTestCase(sample: typeof SAMPLE_TEST_CASES[0]): TestCase {
  const now = new Date().toISOString();
  return {
    id: sample.id,
    name: sample.name,
    description: sample.description || '',
    labels: sample.labels,
    category: 'RCA',
    difficulty: sample.labels.find(l => l.startsWith('difficulty:'))?.split(':')[1] as any || 'Medium',
    currentVersion: 1,
    versions: [{
      version: 1,
      createdAt: now,
      initialPrompt: sample.initialPrompt,
      context: sample.context.map(c => ({ description: c.type, value: JSON.stringify(c.content) })),
      expectedOutcomes: sample.expectedOutcomes,
    }],
    isPromoted: sample.tags?.includes('promoted') || false,
    createdAt: now,
    updatedAt: now,
    initialPrompt: sample.initialPrompt,
    context: sample.context.map(c => ({ description: c.type, value: JSON.stringify(c.content) })),
    expectedOutcomes: sample.expectedOutcomes,
  };
}

/**
 * POST /api/evaluate - Run a single test case evaluation
 *
 * Request body:
 * {
 *   testCaseId?: string;   // Test case ID or name (required unless testCase provided)
 *   testCase?: TestCase;   // Inline test case object (for ad-hoc runs from QuickRunModal)
 *   agentKey: string;      // Agent key
 *   modelId: string;       // Model key
 *   agentEndpoint?: string; // Optional endpoint override
 * }
 *
 * SSE events:
 * - { type: 'started', testCase, agent, reportId }
 * - { type: 'heartbeat' }
 * - { type: 'step', stepIndex, step: { type, content, toolName?, toolArgs? } }
 * - { type: 'completed', report: { id, status, passFailStatus, metrics, ... }, reportId }
 * - { type: 'error', error }
 *
 * Returns the evaluation report with trajectory, metrics, and judge results.
 * Report is automatically saved to storage if configured.
 */
router.post('/api/evaluate', async (req: Request, res: Response) => {
  debug('EvalAPI', 'Received evaluation request');

  const validationError = validateRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { testCaseId, agentKey, modelId, agentEndpoint, evaluatorId } = req.body;
  const inlineTestCase = req.body.testCase as TestCase | undefined;
  debug('EvalAPI', 'testCaseId:', testCaseId, 'agentKey:', agentKey, 'modelId:', modelId, 'inline:', !!inlineTestCase);

  // Validate agent exists (check both built-in and custom agents)
  const config = loadConfigSync();
  const allAgents = [...config.agents, ...getCustomAgents()];
  const agent = allAgents.find(a => a.key === agentKey || a.name.toLowerCase() === agentKey.toLowerCase());
  if (!agent) {
    return res.status(400).json({ error: `Agent not found: ${agentKey}` });
  }

  // Validate model exists
  const model = config.models[modelId];
  if (!model) {
    return res.status(400).json({ error: `Model not found: ${modelId}` });
  }

  // Resolve test case: use inline object if provided, otherwise look up by ID
  let testCase: TestCase | null = null;

  if (inlineTestCase) {
    // Use inline test case directly (from QuickRunModal ad-hoc runs)
    testCase = inlineTestCase;
  } else if (testCaseId) {
    // Check sample data
    const sampleTestCase = SAMPLE_TEST_CASES.find(tc =>
      tc.id === testCaseId || tc.name.toLowerCase() === testCaseId.toLowerCase()
    );
    if (sampleTestCase) {
      testCase = toTestCase(sampleTestCase);
    }

    // Check storage if not found in samples
    if (!testCase) {
      try {
        const storage = getStorageModule();
        // Try by ID first, then by name search
        const byId = await storage.testCases.getById(testCaseId);
        if (byId) {
          testCase = byId;
        } else {
          // Search by name as fallback
          const searchResult = await storage.testCases.search(
            { textSearch: testCaseId },
            { size: 1 }
          );
          if (searchResult.items.length > 0) {
            testCase = searchResult.items[0];
          }
        }
      } catch (e: any) {
        console.warn('[EvaluationAPI] Storage query failed:', e.message);
      }
    }
  }

  if (!testCase) {
    return res.status(404).json({ error: `Test case not found: ${testCaseId || 'inline'}` });
  }

  debug('EvalAPI', 'Test case found:', testCase.name);

  // Build run configuration
  const runConfig: BenchmarkRun = {
    id: `cli-run-${Date.now()}`,
    name: `CLI Run - ${agent.name}`,
    createdAt: new Date().toISOString(),
    agentKey: agent.key,
    modelId: modelId,
    agentEndpoint: agentEndpoint || agent.endpoint,
    results: {},
  };

  const storage = getStorageModule();

  // Pre-persist a placeholder run so the client can poll if SSE disconnects.
  // We use the same field shape as `saveReportWithModule` (storage-layer names like
  // agentId/traceId) so the placeholder is forward-compatible with the final update.
  // This is also the shape that the listing pages and pollReportStatus expect.
  let preCreatedReportId: string | null = null;
  try {
    const placeholder = await storage.runs.create({
      testCaseId: testCase.id,
      testCaseVersion: testCase.currentVersion,
      // Both names so app-side and storage-side queries can find the record
      agentKey: agent.key,
      agentName: agent.name,
      agentId: agent.key,
      agentEndpoint: agentEndpoint || agent.endpoint,
      modelId: modelId,
      modelName: model.display_name || modelId,
      evaluatorId,
      status: 'running',
      trajectory: [],
      metrics: {},
      llmJudgeReasoning: '',
      timestamp: new Date().toISOString(),
    } as Partial<TestCaseRun>);
    preCreatedReportId = placeholder.id;
    debug('EvalAPI', 'Pre-created placeholder run:', preCreatedReportId);
  } catch (e: any) {
    // Storage may not be configured — disconnect recovery will be unavailable
    // but the evaluation can still proceed. Surface this clearly.
    console.warn(
      '[EvaluationAPI] Could not pre-create placeholder run — ' +
      'SSE disconnect recovery will be unavailable for this request. ' +
      `Reason: ${e.message}`
    );
  }

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let clientDisconnected = false;
  let cleanupDone = false;

  // Single cleanup path — idempotent so it's safe to call from any branch.
  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  try {
    // Set up SSE streaming for progress updates
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Heartbeat to keep connection alive during long-running evaluations
    heartbeatInterval = setInterval(() => {
      if (!res.writableEnded && !clientDisconnected) {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      }
    }, 15000);

    // Track client disconnect — but don't abort the evaluation.
    // The server keeps running so the report still gets persisted.
    req.on('close', () => {
      clientDisconnected = true;
      cleanup();
    });

    // Send started event with reportId for polling fallback
    res.write(`data: ${JSON.stringify({ type: 'started', testCase: testCase.name, agent: agent.name, reportId: preCreatedReportId })}\n\n`);

    // Run the evaluation with step progress
    let stepCount = 0;
    const reportId = await runSingleUseCase(
      runConfig,
      testCase,
      storage,
      (step) => {
        stepCount++;
        if (!clientDisconnected && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({
            type: 'step',
            stepIndex: stepCount - 1,
            step: {
              id: step.id,
              type: step.type,
              content: step.content,
              toolName: step.toolName,
              toolArgs: step.toolArgs,
              status: step.status,
              timestamp: step.timestamp,
            },
          })}\n\n`);
        }
      },
      evaluatorId,
      preCreatedReportId || undefined
    );

    // Fetch the completed report via adapter
    const report = await storage.runs.getById(reportId);

    if (!report) {
      throw new Error('Report not found after save');
    }

    cleanup();

    // Send completed event (only if client is still connected)
    if (!clientDisconnected && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({
        type: 'completed',
        reportId,
        report: {
          id: report.id,
          status: report.status,
          passFailStatus: report.passFailStatus,
          metricsStatus: report.metricsStatus,
          metrics: report.metrics,
          trajectorySteps: report.trajectory?.length || 0,
          llmJudgeReasoning: report.llmJudgeReasoning,
          improvementStrategies: report.improvementStrategies,
        },
      })}\n\n`);
      res.end();
    }
  } catch (error: any) {
    console.error('[EvaluationAPI] Evaluation failed:', error.message);
    cleanup();

    // Update placeholder run with failed status so the UI/polling can see it
    if (preCreatedReportId) {
      try {
        await storage.runs.update(preCreatedReportId, {
          status: 'failed',
          llmJudgeReasoning: `Evaluation error: ${error.message}`,
        } as Partial<TestCaseRun>);
      } catch { /* best-effort */ }
    }

    // If headers already sent, send error as SSE event
    if (res.headersSent && !clientDisconnected && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } else if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

export default router;
