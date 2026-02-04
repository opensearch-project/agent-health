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
import { isStorageAvailable, requireStorageClient } from '../middleware/storageClient.js';
import { SAMPLE_TEST_CASES } from '../../cli/demo/sampleTestCases.js';
import { runSingleUseCase } from '../../services/benchmarkRunner.js';
import { loadConfigSync } from '../../lib/config/index.js';
import type { BenchmarkRun, TestCase } from '../../types/index.js';

const router = Router();

/**
 * Validate evaluation request body
 */
function validateRequest(body: any): string | null {
  if (!body || typeof body !== 'object') {
    return 'Request body must be a valid object';
  }
  if (!body.testCaseId || typeof body.testCaseId !== 'string') {
    return 'testCaseId is required and must be a string';
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
 *   testCaseId: string;   // Test case ID or name
 *   agentKey: string;     // Agent key
 *   modelId: string;      // Model key
 *   agentEndpoint?: string; // Optional endpoint override
 * }
 *
 * Returns the evaluation report with trajectory, metrics, and judge results.
 * Report is automatically saved to storage if configured.
 */
router.post('/api/evaluate', async (req: Request, res: Response) => {
  console.log('[EvaluationAPI] Received evaluation request');

  const validationError = validateRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { testCaseId, agentKey, modelId, agentEndpoint } = req.body;
  console.log('[EvaluationAPI] testCaseId:', testCaseId, 'agentKey:', agentKey, 'modelId:', modelId);

  // Validate agent exists
  const config = loadConfigSync();
  const agent = config.agents.find(a => a.key === agentKey || a.name.toLowerCase() === agentKey.toLowerCase());
  if (!agent) {
    return res.status(400).json({ error: `Agent not found: ${agentKey}` });
  }

  // Validate model exists
  const model = config.models[modelId];
  if (!model) {
    return res.status(400).json({ error: `Model not found: ${modelId}` });
  }

  // Find test case - check sample data first, then storage
  let testCase: TestCase | null = null;

  // Check sample data
  const sampleTestCase = SAMPLE_TEST_CASES.find(tc =>
    tc.id === testCaseId || tc.name.toLowerCase() === testCaseId.toLowerCase()
  );
  if (sampleTestCase) {
    testCase = toTestCase(sampleTestCase);
  }

  // Check storage if not found in samples
  if (!testCase && isStorageAvailable(req)) {
    try {
      const client = requireStorageClient(req);
      const result = await client.search({
        index: 'evals_test_cases',
        body: {
          size: 1,
          sort: [{ version: { order: 'desc' } }],
          query: {
            bool: {
              should: [
                { term: { id: testCaseId } },
                { match_phrase: { name: testCaseId } },
              ],
              minimum_should_match: 1,
            },
          },
        },
      });
      const source = result.body.hits?.hits?.[0]?._source;
      if (source) {
        testCase = source as TestCase;
      }
    } catch (e: any) {
      console.warn('[EvaluationAPI] Storage query failed:', e.message);
    }
  }

  if (!testCase) {
    return res.status(404).json({ error: `Test case not found: ${testCaseId}` });
  }

  console.log('[EvaluationAPI] Test case found:', testCase.name);

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

  // Check if storage is available for saving results
  if (!isStorageAvailable(req)) {
    return res.status(400).json({
      error: 'OpenSearch storage not configured. Cannot run evaluations without storage.',
      hint: 'Set OPENSEARCH_STORAGE_* environment variables to enable storage.',
    });
  }

  const client = requireStorageClient(req);

  try {
    // Set up SSE streaming for progress updates
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send started event
    res.write(`data: ${JSON.stringify({ type: 'started', testCase: testCase.name, agent: agent.name })}\n\n`);

    // Run the evaluation with step progress
    let stepCount = 0;
    const reportId = await runSingleUseCase(
      runConfig,
      testCase,
      client,
      (step) => {
        stepCount++;
        // Send progress event for each step
        res.write(`data: ${JSON.stringify({
          type: 'step',
          stepIndex: stepCount - 1,
          step: { type: step.type, content: step.content?.substring(0, 200) },
        })}\n\n`);
      }
    );

    // Fetch the completed report
    const reportResult = await client.get({
      index: 'evals_runs',
      id: reportId,
    });

    if (!reportResult.body.found) {
      throw new Error('Report not found after save');
    }

    const report = reportResult.body._source;

    // Send completed event
    res.write(`data: ${JSON.stringify({
      type: 'completed',
      report: {
        id: report.id,
        status: report.status,
        passFailStatus: report.passFailStatus,
        metrics: report.metrics,
        trajectorySteps: report.trajectory?.length || 0,
        llmJudgeReasoning: report.llmJudgeReasoning,
      },
    })}\n\n`);

    res.end();
  } catch (error: any) {
    console.error('[EvaluationAPI] Evaluation failed:', error.message);

    // If headers already sent, send error as SSE event
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

export default router;
