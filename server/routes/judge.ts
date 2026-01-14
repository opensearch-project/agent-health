/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge API Route - Evaluate agent trajectories
 */

import { Request, Response, Router } from 'express';
import { evaluateTrajectory, parseBedrockError } from '../services/bedrockService';

const router = Router();

/**
 * Generate mock evaluation result for demo mode
 */
function generateMockEvaluation(trajectory: any[], expectedOutcomes: string[]): any {
  // Simulate realistic evaluation based on trajectory content
  const hasToolCalls = trajectory.some((step: any) => step.type === 'action' || step.toolName);
  const hasConclusion = trajectory.some((step: any) =>
    step.type === 'response' || (step.content && step.content.toLowerCase().includes('root cause'))
  );

  // Base accuracy on trajectory quality
  let accuracy = 0.7;
  if (hasToolCalls) accuracy += 0.1;
  if (hasConclusion) accuracy += 0.1;
  accuracy = Math.min(accuracy + (Math.random() * 0.1), 1.0);

  const passFailStatus = accuracy >= 0.7 ? 'passed' : 'failed';

  return {
    passFailStatus,
    accuracy: Math.round(accuracy * 100) / 100,
    reasoning: `**Mock Evaluation Result**

The agent demonstrated ${passFailStatus === 'passed' ? 'appropriate' : 'incomplete'} RCA methodology:

${hasToolCalls ? '✅ Used diagnostic tools to gather system information' : '❌ Did not use diagnostic tools'}
${hasConclusion ? '✅ Provided a clear root cause identification' : '❌ Missing clear root cause conclusion'}

**Expected Outcomes Coverage:**
${expectedOutcomes?.map((outcome, i) => `${i + 1}. "${outcome.substring(0, 50)}..." - ${Math.random() > 0.3 ? '✅ Addressed' : '⚠️ Partially addressed'}`).join('\n') || 'No expected outcomes provided'}

*Note: This is a simulated evaluation for demo purposes.*`,
    improvementStrategies: passFailStatus === 'failed' ? [
      {
        priority: 'high',
        category: 'Tool Usage',
        suggestion: 'Consider using more diagnostic tools before drawing conclusions'
      },
      {
        priority: 'medium',
        category: 'Analysis Depth',
        suggestion: 'Provide more detailed reasoning connecting observations to root cause'
      }
    ] : []
  };
}

/**
 * POST /api/judge - Evaluate agent trajectory
 */
router.post('/api/judge', async (req: Request, res: Response) => {
  try {
    const { trajectory, expectedOutcomes, expectedTrajectory, logs, modelId, judgeKey } = req.body;

    // Validate required fields
    if (!trajectory) {
      return res.status(400).json({
        error: 'Missing required field: trajectory'
      });
    }

    if (!expectedOutcomes?.length && !expectedTrajectory?.length) {
      return res.status(400).json({
        error: 'Missing required field: expectedOutcomes or expectedTrajectory'
      });
    }

    // Check if Demo Judge selected (judgeKey === 'demo')
    if (judgeKey === 'demo') {
      console.log('[JudgeAPI] Demo Judge - returning mock evaluation');
      const mockResult = generateMockEvaluation(trajectory, expectedOutcomes);
      return res.json(mockResult);
    }

    // Call Bedrock service to evaluate trajectory
    // modelId is optional - falls back to BEDROCK_MODEL_ID env var if not provided
    console.log('[JudgeAPI] Using Bedrock Judge:', judgeKey || 'bedrock (default)');
    const result = await evaluateTrajectory({
      trajectory,
      expectedOutcomes,
      expectedTrajectory,
      logs
    }, modelId);

    res.json(result);

  } catch (error: any) {
    console.error('[JudgeAPI] Error during evaluation:', error);

    const errorMessage = parseBedrockError(error);

    res.status(500).json({
      error: `Bedrock Judge evaluation failed: ${errorMessage}`,
      details: error.message
    });
  }
});

export default router;
