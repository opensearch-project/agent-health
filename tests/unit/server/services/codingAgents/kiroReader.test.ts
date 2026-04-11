/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Kiro reader — covers CLI JSONL, IDE workspace-sessions,
 * new .chat format, and kiro-cli SQLite data sources.
 */

import type { AgentSession } from '@/server/services/codingAgents/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockAccess = jest.fn();
const mockReadFile = jest.fn();
const mockReaddir = jest.fn();
const mockStat = jest.fn();

jest.mock('fs/promises', () => ({
  access: (...args: any[]) => mockAccess(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
  stat: (...args: any[]) => mockStat(...args),
}));

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

jest.mock('util', () => ({
  ...jest.requireActual('util'),
  promisify: () => (...args: any[]) => {
    // mockExecFile receives (bin, args, opts) and returns { stdout }
    const result = mockExecFile(...args);
    return Promise.resolve({ stdout: result });
  },
}));

jest.mock('os', () => ({
  homedir: () => '/mock/home',
  platform: () => 'darwin',
}));

// Silence console
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

import { KiroReader } from '@/server/services/codingAgents/readers/kiro';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const IDE_BASE = '/mock/home/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent';
const CLI_DB = '/mock/home/Library/Application Support/kiro-cli/data.sqlite3';

function makeChatFile(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    executionId: 'exec-001',
    actionId: 'act',
    context: [
      {
        type: 'steering',
        id: 'file:///mock/project/.kiro/steering/guide.md',
        displayName: 'guide.md',
        scope: 'workspace',
      },
    ],
    chat: [
      { role: 'human', content: '<identity>\nYou are Kiro</identity>' },
      { role: 'bot', content: 'I will follow these instructions' },
      { role: 'human', content: 'Hello, help me with my project' },
      { role: 'bot', content: 'Sure, I can help with that!' },
    ],
    metadata: {
      modelId: 'claude-sonnet-4.5',
      modelProvider: 'qdev',
      workflow: 'act',
      startTime: 1700000000000,
      endTime: 1700000060000,
    },
    ...overrides,
  });
}

function makeIdeSessionIndex(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'ide-session-001',
    title: 'Test IDE session',
    dateCreated: '1700000000000',
    workspaceDirectory: '/mock/ide-project',
    ...overrides,
  };
}

function makeIdeSessionFile(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    history: [
      { message: { role: 'user', content: 'Fix the bug' } },
      { message: { role: 'assistant', content: 'I found the issue.' } },
    ],
    workspaceDirectory: '/mock/ide-project',
    ...overrides,
  });
}

function makeSqliteMetaRows(rows: Array<Record<string, any>> = []) {
  return JSON.stringify(rows.length ? rows : [
    {
      key: '/mock/project',
      conversation_id: 'conv-001',
      created_at: 1700000000000,
      updated_at: 1700000120000,
      model_id: 'claude-opus-4.6',
      conv_id: 'conv-001',
      history_len: 5,
      transcript_len: 8,
    },
  ]);
}

function makeSqlitePromptRows(rows: Array<Record<string, any>> = []) {
  return JSON.stringify(rows.length ? rows : [
    {
      conversation_id: 'conv-001',
      key: '/mock/project',
      first_prompt: 'Help me refactor this code',
      usage_info: JSON.stringify([{ value: 1.5, unit: 'credit' }]),
    },
  ]);
}

// ─── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: all paths fail access (nothing exists)
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockReaddir.mockResolvedValue([]);
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  mockExecFile.mockReturnValue('[]');
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('KiroReader', () => {
  let reader: KiroReader;

  beforeEach(() => {
    reader = new KiroReader();
  });

  describe('metadata', () => {
    it('has correct agent name and display name', () => {
      expect(reader.agentName).toBe('kiro');
      expect(reader.displayName).toBe('Kiro');
    });
  });

  describe('isAvailable', () => {
    it('returns true when CLI sessions dir exists', async () => {
      mockAccess.mockImplementation((p: string) =>
        p.includes('sessions/cli') ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns true when kiro-cli SQLite DB exists', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns true when IDE workspace-sessions dir exists', async () => {
      mockAccess.mockImplementation((p: string) =>
        p.includes('workspace-sessions') ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns true when hash-based .chat dirs exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      // listChatWorkspaceDirs reads the IDE base dir
      mockReaddir.mockImplementation((dir: string) => {
        if (dir === IDE_BASE) {
          return Promise.resolve([
            { name: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', isDirectory: () => true },
          ]);
        }
        // Inside the hash dir, return a .chat file
        if (dir.includes('a1b2c3d4')) {
          return Promise.resolve(['session.chat']);
        }
        return Promise.resolve([]);
      });
      expect(await reader.isAvailable()).toBe(true);
    });

    it('returns false when nothing exists', async () => {
      mockReaddir.mockResolvedValue([]);
      expect(await reader.isAvailable()).toBe(false);
    });
  });

  describe.skip('getSessions — .chat format (disabled pending perf optimization)', () => {
    beforeEach(() => {
      // Set up hash-based .chat dir
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir === IDE_BASE) {
          return Promise.resolve([
            { name: 'abcdef01234567890abcdef012345678', isDirectory: () => true },
            { name: 'config.json', isDirectory: () => false },
          ]);
        }
        if (dir.includes('abcdef01234567890abcdef012345678')) {
          return Promise.resolve(['exec-001.chat', 'f62de366d0006e17ea00a01f6624aabf']);
        }
        // workspace-sessions returns empty
        if (dir.includes('workspace-sessions')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) return Promise.resolve(makeChatFile());
        return Promise.reject(new Error('ENOENT'));
      });
    });

    it('parses .chat files into sessions', async () => {
      const sessions = await reader.getSessions();
      const chatSessions = sessions.filter(s => s.session_id === 'exec-001');
      expect(chatSessions.length).toBe(1);

      const s = chatSessions[0];
      expect(s.agent).toBe('kiro');
      expect(s.session_id).toBe('exec-001');
      expect(s.project_path).toBe('/mock/project');
      expect(s.user_message_count).toBe(1); // skips <identity> prompt
      expect(s.assistant_message_count).toBe(2);
      expect(s.session_completed).toBe(true);
      expect(s.duration_minutes).toBe(1); // 60000ms = 1min
    });

    it('extracts workspace path from steering context', async () => {
      const sessions = await reader.getSessions();
      const s = sessions.find(s => s.session_id === 'exec-001');
      expect(s?.project_path).toBe('/mock/project');
    });

    it('skips .chat files with no user messages', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) {
          return Promise.resolve(makeChatFile({
            chat: [
              { role: 'human', content: '<identity>\nYou are Kiro</identity>' },
              { role: 'bot', content: 'acknowledged' },
            ],
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      const sessions = await reader.getSessions();
      expect(sessions.filter(s => s.session_id === 'exec-001')).toHaveLength(0);
    });

    it('skips .chat files with no metadata startTime', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) {
          return Promise.resolve(makeChatFile({ metadata: {} }));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      const sessions = await reader.getSessions();
      expect(sessions.filter(s => s.session_id === 'exec-001')).toHaveLength(0);
    });
  });

  describe('getSessions — IDE workspace-sessions format', () => {
    beforeEach(() => {
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) {
          return Promise.resolve([
            { name: 'L21vY2svcHJvamVjdA__', isDirectory: () => true },
          ]);
        }
        if (dir === IDE_BASE) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('sessions.json')) {
          return Promise.resolve(JSON.stringify([makeIdeSessionIndex()]));
        }
        if (p.endsWith('ide-session-001.json')) {
          return Promise.resolve(makeIdeSessionFile());
        }
        return Promise.reject(new Error('ENOENT'));
      });
    });

    it('parses IDE sessions from workspace-sessions dirs', async () => {
      const sessions = await reader.getSessions();
      const ide = sessions.find(s => s.session_id === 'ide-session-001');
      expect(ide).toBeDefined();
      expect(ide!.agent).toBe('kiro');
      expect(ide!.user_message_count).toBe(1);
      expect(ide!.assistant_message_count).toBe(1);
      expect(ide!.first_prompt).toBe('Fix the bug');
    });

    it('skips hidden IDE sessions', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('sessions.json')) {
          return Promise.resolve(JSON.stringify([makeIdeSessionIndex({ hidden: true })]));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      const sessions = await reader.getSessions();
      expect(sessions.find(s => s.session_id === 'ide-session-001')).toBeUndefined();
    });
  });

  describe('getSessions — kiro-cli SQLite', () => {
    beforeEach(() => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockImplementation((dir: string) => {
        if (dir === IDE_BASE) return Promise.resolve([]);
        return Promise.resolve([]);
      });
    });

    it('parses sessions from SQLite via json_extract', async () => {
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('json_extract') && cmd.includes('model_id')) {
          return makeSqliteMetaRows();
        }
        if (cmd.includes('first_prompt')) {
          return makeSqlitePromptRows();
        }
        if (cmd.includes('length(value) >= 10000000')) {
          return '[]';
        }
        return '[]';
      });

      const sessions = await reader.getSessions();
      const db = sessions.find(s => s.session_id === 'conv-001');
      expect(db).toBeDefined();
      expect(db!.agent).toBe('kiro');
      expect(db!.project_path).toBe('/mock/project');
      expect(db!.first_prompt).toBe('Help me refactor this code');
      expect(db!.model).toBe('kiro-cli (claude-opus-4.6)');
      expect(db!.user_message_count).toBe(5);
      expect(db!.estimated_cost).toBe(1.5);
      expect(db!.duration_minutes).toBe(2); // 120000ms = 2min
    });

    it('includes large sessions with basic metadata', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('length(value) >= 10000000')) {
          return JSON.stringify([{
            key: '/mock/big-project',
            conversation_id: 'big-conv-001',
            created_at: 1700000000000,
            updated_at: 1700003600000,
          }]);
        }
        // meta and prompt queries (with size filter) return empty
        return '[]';
      });

      const sessions = await reader.getSessions();
      const big = sessions.find(s => s.session_id === 'big-conv-001');
      expect(big).toBeDefined();
      expect(big!.project_path).toBe('/mock/big-project');
      expect(big!.first_prompt).toBe('(large session)');
      expect(big!.duration_minutes).toBe(60); // 3600000ms = 60min
    });

    it('returns empty when SQLite DB does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockReaddir.mockResolvedValue([]);
      const sessions = await reader.getSessions();
      expect(sessions).toHaveLength(0);
    });

    it('returns empty when sqlite3 command fails', async () => {
      mockExecFile.mockImplementation(() => { throw new Error('sqlite3 not found'); });
      mockReaddir.mockResolvedValue([]);
      const sessions = await reader.getSessions();
      expect(sessions).toHaveLength(0);
    });
  });

  describe('getSessions — deduplication', () => {
    it('deduplicates sessions by session_id across sources', async () => {
      // IDE returns a session
      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) {
          return Promise.resolve([
            { name: 'L21vY2s_', isDirectory: () => true },
          ]);
        }
        if (dir === IDE_BASE) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('sessions.json')) {
          return Promise.resolve(JSON.stringify([makeIdeSessionIndex({ sessionId: 'dup-id' })]));
        }
        if (p.endsWith('dup-id.json')) {
          return Promise.resolve(makeIdeSessionFile());
        }
        return Promise.reject(new Error('ENOENT'));
      });

      // SQLite also returns a session with same ID
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('model_id')) {
          return makeSqliteMetaRows([{
            key: '/mock/project', conversation_id: 'dup-id',
            created_at: 1700000000000, updated_at: 1700000060000,
            model_id: 'opus', conv_id: 'dup-id', history_len: 3, transcript_len: 4,
          }]);
        }
        if (cmd.includes('first_prompt')) {
          return makeSqlitePromptRows([{
            conversation_id: 'dup-id', key: '/mock/project',
            first_prompt: 'test', usage_info: null,
          }]);
        }
        return '[]';
      });

      const sessions = await reader.getSessions();
      const dups = sessions.filter(s => s.session_id === 'dup-id');
      expect(dups).toHaveLength(1);
    });
  });

  describe('getSessionDetail — SQLite', () => {
    it('escapes single quotes in sessionId to prevent SQL injection', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockReturnValue('[]');

      await reader.getSessionDetail("'; DROP TABLE conversations_v2; --");

      // execFileSync is called with args array, not shell string — inherently safe
      // But also verify the SQL escaping in the query arg
      const calls = mockExecFile.mock.calls;
      const sqlCall = calls.find(([bin, args]: [string, string[]]) =>
        bin === 'sqlite3' && args?.some((a: string) => a.includes('conversation_id'))
      );
      expect(sqlCall).toBeDefined();
      const query = sqlCall![1][2]; // args[2] is the SQL query
      // Single quote in input is escaped to '' (SQL standard escaping)
      // Plus execFileSync passes as argument array, not shell string — no shell injection
      expect(query).toContain("conversation_id='''");
      expect(query).toMatch(/conversation_id='.*DROP TABLE.*'/);
    });

    it('returns session detail from SQLite for kiro-cli sessions', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);

      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes("conversation_id='conv-001'")) {
          return JSON.stringify([{
            key: '/mock/project',
            conversation_id: 'conv-001',
            created_at: 1700000000000,
            updated_at: 1700000120000,
            model_id: 'claude-opus-4.6',
            transcript: JSON.stringify([
              '> Help me refactor this code',
              'Sure, let me look at the code.\n[Tool uses: fs_read]',
              'Here is the refactored version.',
            ]),
            history_len: 3,
            first_prompt: 'Help me refactor this code',
          }]);
        }
        return '[]';
      });

      const detail = await reader.getSessionDetail('conv-001');
      expect(detail).not.toBeNull();
      expect(detail!.session.session_id).toBe('conv-001');
      expect(detail!.session.model).toBe('kiro-cli (claude-opus-4.6)');
      expect(detail!.messages.length).toBe(4); // user + assistant + tool + assistant
      expect(detail!.messages[0].role).toBe('user');
      expect(detail!.messages[0].text).toBe('Help me refactor this code');
      expect(detail!.messages[1].role).toBe('assistant');
      expect(detail!.messages[1].text).toContain('let me look at the code');
    });

    it('returns null when session not found in SQLite', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockReturnValue('[]');

      const detail = await reader.getSessionDetail('nonexistent');
      expect(detail).toBeNull();
    });
  });

  describe('getSessionDetail — .chat format with execution index', () => {
    it('uses execution index to find the right workspace dir', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const executionIndex = JSON.stringify({
        executions: [
          { executionId: 'target-exec', type: 'chat-agent', status: 'succeed', startTime: 1700000000000, endTime: 1700000060000 },
        ],
        version: '2.0.0',
      });

      mockReaddir.mockImplementation((dir: string, opts?: any) => {
        if (dir === IDE_BASE) {
          return Promise.resolve([
            { name: 'aaa11111222233334444555566667777', isDirectory: () => true },
            { name: 'bbb11111222233334444555566667777', isDirectory: () => true },
          ]);
        }
        if (dir.includes('workspace-sessions') && opts?.withFileTypes) return Promise.resolve([]);
        // Both dirs have an index file and .chat files
        if (dir.includes('aaa111')) return Promise.resolve(['other.chat', 'exec_index']);
        if (dir.includes('bbb111')) return Promise.resolve(['target.chat', 'exec_index']);
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((p: string) => {
        // Execution index for dir aaa — no match
        if (p.includes('aaa111') && p.endsWith('exec_index')) {
          return Promise.resolve(JSON.stringify({ executions: [], version: '2.0.0' }));
        }
        // Execution index for dir bbb — has our target
        if (p.includes('bbb111') && p.endsWith('exec_index')) {
          return Promise.resolve(executionIndex);
        }
        // The .chat file
        if (p.endsWith('target.chat')) {
          return Promise.resolve(makeChatFile({ executionId: 'target-exec' }));
        }
        if (p.endsWith('other.chat')) {
          return Promise.resolve(makeChatFile({ executionId: 'other-exec' }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const detail = await reader.getSessionDetail('target-exec');
      expect(detail).not.toBeNull();
      expect(detail!.session.session_id).toBe('target-exec');
      // Should NOT have read .chat files in dir aaa (no match in index)
      const chatReads = mockReadFile.mock.calls.filter(
        ([p]: [string]) => p.includes('aaa111') && p.endsWith('.chat')
      );
      expect(chatReads).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('computes stats from all sessions', async () => {
      mockAccess.mockImplementation((p: string) =>
        p === CLI_DB ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      );
      mockReaddir.mockResolvedValue([]);
      mockExecFile.mockImplementation((_bin: string, args: string[]) => { const cmd = (args || []).join(' ');
        if (cmd.includes('model_id')) {
          return makeSqliteMetaRows([
            { key: '/p1', conversation_id: 'c1', created_at: 1700000000000, updated_at: 1700000060000, model_id: 'opus', conv_id: 'c1', history_len: 3, transcript_len: 4 },
            { key: '/p2', conversation_id: 'c2', created_at: 1700086400000, updated_at: 1700086460000, model_id: 'opus', conv_id: 'c2', history_len: 5, transcript_len: 6 },
          ]);
        }
        if (cmd.includes('first_prompt')) {
          return makeSqlitePromptRows([
            { conversation_id: 'c1', key: '/p1', first_prompt: 'test1', usage_info: JSON.stringify([{ value: 1.0 }]) },
            { conversation_id: 'c2', key: '/p2', first_prompt: 'test2', usage_info: JSON.stringify([{ value: 2.0 }]) },
          ]);
        }
        return '[]';
      });

      const stats = await reader.getStats();
      expect(stats.agent).toBe('kiro');
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalCost).toBe(3.0);
      expect(stats.activeDays).toBe(2);
      expect(stats.dailyActivity).toHaveLength(2);
    });
  });

  describe('rereadSession', () => {
    it('handles .chat files', async () => {
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('.chat')) return Promise.resolve(makeChatFile());
        return Promise.reject(new Error('ENOENT'));
      });

      const session = await reader.rereadSession('/some/path/exec.chat');
      expect(session).not.toBeNull();
      expect(session!.session_id).toBe('exec-001');
    });

    it('returns null for missing files', async () => {
      const session = await reader.rereadSession('/nonexistent.chat');
      expect(session).toBeNull();
    });
  });
});
