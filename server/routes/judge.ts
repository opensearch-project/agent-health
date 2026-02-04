/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge API Route - Evaluate agent trajectories
 */

import { Request, Response, Router } from 'express';
import { evaluateTrajectory, parseBedrockError } from '../services/bedrockService';
import { loadConfigSync } from '../../lib/config/index';

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

  const accuracyPct = Math.round(accuracy * 100);
  return {
    passFailStatus,
    metrics: {
      accuracy: accuracyPct,
      faithfulness: Math.round((accuracy - 0.05 + Math.random() * 0.1) * 100),
      latency_score: Math.round((0.8 + Math.random() * 0.2) * 100),
      trajectory_alignment_score: Math.round((accuracy - 0.1 + Math.random() * 0.2) * 100),
    },
    llmJudgeReasoning: `**Mock Evaluation Result**

The agent demonstrated ${passFailStatus === 'passed' ? 'appropriate' : 'incomplete'} RCA methodology:

${hasToolCalls ? '✅ Used diagnostic tools to gather system information' : '❌ Did not use diagnostic tools'}
${hasConclusion ? '✅ Provided a clear root cause identification' : '❌ Missing clear root cause conclusion'}

**Expected Outcomes Coverage:**
${expectedOutcomes?.map((outcome, i) => `${i + 1}. "${outcome.substring(0, 50)}..." - ${Math.random() > 0.3 ? '✅ Addressed' : '⚠️ Partially addressed'}`).join('\n') || 'No expected outcomes provided'}

*Note: This is a simulated evaluation for demo purposes.*`,
    improvementStrategies: passFailStatus === 'failed' ? [
      {
        category: 'Tool Usage',
        issue: 'Insufficient diagnostic tool usage',
        recommendation: 'Consider using more diagnostic tools before drawing conclusions',
        priority: 'high'
      },
      {
        category: 'Analysis Depth',
        issue: 'Reasoning could be more detailed',
        recommendation: 'Provide more detailed reasoning connecting observations to root cause',
        priority: 'medium'
      }
    ] : []
  };
}

/**
 * POST /api/judge - Evaluate agent trajectory
 */
router.post('/api/judge', async (req: Request, res: Response) => {
  try {
    const { trajectory, expectedOutcomes, expectedTrajectory, logs, modelId } = req.body;

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

    // Determine provider from model config
    // Look up by model key first, then by model_id for full Bedrock model IDs
    const config = loadConfigSync();
    let modelConfig = config.models[modelId];
    if (!modelConfig) {
      // Try to find by model_id (in case full Bedrock ID was passed)
      modelConfig = Object.values(config.models).find(m => m.model_id === modelId);
    }
    const provider = modelConfig?.provider || 'bedrock';

    // Route to appropriate provider
    if (provider === 'demo') {
      console.log('[JudgeAPI] Demo provider - returning mock evaluation');
      const mockResult = generateMockEvaluation(trajectory, expectedOutcomes);
      return res.json(mockResult);
    }

    // For now, only bedrock is supported for real evaluation
    // Future: add ollama, openai providers here
    // Use the resolved model_id from config, not the key
    const resolvedModelId = modelConfig?.model_id || modelId;
    console.log('[JudgeAPI] Using provider:', provider, 'model:', resolvedModelId);
    const result = await evaluateTrajectory({
      trajectory,
      expectedOutcomes,
      expectedTrajectory,
      logs
    }, resolvedModelId);

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
