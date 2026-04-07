/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentConfig } from '@/types';

// ---------------------------------------------------------------------------
// fs mock — declared before importing the module under test.
// We use delegate functions so the mock factory (hoisted by Jest) captures
// references that we can reconfigure per-test via the outer jest.fn() handles.
// ---------------------------------------------------------------------------
const mockExistsSync = jest.fn().mockReturnValue(false);
const mockReadFileSync = jest.fn().mockReturnValue('{}');
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

import {
  addCustomAgent,
  removeCustomAgent,
  getCustomAgents,
  clearCustomAgents,
  loadFromDisk,
} from '@/server/services/customAgentStore';

// Suppress console.error during tests (corrupt JSON, write failures, etc.)
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAgent = (key: string, name: string, endpoint: string): AgentConfig => ({
  key,
  name,
  endpoint,
  models: [],
  headers: {},
  connectorType: 'agui-streaming',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('customAgentStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset to defaults
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockReset();
    mockUnlinkSync.mockReset();
    // Clear the in-memory store without triggering saveToDisk assertions
    clearCustomAgents();
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // loadFromDisk
  // -----------------------------------------------------------------------

  describe('loadFromDisk', () => {
    it('hydrates the store from an existing config file', () => {
      const agents = [makeAgent('a', 'Agent A', 'http://a.example.com')];
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ customAgents: agents }));

      loadFromDisk();
      const result = getCustomAgents();

      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('a');
      expect(result[0].isCustom).toBe(true);
    });

    it('starts empty when the config file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      loadFromDisk();
      expect(getCustomAgents()).toEqual([]);
    });

    it('starts empty when the config file contains corrupt JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('NOT VALID JSON {{{');

      loadFromDisk();
      expect(getCustomAgents()).toEqual([]);
    });

    it('starts empty when customAgents key is missing', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ otherKey: 'value' }));

      loadFromDisk();
      expect(getCustomAgents()).toEqual([]);
    });

    it('skips entries that lack a key property', () => {
      const data = {
        customAgents: [
          { name: 'No Key', endpoint: 'http://x' },
          makeAgent('valid', 'Valid', 'http://valid'),
        ],
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(data));

      loadFromDisk();
      const result = getCustomAgents();
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('valid');
    });

    it('handles file containing a JSON array (not object) gracefully', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('["not", "an", "object"]');

      loadFromDisk();
      expect(getCustomAgents()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // saveToDisk (called by add / remove / clear)
  // -----------------------------------------------------------------------

  describe('saveToDisk', () => {
    it('writes JSON to disk after addCustomAgent', () => {
      addCustomAgent(makeAgent('x', 'X', 'http://x'));

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [, content] = mockWriteFileSync.mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.customAgents).toHaveLength(1);
      expect(parsed.customAgents[0].key).toBe('x');
    });

    it('preserves other top-level keys in the config file', () => {
      // Simulate existing file with a sibling key
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ theme: 'dark' }));

      addCustomAgent(makeAgent('y', 'Y', 'http://y'));

      const [, content] = mockWriteFileSync.mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.theme).toBe('dark');
      expect(parsed.customAgents).toHaveLength(1);
    });

    it('does not delete or write the file when agents are empty and no other keys exist', () => {
      // First add an agent (this writes to "disk")
      addCustomAgent(makeAgent('z', 'Z', 'http://z'));
      jest.clearAllMocks();

      // Now simulate file containing only { customAgents: [...] }
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ customAgents: [makeAgent('z', 'Z', 'http://z')] }),
      );

      removeCustomAgent('z');

      // File lifecycle is managed by configService.ts — customAgentStore must not delete
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      // Nothing left to write, so writeFileSync should not be called either
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('keeps the file (without customAgents) when other keys remain', () => {
      // First add an agent
      addCustomAgent(makeAgent('z', 'Z', 'http://z'));
      jest.clearAllMocks();

      // Simulate file containing agents + another key
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          theme: 'dark',
          customAgents: [makeAgent('z', 'Z', 'http://z')],
        }),
      );

      removeCustomAgent('z');

      // Should write the file with only `theme`, not delete it
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
      const [, content] = mockWriteFileSync.mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.theme).toBe('dark');
      expect(parsed.customAgents).toBeUndefined();
    });

    it('skips write when existing config file is unreadable (corrupt JSON)', () => {
      // First add an agent to the in-memory store
      addCustomAgent(makeAgent('mem-agent', 'Memory Agent', 'http://mem'));
      jest.clearAllMocks();

      // Now simulate a corrupt config file for the next saveToDisk call
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('NOT VALID JSON {{{');

      // Adding another agent triggers saveToDisk, which should skip the write
      addCustomAgent(makeAgent('another', 'Another', 'http://another'));

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      // Agent is still in memory despite the write being skipped
      expect(getCustomAgents().find((a) => a.key === 'another')).toBeDefined();
    });

    it('skips write when existing config file contains a JSON array', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('["not", "an", "object"]');

      addCustomAgent(makeAgent('arr-test', 'Array Test', 'http://arr'));

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      // Agent is still in memory
      expect(getCustomAgents().find((a) => a.key === 'arr-test')).toBeDefined();
    });

    it('logs error but does not throw on write failure', () => {
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      // Should not throw
      expect(() => addCustomAgent(makeAgent('w', 'W', 'http://w'))).not.toThrow();
      expect(console.error).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Public API (CRUD operations)
  // -----------------------------------------------------------------------

  describe('addCustomAgent', () => {
    it('stores an agent that can be retrieved', () => {
      addCustomAgent(makeAgent('custom-1', 'My Agent', 'http://localhost:3000'));

      const agents = getCustomAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].key).toBe('custom-1');
      expect(agents[0].name).toBe('My Agent');
      expect(agents[0].endpoint).toBe('http://localhost:3000');
    });

    it('sets isCustom to true on stored agents', () => {
      addCustomAgent(makeAgent('custom-2', 'Agent', 'http://localhost:4000'));

      const agents = getCustomAgents();
      expect(agents[0].isCustom).toBe(true);
    });

    it('overwrites agent with same key', () => {
      addCustomAgent(makeAgent('custom-1', 'Original', 'http://localhost:3000'));
      addCustomAgent(makeAgent('custom-1', 'Updated', 'http://localhost:4000'));

      const agents = getCustomAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Updated');
      expect(agents[0].endpoint).toBe('http://localhost:4000');
    });
  });

  describe('removeCustomAgent', () => {
    it('removes an existing agent and returns true', () => {
      addCustomAgent(makeAgent('custom-1', 'Agent', 'http://localhost:3000'));

      const result = removeCustomAgent('custom-1');
      expect(result).toBe(true);
      expect(getCustomAgents()).toHaveLength(0);
    });

    it('returns false for non-existent key', () => {
      const result = removeCustomAgent('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getCustomAgents', () => {
    it('returns empty array when store is empty', () => {
      expect(getCustomAgents()).toEqual([]);
    });

    it('returns all stored agents', () => {
      addCustomAgent(makeAgent('a', 'Agent A', 'http://a.example.com'));
      addCustomAgent(makeAgent('b', 'Agent B', 'http://b.example.com'));
      addCustomAgent(makeAgent('c', 'Agent C', 'http://c.example.com'));

      const agents = getCustomAgents();
      expect(agents).toHaveLength(3);
      expect(agents.map((a) => a.key).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('clearCustomAgents', () => {
    it('empties the store', () => {
      addCustomAgent(makeAgent('a', 'Agent A', 'http://a.example.com'));
      addCustomAgent(makeAgent('b', 'Agent B', 'http://b.example.com'));

      clearCustomAgents();
      expect(getCustomAgents()).toEqual([]);
    });

    it('is safe to call on empty store', () => {
      clearCustomAgents();
      expect(getCustomAgents()).toEqual([]);
    });
  });
});
