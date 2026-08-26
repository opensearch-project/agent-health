/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eval Generator
 * Auto-generates evals/evals.json from a SKILL.md when none exists.
 * Calls Bedrock directly (not the judge route, which wraps in evaluation framing).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Skill, SkillEvalsFile } from '@/types';
import { debug } from '@/lib/debug';
import { DEFAULT_SKILL_MODEL_ID } from './constants';
import { buildInferenceConfig, resolveRegionAwareModelId } from '@/lib/bedrockCompat';

/**
 * Generate eval cases by calling Bedrock with the skill's instructions.
 */
export async function generateEvals(
  skill: Skill,
  _serverBaseUrl: string,
  modelId?: string,
): Promise<SkillEvalsFile> {
  debug('EvalGenerator', `Generating evals for skill: ${skill.metadata.name}`);

  const prompt = buildGenerationPrompt(skill);
  const effectiveModelId = resolveRegionAwareModelId(modelId || DEFAULT_SKILL_MODEL_ID);

  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-west-2',
  });

  const command = new ConverseCommand({
    modelId: effectiveModelId,
    messages: [
      { role: 'user', content: [{ text: prompt }] },
    ],
    system: [{ text: 'You are a test case generator for AI agent skills. Generate realistic, discriminating test cases that help identify whether a skill actually improves agent performance. Output valid JSON only within the specified markers.' }],
    inferenceConfig: buildInferenceConfig(effectiveModelId, { maxTokens: 4096, temperature: 0.7 }),
  });

  const response = await client.send(command);

  let responseText = '';
  if (response.output?.message?.content) {
    for (const content of response.output.message.content) {
      if ('text' in content && content.text) {
        responseText += content.text;
      }
    }
  }

  if (!responseText) {
    throw new Error('Empty response from Bedrock');
  }

  debug('EvalGenerator', `Got response (${responseText.length} chars)`);
  const evalsFile = parseGeneratedEvals(responseText, skill.metadata.name);

  // Write to skill directory
  const evalsDir = join(skill.path, 'evals');
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(join(evalsDir, 'evals.json'), JSON.stringify(evalsFile, null, 2));

  debug('EvalGenerator', `Generated ${evalsFile.evals.length} eval cases`);
  return evalsFile;
}

function buildGenerationPrompt(skill: Skill): string {
  return `# Generate Eval Test Cases

You are generating evaluation test cases for an AI agent skill.

## Skill
Name: ${skill.metadata.name}
Description: ${skill.metadata.description}

## Instructions the skill provides:
${skill.instructions}

## Your Task

Generate exactly 3 realistic test cases that would test whether this skill improves agent performance. Each test case should:
1. Use a realistic user prompt (the kind of thing someone would actually type)
2. Vary in complexity (one simple, one moderate, one edge case)
3. Have 2-3 specific, verifiable assertions that are HARD to pass without the skill's knowledge
4. Focus on information that the skill uniquely provides (file paths, resolution orders, config structure)

The assertions should be discriminating — an agent WITHOUT this skill should fail at least some of them, while an agent WITH the skill should pass all.

Format your response as valid JSON between these markers:
EVALS_JSON_START
{
  "skill_name": "${skill.metadata.name}",
  "evals": [
    {
      "id": 1,
      "prompt": "realistic user message",
      "expected_output": "description of what success looks like",
      "assertions": [
        "specific verifiable assertion 1",
        "specific verifiable assertion 2"
      ]
    }
  ]
}
EVALS_JSON_END`;
}

function parseGeneratedEvals(reasoning: string, skillName: string): SkillEvalsFile {
  const startMarker = 'EVALS_JSON_START';
  const endMarker = 'EVALS_JSON_END';

  const startIdx = reasoning.indexOf(startMarker);
  const endIdx = reasoning.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const jsonStr = reasoning.slice(startIdx + startMarker.length, endIdx).trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.evals && Array.isArray(parsed.evals)) {
        return {
          skill_name: parsed.skill_name || skillName,
          evals: parsed.evals.map((e: any, idx: number) => ({
            id: e.id ?? idx + 1,
            prompt: e.prompt || '',
            expected_output: e.expected_output || '',
            assertions: Array.isArray(e.assertions) ? e.assertions : [],
          })),
        };
      }
    } catch {
      debug('EvalGenerator', 'Failed to parse JSON inside markers, trying loose extraction');
    }
  }

  // Fallback: try to extract any JSON block from the response.
  const jsonMatch = reasoning.match(/\{[\s\S]*"evals"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        skill_name: parsed.skill_name || skillName,
        evals: parsed.evals.map((e: any, idx: number) => ({
          id: e.id ?? idx + 1,
          prompt: e.prompt || '',
          expected_output: e.expected_output || '',
          assertions: Array.isArray(e.assertions) ? e.assertions : [],
        })),
      };
    } catch {
      // fall through
    }
  }

  // No silent "minimal eval" fallback — that mode hides authoring problems
  // (the user thinks they ran a real evaluation against a generic prompt).
  // Throw with an actionable message: the user can either retry, or hand-author
  // an evals/evals.json (the format they need is right above this function).
  throw new Error(
    `Eval auto-generation for "${skillName}" failed: model response did not contain a parseable JSON eval set ` +
    `between EVALS_JSON_START / EVALS_JSON_END markers. ` +
    `Retry the evaluation, or hand-author evals/evals.json with shape ` +
    `{"skill_name": "${skillName}", "evals": [{"id": 1, "prompt": "...", "assertions": ["..."]}]}.`,
  );
}
