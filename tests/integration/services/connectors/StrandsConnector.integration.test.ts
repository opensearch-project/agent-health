/* Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for StrandsConnector
 *
 * Tests the Strands connector logic end-to-end by mocking the AWS SDK.
 * Verifies:
 * 1. Correct payload construction from test case
 * 2. AWS SDK client configuration with credentials
 * 3. Streaming response parsing (traces + chunks)
 * 4. Trace event parsing into trajectory steps
 * 5. Error handling
 * 6. Health check behavior
 */

import type { ConnectorAuth, ConnectorRequest } from '@/connectors/types';
import type { TestCase } from '@/types';

// Mock the AWS SDK modules
const mockSend = jest.fn();
const mockBedrockAgentRuntimeClient = jest.fn().mockImplementation(() => ({
  send: mockSend,
}));
const mockInvokeAgentCommand = jest.fn().mockImplementation((params) => params);

const mockBedrockAgentClient = jest.fn().mockImplementation(() => ({
  send: mockSend,
}));
const mockGetAgentCommand = jest.fn().mockImplementation((params) => params);

jest.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: mockBedrockAgentRuntimeClient,
  InvokeAgentCommand: mockInvokeAgentCommand,
}));

jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: mockBedrockAgentClient,
  GetAgentCommand: mockGetAgentCommand,
}));

import { StrandsConnector } from '@/connectors/strands';

describe('StrandsConnector Integration Tests', () => {
  let connector: StrandsConnector;

  const makeTestCase = (prompt: string): TestCase => ({
    id: 'test-1',
    name: 'Test Case',
    initialPrompt: prompt,
    expectedOutcomes: ['Find root cause'],
    context: [],
    labels: [],
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const defaultAuth: ConnectorAuth = {
    type: 'aws-sigv4',
    awsRegion: 'us-west-2',
    awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    awsSessionToken: 'session-token-123',
  };

  beforeEach(() => {
    connector = new StrandsConnector();
    jest.clearAllMocks();
  });

  describe('buildPayload', () => {
    it('should construct correct payload from test case', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Why is the cluster unhealthy?'),
        modelId: 'anthropic.claude-3-sonnet',
        connectorConfig: {
          agentAliasId: 'MY_ALIAS',
          sessionId: 'session-abc',
          enableTrace: true,
        },
      };

      const payload = connector.buildPayload(request);

      expect(payload.agentAliasId).toBe('MY_ALIAS');
      expect(payload.sessionId).toBe('session-abc');
      expect(payload.inputText).toBe('Why is the cluster unhealthy?');
      expect(payload.enableTrace).toBe(true);
      expect(payload.agentId).toBe(''); // Set in execute()
    });

    it('should use default alias when not configured', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Analyze logs'),
        modelId: 'model-1',
      };

      const payload = connector.buildPayload(request);

      expect(payload.agentAliasId).toBe('TSTALIASID');
      expect(payload.enableTrace).toBe(true);
    });

    it('should generate a session ID when not provided', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test prompt'),
        modelId: 'model-1',
      };

      const payload = connector.buildPayload(request);

      expect(payload.sessionId).toMatch(/^eval-\d+-[a-z0-9]+$/);
    });
  });

  describe('execute', () => {
    // Helper to create an async iterable for the streaming response
    function createAsyncIterable(events: any[]): AsyncIterable<any> {
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (index >= events.length) {
                return { done: true, value: undefined };
              }
              return { done: false, value: events[index++] };
            },
          };
        },
      };
    }

    it('should configure AWS client with explicit credentials', async () => {
      mockSend.mockResolvedValue({ completion: createAsyncIterable([]) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: { agentAliasId: 'ALIAS1' },
      };

      await connector.execute('AGENT123', request, defaultAuth);

      expect(mockBedrockAgentRuntimeClient).toHaveBeenCalledWith({
        region: 'us-west-2',
        credentials: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          sessionToken: 'session-token-123',
        },
      });
    });

    it('should use endpoint as agentId', async () => {
      mockSend.mockResolvedValue({ completion: createAsyncIterable([]) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await connector.execute('MY_AGENT_ID', request, defaultAuth);

      expect(mockInvokeAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'MY_AGENT_ID' })
      );
    });

    it('should parse text chunks from streaming response', async () => {
      const encoder = new TextEncoder();
      const events = [
        { chunk: { bytes: encoder.encode('Hello ') } },
        { chunk: { bytes: encoder.encode('world!') } },
      ];

      mockSend.mockResolvedValue({ completion: createAsyncIterable(events) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const result = await connector.execute('AGENT1', request, defaultAuth);

      expect(result.trajectory).toHaveLength(1);
      expect(result.trajectory[0].type).toBe('response');
      expect(result.trajectory[0].content).toBe('Hello world!');
    });

    it('should parse orchestration trace events into trajectory steps', async () => {
      const events = [
        {
          trace: {
            trace: {
              orchestrationTrace: {
                rationale: { text: 'I need to search the logs' },
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
                    actionGroupName: 'LogSearch',
                    apiPath: '/search',
                    parameters: [
                      { name: 'query', value: 'error' },
                    ],
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
                  actionGroupInvocationOutput: { text: 'Found 5 errors in logs' },
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
                  finalResponse: { text: 'The root cause is a memory leak.' },
                },
              },
            },
          },
        },
      ];

      mockSend.mockResolvedValue({ completion: createAsyncIterable(events) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Why is the cluster slow?'),
        modelId: 'model-1',
      };

      const result = await connector.execute('AGENT1', request, defaultAuth);

      expect(result.trajectory.length).toBe(4);
      expect(result.trajectory[0].type).toBe('thinking');
      expect(result.trajectory[0].content).toBe('I need to search the logs');
      expect(result.trajectory[1].type).toBe('action');
      expect(result.trajectory[1].toolName).toBe('LogSearch::/search');
      expect(result.trajectory[1].toolArgs).toEqual({ query: 'error' });
      expect(result.trajectory[2].type).toBe('tool_result');
      expect(result.trajectory[2].content).toBe('Found 5 errors in logs');
      expect(result.trajectory[3].type).toBe('response');
      expect(result.trajectory[3].content).toBe('The root cause is a memory leak.');
    });

    it('should parse pre-processing trace', async () => {
      const events = [
        {
          trace: {
            trace: {
              preProcessingTrace: {
                modelInvocationOutput: {
                  parsedResponse: { isValid: true, rationale: 'Input is valid RCA query' },
                },
              },
            },
          },
        },
      ];

      mockSend.mockResolvedValue({ completion: createAsyncIterable(events) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Check health'),
        modelId: 'model-1',
      };

      const result = await connector.execute('AGENT1', request, defaultAuth);

      expect(result.trajectory[0].type).toBe('thinking');
      expect(result.trajectory[0].content).toContain('Pre-processing: Input valid');
      expect(result.trajectory[0].content).toContain('Input is valid RCA query');
    });

    it('should parse knowledge base lookup traces', async () => {
      const events = [
        {
          trace: {
            trace: {
              orchestrationTrace: {
                invocationInput: {
                  knowledgeBaseLookupInput: { text: 'OpenSearch cluster health' },
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
                  knowledgeBaseLookupOutput: {
                    retrievedReferences: [
                      { content: { text: 'Reference content 1' }, location: { s3: 'doc1.pdf' } },
                      { content: { text: 'Reference content 2' }, location: { s3: 'doc2.pdf' } },
                    ],
                  },
                },
              },
            },
          },
        },
      ];

      mockSend.mockResolvedValue({ completion: createAsyncIterable(events) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Help'),
        modelId: 'model-1',
      };

      const result = await connector.execute('AGENT1', request, defaultAuth);

      expect(result.trajectory[0].type).toBe('action');
      expect(result.trajectory[0].toolName).toBe('knowledge_base_lookup');
      expect(result.trajectory[1].type).toBe('tool_result');
      expect(result.trajectory[1].content).toContain('Retrieved 2 reference(s)');
    });

    it('should parse failure trace', async () => {
      const events = [
        {
          trace: {
            trace: {
              failureTrace: { failureReason: 'Agent timed out' },
            },
          },
        },
      ];

      mockSend.mockResolvedValue({ completion: createAsyncIterable(events) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const result = await connector.execute('AGENT1', request, defaultAuth);

      expect(result.trajectory[0].type).toBe('response');
      expect(result.trajectory[0].content).toContain('Agent error: Agent timed out');
    });

    it('should call onProgress for each trajectory step', async () => {
      const events = [
        { trace: { trace: { orchestrationTrace: { rationale: { text: 'Thinking...' } } } } },
      ];

      mockSend.mockResolvedValue({ completion: createAsyncIterable(events) });

      const onProgress = jest.fn();
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await connector.execute('AGENT1', request, defaultAuth, onProgress);

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'thinking', content: 'Thinking...' })
      );
    });

    it('should call onRawEvent for each streaming event', async () => {
      const event1 = { chunk: { bytes: new TextEncoder().encode('Hi') } };
      mockSend.mockResolvedValue({ completion: createAsyncIterable([event1]) });

      const onRawEvent = jest.fn();
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await connector.execute('AGENT1', request, defaultAuth, undefined, onRawEvent);

      expect(onRawEvent).toHaveBeenCalledWith(event1);
    });

    it('should not add duplicate response step when trace already has final response', async () => {
      const encoder = new TextEncoder();
      const events = [
        { trace: { trace: { orchestrationTrace: { observation: { finalResponse: { text: 'Done.' } } } } } },
        { chunk: { bytes: encoder.encode('Done.') } },
      ];

      mockSend.mockResolvedValue({ completion: createAsyncIterable(events) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const result = await connector.execute('AGENT1', request, defaultAuth);

      const responseSteps = result.trajectory.filter(s => s.type === 'response');
      expect(responseSteps).toHaveLength(1);
      expect(responseSteps[0].content).toBe('Done.');
    });

    it('should return correct metadata', async () => {
      mockSend.mockResolvedValue({ completion: createAsyncIterable([]) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: { agentAliasId: 'PROD_ALIAS', sessionId: 'sess-xyz' },
      };

      const result = await connector.execute('AGENT_ABC', request, defaultAuth);

      expect(result.runId).toBe('sess-xyz');
      expect(result.metadata).toEqual({
        agentId: 'AGENT_ABC',
        agentAliasId: 'PROD_ALIAS',
        sessionId: 'sess-xyz',
        region: 'us-west-2',
      });
    });

    it('should use pre-built payload when provided', async () => {
      mockSend.mockResolvedValue({ completion: createAsyncIterable([]) });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Ignored prompt'),
        modelId: 'model-1',
        payload: {
          agentId: '',
          agentAliasId: 'CUSTOM_ALIAS',
          sessionId: 'custom-session',
          inputText: 'Custom input text',
          enableTrace: false,
        },
      };

      await connector.execute('AGENT1', request, defaultAuth);

      expect(mockInvokeAgentCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'AGENT1',
          agentAliasId: 'CUSTOM_ALIAS',
          inputText: 'Custom input text',
          enableTrace: false,
        })
      );
    });

    it('should fall back to us-east-1 when no region provided', async () => {
      mockSend.mockResolvedValue({ completion: createAsyncIterable([]) });
      const originalRegion = process.env.AWS_REGION;
      delete process.env.AWS_REGION;

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const authNoRegion: ConnectorAuth = { type: 'none' };
      await connector.execute('AGENT1', request, authNoRegion);

      expect(mockBedrockAgentRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-east-1' })
      );

      if (originalRegion) process.env.AWS_REGION = originalRegion;
    });
  });

  describe('parseResponse', () => {
    it('should parse trace event from raw response', () => {
      const raw = {
        trace: {
          trace: {
            orchestrationTrace: {
              rationale: { text: 'Analyzing...' },
            },
          },
        },
      };

      const steps = connector.parseResponse(raw);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].content).toBe('Analyzing...');
    });

    it('should wrap string response as response step', () => {
      const steps = connector.parseResponse('Final answer here');

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Final answer here');
    });

    it('should return empty array for unrecognized data', () => {
      const steps = connector.parseResponse({ unknown: true });
      expect(steps).toHaveLength(0);
    });
  });

  describe('healthCheck', () => {
    it('should return true when agent status is PREPARED', async () => {
      mockSend.mockResolvedValue({ agent: { agentStatus: 'PREPARED' } });

      const result = await connector.healthCheck('AGENT123', defaultAuth);

      expect(result).toBe(true);
      expect(mockGetAgentCommand).toHaveBeenCalledWith({ agentId: 'AGENT123' });
    });

    it('should return false when agent status is not PREPARED', async () => {
      mockSend.mockResolvedValue({ agent: { agentStatus: 'CREATING' } });

      const result = await connector.healthCheck('AGENT123', defaultAuth);

      expect(result).toBe(false);
    });

    it('should return false when SDK call throws', async () => {
      mockSend.mockRejectedValue(new Error('Access denied'));

      const result = await connector.healthCheck('AGENT123', defaultAuth);

      expect(result).toBe(false);
    });
  });

  describe('connector properties', () => {
    it('should have correct type and name', () => {
      expect(connector.type).toBe('strands');
      expect(connector.name).toBe('Amazon Strands');
      expect(connector.supportsStreaming).toBe(true);
    });
  });
});
