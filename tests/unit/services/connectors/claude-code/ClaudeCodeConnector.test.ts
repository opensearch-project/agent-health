/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClaudeCodeConnector, claudeCodeConnector, createBedrockClaudeCodeConnector } from '@/services/connectors/claude-code/ClaudeCodeConnector';
import type { ConnectorRequest, ConnectorAuth } from '@/services/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('ClaudeCodeConnector', () => {
  let connector: ClaudeCodeConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;
  let mockProcess: any;

  beforeEach(() => {
    connector = new ClaudeCodeConnector();
    mockTestCase = {
      id: 'tc-123',
      name: 'Test Case',
      initialPrompt: 'What is the cluster health?',
      context: [{ description: 'Cluster Name', value: 'test-cluster' }],
      expectedOutcomes: ['Check cluster health'],
      labels: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockAuth = { type: 'none' };

    // Create mock process
    mockProcess = new EventEmitter();
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.stdin = {
      write: jest.fn(),
      end: jest.fn(),
    };
    mockProcess.pid = 12345;
    mockProcess.kill = jest.fn();

    (spawn as jest.Mock).mockReturnValue(mockProcess);

    // Suppress console output in tests
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('properties', () => {
    it('should have correct type', () => {
      expect(connector.type).toBe('claude-code');
    });

    it('should have correct name', () => {
      expect(connector.name).toBe('Claude Code CLI');
    });

    it('should support streaming', () => {
      expect(connector.supportsStreaming).toBe(true);
    });
  });

  describe('buildPayload', () => {
    it('should format prompt with markdown sections', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload).toContain('## Context');
      expect(payload).toContain('## Task');
      expect(payload).toContain(mockTestCase.initialPrompt);
    });

    it('should include context items', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload).toContain('**Cluster Name:**');
      expect(payload).toContain('test-cluster');
    });

    it('should skip context section if no context', () => {
      const testCaseNoContext = { ...mockTestCase, context: [] };
      const request: ConnectorRequest = {
        testCase: testCaseNoContext,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload).not.toContain('## Context');
      expect(payload).toContain('## Task');
    });
  });

  describe('execute', () => {
    it('should spawn claude command with stream-json output', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute('claude', request, mockAuth);

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--print', '--verbose', '--output-format', 'stream-json']),
        expect.any(Object)
      );
    });

    it('should parse JSON stream events', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        // Send a valid JSON event
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(progressSteps.length).toBeGreaterThan(0);
    });

    it('should handle thinking blocks', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me analyze..."}]}}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      const thinkingSteps = progressSteps.filter(s => s.type === 'thinking');
      expect(thinkingSteps.length).toBeGreaterThan(0);
    });

    it('should handle tool_use blocks', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"read_file","input":{"path":"/test"}}]}}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      const actionSteps = progressSteps.filter(s => s.type === 'action');
      expect(actionSteps.length).toBeGreaterThan(0);
      expect(actionSteps[0].toolName).toBe('read_file');
    });

    it('should handle result events', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"result","result":"Final answer"}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      const responseSteps = progressSteps.filter(s => s.type === 'response');
      expect(responseSteps.length).toBeGreaterThan(0);
    });

    it('should handle tool_result events', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"tool_result","content":"File contents here","is_error":false}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      const resultSteps = progressSteps.filter(s => s.type === 'tool_result');
      expect(resultSteps.length).toBeGreaterThan(0);
      expect(resultSteps[0].status).toBe('SUCCESS');
    });

    it('should handle error tool_result', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"tool_result","content":"Error message","is_error":true}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      const resultSteps = progressSteps.filter(s => s.type === 'tool_result');
      expect(resultSteps[0].status).toBe('FAILURE');
    });

    it('should handle non-JSON lines gracefully', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('Not JSON\n'));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      // Should create assistant step for non-JSON
      const assistantSteps = progressSteps.filter(s => s.type === 'assistant');
      expect(assistantSteps.length).toBeGreaterThan(0);
    });

    it('should reset state between executions', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      // First execution
      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('First\n'));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute('claude', request, mockAuth);

      // Create new mock process for second execution
      const mockProcess2 = new EventEmitter();
      mockProcess2.stdout = new EventEmitter();
      mockProcess2.stderr = new EventEmitter();
      mockProcess2.stdin = { write: jest.fn(), end: jest.fn() };
      mockProcess2.pid = 12346;
      mockProcess2.kill = jest.fn();
      (spawn as jest.Mock).mockReturnValue(mockProcess2);

      const secondProgressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess2.stdout.emit('data', Buffer.from('Second\n'));
        mockProcess2.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => secondProgressSteps.push(step)
      );

      // Should not contain data from first execution
      const contents = secondProgressSteps.map(s => s.content);
      expect(contents).not.toContain('First');
    });
  });

  describe('parseResponse', () => {
    it('should extract thinking blocks from output', () => {
      const steps = connector.parseResponse({
        stdout: '<thinking>Let me think</thinking>\nFinal answer',
        stderr: '',
        exitCode: 0,
      });

      expect(steps.some(s => s.type === 'thinking')).toBe(true);
      expect(steps.some(s => s.type === 'response')).toBe(true);
    });

    it('should handle multiple thinking blocks', () => {
      const steps = connector.parseResponse({
        stdout: '<thinking>First</thinking>Middle<thinking>Second</thinking>End',
        stderr: '',
        exitCode: 0,
      });

      const thinkingSteps = steps.filter(s => s.type === 'thinking');
      expect(thinkingSteps).toHaveLength(2);
    });

    it('should add error step for non-zero exit', () => {
      const steps = connector.parseResponse({
        stdout: '',
        stderr: 'CLI error',
        exitCode: 1,
      });

      const errorSteps = steps.filter(s => s.status === 'FAILURE');
      expect(errorSteps.length).toBeGreaterThan(0);
    });
  });

  describe('healthCheck', () => {
    it('should check for claude command', async () => {
      const healthProcess = new EventEmitter();
      healthProcess.stdout = new EventEmitter();
      healthProcess.stderr = new EventEmitter();
      healthProcess.stdin = { write: jest.fn(), end: jest.fn() };
      (spawn as jest.Mock).mockReturnValue(healthProcess);

      const resultPromise = connector.healthCheck('', mockAuth);

      setTimeout(() => {
        healthProcess.emit('close', 0);
      }, 10);

      const result = await resultPromise;
      expect(result).toBe(true);

      // Should check for 'claude' command by default
      expect(spawn).toHaveBeenCalledWith(
        'which',
        ['claude'],
        expect.any(Object)
      );
    });

    it('should use custom endpoint if provided', async () => {
      const healthProcess = new EventEmitter();
      healthProcess.stdout = new EventEmitter();
      healthProcess.stderr = new EventEmitter();
      healthProcess.stdin = { write: jest.fn(), end: jest.fn() };
      (spawn as jest.Mock).mockReturnValue(healthProcess);

      const resultPromise = connector.healthCheck('custom-claude', mockAuth);

      setTimeout(() => {
        healthProcess.emit('close', 0);
      }, 10);

      await resultPromise;

      expect(spawn).toHaveBeenCalledWith(
        'which',
        ['custom-claude'],
        expect.any(Object)
      );
    });
  });

  describe('createBedrockClaudeCodeConnector', () => {
    it('should create connector with Bedrock config', () => {
      const bedrockConnector = createBedrockClaudeCodeConnector();

      expect(bedrockConnector).toBeInstanceOf(ClaudeCodeConnector);
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(claudeCodeConnector).toBeInstanceOf(ClaudeCodeConnector);
    });
  });
});
