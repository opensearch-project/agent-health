/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AGUIStreamingConnector } from '@/services/connectors/agui/AGUIStreamingConnector';
import { ClaudeCodeConnector } from '@/services/connectors/claude-code/ClaudeCodeConnector';
import { KiroConnector } from '@/services/connectors/kiro/KiroConnector';
import { LangGraphConnector } from '@/services/connectors/langgraph/LangGraphConnector';
import { MockConnector } from '@/services/connectors/mock/MockConnector';
import { OpenAICompatibleConnector } from '@/services/connectors/openai-compatible/OpenAICompatibleConnector';
import { PiConnector } from '@/services/connectors/pi/PiConnector';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import { StrandsConnector } from '@/services/connectors/strands/StrandsConnector';
import { SubprocessConnector } from '@/services/connectors/subprocess/SubprocessConnector';
import type { ConnectorRequest } from '@/services/connectors/types';
import type { TestCase } from '@/types';

describe('fixture delivery contract', () => {
  it.each([
    ['AG-UI', new AGUIStreamingConnector()],
    ['Claude Code', new ClaudeCodeConnector()],
    ['Kiro', new KiroConnector()],
    ['LangGraph', new LangGraphConnector()],
    ['mock', new MockConnector()],
    ['OpenAI-compatible', new OpenAICompatibleConnector()],
    ['pi', new PiConnector()],
    ['REST', new RESTConnector()],
    ['Strands', new StrandsConnector()],
    ['subprocess', new SubprocessConnector({ command: 'agent' })],
  ])('%s payload contains normal agent input but no fixture data', (_name, connector) => {
    const fixture = {
      type: 'filesystem-workspace-delivery-sentinel',
      ref: 'fixture-ref-delivery-sentinel',
      integrity: 'sha256:integrityDeliverySentinel',
      payload: { manifest: 'payload-delivery-sentinel' },
    };
    const testCase = {
      id: 'tc-fixture-delivery',
      name: 'Fixture delivery regression',
      initialPrompt: 'prompt-delivery-sentinel',
      context: [{ description: 'context', value: 'context-delivery-sentinel' }],
      fixture,
      tools: [],
    } as unknown as TestCase;
    const request: ConnectorRequest = { testCase, modelId: 'test-model' };

    const delivered = JSON.stringify(connector.buildPayload(request));

    expect(delivered).toContain('prompt-delivery-sentinel');
    expect(delivered).not.toContain(fixture.type);
    expect(delivered).not.toContain(fixture.ref);
    expect(delivered).not.toContain(fixture.integrity);
    expect(delivered).not.toContain(fixture.payload.manifest);
  });
});
