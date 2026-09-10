/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClaudeCodeConnector, claudeCodeConnector, createBedrockClaudeCodeConnector, boundToolOutput, CLAUDE_CODE_MAX_TOOL_OUTPUT_CHARS } from '@/connectors/claude-code';
import type { ClaudeCodeConnectorConfig } from '@/connectors/claude-code';
import type { ConnectorRequest, ConnectorAuth } from '@/connectors/types';
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

  // Regression: the registry hands out a SINGLETON connector shared by all
  // concurrent benchmark tasks. Building per-execution args by appending to
  // this.config.args compounded another in-flight execution's config args —
  // spawns were observed with --append-system-prompt / --allowed-tools
  // duplicated up to 5x at benchmark concurrency 3.
  describe('concurrent executions (shared singleton instance)', () => {
    it('does not duplicate config args across overlapping executions', async () => {
      const procs: any[] = [];
      (spawn as jest.Mock).mockClear();
      (spawn as jest.Mock).mockImplementation(() => {
        const proc: any = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write: jest.fn(), end: jest.fn() };
        proc.pid = 100 + procs.length;
        proc.kill = jest.fn();
        procs.push(proc);
        return proc;
      });

      const connectorConfig: ClaudeCodeConnectorConfig = {
        appendSystemPrompt: 'Answer from the corpus only.',
        allowedTools: ['Read', 'Grep', 'Glob'],
      };
      const mkRequest = (id: string): ConnectorRequest => ({
        testCase: { ...mockTestCase, id },
        modelId: 'test-model',
        connectorConfig: connectorConfig as any,
      });

      // Start three overlapping executions before any of them finishes.
      const e1 = connector.execute('claude', mkRequest('tc-1'), mockAuth);
      const e2 = connector.execute('claude', mkRequest('tc-2'), mockAuth);
      const e3 = connector.execute('claude', mkRequest('tc-3'), mockAuth);

      // Let them all spawn, then close in reverse order to exercise the
      // finally-restore path interleaving.
      await new Promise((r) => setTimeout(r, 10));
      for (const proc of [...procs].reverse()) proc.emit('close', 0, null);
      await Promise.all([e1, e2, e3]);

      expect(procs.length).toBe(3);
      const calls = (spawn as jest.Mock).mock.calls.slice(-3);
      for (const [, args] of calls) {
        const appendCount = (args as string[]).filter((a) => a === '--append-system-prompt').length;
        const allowedCount = (args as string[]).filter((a) => a === '--allowed-tools').length;
        expect(appendCount).toBe(1);
        expect(allowedCount).toBe(1);
      }
    });

    it('sequential executions also build args from the pristine base', async () => {
      const connectorConfig: ClaudeCodeConnectorConfig = { appendSystemPrompt: 'p' };
      for (let i = 0; i < 3; i++) {
        setTimeout(() => mockProcess.emit('close', 0, null), 5);
        await connector.execute('claude', {
          testCase: mockTestCase,
          modelId: 'test-model',
          connectorConfig: connectorConfig as any,
        }, mockAuth);
      }
      const lastArgs = (spawn as jest.Mock).mock.calls.at(-1)![1] as string[];
      expect(lastArgs.filter((a) => a === '--append-system-prompt').length).toBe(1);
    });

    // Regression (P0, cross-run data corruption): `sessionId` used to be
    // INSTANCE state on the shared singleton. With two evaluation runs in
    // flight, whichever child process emitted its stream-json last set
    // `this.sessionId`, and BOTH results reported it — one run's report
    // carried the other run's session id, so the trace poller (Strategy D,
    // session.id correlation) fetched the FOREIGN case's spans and replaced
    // the trajectory: cases were judged on another case's tool calls
    // (measured live: 11/62 reports cross-wired). Session capture must be
    // per-invocation.
    it('two interleaved executions each return their OWN session id (no cross-wiring)', async () => {
      const procs: any[] = [];
      (spawn as jest.Mock).mockClear();
      (spawn as jest.Mock).mockImplementation(() => {
        const proc: any = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write: jest.fn(), end: jest.fn() };
        proc.pid = 200 + procs.length;
        proc.kill = jest.fn();
        procs.push(proc);
        return proc;
      });

      const e1 = connector.execute('claude', { testCase: { ...mockTestCase, id: 'tc-A' }, modelId: 'm' }, mockAuth);
      const e2 = connector.execute('claude', { testCase: { ...mockTestCase, id: 'tc-B' }, modelId: 'm' }, mockAuth);
      await new Promise((r) => setTimeout(r, 5));
      expect(procs.length).toBe(2);
      const [pA, pB] = procs;

      // Deterministic interleaving of the real race window. Every stream-json
      // event carries `session_id`, so the instance field was re-stamped on
      // each data event — the corruption needs a SIBLING's data event to land
      // between a run's last stdout chunk and its `close` (separate event-loop
      // ticks in a real child process; routine under concurrency > 1):
      //   A: init + result (sess-A) → B: init (sess-B) → A: close.
      // Pre-fix, A's result read `this.sessionId === 'sess-B'`.
      pA.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"sess-A"}\n'));
      pA.stdout.emit('data', Buffer.from('{"type":"result","result":"answer A","session_id":"sess-A"}\n'));
      pB.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"sess-B"}\n'));
      pA.emit('close', 0, null);
      const rA = await e1;

      pB.stdout.emit('data', Buffer.from('{"type":"result","result":"answer B","session_id":"sess-B"}\n'));
      pB.emit('close', 0, null);
      const rB = await e2;

      expect(rA.metadata?.sessionId).toBe('sess-A');
      expect(rB.metadata?.sessionId).toBe('sess-B');
      // Trajectories must not bleed either (the NDJSON line buffer was also
      // instance state).
      expect(rA.trajectory.map((s) => s.content)).toEqual(['answer A']);
      expect(rB.trajectory.map((s) => s.content)).toEqual(['answer B']);
    });

    it('interleaved partial NDJSON chunks are buffered per execution, not per instance', async () => {
      const procs: any[] = [];
      (spawn as jest.Mock).mockClear();
      (spawn as jest.Mock).mockImplementation(() => {
        const proc: any = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write: jest.fn(), end: jest.fn() };
        proc.pid = 300 + procs.length;
        proc.kill = jest.fn();
        procs.push(proc);
        return proc;
      });

      const e1 = connector.execute('claude', { testCase: { ...mockTestCase, id: 'tc-A' }, modelId: 'm' }, mockAuth);
      const e2 = connector.execute('claude', { testCase: { ...mockTestCase, id: 'tc-B' }, modelId: 'm' }, mockAuth);
      await new Promise((r) => setTimeout(r, 5));
      const [pA, pB] = procs;

      // Each process delivers ONE JSON line split across two chunks, and the
      // chunks of A and B arrive interleaved at arbitrary byte boundaries.
      const lineA = '{"type":"assistant","message":{"content":[{"type":"text","text":"from A"}]},"session_id":"sess-A"}\n';
      const lineB = '{"type":"assistant","message":{"content":[{"type":"text","text":"from B"}]},"session_id":"sess-B"}\n';
      pA.stdout.emit('data', Buffer.from(lineA.slice(0, 37)));
      pB.stdout.emit('data', Buffer.from(lineB.slice(0, 22)));
      pA.stdout.emit('data', Buffer.from(lineA.slice(37)));
      pB.stdout.emit('data', Buffer.from(lineB.slice(22)));
      pA.emit('close', 0, null);
      pB.emit('close', 0, null);
      const [rA, rB] = await Promise.all([e1, e2]);

      expect(rA.trajectory.map((s) => s.content)).toEqual(['from A']);
      expect(rB.trajectory.map((s) => s.content)).toEqual(['from B']);
      expect(rA.metadata?.sessionId).toBe('sess-A');
      expect(rB.metadata?.sessionId).toBe('sess-B');
    });
  });

  // Regression (codex_review finding on this fix): per-execution options used
  // to be applied by MUTATING the shared singleton's `this.config` and
  // restoring it in `finally`. That only held while no `await` separated the
  // write from every read; a callback reading `this.config` after the first
  // await saw whichever concurrent execution wrote last. Options are now
  // resolved into an immutable per-call snapshot and `this.config` is never
  // written during execution.
  describe('per-execution config isolation (shared singleton instance)', () => {
    function spawnCollector() {
      const procs: any[] = [];
      (spawn as jest.Mock).mockClear();
      (spawn as jest.Mock).mockImplementation(() => {
        const proc: any = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write: jest.fn(), end: jest.fn() };
        proc.pid = 400 + procs.length;
        proc.kill = jest.fn();
        procs.push(proc);
        return proc;
      });
      return procs;
    }

    it('concurrent executions with different connectorConfigs each spawn with their own args/env/cwd', async () => {
      const procs = spawnCollector();
      const e1 = connector.execute('claude', {
        testCase: { ...mockTestCase, id: 'tc-A' }, modelId: 'm',
        connectorConfig: { appendSystemPrompt: 'prompt A', env: { WHO: 'A' }, workingDir: '/tmp/a', allowedTools: ['Read'] } as any,
      }, mockAuth);
      const e2 = connector.execute('claude', {
        testCase: { ...mockTestCase, id: 'tc-B' }, modelId: 'm',
        connectorConfig: { systemPrompt: 'prompt B', env: { WHO: 'B' }, workingDir: '/tmp/b', usePromptArg: true } as any,
      }, mockAuth);
      await new Promise((r) => setTimeout(r, 5));
      expect(procs.length).toBe(2);
      for (const p of procs) p.emit('close', 0, null);
      await Promise.all([e1, e2]);

      const [[, argsA, optsA], [, argsB, optsB]] = (spawn as jest.Mock).mock.calls;
      expect(argsA).toContain('--append-system-prompt');
      expect(argsA[argsA.indexOf('--append-system-prompt') + 1]).toBe('prompt A');
      expect(argsA).toContain('--allowed-tools');
      expect(argsA).not.toContain('--system-prompt');
      expect(optsA.env.WHO).toBe('A');
      expect(optsA.cwd).toBe('/tmp/a');
      // A used stdin; B used --print with the prompt as an argv slot.
      expect(procs[0].stdin.write).toHaveBeenCalled();

      expect(argsB).toContain('--system-prompt');
      expect(argsB[argsB.indexOf('--system-prompt') + 1]).toBe('prompt B');
      expect(argsB).not.toContain('--append-system-prompt');
      expect(argsB).not.toContain('--allowed-tools');
      expect(optsB.env.WHO).toBe('B');
      expect(optsB.cwd).toBe('/tmp/b');
      expect(argsB.at(-1)).toContain('## Task'); // usePromptArg → prompt appended as arg
      expect(procs[1].stdin.write).not.toHaveBeenCalled();
    });

    it('never writes per-execution options onto the shared this.config (not even transiently)', async () => {
      const procs = spawnCollector();
      const cfg = (connector as any).config;
      const before = JSON.stringify(cfg);
      const pending = connector.execute('claude', {
        testCase: mockTestCase, modelId: 'm',
        connectorConfig: { appendSystemPrompt: 'p', env: { X: '1' }, timeout: 123, workingDir: '/tmp/x', usePromptArg: true } as any,
      }, mockAuth);
      // Mid-execution (child spawned, not yet closed): the shared config is untouched.
      await new Promise((r) => setTimeout(r, 5));
      expect(JSON.stringify((connector as any).config)).toBe(before);
      expect((connector as any).config.args).not.toContain('--append-system-prompt');
      procs[0].emit('close', 0, null);
      await pending;
      expect(JSON.stringify((connector as any).config)).toBe(before);
      // …while the spawned child DID get the per-execution options.
      const [, args, opts] = (spawn as jest.Mock).mock.calls[0];
      expect(args).toContain('--append-system-prompt');
      expect(opts.env.X).toBe('1');
      expect(opts.cwd).toBe('/tmp/x');
    });
  });

  // Regression (P1, evidence fidelity): tool results used to be persisted
  // without a `toolName` or `toolOutput` (only `content`), so the span-derived
  // "tool succeeded" stubs replaced them and the judge saw 0 bytes of output
  // while `report.rawEvents` held the full results (up to ~28 KB each).
  // Results are now paired with their `tool_use` by `tool_use_id` and carry
  // the (bounded) output on both `content` and `toolOutput`.
  describe('tool_use ↔ tool_result pairing with real outputs', () => {
    /**
     * Synthesized stream-json session (no internal data): an init event, an
     * assistant turn with two tool_use blocks, the two matching tool_result
     * user events (one string content, one content-block array like MCP tools
     * emit), and the final result. Emitted as raw stdout chunks split at
     * arbitrary byte boundaries — the connector must concatenate and re-split
     * on newlines exactly like it does against a real child process.
     */
    const bigOutput = 'x'.repeat(20_000);
    const events = [
      { type: 'system', subtype: 'init', session_id: 'sess-fixture' },
      {
        type: 'assistant',
        session_id: 'sess-fixture',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/tmp/a.txt' } },
            { type: 'tool_use', id: 'toolu_02', name: 'mcp__search__SearchIndexTool', input: { index: 'kb', query: 'q' } },
          ],
        },
      },
      {
        type: 'user',
        session_id: 'sess-fixture',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'line1\nline2' }] },
        tool_use_result: { type: 'text', file: { filePath: '/tmp/a.txt', content: 'line1\nline2' } },
      },
      {
        type: 'user',
        session_id: 'sess-fixture',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_02',
            content: [{ type: 'text', text: `Search results (JSON): ${bigOutput}` }],
          }],
        },
        tool_use_result: [{ type: 'text', text: `Search results (JSON): ${bigOutput}` }],
      },
      { type: 'result', subtype: 'success', result: 'Final answer', session_id: 'sess-fixture' },
    ];
    const stream = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

    function emitInArbitraryChunks(proc: any, text: string, sizes = [11, 97, 4000, 250]) {
      let i = 0; let k = 0;
      while (i < text.length) {
        const n = sizes[k++ % sizes.length];
        proc.stdout.emit('data', Buffer.from(text.slice(i, i + n)));
        i += n;
      }
    }

    it('pairs each tool_result with its tool_use and populates toolName + toolOutput', async () => {
      const request: ConnectorRequest = { testCase: mockTestCase, modelId: 'm' };
      setTimeout(() => {
        emitInArbitraryChunks(mockProcess, stream);
        mockProcess.emit('close', 0, null);
      }, 5);
      const result = await connector.execute('claude', request, mockAuth);

      const results = result.trajectory.filter((s) => s.type === 'tool_result');
      expect(results).toHaveLength(2);

      expect(results[0].toolName).toBe('Read');
      expect(results[0].content).toBe('line1\nline2');
      expect(results[0].toolOutput).toBe('line1\nline2');
      expect(results[0].status).toBe('SUCCESS');

      // Content-block arrays are flattened to the text the model saw.
      expect(results[1].toolName).toBe('mcp__search__SearchIndexTool');
      expect(results[1].content.startsWith('Search results (JSON): xxxx')).toBe(true);
      expect(results[1].toolOutput).toBe(results[1].content);
      expect((results[1].toolOutput as string).length).toBeGreaterThan(20_000);

      // Actions still carry the tool name/args, and the answer is intact.
      const actions = result.trajectory.filter((s) => s.type === 'action');
      expect(actions.map((a) => a.toolName)).toEqual(['Read', 'mcp__search__SearchIndexTool']);
      expect(result.trajectory.at(-1)).toMatchObject({ type: 'response', content: 'Final answer' });
      expect(result.metadata?.sessionId).toBe('sess-fixture');
    });

    it('bounds oversized outputs with an explicit truncation marker carrying the full length', async () => {
      const huge = 'y'.repeat(CLAUDE_CODE_MAX_TOOL_OUTPUT_CHARS + 5_000);
      const line =
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big' } }] } }) + '\n' +
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] } }) + '\n';
      setTimeout(() => {
        emitInArbitraryChunks(mockProcess, line, [8192]);
        mockProcess.emit('close', 0, null);
      }, 5);
      const result = await connector.execute('claude', { testCase: mockTestCase, modelId: 'm' }, mockAuth);
      const tr = result.trajectory.find((s) => s.type === 'tool_result')!;
      expect(tr.toolName).toBe('Bash');
      expect((tr.toolOutput as string).length).toBeLessThan(huge.length);
      expect(tr.toolOutput).toMatch(/\[tool output truncated: showing \d+ of \d+ chars\]$/);
      expect(tr.toolOutput).toContain(`of ${huge.length} chars`);
      expect((tr.toolOutput as string).startsWith('y'.repeat(CLAUDE_CODE_MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    });

    it('falls back to the event-level tool_use_result when the block has no content', async () => {
      const line =
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'q' } }] } }) + '\n' +
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] }, tool_use_result: { matches: ['a', 'b'] } }) + '\n';
      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(line));
        mockProcess.emit('close', 0, null);
      }, 5);
      const result = await connector.execute('claude', { testCase: mockTestCase, modelId: 'm' }, mockAuth);
      const tr = result.trajectory.find((s) => s.type === 'tool_result')!;
      expect(tr.toolName).toBe('ToolSearch');
      expect(tr.toolOutput).toBe(JSON.stringify({ matches: ['a', 'b'] }));
    });

    it('an unmatched tool_result (unknown tool_use_id) still keeps its output, without a toolName', async () => {
      const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'orphan output', is_error: true }] } }) + '\n';
      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(line));
        mockProcess.emit('close', 0, null);
      }, 5);
      const result = await connector.execute('claude', { testCase: mockTestCase, modelId: 'm' }, mockAuth);
      const tr = result.trajectory.find((s) => s.type === 'tool_result')!;
      expect(tr.toolName).toBeUndefined();
      expect(tr.toolOutput).toBe('orphan output');
      expect(tr.status).toBe('FAILURE');
    });

    it('boundToolOutput is the identity below the cap', () => {
      expect(boundToolOutput('short')).toBe('short');
      expect(boundToolOutput('abc', 3)).toBe('abc');
      expect(boundToolOutput('abcd', 3)).toBe('abc\n… [tool output truncated: showing 3 of 4 chars]');
    });
  });
});
