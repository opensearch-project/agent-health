/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side API for skill evaluation and improvement.
 * Handles SSE streaming from /api/skills/eval.
 */

import type { SkillValidationResult, SkillEvalProgressEvent, SkillBenchmarkResult } from '@/types';

export interface DiscoveredSkill {
  path: string;
  name: string;
  description: string;
  source: string;
}

export async function discoverSkills(): Promise<DiscoveredSkill[]> {
  const response = await fetch('/api/skills/discover');
  if (!response.ok) {
    throw new Error(`Discovery failed: ${response.statusText}`);
  }
  const data = await response.json();
  return data.skills;
}

export async function browseForSkillFolder(): Promise<{ cancelled: boolean; path: string | null }> {
  const response = await fetch('/api/skills/browse', { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Browse failed: ${response.statusText}`);
  }
  return response.json();
}

export async function uploadSkillFile(content: string, fileName?: string, evalsContent?: string): Promise<{ path: string; skillName: string }> {
  const response = await fetch('/api/skills/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, fileName, evalsContent }),
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }
  return response.json();
}

export async function validateSkill(path: string): Promise<SkillValidationResult> {
  const response = await fetch('/api/skills/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    throw new Error(`Validation failed: ${response.statusText}`);
  }

  return response.json();
}

export interface SkillEvalOptions {
  path: string;
  agentKey?: string;
  modelId?: string;
  auto?: boolean;
}

export interface SkillEvalResult {
  benchmark: SkillBenchmarkResult;
  improvement?: {
    applied: boolean;
    changes: string;
    reasoning: string;
    improvedInstructions?: string;
  };
}

export async function streamSkillEval(
  options: SkillEvalOptions,
  onEvent: (event: SkillEvalProgressEvent) => void,
): Promise<SkillEvalResult> {
  const response = await fetch('/api/skills/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Evaluation failed: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let benchmark: SkillBenchmarkResult | null = null;
  let improvement: SkillEvalResult['improvement'] = undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const eventBlock of events) {
      const lines = eventBlock.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6)) as SkillEvalProgressEvent;
          onEvent(data);

          if (data.type === 'completed') {
            benchmark = data.benchmark;
          } else if (data.type === 'improved') {
            improvement = {
              applied: data.applied,
              changes: data.changes,
              reasoning: data.reasoning,
              improvedInstructions: data.improvedInstructions,
            };
          } else if (data.type === 'error') {
            throw new Error(data.message);
          }
        } catch (e) {
          if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6)) as SkillEvalProgressEvent;
        if (data.type === 'completed') benchmark = data.benchmark;
        else if (data.type === 'improved') {
          improvement = { applied: data.applied, changes: data.changes, reasoning: data.reasoning, improvedInstructions: data.improvedInstructions };
        }
      } catch { /* ignore */ }
    }
  }

  if (!benchmark) {
    throw new Error('Evaluation completed without benchmark results');
  }

  return { benchmark, improvement };
}

export interface SkillResultsResponse {
  iterations: SkillBenchmarkResult[];
  /** Improvement proposals keyed by iteration number (sparse — only present for iterations that had failures). */
  proposals?: Record<number, {
    applied: boolean;
    changes: string;
    reasoning: string;
    improvedInstructions?: string;
  }>;
}

export async function getSkillResults(workspace: string): Promise<SkillResultsResponse> {
  const response = await fetch(`/api/skills/results?workspace=${encodeURIComponent(workspace)}`);
  if (!response.ok) {
    throw new Error(`Failed to load results: ${response.statusText}`);
  }
  return response.json();
}
