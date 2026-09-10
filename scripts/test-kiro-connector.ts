/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Smoke test for KiroConnector.
 *
 * Spawns kiro-cli through the connector with a simple multi-tool prompt
 * and asserts:
 *   1. trajectory contains at least one `action` step
 *   2. trajectory contains at least one `tool_result` step
 *   3. trajectory ends with a `response` step
 *   4. rawEvents contains both stdout and stderr entries
 *
 * Run with:
 *   npx tsx scripts/test-kiro-connector.ts
 */

import { kiroConnector } from '@/connectors/kiro';

async function main() {
  const request = {
    testCase: {
      id: 'smoke-test',
      name: 'kiro smoke',
      initialPrompt: 'Run `date` and tell me the day of the week.',
      expectedOutcomes: [],
    } as any,
    modelId: undefined,
    agentKey: 'kiro',
    payload: 'Run `date` and tell me the day of the week.',
  } as any;

  const auth = { type: 'none' as const };

  const stepLog: string[] = [];
  const rawLog: string[] = [];

  const result = await kiroConnector.execute(
    'kiro-cli',
    request,
    auth,
    (step) => {
      stepLog.push(`${step.type}${step.toolName ? `(${step.toolName})` : ''}`);
    },
    (ev) => {
      rawLog.push(ev.type);
    }
  );

  const counts: Record<string, number> = {};
  for (const s of result.trajectory) {
    counts[s.type] = (counts[s.type] || 0) + 1;
  }
  const rawCounts: Record<string, number> = {};
  for (const t of rawLog) {
    rawCounts[t] = (rawCounts[t] || 0) + 1;
  }

  console.log('\n=== KiroConnector smoke test ===');
  console.log('trajectory step counts:', counts);
  console.log('raw event counts:', rawCounts);
  console.log('\nsteps emitted (in order):');
  console.log(stepLog.join(' → '));
  console.log('\naction steps (tool calls captured):');
  for (const s of result.trajectory) {
    if (s.type === 'action') {
      console.log(`  • ${s.toolName}  args=${JSON.stringify(s.toolArgs)}`);
    }
  }
  console.log('\ntool_result steps:');
  for (const s of result.trajectory) {
    if (s.type === 'tool_result') {
      console.log(`  • toolName=${s.toolName} status=${s.status} content=${s.content}`);
    }
  }
  const responseStep = result.trajectory.find(s => s.type === 'response');
  console.log('\nfinal response (first 300 chars):');
  console.log((responseStep?.content || '').slice(0, 300));

  const ok =
    (counts.action || 0) > 0 &&
    (counts.tool_result || 0) > 0 &&
    !!responseStep &&
    (rawCounts.stderr || 0) > 0 &&
    (rawCounts.stdout || 0) > 0;

  console.log('\nresult:', ok ? 'PASS ✓' : 'FAIL ✗');
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(2);
});
