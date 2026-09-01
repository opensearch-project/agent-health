/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { StrandsConnector, strandsConnector } from '@/connectors/strands';
import type { ConnectorRequest, ConnectorAuth } from '@/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';

// Mock AWS SDK modules
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  InvokeAgentCommand: jest.fn().mockImplementation((params: any) => params),
}));

const mockAgentSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({
    send: mockAgentSend,
  })),
  GetAgentCommand: jest.fn().mockImplementation((params: any) => params),
}));

describe('StrandsConnector', () => {
  let connector: StrandsConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;

  beforeEach(() => {
    connector = new StrandsConnector();
    mockTestCase = {
      id: 'tc-123',
      name: 'Test Case',
      initialPrompt: 'Diagnose the issue',
      context: [{ description: 'Service', value: 'my-service' }],
      expectedOutcomes: ['Identify root cause'],
      labels: [],
      tools: ['search_logs'],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockAuth = { type: 'aws-sigv4', awsRegion: 'us-west-2' };
    mockSend.mockReset();
    mockAgentSend.mockReset();
  });

  describe('properties', () => {
    it('should have correct type', () => {
      expect(connector.type).toBe('strands');
    });

    it('should have correct name', () => {
      expect(connector.name).toBe('Amazon Strands');
    });

    it('should support streaming', () => {
      expect(connector.supportsStreaming).toBe(true);
    });
  });

  describe('buildPayload', () => {
    it('should build payload with agent input text', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
      };

      const payload = connector.buildPayload(request);

      expect(payload.inputText).toBe('Diagnose the issue');
      expect(payload.agentAliasId).toBe('TSTALIASID');
      expect(payload.enableTrace).toBe(true);
      expect(payload.sessionId).toMatch(/^eval-/);
    });

    it('should use custom agentAliasId from connectorConfig', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        connectorConfig: { agentAliasId: 'CUSTOM123' },
      };

      const payload = connector.buildPayload(request);

      expect(payload.agentAliasId).toBe('CUSTOM123');
    });

    it('should use custom sessionId from connectorConfig', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        connectorConfig: { sessionId: 'my-session' },
      };

      const payload = connector.buildPayload(request);

      expect(payload.sessionId).toBe('my-session');
    });

    it('should allow disabling trace', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        connectorConfig: { enableTrace: false },
      };

      const payload = connector.buildPayload(request);

      expect(payload.enableTrace).toBe(false);
    });
  });

  describe('execute', () => {
    function createStreamingResponse(events: any[]) {
      return {
        completion: (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
      };
    }

    it('should invoke Bedrock agent with correct parameters', async () => {
      mockSend.mockResolvedValue(createStreamingResponse([
        { chunk: { bytes: new TextEncoder().encode('Hello') } },
      ]));

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        connectorConfig: { agentAliasId: 'ALIAS1' },
      };

      await connector.execute('AGENT123', request, mockAuth);

      const { InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
      expect(InvokeAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'AGENT123',
          agentAliasId: 'ALIAS1',
          inputText: 'Diagnose the issue',
          enableTrace: true,
        })
      );
    });

    it('should accumulate chunk bytes into final response', async () => {
      mockSend.mockResolvedValue(createStreamingResponse([
        { chunk: { bytes: new TextEncoder().encode('Hello ') } },
        { chunk: { bytes: new TextEncoder().encode('World') } },
      ]));

      const request: ConnectorRequest = { testCase: mockTestCase };
      const result = await connector.execute('AGENT123', request, mockAuth);

      const responseStep = result.trajectory.find(s => s.type === 'response');
      expect(responseStep).toBeDefined();
      expect(responseStep!.content).toBe('Hello World');
    });

    it('should parse trace events into trajectory steps', async () => {
      mockSend.mockResolvedValue(createStreamingResponse([
        {
          trace: {
            trace: {
              orchestrationTrace: {
                rationale: { text: 'I should search the logs' },
              },
            },
          },
        },
        {
          trace: {
            trace: {
              orchestrationTrace: {
                invocationInput: {
                  actionGroupInvocationInput: {
                    actionGroupName: 'tools',
                    function: 'search_logs',
                    parameters: [{ name: 'query', value: 'error' }],
                  },
                },
              },
            },
          },
        },
        {
          trace: {
            trace: {
              orchestrationTrace: {
                observation: {
                  actionGroupInvocationOutput: { text: 'Found 5 errors' },
                },
              },
            },
          },
        },
        { chunk: { bytes: new TextEncoder().encode('The issue is...') } },
      ]));

      const request: ConnectorRequest = { testCase: mockTestCase };
      const progressSteps: TrajectoryStep[] = [];

      const result = await connector.execute(
        'AGENT123',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(result.trajectory.length).toBeGreaterThanOrEqual(4);
      expect(progressSteps.length).toBe(result.trajectory.length);

      // Verify step types
      const thinking = result.trajectory.find(s => s.type === 'thinking');
      expect(thinking).toBeDefined();
      expect(thinking!.content).toContain('search the logs');

      const action = result.trajectory.find(s => s.type === 'action');
      expect(action).toBeDefined();
      expect(action!.toolName).toContain('search_logs');

      const toolResult = result.trajectory.find(s => s.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.content).toBe('Found 5 errors');

      const response = result.trajectory.find(s => s.type === 'response');
      expect(response).toBeDefined();
      expect(response!.content).toBe('The issue is...');
    });

    it('should call onRawEvent for each event', async () => {
      const events = [
        { chunk: { bytes: new TextEncoder().encode('Hi') } },
      ];
      mockSend.mockResolvedValue(createStreamingResponse(events));

      const request: ConnectorRequest = { testCase: mockTestCase };
      const rawEvents: any[] = [];

      await connector.execute(
        'AGENT123',
        request,
        mockAuth,
        undefined,
        (event) => rawEvents.push(event)
      );

      expect(rawEvents.length).toBeGreaterThan(0);
    });

    it('should use explicit AWS credentials when provided', async () => {
      mockSend.mockResolvedValue(createStreamingResponse([]));

      const request: ConnectorRequest = { testCase: mockTestCase };
      const authWithCreds: ConnectorAuth = {
        type: 'aws-sigv4',
        awsRegion: 'eu-west-1',
        awsAccessKeyId: 'AKID',
        awsSecretAccessKey: 'SECRET',
        awsSessionToken: 'TOKEN',
      };

      await connector.execute('AGENT123', request, authWithCreds);

      const { BedrockAgentRuntimeClient } = require('@aws-sdk/client-bedrock-agent-runtime');
      expect(BedrockAgentRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'eu-west-1',
          credentials: expect.objectContaining({
            accessKeyId: 'AKID',
            secretAccessKey: 'SECRET',
            sessionToken: 'TOKEN',
          }),
        })
      );
    });

    it('should return metadata with agent and session info', async () => {
      mockSend.mockResolvedValue(createStreamingResponse([]));

      const request: ConnectorRequest = { testCase: mockTestCase };
      const result = await connector.execute('AGENT123', request, mockAuth);

      expect(result.metadata).toEqual(expect.objectContaining({
        agentId: 'AGENT123',
        region: 'us-west-2',
      }));
      expect(result.runId).toBeDefined();
    });

    it('should not produce duplicate response steps when trace emits finalResponse and chunks are present', async () => {
      mockSend.mockResolvedValue(createStreamingResponse([
        {
          trace: {
            trace: {
              orchestrationTrace: {
                observation: {
                  finalResponse: { text: 'Final from trace' },
                },
              },
            },
          },
        },
        { chunk: { bytes: new TextEncoder().encode('Final from chunks') } },
      ]));

      const request: ConnectorRequest = { testCase: mockTestCase };
      const result = await connector.execute('AGENT123', request, mockAuth);

      const responseSteps = result.trajectory.filter(s => s.type === 'response');
      expect(responseSteps).toHaveLength(1);
      expect(responseSteps[0].content).toBe('Final from trace');
    });

    it('should default region to us-east-1 when not specified', async () => {
      mockSend.mockResolvedValue(createStreamingResponse([]));

      const request: ConnectorRequest = { testCase: mockTestCase };
      const noRegionAuth: ConnectorAuth = { type: 'none' };

      // Remove env var to test default
      const originalRegion = process.env.AWS_REGION;
      delete process.env.AWS_REGION;

      await connector.execute('AGENT123', request, noRegionAuth);

      const { BedrockAgentRuntimeClient } = require('@aws-sdk/client-bedrock-agent-runtime');
      const callArgs = BedrockAgentRuntimeClient.mock.calls[BedrockAgentRuntimeClient.mock.calls.length - 1][0];
      expect(callArgs.region).toBe('us-east-1');

      // Restore
      if (originalRegion) process.env.AWS_REGION = originalRegion;
    });
  });

  describe('parseResponse', () => {
    it('should parse trace event with trace.trace', () => {
      const steps = connector.parseResponse({
        trace: {
          trace: {
            orchestrationTrace: {
              rationale: { text: 'Thinking...' },
            },
          },
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].content).toContain('Thinking...');
    });

    it('should parse string response', () => {
      const steps = connector.parseResponse('Simple answer');

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Simple answer');
    });

    it('should return empty array for unrecognized input', () => {
      const steps = connector.parseResponse({ unknown: true });

      expect(steps).toHaveLength(0);
    });
  });

  describe('parseTraceEvent (via parseResponse)', () => {
    function parseTrace(trace: any) {
      return connector.parseResponse({ trace: { trace } });
    }

    it('should parse pre-processing trace', () => {
      const steps = parseTrace({
        preProcessingTrace: {
          modelInvocationOutput: {
            parsedResponse: { isValid: true, rationale: 'Input looks good' },
          },
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].content).toContain('valid');
      expect(steps[0].content).toContain('Input looks good');
    });

    it('should parse orchestration rationale', () => {
      const steps = parseTrace({
        orchestrationTrace: {
          rationale: { text: 'Let me check the logs' },
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].content).toBe('Let me check the logs');
    });

    it('should parse knowledge base lookup', () => {
      const steps = parseTrace({
        orchestrationTrace: {
          invocationInput: {
            knowledgeBaseLookupInput: { text: 'How to fix OOM' },
          },
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('knowledge_base_lookup');
    });

    it('should parse knowledge base results', () => {
      const steps = parseTrace({
        orchestrationTrace: {
          observation: {
            knowledgeBaseLookupOutput: {
              retrievedReferences: [
                { content: { text: 'Reference 1' }, location: { uri: 's3://bucket/doc.pdf' } },
                { content: { text: 'Reference 2' }, location: { uri: 's3://bucket/doc2.pdf' } },
              ],
            },
          },
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('tool_result');
      expect(steps[0].content).toContain('2 reference(s)');
    });

    it('should parse final response in observation', () => {
      const steps = parseTrace({
        orchestrationTrace: {
          observation: {
            finalResponse: { text: 'The root cause is...' },
          },
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('The root cause is...');
    });

    it('should parse post-processing trace', () => {
      const steps = parseTrace({
        postProcessingTrace: {
          modelInvocationOutput: {
            parsedResponse: { text: 'Summarizing findings' },
          },
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].content).toContain('Summarizing findings');
    });

    it('should parse failure trace', () => {
      const steps = parseTrace({
        failureTrace: {
          failureReason: 'Agent throttled',
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toContain('Agent throttled');
    });
  });

  describe('healthCheck', () => {
    it('should return true when agent is PREPARED', async () => {
      mockAgentSend.mockResolvedValue({
        agent: { agentStatus: 'PREPARED' },
      });

      const result = await connector.healthCheck('AGENT123', mockAuth);

      expect(result).toBe(true);
    });

    it('should return false when agent is not PREPARED', async () => {
      mockAgentSend.mockResolvedValue({
        agent: { agentStatus: 'CREATING' },
      });

      const result = await connector.healthCheck('AGENT123', mockAuth);

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockAgentSend.mockRejectedValue(new Error('Access denied'));

      const result = await connector.healthCheck('AGENT123', mockAuth);

      expect(result).toBe(false);
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(strandsConnector).toBeInstanceOf(StrandsConnector);
    });
  });
});
