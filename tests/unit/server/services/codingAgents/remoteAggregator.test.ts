/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RemoteServerConfig } from '@/lib/config/types';

// Mock the parent class so its constructor doesn't run real logic.
// We need to put getAllSessions and getSessionDetail on the prototype
// because RemoteAggregator uses super.method() which resolves via prototype chain.
const mockGetAllSessions = jest.fn().mockResolvedValue([]);
const mockGetSessionDetail = jest.fn().mockResolvedValue(null);

jest.mock('@/server/services/codingAgents/registry', () => {
  function MockCodingAgentRegistry(this: any) {
    // Constructor body - intentionally empty (no warmup/backgroundRefresh)
  }
  MockCodingAgentRegistry.prototype.getAllSessions = mockGetAllSessions;
  MockCodingAgentRegistry.prototype.getSessionDetail = mockGetSessionDetail;
  MockCodingAgentRegistry.prototype.getAvailableReaders = jest.fn().mockResolvedValue([]);
  MockCodingAgentRegistry.prototype.getReader = jest.fn();
  MockCodingAgentRegistry.prototype.stopBackgroundRefresh = jest.fn();

  return { CodingAgentRegistry: MockCodingAgentRegistry };
});

import { RemoteAggregator } from '@/server/services/codingAgents/remoteAggregator';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<any> = {}): any {
  return {
    session_id: 'test-1',
    agent: 'claude-code',
    start_time: '2024-01-15T10:00:00Z',
    estimated_cost: 0.5,
    input_tokens: 1000,
    output_tokens: 500,
    duration_minutes: 30,
    user_message_count: 5,
    assistant_message_count: 5,
    tool_counts: {},
    tool_error_counts: {},
    total_tool_errors: 0,
    session_completed: true,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    first_prompt: 'test prompt',
    uses_mcp: false,
    ...overrides,
  };
}

function makeRemoteServer(overrides: Partial<RemoteServerConfig> = {}): RemoteServerConfig {
  return {
    name: 'remote-1',
    url: 'http://remote-1:4001',
    apiKey: 'test-key',
    ...overrides,
  };
}

function mockFetchResponse(sessions: any[]): Partial<Response> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue({ sessions }),
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('RemoteAggregator', () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = mockFetch as any;
    mockGetAllSessions.mockResolvedValue([]);
    mockGetSessionDetail.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should store remote servers', () => {
      const servers = [makeRemoteServer({ name: 'server-a' }), makeRemoteServer({ name: 'server-b' })];
      const aggregator = new RemoteAggregator(servers);

      expect(aggregator.getRemoteServerNames()).toEqual(['server-a', 'server-b']);
    });
  });

  describe('getAllSessions', () => {
    it('should merge local and remote sessions', async () => {
      const localSession = makeSession({ session_id: 'local-1', start_time: '2024-01-15T12:00:00Z' });
      const remoteSession = makeSession({ session_id: 'remote-1', start_time: '2024-01-15T11:00:00Z' });

      mockGetAllSessions.mockResolvedValue([localSession]);
      mockFetch.mockResolvedValue(mockFetchResponse([remoteSession]));

      const aggregator = new RemoteAggregator([makeRemoteServer()]);
      const sessions = await aggregator.getAllSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s: any) => s.session_id)).toContain('local-1');
      expect(sessions.map((s: any) => s.session_id)).toContain('remote-1');
    });

    it('should tag local sessions with server_name "local"', async () => {
      const localSession = makeSession({ session_id: 'local-1' });
      mockGetAllSessions.mockResolvedValue([localSession]);

      const aggregator = new RemoteAggregator([]);
      const sessions = await aggregator.getAllSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].server_name).toBe('local');
    });

    it('should tag remote sessions with the remote server name', async () => {
      const remoteSession = makeSession({ session_id: 'remote-1' });
      mockFetch.mockResolvedValue(mockFetchResponse([remoteSession]));

      const aggregator = new RemoteAggregator([makeRemoteServer({ name: 'my-server' })]);
      const sessions = await aggregator.getAllSessions();

      const remote = sessions.find((s: any) => s.session_id === 'remote-1');
      expect(remote).toBeDefined();
      expect(remote!.server_name).toBe('my-server');
    });

    it('should return empty array for failed remote fetch without throwing', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const aggregator = new RemoteAggregator([makeRemoteServer()]);
      const sessions = await aggregator.getAllSessions();

      // Should not throw, just return local sessions (empty in this case)
      expect(sessions).toEqual([]);
    });

    it('should return stale cached data when remote fetch fails', async () => {
      const realDateNow = Date.now;
      let fakeNow = Date.now();
      Date.now = jest.fn(() => fakeNow);

      const remoteSession = makeSession({ session_id: 'cached-1' });
      mockFetch.mockResolvedValue(mockFetchResponse([remoteSession]));

      const aggregator = new RemoteAggregator([makeRemoteServer()]);

      // First call populates cache
      await aggregator.getAllSessions();

      // Advance time past TTL
      fakeNow += 31_000;

      // Second call fails - should use stale cache
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const sessions = await aggregator.getAllSessions();
      const remote = sessions.find((s: any) => s.session_id === 'cached-1');
      expect(remote).toBeDefined();
      expect(remote!.server_name).toBe('remote-1');

      Date.now = realDateNow;
    });

    it('should use cached data within 30s TTL without re-fetching', async () => {
      const remoteSession = makeSession({ session_id: 'cached-1' });
      mockFetch.mockResolvedValue(mockFetchResponse([remoteSession]));

      const aggregator = new RemoteAggregator([makeRemoteServer()]);

      // First call
      await aggregator.getAllSessions();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call within TTL - should use cache
      const sessions = await aggregator.getAllSessions();
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still only 1 fetch call
      expect(sessions.find((s: any) => s.session_id === 'cached-1')).toBeDefined();
    });

    it('should re-fetch after cache TTL expires', async () => {
      const realDateNow = Date.now;
      let fakeNow = Date.now();
      Date.now = jest.fn(() => fakeNow);

      const remoteSession = makeSession({ session_id: 'cached-1' });
      mockFetch.mockResolvedValue(mockFetchResponse([remoteSession]));

      const aggregator = new RemoteAggregator([makeRemoteServer()]);

      // First call
      await aggregator.getAllSessions();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past TTL
      fakeNow += 31_000;

      const updatedSession = makeSession({ session_id: 'updated-1' });
      mockFetch.mockResolvedValue(mockFetchResponse([updatedSession]));

      // Second call after TTL - should re-fetch
      await aggregator.getAllSessions();
      expect(mockFetch).toHaveBeenCalledTimes(2);

      Date.now = realDateNow;
    });

    it('should sort merged sessions by start_time descending', async () => {
      const localSession = makeSession({ session_id: 'local-1', start_time: '2024-01-15T08:00:00Z' });
      const remoteSession = makeSession({ session_id: 'remote-1', start_time: '2024-01-15T12:00:00Z' });

      mockGetAllSessions.mockResolvedValue([localSession]);
      mockFetch.mockResolvedValue(mockFetchResponse([remoteSession]));

      const aggregator = new RemoteAggregator([makeRemoteServer()]);
      const sessions = await aggregator.getAllSessions();

      expect(sessions[0].session_id).toBe('remote-1'); // 12:00 is later
      expect(sessions[1].session_id).toBe('local-1');
    });
  });

  describe('getSessionDetail', () => {
    it('should route to remote server when serverName is provided', async () => {
      const detail = { session: makeSession(), messages: [] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(detail),
      });

      const server = makeRemoteServer({ name: 'prod-server' });
      const aggregator = new RemoteAggregator([server]);
      const result = await aggregator.getSessionDetail('claude-code', 'session-1', 'prod-server');

      expect(result).toEqual(detail);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/coding-agents/sessions/claude-code/session-1'),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key' }) }),
      );
    });

    it('should fall back to local when serverName is "local"', async () => {
      const detail = { session: makeSession(), messages: [] };
      mockGetSessionDetail.mockResolvedValue(detail);

      const aggregator = new RemoteAggregator([makeRemoteServer()]);
      const result = await aggregator.getSessionDetail('claude-code', 'session-1', 'local');

      expect(result).toEqual(detail);
      expect(mockGetSessionDetail).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return null for unknown server name', async () => {
      const aggregator = new RemoteAggregator([makeRemoteServer({ name: 'known-server' })]);
      const result = await aggregator.getSessionDetail('claude-code', 'session-1', 'unknown-server');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getRemoteServerNames', () => {
    it('should return configured server names', () => {
      const servers = [
        makeRemoteServer({ name: 'alpha' }),
        makeRemoteServer({ name: 'beta' }),
        makeRemoteServer({ name: 'gamma' }),
      ];
      const aggregator = new RemoteAggregator(servers);

      expect(aggregator.getRemoteServerNames()).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('should return empty array when no remote servers configured', () => {
      const aggregator = new RemoteAggregator([]);
      expect(aggregator.getRemoteServerNames()).toEqual([]);
    });
  });
});
