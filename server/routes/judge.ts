/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge API Route - Evaluate agent trajectories
 */

import { Request, Response, Router } from 'express';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { evaluateTrajectory, parseBedrockError } from '../services/bedrockService';
import { evaluateWithOpenAICompatible, parseOpenAICompatibleError } from '../services/judgeService';
import { loadConfigSync } from '../../lib/config/index';
import serverConfig from '../config';
import { debug } from '@/lib/debug';

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
 * GET /api/judge/openai-compatible-models
 * Discover available models from the configured OpenAI-compatible endpoint.
 * Returns { models: string[], endpoint: string, configured: boolean }
 */
router.get('/api/judge/openai-compatible-models', async (_req: Request, res: Response) => {
  const endpoint = serverConfig.OPENAI_COMPATIBLE_ENDPOINT;
  // Derive the /models URL from the chat completions endpoint
  const modelsUrl = endpoint.replace(/\/chat\/completions$/, '/models');

  debug('JudgeAPI', 'Fetching OpenAI-compatible models from:', modelsUrl);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (serverConfig.OPENAI_COMPATIBLE_API_KEY) {
    headers['Authorization'] = `Bearer ${serverConfig.OPENAI_COMPATIBLE_API_KEY}`;
  }

  try {
    const response = await fetch(modelsUrl, { headers });
    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        error: `OpenAI-compatible /models returned ${response.status}`,
        details: body,
        endpoint: modelsUrl,
        configured: !!serverConfig.OPENAI_COMPATIBLE_API_KEY,
      });
    }
    const data = await response.json();
    // OpenAI /models returns { object: "list", data: [{ id, ... }] }
    const models: string[] = (data.data || data.models || []).map((m: any) => m.id || m).filter(Boolean);
    debug('JudgeAPI', 'Discovered', models.length, 'OpenAI-compatible models');
    return res.json({
      models,
      endpoint: modelsUrl,
      configured: !!serverConfig.OPENAI_COMPATIBLE_API_KEY,
    });
  } catch (err: any) {
    return res.status(503).json({
      error: `Cannot reach OpenAI-compatible endpoint: ${err.message}`,
      endpoint: modelsUrl,
      configured: !!serverConfig.OPENAI_COMPATIBLE_API_KEY,
    });
  }
});

/**
 * GET /api/judge/bedrock-models
 * Discover available Anthropic models from AWS Bedrock via ListInferenceProfiles.
 * Returns { models: Array<{id, name}>, region: string, configured: boolean }
 */
router.get('/api/judge/bedrock-models', async (_req: Request, res: Response) => {
  const region = serverConfig.AWS_REGION;
  debug('JudgeAPI', 'Fetching Bedrock inference profiles from region:', region);

  try {
    const client = new BedrockClient({
      region,
      credentials: fromNodeProviderChain(),
    });

    const command = new ListInferenceProfilesCommand({});
    const response = await client.send(command);

    const profiles = response.inferenceProfileSummaries || [];
    const anthropicModels = profiles
      .filter(p => (p.inferenceProfileId || '').includes('anthropic'))
      .map(p => ({
        id: p.inferenceProfileId,
        name: p.inferenceProfileName || p.inferenceProfileId,
      }));

    debug('JudgeAPI', 'Discovered', anthropicModels.length, 'Anthropic Bedrock models');
    return res.json({
      models: anthropicModels,
      region,
      configured: true,
    });
  } catch (err: any) {
    debug('JudgeAPI', 'Bedrock discovery failed:', err.message);
    return res.status(503).json({
      error: `Cannot discover Bedrock models: ${err.message}`,
      region,
      configured: false,
    });
  }
});

/**
 * POST /api/judge - Evaluate agent trajectory
 */
router.post('/api/judge', async (req: Request, res: Response) => {
  try {
    const { trajectory, expectedOutcomes, expectedTrajectory, logs, modelId } = req.body;

    // Validate required fields
    if (!trajectory || !Array.isArray(trajectory) || trajectory.length === 0) {
      return res.status(400).json({
        error: 'Trajectory is required and must be a non-empty array'
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

    // Use the resolved model_id from config, not the key
    const resolvedModelId = modelConfig?.model_id || modelId;
    debug('JudgeAPI', 'Using provider:', provider, 'model:', resolvedModelId);

    // Route to appropriate provider
    if (provider === 'demo') {
      debug('JudgeAPI', 'Demo provider - returning mock evaluation');
      const mockResult = generateMockEvaluation(trajectory, expectedOutcomes);
      return res.json(mockResult);
    }

    if (provider === 'openai-compatible') {
      debug('JudgeAPI', 'OpenAI-compatible provider - calling endpoint');
      const result = await evaluateWithOpenAICompatible(
        { trajectory, expectedOutcomes, expectedTrajectory, logs },
        resolvedModelId
      );
      return res.json(result);
    }

    // Default: bedrock
    const result = await evaluateTrajectory({
      trajectory,
      expectedOutcomes,
      expectedTrajectory,
      logs
    }, resolvedModelId);

    res.json(result);

  } catch (error: any) {
    console.error('[JudgeAPI] Error during evaluation:', error);

    const provider = (() => {
      try {
        const config = loadConfigSync();
        const { modelId } = req.body;
        const modelConfig = config.models[modelId] ||
          Object.values(config.models).find(m => m.model_id === modelId);
        return modelConfig?.provider || 'bedrock';
      } catch {
        return 'bedrock';
      }
    })();

    const errorMessage = provider === 'openai-compatible'
      ? parseOpenAICompatibleError(error)
      : parseBedrockError(error);

    res.status(500).json({
      error: `Judge evaluation failed: ${errorMessage}`,
      details: error.message
    });
  }
});

export default router;
