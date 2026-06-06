/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for extractFromNdjson — pi `--mode json` emits one JSON event
 * per line (NDJSON), so the verdict must be recovered from the stream rather
 * than via a single JSON.parse(stdout). The verdict lives either in an
 * explicit `result` event or in the last assistant message's text content.
 */

import { extractFromNdjson } from '@/server/services/piJudgeService';

describe('extractFromNdjson', () => {
  it('returns the explicit result event when present', () => {
    const stdout = [
      JSON.stringify({ type: 'session', id: 'x' }),
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'result', result: '{"pass_fail_status":"passed"}' }),
    ].join('\n');
    expect(extractFromNdjson(stdout)).toBe('{"pass_fail_status":"passed"}');
  });

  it('falls back to the last assistant message text content', () => {
    const stdout = [
      JSON.stringify({ type: 'session', id: 'x' }),
      // a tool-using assistant turn (no text) must NOT be picked
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'query_spans' }] } }),
      // intermediate assistant text
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] } }),
      // final assistant verdict text — this is what we want
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Verified.\n{"pass_fail_status":"passed","accuracy":85}' }] } }),
    ].join('\n');
    expect(extractFromNdjson(stdout)).toBe('Verified.\n{"pass_fail_status":"passed","accuracy":85}');
  });

  it('prefers a result event over assistant text', () => {
    const stdout = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'assistant text' }] } }),
      JSON.stringify({ type: 'result', result: 'RESULT' }),
    ].join('\n');
    expect(extractFromNdjson(stdout)).toBe('RESULT');
  });

  it('ignores blank lines and unparseable lines', () => {
    const stdout = [
      '',
      'not json at all',
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      '   ',
    ].join('\n');
    expect(extractFromNdjson(stdout)).toBe('ok');
  });

  it('returns undefined when no result or assistant text is found', () => {
    const stdout = [
      JSON.stringify({ type: 'session' }),
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } }),
    ].join('\n');
    expect(extractFromNdjson(stdout)).toBeUndefined();
  });
});
