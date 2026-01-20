/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side API for benchmark execution
 *
 * Handles SSE streaming from the server-side benchmark runner
 * with proper chunk buffering for incomplete events.
 */

import { BenchmarkRun, BenchmarkProgress, BenchmarkStartedEvent, RunConfigInput } from '@/types';

/**
 * Execute a benchmark run via the server-side API with SSE streaming.
 *
 * The server executes the benchmark in the background and streams progress
 * events. Even if the client disconnects, the server continues execution.
 *
 * @param benchmarkId - The benchmark ID to run
 * @param runConfig - Configuration for the run (agent, model, etc.)
 * @param onProgress - Callback for progress updates
 * @param onStarted - Optional callback when run starts with test case list
 * @returns The completed BenchmarkRun
 */
export async function executeBenchmarkRun(
  benchmarkId: string,
  runConfig: RunConfigInput,
  onProgress: (progress: BenchmarkProgress) => void,
  onStarted?: (event: BenchmarkStartedEvent) => void
): Promise<BenchmarkRun> {
  const response = await fetch(`/api/storage/benchmarks/${benchmarkId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(runConfig),
  });

  if (!response.ok) {
    throw new Error(`Failed to start benchmark run: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let completedRun: BenchmarkRun | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Append new chunk to buffer
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const events = buffer.split('\n\n');

    // Keep the last potentially incomplete event in the buffer
    buffer = events.pop() || '';

    // Process complete events
    for (const event of events) {
      const lines = event.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'started') {
              onStarted?.({ runId: data.runId, testCases: data.testCases || [] });
            } else if (data.type === 'progress') {
              onProgress(data as BenchmarkProgress);
            } else if (data.type === 'completed') {
              completedRun = data.run;
            } else if (data.type === 'error') {
              throw new Error(data.error);
            }
          } catch (e) {
            // Rethrow application errors, ignore JSON parse errors for incomplete chunks
            if (e instanceof Error && !(e instanceof SyntaxError)) {
              throw e;
            }
            // SyntaxError from JSON.parse on incomplete chunks is expected - ignore
          }
        }
      }
    }
  }

  // Process any remaining buffer content
  if (buffer.trim()) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'completed') {
            completedRun = data.run;
          } else if (data.type === 'error') {
            throw new Error(data.error);
          }
        } catch (e) {
          // Rethrow application errors, ignore JSON parse errors for final chunk
          if (e instanceof Error && !(e instanceof SyntaxError)) {
            throw e;
          }
        }
      }
    }
  }

  if (!completedRun) {
    throw new Error('Run completed without returning result');
  }

  return completedRun;
}

/**
 * Cancel an in-progress benchmark run.
 *
 * @param benchmarkId - The benchmark ID
 * @param runId - The run ID to cancel
 * @returns Whether the cancellation was successful
 */
export async function cancelBenchmarkRun(
  benchmarkId: string,
  runId: string
): Promise<boolean> {
  const response = await fetch(`/api/storage/benchmarks/${benchmarkId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to cancel run');
  }

  const result = await response.json();
  return result.cancelled === true;
}

// Backwards compatibility aliases
/** @deprecated Use executeBenchmarkRun instead */
export const executeExperimentRun = executeBenchmarkRun;
/** @deprecated Use cancelBenchmarkRun instead */
export const cancelExperimentRun = cancelBenchmarkRun;
