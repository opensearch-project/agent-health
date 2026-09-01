/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PiConnector } from './index';

const request = {
  testCase: {
    name: 'pi case',
    initialPrompt: 'inspect this',
    context: [{ description: 'repo', value: '/workspace' }],
  },
  modelId: 'model',
} as any;

describe('PiConnector', () => {
  it('keeps the pi protocol name and builds the legacy context prompt', () => {
    const connector = new PiConnector();
    expect(connector.type).toBe('pi');
    expect(connector.buildPayload(request)).toContain('**repo:**\n/workspace');
    expect(connector.buildPayload(request)).toContain('## Task\ninspect this');
  });

  it('parses settled text output as the final response', () => {
    const connector = new PiConnector();
    expect(connector.parseResponse({ stdout: 'done\n', stderr: '', exitCode: 0 }))
      .toEqual([expect.objectContaining({ type: 'response', content: 'done' })]);
  });
});
