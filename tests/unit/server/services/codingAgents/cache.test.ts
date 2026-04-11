/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentSession } from '@/server/services/codingAgents/types';

// Mock fs/promises before importing the module under test
const mockStat = jest.fn();
const mockReaddir = jest.fn();
jest.mock('fs/promises', () => ({
  stat: (...args: any[]) => mockStat(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
}));

// Mock os for homedir
jest.mock('os', () => ({
  homedir: () => '/mock/home',
  platform: () => 'darwin',
}));

import { ReaderCache, SessionCacheManager } from '@/server/services/codingAgents/cache';

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

function createMockReader(agentName: string = 'claude-code'): any {
  return {
    agentName,
    displayName: 'Mock Agent',
    isAvailable: jest.fn().mockResolvedValue(true),
    getSessions: jest.fn().mockResolvedValue([]),
    getStats: jest.fn().mockResolvedValue({}),
    getSessionDetail: jest.fn().mockResolvedValue(null),
    rereadSession: jest.fn().mockResolvedValue(null),
  };
}

function createMockSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: 'claude-code',
    session_id: `session-${Math.random().toString(36).slice(2, 8)}`,
    project_path: '/test/project',
    start_time: new Date().toISOString(),
    duration_minutes: 10,
    user_message_count: 5,
    assistant_message_count: 5,
    tool_counts: {},
    tool_error_counts: {},
    total_tool_errors: 0,
    session_completed: false,
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    first_prompt: 'test prompt',
    estimated_cost: 0.01,
    uses_mcp: false,
    ...overrides,
  };
}

// Known base directories from cache.ts (using mocked homedir /mock/home)
const CLAUDE_PROJECTS = '/mock/home/.claude/projects';
const KIRO_CLI = '/mock/home/.kiro/sessions/cli';
const CODEX_SESSIONS = '/mock/home/.codex/sessions';
const BASE_DIRS = new Set([CLAUDE_PROJECTS, KIRO_CLI, CODEX_SESSIONS]);

/**
 * Set up fs mocks for dirSignature.
 * Only known base directories return subdirectory entries.
 * Everything else returns file entries (prevents infinite recursion in walkDir).
 */
function setupDirSignatureMocks(mtimeMs: number = 1000, projectCount: number = 1): void {
  mockStat.mockImplementation(async () => {
    return { mtimeMs, isDirectory: () => false, isFile: () => true } as any;
  });

  mockReaddir.mockImplementation(async (dir: any, opts?: any) => {
    const dirStr = typeof dir === 'string' ? dir : dir.toString();

    if (opts?.withFileTypes) {
      // Only known base directories return subdirectory entries
      if (BASE_DIRS.has(dirStr)) {
        return Array.from({ length: projectCount }, (_, i) => ({
          name: `project-${i}`,
          isDirectory: () => true,
          isFile: () => false,
        })) as any;
      }
      // Everything else returns file entries (leaf nodes)
      return [{
        name: 'conversation.jsonl',
        isDirectory: () => false,
        isFile: () => true,
      }] as any;
    }
    // Non-withFileTypes readdir: return .jsonl files
    return ['conversation.jsonl'] as any;
  });
}

describe('ReaderCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getSessions()', () => {
    it('should delegate to reader on first call', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      const sessions = [createMockSession()];
      reader.getSessions.mockResolvedValue(sessions);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();
      const result = await cache.getSessions();

      expect(reader.getSessions).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].session_id).toBe(sessions[0].session_id);
    });

    it('should return cached results when directory signature is unchanged', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      const sessions = [createMockSession()];
      reader.getSessions.mockResolvedValue(sessions);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();

      const result = await cache.getSessions();
      expect(reader.getSessions).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it('should update data after fullRefresh', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      const session1 = createMockSession({ session_id: 'session-1' });
      const session2 = createMockSession({ session_id: 'session-2' });

      reader.getSessions
        .mockResolvedValueOnce([session1])
        .mockResolvedValueOnce([session1, session2]);

      const cache = new ReaderCache(reader);

      await cache.fullRefresh();
      const result1 = await cache.getSessions();
      expect(result1).toHaveLength(1);

      await cache.fullRefresh();
      const result2 = await cache.getSessions();
      expect(result2).toHaveLength(2);
    });

    it('should return empty for unknown agent types before refresh', async () => {
      const reader = createMockReader('unknown-agent' as any);
      const sessions = [createMockSession({ agent: 'claude-code' })];
      reader.getSessions.mockResolvedValue(sessions);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();
      const result = await cache.getSessions();

      expect(reader.getSessions).toHaveBeenCalled();
      expect(result).toEqual(sessions);
    });
  });

  describe('fullRefresh()', () => {
    it('should call reader.getSessions() and update signature', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      const sessions = [createMockSession()];
      reader.getSessions.mockResolvedValue(sessions);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();

      expect(reader.getSessions).toHaveBeenCalledTimes(1);

      const result = await cache.getSessions();
      expect(reader.getSessions).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it('should not call reader twice when fullRefresh is called concurrently', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      reader.getSessions.mockResolvedValue([createMockSession()]);

      const cache = new ReaderCache(reader);
      await Promise.all([cache.fullRefresh(), cache.fullRefresh()]);

      expect(reader.getSessions).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshActiveSessions()', () => {
    it('should return false when no active sessions', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      reader.getSessions.mockResolvedValue([createMockSession({ session_completed: true })]);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();

      const changed = await cache.refreshActiveSessions();
      expect(changed).toBe(false);
    });

    it('should return true when directory signature changed', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      reader.getSessions.mockResolvedValue([createMockSession()]);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();

      setupDirSignatureMocks(9999, 5);
      reader.getSessions.mockResolvedValue([createMockSession(), createMockSession()]);

      const changed = await cache.refreshActiveSessions();
      expect(changed).toBe(true);
    });

    it('should return true when active session file mtime changed', async () => {
      const filePath = '/mock/home/.claude/projects/test/conversation.jsonl';
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      const activeSession = createMockSession({
        session_id: 'active-1',
        session_completed: false,
        _filePath: filePath,
      });
      reader.getSessions.mockResolvedValue([activeSession]);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();

      // Keep base dir signature the same, but change the specific file mtime
      mockStat.mockImplementation(async (p: any) => {
        const pathStr = typeof p === 'string' ? p : p.toString();
        if (pathStr === filePath) {
          return { mtimeMs: 9999, isDirectory: () => false, isFile: () => true } as any;
        }
        return { mtimeMs: 1000, isDirectory: () => false, isFile: () => true } as any;
      });

      reader.rereadSession.mockResolvedValue(
        createMockSession({ session_id: 'active-1', session_completed: false, _filePath: filePath, user_message_count: 10 }),
      );

      const changed = await cache.refreshActiveSessions();
      expect(changed).toBe(true);
    });
  });

  describe('getLastRefreshTime()', () => {
    it('should return 0 before any refresh', () => {
      const reader = createMockReader();
      const cache = new ReaderCache(reader);
      expect(cache.getLastRefreshTime()).toBe(0);
    });

    it('should return a positive timestamp after refresh', async () => {
      setupDirSignatureMocks(1000, 1);
      const reader = createMockReader();
      reader.getSessions.mockResolvedValue([]);

      const cache = new ReaderCache(reader);
      await cache.fullRefresh();

      expect(cache.getLastRefreshTime()).toBeGreaterThan(0);
    });
  });
});

describe('SessionCacheManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getAllSessionsCached()', () => {
    it('should return available data during warmup rather than blocking', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      reader.getSessions.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([createMockSession()]), 100))
      );

      const manager = new SessionCacheManager([reader]);
      manager.warmup();

      // During warmup, returns whatever is available (may be empty if no fast pass data yet)
      const result = await manager.getAllSessionsCached();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return merged sessions from all readers', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader1 = createMockReader('claude-code');
      const reader2 = createMockReader('codex');

      reader1.getSessions.mockResolvedValue([
        createMockSession({ agent: 'claude-code', session_id: 'cc-1', start_time: '2024-01-02T00:00:00Z' }),
      ]);
      reader2.getSessions.mockResolvedValue([
        createMockSession({ agent: 'codex', session_id: 'codex-1', start_time: '2024-01-01T00:00:00Z' }),
      ]);

      const manager = new SessionCacheManager([reader1, reader2]);
      manager.warmup();
      await manager.waitForFastPass();
      // Wait for backfill
      await new Promise(r => setTimeout(r, 100));
      const result = await manager.getAllSessionsCached();

      expect(result).toHaveLength(2);
      expect(result[0].session_id).toBe('cc-1');
      expect(result[1].session_id).toBe('codex-1');
    });

    it('should strip _filePath from sessions', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      reader.getSessions.mockResolvedValue([createMockSession({ _filePath: '/some/path.jsonl' })]);

      const manager = new SessionCacheManager([reader]);
      manager.warmup();
      await manager.waitForFastPass();
      await new Promise(r => setTimeout(r, 100));
      const result = await manager.getAllSessionsCached();

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('_filePath');
    });
  });

  describe('warmup()', () => {
    it('should trigger fullRefresh on all reader caches', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader1 = createMockReader('claude-code');
      const reader2 = createMockReader('codex');
      reader1.getSessions.mockResolvedValue([createMockSession()]);
      reader2.getSessions.mockResolvedValue([createMockSession({ agent: 'codex' })]);

      const manager = new SessionCacheManager([reader1, reader2]);
      manager.warmup();

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(reader1.getSessions).toHaveBeenCalled();
      expect(reader2.getSessions).toHaveBeenCalled();
    });
  });

  describe('startBackgroundRefresh() / stopBackgroundRefresh()', () => {
    it('should create an interval timer', () => {
      jest.useFakeTimers();
      const reader = createMockReader();
      const manager = new SessionCacheManager([reader]);

      const spy = jest.spyOn(global, 'setInterval');
      manager.startBackgroundRefresh(5000);

      expect(spy).toHaveBeenCalledWith(expect.any(Function), 5000);

      manager.stopBackgroundRefresh();
      spy.mockRestore();
    });

    it('should clear interval timer on stop', () => {
      jest.useFakeTimers();
      const reader = createMockReader();
      const manager = new SessionCacheManager([reader]);

      const spy = jest.spyOn(global, 'clearInterval');
      manager.startBackgroundRefresh(5000);
      manager.stopBackgroundRefresh();

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should not create duplicate intervals if called twice', () => {
      jest.useFakeTimers();
      const reader = createMockReader();
      const manager = new SessionCacheManager([reader]);

      const spy = jest.spyOn(global, 'setInterval');
      manager.startBackgroundRefresh(5000);
      manager.startBackgroundRefresh(5000);

      expect(spy).toHaveBeenCalledTimes(1);

      manager.stopBackgroundRefresh();
      spy.mockRestore();
    });

    it('should invalidate merged cache when background refresh detects changes', async () => {
      setupDirSignatureMocks(1000, 1);

      const reader = createMockReader();
      reader.getSessions.mockResolvedValue([createMockSession({ session_completed: false })]);

      const manager = new SessionCacheManager([reader]);

      await manager.getAllSessionsCached();
      const initialCallCount = reader.getSessions.mock.calls.length;

      manager.startBackgroundRefresh(50);

      // Change signature to trigger refresh
      setupDirSignatureMocks(9999, 5);
      reader.getSessions.mockResolvedValue([createMockSession(), createMockSession()]);

      await new Promise(resolve => setTimeout(resolve, 200));

      await manager.getAllSessionsCached();
      expect(reader.getSessions.mock.calls.length).toBeGreaterThan(initialCallCount);

      manager.stopBackgroundRefresh();
    });
  });
});
