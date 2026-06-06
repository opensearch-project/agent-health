/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Improver
 * Analyzes failed assertions and proposes SKILL.md improvements
 * by calling Bedrock directly with the failure evidence.
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Skill, SkillGradingResult, SkillBenchmarkResult } from '@/types';
import { debug } from '@/lib/debug';
import { DEFAULT_SKILL_MODEL_ID } from './constants';

export interface ImprovementProposal {
  originalInstructions: string;
  improvedInstructions: string;
  reasoning: string;
  changesDescription: string;
}

interface ImproveOptions {
  skill: Skill;
  withSkillGradings: SkillGradingResult[];
  withoutSkillGradings: SkillGradingResult[];
  benchmark: SkillBenchmarkResult;
  serverBaseUrl: string;
  modelId?: string;
}

/**
 * Analyze eval results and propose an improved SKILL.md body.
 */
export async function proposeImprovement(options: ImproveOptions): Promise<ImprovementProposal> {
  const { skill, withSkillGradings, withoutSkillGradings, benchmark, modelId } = options;

  // Collect failed assertions with evidence
  const failures = withSkillGradings.flatMap(g =>
    g.assertion_results
      .filter(a => !a.passed)
      .map(a => ({ assertion: a.text, evidence: a.evidence }))
  );

  // Collect assertions that pass without skill (baseline strengths)
  const baselineSuccesses = withoutSkillGradings.flatMap(g =>
    g.assertion_results
      .filter(a => a.passed)
      .map(a => a.text)
  );

  const prompt = buildImprovementPrompt(skill, failures, baselineSuccesses, benchmark);
  const effectiveModelId = modelId || DEFAULT_SKILL_MODEL_ID;

  debug('SkillImprover', `Requesting improvement. Failures: ${failures.length}`);

  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-west-2',
  });

  const command = new ConverseCommand({
    modelId: effectiveModelId,
    messages: [
      { role: 'user', content: [{ text: prompt }] },
    ],
    system: [{ text: 'You are a skill optimization expert. Analyze evaluation failures and produce improved skill instructions that are lean, generalizable, and reasoning-based. Always output between the specified markers.' }],
    inferenceConfig: { maxTokens: 8192, temperature: 0.3 },
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

  const improved = extractImprovedInstructions(responseText, skill.instructions);

  return {
    originalInstructions: skill.instructions,
    improvedInstructions: improved.instructions,
    reasoning: improved.reasoning,
    changesDescription: improved.summary,
  };
}

function buildImprovementPrompt(
  skill: Skill,
  failures: { assertion: string; evidence: string }[],
  baselineSuccesses: string[],
  benchmark: SkillBenchmarkResult,
): string {
  const parts: string[] = [];

  parts.push(`# Skill Improvement Request`);
  parts.push('');
  parts.push(`## Current SKILL.md`);
  parts.push(`Name: ${skill.metadata.name}`);
  parts.push(`Description: ${skill.metadata.description}`);
  parts.push('');
  parts.push('### Instructions:');
  parts.push(skill.instructions);
  parts.push('');

  parts.push(`## Evaluation Results`);
  parts.push(`- With skill pass rate: ${Math.round(benchmark.run_summary.with_skill.pass_rate.mean * 100)}%`);
  parts.push(`- Without skill pass rate: ${Math.round(benchmark.run_summary.without_skill.pass_rate.mean * 100)}%`);
  parts.push(`- Delta: ${benchmark.run_summary.delta.pass_rate >= 0 ? '+' : ''}${Math.round(benchmark.run_summary.delta.pass_rate * 100)}%`);
  parts.push('');

  if (failures.length > 0) {
    parts.push(`## Failed Assertions (${failures.length})`);
    for (const f of failures) {
      parts.push(`### Assertion: "${f.assertion}"`);
      parts.push(`Evidence: ${f.evidence.substring(0, 500)}`);
      parts.push('');
    }
  }

  if (baselineSuccesses.length > 0) {
    parts.push(`## Assertions that pass WITHOUT the skill`);
    parts.push('These already work without help — focus improvement on the failures above.');
    for (const s of baselineSuccesses) {
      parts.push(`- ${s}`);
    }
    parts.push('');
  }

  parts.push(`## Your Task`);
  parts.push('');
  parts.push('Provide an improved version of the skill instructions that:');
  parts.push('1. Fixes the failed assertions by adding specific guidance');
  parts.push('2. Keeps instructions lean — fewer, better instructions outperform exhaustive rules');
  parts.push('3. Generalizes from test cases — the skill serves many prompts, not just these');
  parts.push('4. Explains WHY (reasoning-based instructions work better than rigid directives)');
  parts.push('');
  parts.push('Format your response as:');
  parts.push('CHANGES: <one-line summary of what changed>');
  parts.push('REASONING: <why these changes will help>');
  parts.push('IMPROVED_INSTRUCTIONS_START');
  parts.push('<the full improved instructions markdown>');
  parts.push('IMPROVED_INSTRUCTIONS_END');

  return parts.join('\n');
}

function extractImprovedInstructions(
  reasoning: string,
  originalInstructions: string,
): { instructions: string; reasoning: string; summary: string } {
  const startMarker = 'IMPROVED_INSTRUCTIONS_START';
  const endMarker = 'IMPROVED_INSTRUCTIONS_END';

  const startIdx = reasoning.indexOf(startMarker);
  const endIdx = reasoning.indexOf(endMarker);

  let instructions = originalInstructions;
  let summary = 'No changes proposed';
  let reasoningText = reasoning;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    instructions = reasoning.slice(startIdx + startMarker.length, endIdx).trim();
    summary = extractField(reasoning, 'CHANGES:') || 'Skill instructions updated';
    reasoningText = extractField(reasoning, 'REASONING:') || reasoning.substring(0, 500);
  }

  return { instructions, reasoning: reasoningText, summary };
}

function extractField(text: string, prefix: string): string | null {
  const idx = text.indexOf(prefix);
  if (idx === -1) return null;
  const afterPrefix = text.slice(idx + prefix.length);
  const endOfLine = afterPrefix.indexOf('\n');
  return endOfLine !== -1 ? afterPrefix.slice(0, endOfLine).trim() : afterPrefix.trim();
}
