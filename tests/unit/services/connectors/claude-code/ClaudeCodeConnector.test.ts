/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClaudeCodeConnector, claudeCodeConnector, createBedrockClaudeCodeConnector } from '@/services/connectors/claude-code/ClaudeCodeConnector';
import type { ClaudeCodeConnectorConfig } from '@/services/connectors/claude-code/ClaudeCodeConnector';
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

    it('captures session_id from stream-json and surfaces it as metadata.sessionId (#313)', async () => {
      const request: ConnectorRequest = { testCase: mockTestCase, modelId: 'test-model' };

      setTimeout(() => {
        // Claude Code emits the session_id on its system/init event (and every
        // subsequent event). It equals the `session.id` attribute on its OTel
        // spans — captured for Strategy D trace correlation.
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"system","subtype":"init","session_id":"sess-abc-123"}\n' +
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]},"session_id":"sess-abc-123"}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      const result = await connector.execute('claude', request, mockAuth);
      expect(result.metadata?.sessionId).toBe('sess-abc-123');
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
        // Claude Code emits tool results as user-role messages with
        // tool_result content blocks (not top-level tool_result events).
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"File contents here","is_error":false}]}}\n'
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
          '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"Error message","is_error":true}]}}\n'
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

  describe('error surfacing', () => {
    it('should create error step when process exits with non-zero code and empty trajectory', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stderr.emit('data', Buffer.from('Error: --mcp-config file not found'));
        mockProcess.emit('close', 1, null);
      }, 10);

      const result = await connector.execute(
        'claude',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(result.trajectory.length).toBeGreaterThan(0);
      expect(result.trajectory[0].type).toBe('tool_result');
      expect(result.trajectory[0].status).toBe('FAILURE');
      expect(result.trajectory[0].content).toContain('exited with code 1');
      expect(result.trajectory[0].content).toContain('--mcp-config file not found');
      expect(progressSteps.length).toBeGreaterThan(0);
    });

    it('should create error step with just exit code when stderr is empty', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', 2, null);
      }, 10);

      const result = await connector.execute('claude', request, mockAuth);

      expect(result.trajectory.length).toBe(1);
      expect(result.trajectory[0].content).toBe('Error: Process exited with code 2');
    });
  });

  describe('buffer flushing', () => {
    it('should flush outputBuffer when process closes with incomplete line', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        // Send JSON without trailing newline
        mockProcess.stdout.emit('data', Buffer.from('{"type":"result","result":"Final answer"}'));
        mockProcess.emit('close', 0, null);
      }, 10);

      const result = await connector.execute('claude', request, mockAuth);

      const responseSteps = result.trajectory.filter(s => s.type === 'response');
      expect(responseSteps.length).toBe(1);
      expect(responseSteps[0].content).toBe('Final answer');
    });

    it('should flush thinkingBuffer when process closes without content_block_stop', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Analyzing..."}}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      const result = await connector.execute('claude', request, mockAuth);

      const thinkingSteps = result.trajectory.filter(s => s.type === 'thinking');
      expect(thinkingSteps.length).toBe(1);
      expect(thinkingSteps[0].content).toBe('Analyzing...');
    });

    it('should flush textBuffer as response when process exits without result event', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial response"}}\n'
        ));
        mockProcess.emit('close', 1, null);
      }, 10);

      const result = await connector.execute('claude', request, mockAuth);

      const responseSteps = result.trajectory.filter(s => s.type === 'response');
      expect(responseSteps.length).toBe(1);
      expect(responseSteps[0].content).toBe('Partial response');
    });
  });

  describe('text buffer consolidation', () => {
    it('should emit consolidated assistant step from text_delta buffer and response from result', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n' +
          '{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n' +
          '{"type":"content_block_stop"}\n' +
          '{"type":"result","result":"Hello world"}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      const result = await connector.execute('claude', request, mockAuth);

      // Should have one consolidated assistant step from buffer and one response from result
      const assistantTextSteps = result.trajectory.filter(
        s => s.type === 'assistant' && s.content.includes('Hello')
      );
      const responseSteps = result.trajectory.filter(s => s.type === 'response');
      expect(assistantTextSteps.length).toBe(1);
      expect(assistantTextSteps[0].content).toBe('Hello world');
      expect(responseSteps.length).toBe(1);
      expect(responseSteps[0].content).toBe('Hello world');
    });

    it('should emit thinking, assistant, and response steps from full stream', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(
          '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me think"}}\n' +
          '{"type":"content_block_stop"}\n' +
          '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n' +
          '{"type":"content_block_stop"}\n' +
          '{"type":"result","result":"Answer"}\n'
        ));
        mockProcess.emit('close', 0, null);
      }, 10);

      const result = await connector.execute('claude', request, mockAuth);

      const thinkingSteps = result.trajectory.filter(s => s.type === 'thinking');
      const assistantSteps = result.trajectory.filter(s => s.type === 'assistant');
      const responseSteps = result.trajectory.filter(s => s.type === 'response');
      expect(thinkingSteps.length).toBe(1);
      expect(thinkingSteps[0].content).toBe('Let me think');
      expect(assistantSteps.length).toBe(1);
      expect(assistantSteps[0].content).toBe('Answer');
      expect(responseSteps.length).toBe(1);
      expect(responseSteps[0].content).toBe('Answer');
    });
  });

  describe('createBedrockClaudeCodeConnector', () => {
    it('should create connector with Bedrock config', () => {
      const bedrockConnector = createBedrockClaudeCodeConnector();

      expect(bedrockConnector).toBeInstanceOf(ClaudeCodeConnector);
    });

    it('sets OTEL_LOG_USER_PROMPTS=1 by default when telemetry is enabled', () => {
      const prev = { ...process.env };
      process.env.CLAUDE_CODE_TELEMETRY_ENABLED = 'true';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example/v1/traces';
      delete process.env.OTEL_LOG_USER_PROMPTS;
      try {
        const env = (createBedrockClaudeCodeConnector() as any).config.env;
        expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
        expect(env.OTEL_LOG_USER_PROMPTS).toBe('1');
      } finally {
        process.env = prev;
      }
    });

    it('honors an explicit OTEL_LOG_USER_PROMPTS opt-out', () => {
      const prev = { ...process.env };
      process.env.CLAUDE_CODE_TELEMETRY_ENABLED = 'true';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otlp.example/v1/traces';
      process.env.OTEL_LOG_USER_PROMPTS = '0';
      try {
        const env = (createBedrockClaudeCodeConnector() as any).config.env;
        expect(env.OTEL_LOG_USER_PROMPTS).toBe('0');
      } finally {
        process.env = prev;
      }
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(claudeCodeConnector).toBeInstanceOf(ClaudeCodeConnector);
    });
  });

  describe('connectorConfig', () => {
    beforeEach(() => {
      (spawn as jest.Mock).mockClear();
    });

    function createMockProcess() {
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: jest.fn(), end: jest.fn() };
      proc.pid = 99999;
      proc.kill = jest.fn();
      return proc;
    }

    it('should add --dangerously-skip-permissions flag', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          dangerouslySkipPermissions: true,
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--dangerously-skip-permissions');
    });

    it('should add --allowed-tools with tool patterns', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          allowedTools: ['mcp__aws-prometheus__*', 'mcp__aws-cloudwatch__*', 'Bash'],
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      const toolsIdx = spawnArgs.indexOf('--allowed-tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(spawnArgs[toolsIdx + 1]).toBe('mcp__aws-prometheus__*');
      expect(spawnArgs[toolsIdx + 2]).toBe('mcp__aws-cloudwatch__*');
      expect(spawnArgs[toolsIdx + 3]).toBe('Bash');
    });

    it('should add --disallowed-tools with tool patterns', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          disallowedTools: ['Write', 'Edit'],
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--disallowed-tools');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('Write');
      expect(spawnArgs[idx + 2]).toBe('Edit');
    });

    it('should add --append-system-prompt with prompt string', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          appendSystemPrompt: 'You are an observability agent.',
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--append-system-prompt');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('You are an observability agent.');
    });

    it('should use --system-prompt over --append-system-prompt when both set', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          systemPrompt: 'Full system prompt.',
          appendSystemPrompt: 'Appended prompt.',
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--system-prompt');
      expect(spawnArgs).not.toContain('--append-system-prompt');
      const idx = spawnArgs.indexOf('--system-prompt');
      expect(spawnArgs[idx + 1]).toBe('Full system prompt.');
    });

    it('should add --mcp-config with inline JSON', async () => {
      const mcpServers = {
        'aws-prometheus': {
          command: 'python3',
          args: ['/path/to/server.py'],
          env: { AWS_REGION: 'us-east-1' },
        },
      };

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          mcpServers,
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--mcp-config');
      expect(idx).toBeGreaterThan(-1);
      const parsed = JSON.parse(spawnArgs[idx + 1]);
      expect(parsed.mcpServers['aws-prometheus'].command).toBe('python3');
    });

    it('should add --strict-mcp-config flag', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          strictMcpConfig: true,
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--strict-mcp-config');
    });

    it('should use --mcp-config with file path when mcpConfigPath is set', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          mcpConfigPath: './mcp-config.json',
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--mcp-config');
      expect(idx).toBeGreaterThan(-1);
      expect(spawnArgs[idx + 1]).toBe('./mcp-config.json');
    });

    it('should prefer mcpConfigPath over inline mcpServers', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          mcpConfigPath: '/path/to/config.json',
          mcpServers: {
            'some-server': { command: 'node', args: ['server.js'] },
          },
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      const idx = spawnArgs.indexOf('--mcp-config');
      expect(idx).toBeGreaterThan(-1);
      // Should use file path, not inline JSON
      expect(spawnArgs[idx + 1]).toBe('/path/to/config.json');
      expect(spawnArgs[idx + 1]).not.toContain('mcpServers');
    });

    it('should add no extra flags for empty connectorConfig', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {} as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      // Should only have base args + model flag, no config flags
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
      expect(spawnArgs).not.toContain('--allowed-tools');
      expect(spawnArgs).not.toContain('--append-system-prompt');
      expect(spawnArgs).not.toContain('--mcp-config');
      expect(spawnArgs).not.toContain('--strict-mcp-config');
    });

    it('should restore config after execution (session scoping)', async () => {
      // First call with connectorConfig
      const request1: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          dangerouslySkipPermissions: true,
          allowedTools: ['Bash'],
          env: { CUSTOM_VAR: 'custom-value' },
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);
      await connector.execute('claude', request1, mockAuth);

      // Second call without connectorConfig
      const mockProcess2 = createMockProcess();
      (spawn as jest.Mock).mockReturnValue(mockProcess2);

      const request2: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => mockProcess2.emit('close', 0, null), 10);
      await connector.execute('claude', request2, mockAuth);

      // Second call should NOT have config flags from first call
      const spawnArgs2 = (spawn as jest.Mock).mock.calls[1][1] as string[];
      expect(spawnArgs2).not.toContain('--dangerously-skip-permissions');
      expect(spawnArgs2).not.toContain('--allowed-tools');

      // Env from second call should not contain CUSTOM_VAR
      const spawnOpts2 = (spawn as jest.Mock).mock.calls[1][2] as { env: Record<string, string> };
      expect(spawnOpts2.env.CUSTOM_VAR).toBeUndefined();
    });

    it('should switch to arg input mode when usePromptArg is true', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          usePromptArg: true,
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      // When inputMode is 'arg', the prompt is appended to args and stdin is NOT used
      expect(mockProcess.stdin.write).not.toHaveBeenCalled();
    });

    it('should merge connectorConfig.env with default env', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          env: { MY_CUSTOM_VAR: 'my-value', CLAUDE_CODE_USE_BEDROCK: '1' },
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnOpts = (spawn as jest.Mock).mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.MY_CUSTOM_VAR).toBe('my-value');
      expect(spawnOpts.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      // Bedrock mode should also clear ANTHROPIC_API_KEY
      expect(spawnOpts.env.ANTHROPIC_API_KEY).toBe('');
    });

    it('should pass additionalArgs through to CLI', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
        connectorConfig: {
          additionalArgs: ['--max-turns', '50', '--no-cache'],
        } as ClaudeCodeConnectorConfig,
      };

      setTimeout(() => mockProcess.emit('close', 0, null), 10);

      await connector.execute('claude', request, mockAuth);

      const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[];
      expect(spawnArgs).toContain('--max-turns');
      expect(spawnArgs).toContain('50');
      expect(spawnArgs).toContain('--no-cache');
    });
  });
});
