/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared test configuration for integration tests.
 * Reads AH_PORT to determine the backend URL.
 */

const DEFAULT_PORT = 4001;

export function getTestBackendUrl(): string {
  const port = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || String(DEFAULT_PORT);
  return `http://localhost:${port}`;
}

/**
 * Probe whether the backend can run a *real* (Bedrock) LLM judge.
 *
 * The CI `integration-tests` job runs against a real OpenSearch service but has
 * **no AWS credentials**, so any test that needs a real judge to reach a
 * `completed` / scored result (e.g. judgeModelId round-trips, benchmark runs
 * that actually score) must skip there rather than fail. This probes the judge
 * route with a Bedrock-backed model and a trivial trajectory:
 *   - returns `true`  when a real judge call succeeds (creds present, e.g. local
 *     `AWS_PROFILE=Bedrock`);
 *   - returns `false` when Bedrock is unreachable / credentials are missing
 *     (the route 4xx/5xx's, or the request throws).
 *
 * It deliberately uses a Bedrock provider model (not the mock `demo` provider)
 * so the signal reflects credential availability. Cost is one tiny judge call
 * when creds are present; in CI (no creds) the SDK credential chain fails fast
 * without invoking Bedrock.
 */
export async function checkJudgeAvailable(baseUrl: string = getTestBackendUrl()): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'claude-sonnet-4.6',
        trajectory: [{ type: 'assistant', content: 'ok' }],
        expectedOutcomes: ['ok'],
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
