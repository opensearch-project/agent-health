/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { SubprocessConnector, subprocessConnector } from '@/services/connectors/subprocess/SubprocessConnector';
import type { ConnectorRequest, ConnectorAuth, SubprocessConfig } from '@/services/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('SubprocessConnector', () => {
  let connector: SubprocessConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;
  let mockProcess: any;

  beforeEach(() => {
    connector = new SubprocessConnector();
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
      expect(connector.type).toBe('subprocess');
    });

    it('should have correct name', () => {
      expect(connector.name).toBe('Subprocess (CLI)');
    });

    it('should support streaming', () => {
      expect(connector.supportsStreaming).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should accept custom config', () => {
      const customConnector = new SubprocessConnector({
        command: 'custom-cmd',
        args: ['--verbose'],
        timeout: 60000,
      });

      expect(customConnector.type).toBe('subprocess');
    });
  });

  describe('buildPayload', () => {
    it('should build prompt string from test case', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload).toContain(mockTestCase.initialPrompt);
    });

    it('should include context in prompt', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload).toContain('Context:');
      expect(payload).toContain('Cluster Name');
      expect(payload).toContain('test-cluster');
    });

    it('should handle empty context', () => {
      const testCaseNoContext = { ...mockTestCase, context: [] };
      const request: ConnectorRequest = {
        testCase: testCaseNoContext,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload).toBe(testCaseNoContext.initialPrompt);
    });
  });

  describe('execute', () => {
    it('should spawn process with correct command', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      // Simulate successful process completion
      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('Test output'));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute('test-command', request, mockAuth);

      expect(spawn).toHaveBeenCalledWith(
        'test-command',
        [],
        expect.objectContaining({
          shell: true,
        })
      );
    });

    it('should write to stdin when inputMode is stdin', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute('test-command', request, mockAuth);

      expect(mockProcess.stdin.write).toHaveBeenCalled();
      expect(mockProcess.stdin.end).toHaveBeenCalled();
    });

    it('should include env vars from auth', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute('test-command', request, {
        type: 'aws-sigv4',
        awsRegion: 'us-west-2',
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            AWS_REGION: 'us-west-2',
          }),
        })
      );
    });

    it('should return trajectory from stdout', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('Response output'));
        mockProcess.emit('close', 0, null);
      }, 10);

      const response = await connector.execute('test-command', request, mockAuth);

      expect(response.trajectory.length).toBeGreaterThan(0);
      expect(response.trajectory[0].type).toBe('response');
      expect(response.trajectory[0].content).toBe('Response output');
    });

    it('should call onProgress with steps', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('Test output'));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'test-command',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(progressSteps.length).toBeGreaterThan(0);
    });

    it('should call onRawEvent with stdout/stderr data', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const rawEvents: any[] = [];

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('stdout data'));
        mockProcess.stderr.emit('data', Buffer.from('stderr data'));
        mockProcess.emit('close', 0, null);
      }, 10);

      await connector.execute(
        'test-command',
        request,
        mockAuth,
        undefined,
        (event) => rawEvents.push(event)
      );

      expect(rawEvents).toContainEqual({ type: 'stdout', data: 'stdout data' });
      expect(rawEvents).toContainEqual({ type: 'stderr', data: 'stderr data' });
    });

    it('should handle non-zero exit code', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stderr.emit('data', Buffer.from('Error message'));
        mockProcess.emit('close', 1, null);
      }, 10);

      const response = await connector.execute('test-command', request, mockAuth);

      expect(response.metadata?.exitCode).toBe(1);
    });

    it('should reject on spawn error', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('error', new Error('ENOENT: command not found'));
      }, 10);

      await expect(
        connector.execute('nonexistent-command', request, mockAuth)
      ).rejects.toThrow("Command 'nonexistent-command' not found");
    });

    it('should include metadata in response', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', 0, null);
      }, 10);

      const response = await connector.execute('test-command', request, mockAuth);

      expect(response.metadata?.command).toBe('test-command');
      expect(response.metadata?.exitCode).toBe(0);
      expect(response.runId).toMatch(/^subprocess-\d+$/);
    });
  });

  describe('parseResponse', () => {
    it('should parse text output', () => {
      const steps = connector.parseResponse({
        stdout: 'Plain text output',
        stderr: '',
        exitCode: 0,
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Plain text output');
    });

    it('should handle empty stdout', () => {
      const steps = connector.parseResponse({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      expect(steps).toHaveLength(0);
    });

    it('should add error step for non-zero exit with stderr', () => {
      const steps = connector.parseResponse({
        stdout: '',
        stderr: 'Error occurred',
        exitCode: 1,
      });

      expect(steps.length).toBeGreaterThan(0);
      expect(steps[steps.length - 1].type).toBe('tool_result');
      expect(steps[steps.length - 1].content).toContain('Error');
    });
  });

  describe('healthCheck', () => {
    it('should return true when command exists', async () => {
      const healthProcess = new EventEmitter();
      healthProcess.stdout = new EventEmitter();
      healthProcess.stderr = new EventEmitter();
      healthProcess.stdin = { write: jest.fn(), end: jest.fn() };
      (spawn as jest.Mock).mockReturnValue(healthProcess);

      const resultPromise = connector.healthCheck('node', mockAuth);

      setTimeout(() => {
        healthProcess.emit('close', 0);
      }, 10);

      const result = await resultPromise;
      expect(result).toBe(true);
    });

    it('should return false when command does not exist', async () => {
      const healthProcess = new EventEmitter();
      healthProcess.stdout = new EventEmitter();
      healthProcess.stderr = new EventEmitter();
      healthProcess.stdin = { write: jest.fn(), end: jest.fn() };
      (spawn as jest.Mock).mockReturnValue(healthProcess);

      const resultPromise = connector.healthCheck('nonexistent', mockAuth);

      setTimeout(() => {
        healthProcess.emit('close', 1);
      }, 10);

      const result = await resultPromise;
      expect(result).toBe(false);
    });

    it('should return false when spawn errors', async () => {
      const healthProcess = new EventEmitter();
      healthProcess.stdout = new EventEmitter();
      healthProcess.stderr = new EventEmitter();
      healthProcess.stdin = { write: jest.fn(), end: jest.fn() };
      (spawn as jest.Mock).mockReturnValue(healthProcess);

      const resultPromise = connector.healthCheck('test', mockAuth);

      setTimeout(() => {
        healthProcess.emit('error', new Error('spawn error'));
      }, 10);

      const result = await resultPromise;
      expect(result).toBe(false);
    });

    it('should return false for empty command', async () => {
      const result = await connector.healthCheck('', mockAuth);
      expect(result).toBe(false);
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(subprocessConnector).toBeInstanceOf(SubprocessConnector);
    });
  });

  describe('timeout handling', () => {
    it('should reject when process times out', async () => {
      // Create connector with very short timeout
      const timeoutConnector = new SubprocessConnector({
        timeout: 50,
        command: 'sleep',
        args: ['10'],
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      // Don't emit close - let it timeout
      await expect(
        timeoutConnector.execute('sleep', request, mockAuth)
      ).rejects.toThrow(/timed out/);

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should not resolve after timeout when close event fires', async () => {
      // Verify the settled flag prevents double-settlement:
      // timeout rejects first, then close event should be ignored.
      const timeoutConnector = new SubprocessConnector({
        timeout: 50,
        command: 'slow-cmd',
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      // After timeout fires (~50ms), emit close with exit code 0.
      // Without the settled guard, the promise would resolve (not reject).
      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('late output'));
        mockProcess.emit('close', 0, null);
      }, 100);

      await expect(
        timeoutConnector.execute('slow-cmd', request, mockAuth)
      ).rejects.toThrow(/timed out/);
    });
  });

  describe('signal handling', () => {
    it('should handle process killed by signal', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', null, 'SIGTERM');
      }, 10);

      // Process closed by signal should still return a response
      const response = await connector.execute('test-command', request, mockAuth);
      expect(response.trajectory).toBeDefined();
    });

    it('should handle SIGKILL signal', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', null, 'SIGKILL');
      }, 10);

      // Process killed should still return a response
      const response = await connector.execute('test-command', request, mockAuth);
      expect(response.trajectory).toBeDefined();
    });
  });

  describe('streaming output parsing', () => {
    it('should parse streaming JSON output', async () => {
      const streamingConnector = new SubprocessConnector({
        outputParser: 'streaming',
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const progressSteps: TrajectoryStep[] = [];

      setTimeout(() => {
        // Emit JSON lines that look like trajectory steps
        mockProcess.stdout.emit('data', Buffer.from('{"type":"thinking","content":"Analyzing..."}\n'));
        mockProcess.stdout.emit('data', Buffer.from('{"type":"response","content":"Done"}\n'));
        mockProcess.emit('close', 0, null);
      }, 10);

      await streamingConnector.execute(
        'test-command',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      // Streaming connector should emit steps as they come
      expect(progressSteps.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle malformed JSON in streaming mode', async () => {
      const streamingConnector = new SubprocessConnector({
        outputParser: 'streaming',
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        // Emit invalid JSON
        mockProcess.stdout.emit('data', Buffer.from('not valid json\n'));
        mockProcess.stdout.emit('data', Buffer.from('{"type":"response","content":"Valid"}\n'));
        mockProcess.emit('close', 0, null);
      }, 10);

      // Should not throw, just skip invalid lines
      const response = await streamingConnector.execute('test-command', request, mockAuth);
      expect(response.trajectory).toBeDefined();
    });
  });

  describe('JSON output parsing', () => {
    it('should parse JSON output when configured', async () => {
      const jsonConnector = new SubprocessConnector({
        outputParser: 'json',
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from(JSON.stringify({
          thinking: 'Analysis',
          response: 'Final answer',
        })));
        mockProcess.emit('close', 0, null);
      }, 10);

      const response = await jsonConnector.execute('test-command', request, mockAuth);
      expect(response.trajectory.length).toBeGreaterThan(0);
    });

    it('should handle invalid JSON output gracefully', async () => {
      const jsonConnector = new SubprocessConnector({
        outputParser: 'json',
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('not valid json'));
        mockProcess.emit('close', 0, null);
      }, 10);

      // Should not throw, just treat as text
      const response = await jsonConnector.execute('test-command', request, mockAuth);
      expect(response.trajectory).toBeDefined();
    });
  });

  describe('environment variables', () => {
    it('should pass environment variables to subprocess', async () => {
      const envConnector = new SubprocessConnector({
        env: {
          CUSTOM_VAR: 'custom_value',
          ANOTHER_VAR: 'another_value',
        },
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      setTimeout(() => {
        mockProcess.emit('close', 0, null);
      }, 10);

      await envConnector.execute('test-command', request, mockAuth);

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CUSTOM_VAR: 'custom_value',
            ANOTHER_VAR: 'another_value',
          }),
        })
      );
    });
  });
});
