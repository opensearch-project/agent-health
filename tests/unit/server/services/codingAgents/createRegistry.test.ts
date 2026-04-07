/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

describe('createRegistry', () => {
  const originalEnv = process.env;

  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AGENT_HEALTH_DISABLE_CODING_ANALYTICS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setupMocks(remotes: Array<{ name: string; url: string }> = []) {
    jest.doMock('@/server/services/codingAgents/registry');
    jest.doMock('@/server/services/codingAgents/remoteAggregator');
    jest.doMock('@/server/services/codingAgents/remoteConfig', () => ({
      getRemoteServers: jest.fn().mockReturnValue(remotes),
    }));
  }

  it('should create CodingAgentRegistry when feature is enabled and no remotes', () => {
    setupMocks([]);

    const { CodingAgentRegistry } = require('@/server/services/codingAgents/registry');
    const { RemoteAggregator } = require('@/server/services/codingAgents/remoteAggregator');
    const mod = require('@/server/services/codingAgents/createRegistry');

    expect(mod.codingAnalyticsEnabled).toBe(true);
    expect(CodingAgentRegistry).toHaveBeenCalledTimes(1);
    expect(RemoteAggregator).not.toHaveBeenCalled();
    expect(mod.codingAgentRegistry).toBeInstanceOf(CodingAgentRegistry);
  });

  it('should create RemoteAggregator when feature is enabled with remotes', () => {
    const remotes = [
      { name: 'server-1', url: 'http://localhost:4002' },
      { name: 'server-2', url: 'http://localhost:4003' },
    ];
    setupMocks(remotes);

    const { CodingAgentRegistry } = require('@/server/services/codingAgents/registry');
    const { RemoteAggregator } = require('@/server/services/codingAgents/remoteAggregator');
    const mod = require('@/server/services/codingAgents/createRegistry');

    expect(mod.codingAnalyticsEnabled).toBe(true);
    expect(RemoteAggregator).toHaveBeenCalledWith(remotes);
    expect(CodingAgentRegistry).not.toHaveBeenCalled();
    expect(mod.codingAgentRegistry).toBeInstanceOf(RemoteAggregator);
  });

  it('should return null when feature is disabled via env var', () => {
    process.env.AGENT_HEALTH_DISABLE_CODING_ANALYTICS = 'true';
    setupMocks([]);

    const { CodingAgentRegistry } = require('@/server/services/codingAgents/registry');
    const { RemoteAggregator } = require('@/server/services/codingAgents/remoteAggregator');
    const mod = require('@/server/services/codingAgents/createRegistry');

    expect(mod.codingAnalyticsEnabled).toBe(false);
    expect(mod.codingAgentRegistry).toBeNull();
    expect(CodingAgentRegistry).not.toHaveBeenCalled();
    expect(RemoteAggregator).not.toHaveBeenCalled();
  });

  it('should return null when feature is disabled via config file', () => {
    const fs = require('fs');
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ codingAgentAnalytics: false })
    );

    setupMocks([]);

    const mod = require('@/server/services/codingAgents/createRegistry');

    expect(mod.codingAnalyticsEnabled).toBe(false);
    expect(mod.codingAgentRegistry).toBeNull();

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should log when remote aggregation is enabled', () => {
    const remotes = [{ name: 'build-server', url: 'http://10.0.1.50:4001' }];
    setupMocks(remotes);

    require('@/server/services/codingAgents/createRegistry');

    expect(console.log).toHaveBeenCalledWith(
      '[CodingAgents] Remote aggregation enabled: build-server'
    );
  });

  it('should log when feature is disabled', () => {
    process.env.AGENT_HEALTH_DISABLE_CODING_ANALYTICS = 'true';
    setupMocks([]);

    require('@/server/services/codingAgents/createRegistry');

    expect(console.log).toHaveBeenCalledWith(
      '[CodingAgents] Feature disabled via toggle'
    );
  });
});
