/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { connectorRegistry } from './server';
import { serverConnectorFactories } from './server';

const legacyProtocolNames = [
  'agui-streaming',
  'rest',
  'openai-compatible',
  'subprocess',
  'claude-code',
  'kiro',
  'pi',
  'strands',
  'langgraph',
  'mock',
] as const;

describe('well-known connector registry compatibility', () => {
  it.each(legacyProtocolNames)('still resolves the existing %s config string', protocol => {
    expect(serverConnectorFactories[protocol]().type).toBe(protocol);
    expect(connectorRegistry.get(protocol)?.type).toBe(protocol);
  });

  it('registers pi-web as an isolated well-known server connector', () => {
    expect(serverConnectorFactories['pi-web']().type).toBe('pi-web');
    expect(connectorRegistry.get('pi-web')?.type).toBe('pi-web');
  });

  it('keeps omitted connectorType and mock:// endpoint compatibility', () => {
    expect(connectorRegistry.getForAgent({
      key: 'legacy', name: 'legacy', endpoint: 'http://agent', models: [],
    }).type).toBe('agui-streaming');
    expect(connectorRegistry.getForAgent({
      key: 'demo', name: 'demo', endpoint: 'mock://demo', models: [],
    }).type).toBe('mock');
  });
});
