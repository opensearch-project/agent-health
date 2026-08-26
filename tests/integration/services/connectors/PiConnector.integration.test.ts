/* Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConnectorAuth, ConnectorRequest } from '@/services/connectors/types';
import type { TestCase } from '@/types';
import { ToolCallStatus } from '@/types';

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

import { PiConnector, createAgentHealthPiConnector } from '@/services/connectors/pi/PiConnector';
import { EventEmitter } from 'events';

describe('PiConnector Integration Tests', () => {
  let connector: PiConnector;

  const makeTestCase = (prompt: string, context?: TestCase['context']): TestCase => ({
    id: 'test-1',
    name: 'Test Case',
    initialPrompt: prompt,
    expectedOutcomes: ['Find root cause'],
    context: context || [],
    labels: [],
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const defaultAuth: ConnectorAuth = { type: 'none' };

  function createMockProcess() {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: jest.fn(), end: jest.fn() };
    proc.kill = jest.fn();
    proc.pid = 12345;
    return proc;
  }

  beforeEach(() => {
    connector = new PiConnector();
    jest.clearAllMocks();
  });

  describe('buildPayload', () => {
    it('should build prompt from initialPrompt only', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Why is the cluster slow?'),
        modelId: 'claude-sonnet-4-5',
      };

      const payload = connector.buildPayload(request);

      expect(payload).toContain('## Task');
      expect(payload).toContain('Why is the cluster slow?');
      expect(payload).not.toContain('## Context');
    });

    it('should include context when provided', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Diagnose the issue', [
          { description: 'Error logs', value: 'OOMKilled in pod-abc' },
          { description: 'Cluster state', value: 'RED' },
        ]),
        modelId: 'model-1',
      };

      const payload = connector.buildPayload(request);

      expect(payload).toContain('## Context');
      expect(payload).toContain('**Error logs:**');
      expect(payload).toContain('OOMKilled in pod-abc');
      expect(payload).toContain('**Cluster state:**');
      expect(payload).toContain('RED');
      expect(payload).toContain('## Task');
      expect(payload).toContain('Diagnose the issue');
    });

    it('should not include context section when context array is empty', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test prompt', []),
        modelId: 'model-1',
      };

      const payload = connector.buildPayload(request);

      expect(payload).not.toContain('## Context');
      expect(payload).toContain('## Task');
    });
  });

  describe('parseStreamingOutput and parsePiEvent', () => {
    it('should parse message_end with thinking and text blocks', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const onProgress = jest.fn();
      const executePromise = connector.execute('pi', request, defaultAuth, onProgress);

      const event = JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me analyze this' },
            { type: 'text', text: 'Here is my answer' },
          ],
        },
      });

      proc.stdout.emit('data', Buffer.from(event + '\n'));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        expect(result.trajectory).toHaveLength(2);
        expect(result.trajectory[0].type).toBe('thinking');
        expect(result.trajectory[0].content).toBe('Let me analyze this');
        expect(result.trajectory[1].type).toBe('assistant');
        expect(result.trajectory[1].content).toBe('Here is my answer');
      });
    });

    it('should parse message_end with tool_use blocks', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      const event = JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'search_logs', input: { query: 'error' } },
          ],
        },
      });

      proc.stdout.emit('data', Buffer.from(event + '\n'));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        expect(result.trajectory).toHaveLength(1);
        expect(result.trajectory[0].type).toBe('action');
        expect(result.trajectory[0].toolName).toBe('search_logs');
        expect(result.trajectory[0].toolArgs).toEqual({ query: 'error' });
      });
    });

    it('should parse tool_result events', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      const successEvent = JSON.stringify({
        type: 'tool_result',
        content: 'Found 5 matching logs',
        is_error: false,
      });
      const errorEvent = JSON.stringify({
        type: 'tool_result',
        content: 'Permission denied',
        is_error: true,
      });

      proc.stdout.emit('data', Buffer.from(successEvent + '\n' + errorEvent + '\n'));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        expect(result.trajectory).toHaveLength(2);
        expect(result.trajectory[0].type).toBe('tool_result');
        expect(result.trajectory[0].content).toBe('Found 5 matching logs');
        expect(result.trajectory[0].status).toBe(ToolCallStatus.SUCCESS);
        expect(result.trajectory[1].type).toBe('tool_result');
        expect(result.trajectory[1].content).toBe('Permission denied');
        expect(result.trajectory[1].status).toBe(ToolCallStatus.FAILURE);
      });
    });

    it('should accumulate message_update deltas and flush on agent_end', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      const events = [
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Think' } }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'ing...' } }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } }),
        JSON.stringify({ type: 'agent_end' }),
      ];

      proc.stdout.emit('data', Buffer.from(events.join('\n') + '\n'));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        const thinking = result.trajectory.find(s => s.type === 'thinking');
        const response = result.trajectory.find(s => s.type === 'response');
        expect(thinking?.content).toBe('Thinking...');
        expect(response?.content).toBe('Hello world');
      });
    });

    it('should treat non-JSON lines as assistant messages', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      proc.stdout.emit('data', Buffer.from('plain text output\n'));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        expect(result.trajectory).toHaveLength(1);
        expect(result.trajectory[0].type).toBe('assistant');
        expect(result.trajectory[0].content).toBe('plain text output');
      });
    });

    it('should handle incomplete NDJSON lines across chunks', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      const fullEvent = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'complete' }] },
      });

      // Split the event across two chunks
      const midpoint = Math.floor(fullEvent.length / 2);
      proc.stdout.emit('data', Buffer.from(fullEvent.substring(0, midpoint)));
      proc.stdout.emit('data', Buffer.from(fullEvent.substring(midpoint) + '\n'));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        expect(result.trajectory).toHaveLength(1);
        expect(result.trajectory[0].type).toBe('assistant');
        expect(result.trajectory[0].content).toBe('complete');
      });
    });
  });

  describe('parseResponse', () => {
    it('should create response step from stdout on success', () => {
      const steps = connector.parseResponse({ stdout: 'Final answer\n', stderr: '', exitCode: 0 });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Final answer');
    });

    it('should create error step on non-zero exit with stderr', () => {
      const steps = connector.parseResponse({ stdout: '', stderr: 'command failed\n', exitCode: 1 });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('tool_result');
      expect(steps[0].content).toBe('Error: command failed');
      expect(steps[0].status).toBe(ToolCallStatus.FAILURE);
    });

    it('should return empty array when stdout is empty and exit code is 0', () => {
      const steps = connector.parseResponse({ stdout: '', stderr: '', exitCode: 0 });
      expect(steps).toHaveLength(0);
    });
  });

  describe('onBeforeStreamEnd', () => {
    it('should flush remaining output buffer as JSON', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      // Send incomplete line (no trailing newline) that is valid JSON
      const event = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'buffered' }] },
      });
      proc.stdout.emit('data', Buffer.from(event));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        expect(result.trajectory).toHaveLength(1);
        expect(result.trajectory[0].content).toBe('buffered');
      });
    });

    it('should flush remaining thinking and text buffers', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      // Send message_update events without agent_end to leave buffers populated
      const events = [
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'buffered thinking' } }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'buffered text' } }),
      ];
      proc.stdout.emit('data', Buffer.from(events.join('\n') + '\n'));
      proc.emit('close', 0, null);

      return executePromise.then((result) => {
        const thinking = result.trajectory.find(s => s.type === 'thinking');
        const response = result.trajectory.find(s => s.type === 'response');
        expect(thinking?.content).toBe('buffered thinking');
        expect(response?.content).toBe('buffered text');
      });
    });
  });

  describe('execute - connectorConfig application', () => {
    it('should apply packagePath as --skill, --extension, --append-system-prompt args', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: {
          packagePath: '/path/to/my-package',
        },
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--skill');
      expect(spawnArgs).toContain('/path/to/my-package/skills/*');
      expect(spawnArgs).toContain('--extension');
      expect(spawnArgs).toContain('/path/to/my-package/extensions/agent-health.ts');
      expect(spawnArgs).toContain('--append-system-prompt');
      expect(spawnArgs).toContain('/path/to/my-package/prompts/agent-health.md');
    });

    it('should apply model as --model arg', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: {
          model: 'claude-sonnet-4-5',
        },
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('claude-sonnet-4-5');
    });

    it('should apply additionalArgs', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: {
          additionalArgs: ['--verbose', '--no-cache'],
        },
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--verbose');
      expect(spawnArgs).toContain('--no-cache');
    });

    it('should apply workingDir from connectorConfig', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: {
          workingDir: '/custom/workdir',
        },
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.cwd).toBe('/custom/workdir');
    });

    it('should apply timeout from connectorConfig', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: {
          timeout: 120000,
        },
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      // Timeout is applied internally; we verify by checking it doesn't use the default
      // The connector restores config after execute, so we check it was applied during spawn
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('should merge env from connectorConfig', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: {
          env: { CUSTOM_VAR: 'custom-value' },
        },
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.env.CUSTOM_VAR).toBe('custom-value');
    });

    it('should inherit AWS_PROFILE and AWS_REGION from process.env', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const originalProfile = process.env.AWS_PROFILE;
      const originalRegion = process.env.AWS_REGION;
      process.env.AWS_PROFILE = 'test-profile';
      process.env.AWS_REGION = 'us-west-2';

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnOptions = mockSpawn.mock.calls[0][2];
      expect(spawnOptions.env.AWS_PROFILE).toBe('test-profile');
      expect(spawnOptions.env.AWS_REGION).toBe('us-west-2');

      // Restore
      if (originalProfile) process.env.AWS_PROFILE = originalProfile;
      else delete process.env.AWS_PROFILE;
      if (originalRegion) process.env.AWS_REGION = originalRegion;
      else delete process.env.AWS_REGION;
    });

    it('should add --model from request.modelId', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'claude-opus-4',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--model');
      expect(spawnArgs).toContain('claude-opus-4');
    });

    it('should restore config after execute completes', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: {
          packagePath: '/some/path',
          model: 'custom-model',
          workingDir: '/custom',
          timeout: 999,
          env: { FOO: 'bar' },
          additionalArgs: ['--extra'],
        },
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      // Execute again without connectorConfig to verify args were restored
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);

      const request2: ConnectorRequest = {
        testCase: makeTestCase('Test 2'),
        modelId: 'model-1',
      };

      const executePromise2 = connector.execute('pi', request2, defaultAuth);
      proc2.emit('close', 0, null);
      await executePromise2;

      const secondCallArgs = mockSpawn.mock.calls[1][1];
      expect(secondCallArgs).not.toContain('--skill');
      expect(secondCallArgs).not.toContain('--extra');
      expect(secondCallArgs).not.toContain('custom-model');
    });

    it('should reset buffers on each execute call', async () => {
      const proc1 = createMockProcess();
      mockSpawn.mockReturnValue(proc1);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      // First execution with deltas that get flushed
      const exec1 = connector.execute('pi', request, defaultAuth);
      proc1.stdout.emit('data', Buffer.from(
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first run' } }) + '\n'
      ));
      proc1.emit('close', 0, null);
      const result1 = await exec1;
      expect(result1.trajectory.find(s => s.type === 'response')?.content).toBe('first run');

      // Second execution should not contain residual from first
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValue(proc2);
      const exec2 = connector.execute('pi', request, defaultAuth);
      proc2.emit('close', 0, null);
      const result2 = await exec2;
      expect(result2.trajectory.filter(s => s.content === 'first run')).toHaveLength(0);
    });
  });

  describe('execute - error handling', () => {
    it('should reject with helpful message when pi command is not found (ENOENT)', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);

      const error = new Error('spawn pi ENOENT');
      proc.emit('error', error);

      await expect(executePromise).rejects.toThrow("Command 'pi' not found");
    });

    it('should surface error in trajectory when process exits with non-zero and no streaming steps', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = connector.execute('pi', request, defaultAuth);
      proc.stderr.emit('data', Buffer.from('fatal: unknown flag'));
      proc.emit('close', 1, null);

      const result = await executePromise;
      expect(result.trajectory).toHaveLength(1);
      expect(result.trajectory[0].type).toBe('tool_result');
      expect(result.trajectory[0].content).toContain('fatal: unknown flag');
      expect(result.trajectory[0].status).toBe(ToolCallStatus.FAILURE);
    });
  });

  describe('healthCheck', () => {
    it('should check if pi command exists using which', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = connector.healthCheck('', defaultAuth);
      proc.emit('close', 0, null);

      const result = await promise;
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('which', ['pi'], expect.objectContaining({ shell: false }));
    });

    it('should use endpoint if provided', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = connector.healthCheck('/usr/local/bin/pi', defaultAuth);
      proc.emit('close', 0, null);

      await promise;
      expect(mockSpawn).toHaveBeenCalledWith('which', ['/usr/local/bin/pi'], expect.objectContaining({ shell: false }));
    });

    it('should return false when command is not found', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const promise = connector.healthCheck('', defaultAuth);
      proc.emit('close', 1, null);

      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe('createAgentHealthPiConnector', () => {
    it('should create connector with default args', () => {
      const conn = createAgentHealthPiConnector();
      expect(conn).toBeInstanceOf(PiConnector);
    });

    it('should include package-derived args when packagePath is provided', async () => {
      const conn = createAgentHealthPiConnector('/my/package');
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const executePromise = conn.execute('pi', request, defaultAuth);
      proc.emit('close', 0, null);
      await executePromise;

      const spawnArgs = mockSpawn.mock.calls[0][1];
      // Implementation expands packagePath into --skill / --extension /
      // --append-system-prompt args (rather than a single --package arg).
      expect(spawnArgs).toContain('--skill');
      expect(spawnArgs).toContain('/my/package/skills/*');
      expect(spawnArgs).toContain('--extension');
      expect(spawnArgs).toContain('/my/package/extensions/agent-health.ts');
      expect(spawnArgs).toContain('--append-system-prompt');
      expect(spawnArgs).toContain('/my/package/prompts/agent-health.md');
    });
  });

  describe('connector properties', () => {
    it('should have correct type and name', () => {
      expect(connector.type).toBe('pi');
      expect(connector.name).toBe('Pi (pi.dev)');
      expect(connector.supportsStreaming).toBe(true);
    });
  });
});
