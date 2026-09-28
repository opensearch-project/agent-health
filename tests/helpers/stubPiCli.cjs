#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stub for the `pi` CLI used by judge tests. Behaviour is selected by the
 * STUB_PI_MODE env var so one script covers every failure shape the judge
 * has to tell apart:
 *
 *   empty     — exit 0, print nothing (CLI ran but emitted no verdict)
 *   crash     — write a stack + a fake credential to stderr, exit 2
 *   overflow  — write a provider "Input is too long" error to stderr, exit 1
 *   preamble  — NDJSON: a prose assistant turn, then the JSON verdict in a
 *               fenced block (the normal happy path with chatter)
 *   echo      — verdict whose `reasoning` reports the stdin prompt length and
 *               whether it contained the truncation marker (budget tests)
 *   hang      — never exit (timeout tests; killed by the caller)
 *
 * Always drains stdin first (the judge writes the prompt there).
 */

const mode = process.env.STUB_PI_MODE || 'preamble';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const verdict = (extra) =>
    JSON.stringify({
      pass_fail_status: 'passed',
      accuracy: 88,
      reasoning: extra || 'stub verdict',
      metrics: { faithfulness: 80, latency_score: 90, trajectory_alignment_score: 85 },
      improvement_strategies: [],
    });
  const ndjson = (text) =>
    [
      JSON.stringify({ type: 'session', id: 'stub' }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n') + '\n';

  switch (mode) {
    case 'empty':
      process.exit(0);
      break;
    case 'crash':
      process.stderr.write(
        'Error: something exploded while judging\n    at judge (/stub/pi.js:1:1)\n' +
          'debug: using AKIAABCDEFGHIJKLMNOP aws_secret_access_key=s3cr3t/value+here\n'
      );
      process.exit(2);
      break;
    case 'overflow':
      process.stderr.write('ValidationException: Input is too long for requested model.\n');
      process.exit(1);
      break;
    case 'echo':
      process.stdout.write(
        ndjson(
          `promptChars=${prompt.length} marker=${prompt.includes("to fit the judge's context budget")}\n` +
            '```json\n' + verdict(`promptChars=${prompt.length} marker=${prompt.includes("to fit the judge's context budget")}`) + '\n```'
        )
      );
      process.exit(0);
      break;
    case 'hang':
      setInterval(() => {}, 1000);
      break;
    case 'preamble':
    default:
      process.stdout.write(
        ndjson('Based on my analysis of the trajectory, here is my evaluation:\n\n```json\n' + verdict() + '\n```')
      );
      process.exit(0);
  }
});
