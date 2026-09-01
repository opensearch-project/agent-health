/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiWebConnector } from './index';

const testCase = {
  id: 'tc-1',
  name: 'pi-web case',
  initialPrompt: 'finish the task',
  context: [],
} as any;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PiWebConnector', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds prompts from prompt-disposition context only', () => {
    const connector = new PiWebConnector();
    const payload = connector.buildPayload({
      testCase: {
        ...testCase,
        context: [
          { description: 'visible', value: 'yes', disposition: 'prompt' },
          { description: 'fixture', value: 'legacy', disposition: 'connector' },
          { description: 'notes', value: 'hidden', disposition: 'documentation' },
        ],
      },
      modelId: 'model',
    });
    expect(payload.message).toContain('### visible\nyes');
    expect(payload.message).not.toContain('legacy');
    expect(payload.message).not.toContain('hidden');
  });

  it('waits for recursive settlement before harvesting and keeps numeric timestamps', async () => {
    const calls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      calls.push(`${init?.method || 'GET'} ${path}`);
      if (path === '/api/new-chat') return jsonResponse({ sessionId: 'session-1' });
      if (path === '/api/sessions/session-1/status') {
        return jsonResponse({
          sessionId: 'session-1',
          state: 'idle',
          settled: true,
          pendingWakeups: 0,
          trackedWorkers: [{ id: 'worker-1', state: 'idle', settled: true }],
        });
      }
      if (path === '/api/messages') {
        return jsonResponse({
          messages: [{ role: 'assistant', text: 'complete', timestamp: '1712345678901' }],
        });
      }
      return jsonResponse({ ok: true });
    });

    const result = await new PiWebConnector().execute(
      'http://pi-web.example',
      {
        testCase,
        modelId: 'model',
        connectorConfig: { timeoutMs: 100, pollIntervalMs: 1, settleMs: 0 },
      },
      { type: 'bearer', token: 'secret' },
    );

    expect(calls.indexOf('GET /api/sessions/session-1/status'))
      .toBeLessThan(calls.indexOf('GET /api/messages'));
    expect(result.trajectory).toEqual([
      expect.objectContaining({ type: 'response', content: 'complete', timestamp: 1712345678901 }),
    ]);
    expect(result.metadata).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      childSessions: ['worker-1'],
      timedOut: false,
    }));
  });

  it('rejects an envelope whose filesystem fixture fails integrity verification', async () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), 'agent-health-pi-web-fixtures-'));
    mkdirSync(join(fixturesDir, 'workspace'));
    writeFileSync(join(fixturesDir, 'workspace', 'file.txt'), 'actual');

    await expect(new PiWebConnector().execute(
      'http://pi-web.example',
      {
        testCase: {
          ...testCase,
          fixture: {
            type: 'filesystem-workspace',
            ref: 'workspace',
            integrity: `sha256:${'0'.repeat(64)}`,
          },
        },
        modelId: 'model',
        connectorConfig: { fixturesDir },
      },
      { type: 'none' },
    )).rejects.toThrow('Fixture integrity mismatch');
  });
});
