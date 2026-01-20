/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - AG-UI event types have strict requirements not needed for unit tests
import { AGUIToTrajectoryConverter, computeTrajectoryFromRawEvents } from '@/services/agent/aguiConverter';
import { AGUIEventType, AGUIEvent } from '@/types/agui';
import { ToolCallStatus } from '@/types';

describe('AGUIToTrajectoryConverter', () => {
  let converter: AGUIToTrajectoryConverter;

  beforeEach(() => {
    converter = new AGUIToTrajectoryConverter();
  });

  describe('processEvent', () => {
    it('should return empty array for unhandled event types', () => {
      const event = { type: 'UNKNOWN_EVENT' as any };
      const steps = converter.processEvent(event);
      expect(steps).toEqual([]);
    });
  });

  describe('Run lifecycle events', () => {
    it('should handle RUN_STARTED event', () => {
      const event = {
        type: AGUIEventType.RUN_STARTED,
        runId: 'run-123',
        threadId: 'thread-456',
        timestamp: Date.now(),
      } as any;

      const steps = converter.processEvent(event);
      expect(steps).toEqual([]);
      expect(converter.getRunId()).toBe('run-123');
      expect(converter.getThreadId()).toBe('thread-456');
    });

    it('should handle RUN_FINISHED event', () => {
      const event = {
        type: AGUIEventType.RUN_FINISHED,
        timestamp: Date.now(),
      };

      const steps = converter.processEvent(event);
      expect(steps).toEqual([]);
    });

    it('should handle RUN_ERROR event', () => {
      const timestamp = Date.now();
      const event = {
        type: AGUIEventType.RUN_ERROR,
        message: 'Something went wrong',
        timestamp,
      };

      const steps = converter.processEvent(event);
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('tool_result');
      expect(steps[0].content).toContain('Error: Something went wrong');
      expect(steps[0].status).toBe(ToolCallStatus.FAILURE);
    });
  });

  describe('Text message events', () => {
    it('should handle complete text message lifecycle', () => {
      const startTime = Date.now();
      const messageId = 'msg-123';

      // Start message
      const startEvent = {
        type: AGUIEventType.TEXT_MESSAGE_START,
        messageId,
        timestamp: startTime,
      };
      expect(converter.processEvent(startEvent)).toEqual([]);

      // Content delta
      const contentEvent1 = {
        type: AGUIEventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: 'Hello ',
        timestamp: startTime + 100,
      };
      expect(converter.processEvent(contentEvent1)).toEqual([]);

      const contentEvent2 = {
        type: AGUIEventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: 'World!',
        timestamp: startTime + 200,
      };
      expect(converter.processEvent(contentEvent2)).toEqual([]);

      // End message
      const endEvent = {
        type: AGUIEventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: startTime + 300,
      };
      const steps = converter.processEvent(endEvent);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('assistant');
      expect(steps[0].content).toBe('Hello World!');
      expect(steps[0].latencyMs).toBe(300);
    });

    it('should skip empty assistant messages', () => {
      const startTime = Date.now();
      const messageId = 'msg-empty';

      converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_START,
        messageId,
        timestamp: startTime,
      });

      // Content with only whitespace
      converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: '   \n   ',
        timestamp: startTime + 100,
      });

      const steps = converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: startTime + 200,
      });

      expect(steps).toEqual([]);
    });

    it('should classify as response after RUN_FINISHED', () => {
      const startTime = Date.now();
      const messageId = 'msg-final';

      // Start run
      converter.processEvent({
        type: AGUIEventType.RUN_STARTED,
        runId: 'run-1',
        threadId: 'thread-1',
        timestamp: startTime,
      });

      // Start message
      converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_START,
        messageId,
        timestamp: startTime + 100,
      });

      converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: 'Final response',
        timestamp: startTime + 200,
      });

      // Run finishes before message ends
      converter.processEvent({
        type: AGUIEventType.RUN_FINISHED,
        timestamp: startTime + 250,
      });

      // End message
      const steps = converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: startTime + 300,
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Final response');
    });

    it('should ignore content for unknown message', () => {
      const steps = converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_CONTENT,
        messageId: 'unknown-msg',
        delta: 'content',
        timestamp: Date.now(),
      });
      expect(steps).toEqual([]);
    });

    it('should ignore end for unknown message', () => {
      const steps = converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_END,
        messageId: 'unknown-msg',
        timestamp: Date.now(),
      });
      expect(steps).toEqual([]);
    });
  });

  describe('Tool call events', () => {
    it('should handle tool call lifecycle', () => {
      const startTime = Date.now();
      const toolCallId = 'tool-123';

      // Tool call start
      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: 'execute_ppl_query',
        timestamp: startTime,
      });

      // Tool call args
      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{"query": "source=logs | stats count()"}',
        timestamp: startTime + 50,
      });

      // Tool call end
      const endSteps = converter.processEvent({
        type: AGUIEventType.TOOL_CALL_END,
        toolCallId,
        timestamp: startTime + 100,
      });

      expect(endSteps).toHaveLength(1);
      expect(endSteps[0].type).toBe('action');
      expect(endSteps[0].toolName).toBe('execute_ppl_query');
      expect(endSteps[0].toolArgs).toEqual({ query: 'source=logs | stats count()' });

      // Tool call result
      const resultSteps = converter.processEvent({
        type: AGUIEventType.TOOL_CALL_RESULT,
        toolCallId,
        content: '{"rows": 100}',
        timestamp: startTime + 200,
      });

      expect(resultSteps).toHaveLength(1);
      expect(resultSteps[0].type).toBe('tool_result');
      expect(resultSteps[0].status).toBe(ToolCallStatus.SUCCESS);
    });

    it('should handle tool call result without prior end event', () => {
      const startTime = Date.now();
      const toolCallId = 'tool-456';

      // Start tool
      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: 'search',
        timestamp: startTime,
      });

      // Args
      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{"q": "test"}',
        timestamp: startTime + 50,
      });

      // Skip TOOL_CALL_END, go directly to result
      const resultSteps = converter.processEvent({
        type: AGUIEventType.TOOL_CALL_RESULT,
        toolCallId,
        content: 'Search results',
        timestamp: startTime + 200,
      });

      // Should emit both action and tool_result
      expect(resultSteps).toHaveLength(2);
      expect(resultSteps[0].type).toBe('action');
      expect(resultSteps[1].type).toBe('tool_result');
    });

    it('should handle invalid JSON in tool args', () => {
      const startTime = Date.now();
      const toolCallId = 'tool-bad-json';

      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: 'test_tool',
        timestamp: startTime,
      });

      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: 'not valid json {',
        timestamp: startTime + 50,
      });

      const steps = converter.processEvent({
        type: AGUIEventType.TOOL_CALL_END,
        toolCallId,
        timestamp: startTime + 100,
      });

      expect(steps[0].toolArgs).toEqual({ _raw: 'not valid json {' });
    });

    it('should ignore tool call end for unknown tool', () => {
      const steps = converter.processEvent({
        type: AGUIEventType.TOOL_CALL_END,
        toolCallId: 'unknown-tool',
        timestamp: Date.now(),
      });
      expect(steps).toEqual([]);
    });

    it('should ignore tool call result for unknown tool', () => {
      const steps = converter.processEvent({
        type: AGUIEventType.TOOL_CALL_RESULT,
        toolCallId: 'unknown-tool',
        content: 'result',
        timestamp: Date.now(),
      });
      expect(steps).toEqual([]);
    });

    it('should parse JSON content in tool result', () => {
      const startTime = Date.now();
      const toolCallId = 'tool-json-result';

      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: 'json_tool',
        timestamp: startTime,
      });

      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_END,
        toolCallId,
        timestamp: startTime + 50,
      });

      const steps = converter.processEvent({
        type: AGUIEventType.TOOL_CALL_RESULT,
        toolCallId,
        content: JSON.stringify({ data: [1, 2, 3], status: 'ok' }),
        timestamp: startTime + 100,
      });

      expect(steps[0].content).toContain('"data"');
      expect(steps[0].content).toContain('"status"');
    });
  });

  describe('Activity events', () => {
    it('should handle ACTIVITY_SNAPSHOT event', () => {
      const timestamp = Date.now();
      const event = {
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId: 'activity-1',
        content: {
          title: 'Running execute_ppl_query',
          description: 'query: "source=logs"',
        },
        timestamp,
      };

      const steps = converter.processEvent(event);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('execute_ppl_query');
    });

    it('should handle ACTIVITY_DELTA with completion', () => {
      const startTime = Date.now();
      const messageId = 'activity-2';

      // First create the activity
      converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId,
        content: {
          title: 'Running tool',
          description: '',
        },
        timestamp: startTime,
      });

      // Then complete it
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_DELTA,
        messageId,
        patch: [
          { path: '/icon', op: 'replace', value: 'CheckCircle' },
          { path: '/description', op: 'replace', value: 'Tool completed successfully' },
        ],
        timestamp: startTime + 500,
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('tool_result');
      expect(steps[0].status).toBe(ToolCallStatus.SUCCESS);
      expect(steps[0].content).toBe('Tool completed successfully');
      expect(steps[0].latencyMs).toBe(500);
    });

    it('should ignore ACTIVITY_DELTA without completion icon', () => {
      const messageId = 'activity-3';

      converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId,
        content: { title: 'Tool', description: '' },
        timestamp: Date.now(),
      });

      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_DELTA,
        messageId,
        patch: [{ path: '/description', op: 'replace', value: 'Progress...' }],
        timestamp: Date.now() + 100,
      });

      expect(steps).toEqual([]);
    });

    it('should ignore ACTIVITY_DELTA for unknown message', () => {
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_DELTA,
        messageId: 'unknown-activity',
        patch: [{ path: '/icon', op: 'replace', value: 'CheckCircle' }],
        timestamp: Date.now(),
      });

      expect(steps).toEqual([]);
    });
  });

  describe('Thinking events', () => {
    it('should handle thinking message lifecycle', () => {
      const startTime = Date.now();

      // Thinking start
      converter.processEvent({
        type: AGUIEventType.THINKING_START,
        timestamp: startTime,
      });

      // Thinking text message start
      converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_START,
        timestamp: startTime + 100,
      });

      // Thinking content
      converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta: 'I need to analyze ',
        timestamp: startTime + 150,
      });

      converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta: 'the logs carefully.',
        timestamp: startTime + 200,
      });

      // Thinking text message end
      const steps = converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_END,
        timestamp: startTime + 300,
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].content).toBe('I need to analyze the logs carefully.');

      // Thinking end
      const endSteps = converter.processEvent({
        type: AGUIEventType.THINKING_END,
        timestamp: startTime + 400,
      });

      expect(endSteps).toEqual([]);
    });

    it('should skip empty thinking messages', () => {
      converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_START,
        timestamp: Date.now(),
      });

      converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta: '   ',
        timestamp: Date.now() + 50,
      });

      const steps = converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_END,
        timestamp: Date.now() + 100,
      });

      expect(steps).toEqual([]);
    });

    it('should handle thinking end without active message', () => {
      const steps = converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_END,
        timestamp: Date.now(),
      });
      expect(steps).toEqual([]);
    });

    it('should ignore thinking content without active message', () => {
      const steps = converter.processEvent({
        type: AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta: 'some thought',
        timestamp: Date.now(),
      });
      expect(steps).toEqual([]);
    });
  });

  describe('extractToolName', () => {
    it('should extract tool name from "Running X" format', () => {
      const converter = new AGUIToTrajectoryConverter();
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId: 'test',
        content: {
          title: 'Running execute_ppl_query',
          description: '',
        },
        timestamp: Date.now(),
      });

      expect(steps[0].toolName).toBe('execute_ppl_query');
    });

    it('should extract tool name from "X completed" format', () => {
      const converter = new AGUIToTrajectoryConverter();
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId: 'test',
        content: {
          title: 'search_tool completed',
          description: '',
        },
        timestamp: Date.now(),
      });

      expect(steps[0].toolName).toBe('search_tool');
    });

    it('should return title as-is if no pattern matches', () => {
      const converter = new AGUIToTrajectoryConverter();
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId: 'test',
        content: {
          title: 'custom_tool_name',
          description: '',
        },
        timestamp: Date.now(),
      });

      expect(steps[0].toolName).toBe('custom_tool_name');
    });
  });

  describe('parseToolArgs', () => {
    it('should parse key-value pairs from description', () => {
      const converter = new AGUIToTrajectoryConverter();
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId: 'test',
        content: {
          title: 'Running tool',
          description: 'query: "test query" autoExecute: true count: 10',
        },
        timestamp: Date.now(),
      });

      expect(steps[0].toolArgs).toEqual({
        query: 'test query',
        autoExecute: true,
        count: 10,
      });
    });

    it('should handle boolean values', () => {
      const converter = new AGUIToTrajectoryConverter();
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId: 'test',
        content: {
          title: 'Running tool',
          description: 'enabled: true disabled: false',
        },
        timestamp: Date.now(),
      });

      expect(steps[0].toolArgs.enabled).toBe(true);
      expect(steps[0].toolArgs.disabled).toBe(false);
    });

    it('should return description as fallback', () => {
      const converter = new AGUIToTrajectoryConverter();
      const steps = converter.processEvent({
        type: AGUIEventType.ACTIVITY_SNAPSHOT,
        messageId: 'test',
        content: {
          title: 'Running tool',
          description: 'some plain text without key-value pairs',
        },
        timestamp: Date.now(),
      });

      expect(steps[0].toolArgs).toEqual({ description: 'some plain text without key-value pairs' });
    });
  });

  describe('State reset on new run', () => {
    it('should reset state when a new run starts', () => {
      // First run
      converter.processEvent({
        type: AGUIEventType.RUN_STARTED,
        runId: 'run-1',
        threadId: 'thread-1',
        timestamp: Date.now(),
      });

      // Create some state
      converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_START,
        messageId: 'msg-1',
        timestamp: Date.now(),
      });

      converter.processEvent({
        type: AGUIEventType.TOOL_CALL_START,
        toolCallId: 'tool-1',
        toolCallName: 'test',
        timestamp: Date.now(),
      });

      // Start a new run
      converter.processEvent({
        type: AGUIEventType.RUN_STARTED,
        runId: 'run-2',
        threadId: 'thread-2',
        timestamp: Date.now(),
      });

      expect(converter.getRunId()).toBe('run-2');
      expect(converter.getThreadId()).toBe('thread-2');

      // Old message should be cleared - end should do nothing
      const steps = converter.processEvent({
        type: AGUIEventType.TEXT_MESSAGE_END,
        messageId: 'msg-1',
        timestamp: Date.now(),
      });

      expect(steps).toEqual([]);
    });
  });
});

describe('computeTrajectoryFromRawEvents', () => {
  it('should convert a sequence of events to trajectory', () => {
    const startTime = Date.now();
    const events = [
      {
        type: AGUIEventType.RUN_STARTED,
        runId: 'run-1',
        threadId: 'thread-1',
        timestamp: startTime,
      },
      {
        type: AGUIEventType.THINKING_TEXT_MESSAGE_START,
        timestamp: startTime + 100,
      },
      {
        type: AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta: 'Analyzing...',
        timestamp: startTime + 150,
      },
      {
        type: AGUIEventType.THINKING_TEXT_MESSAGE_END,
        timestamp: startTime + 200,
      },
      {
        type: AGUIEventType.TOOL_CALL_START,
        toolCallId: 'tool-1',
        toolCallName: 'search',
        timestamp: startTime + 300,
      },
      {
        type: AGUIEventType.TOOL_CALL_ARGS,
        toolCallId: 'tool-1',
        delta: '{"q": "test"}',
        timestamp: startTime + 350,
      },
      {
        type: AGUIEventType.TOOL_CALL_END,
        toolCallId: 'tool-1',
        timestamp: startTime + 400,
      },
      {
        type: AGUIEventType.TOOL_CALL_RESULT,
        toolCallId: 'tool-1',
        content: 'Found results',
        timestamp: startTime + 500,
      },
      {
        type: AGUIEventType.TEXT_MESSAGE_START,
        messageId: 'msg-1',
        timestamp: startTime + 600,
      },
      {
        type: AGUIEventType.TEXT_MESSAGE_CONTENT,
        messageId: 'msg-1',
        delta: 'Here is my response.',
        timestamp: startTime + 650,
      },
      {
        type: AGUIEventType.RUN_FINISHED,
        timestamp: startTime + 700,
      },
      {
        type: AGUIEventType.TEXT_MESSAGE_END,
        messageId: 'msg-1',
        timestamp: startTime + 750,
      },
    ];

    const trajectory = computeTrajectoryFromRawEvents(events as any);

    expect(trajectory).toHaveLength(4);
    expect(trajectory[0].type).toBe('thinking');
    expect(trajectory[0].content).toBe('Analyzing...');
    expect(trajectory[1].type).toBe('action');
    expect(trajectory[1].toolName).toBe('search');
    expect(trajectory[2].type).toBe('tool_result');
    expect(trajectory[3].type).toBe('response');
    expect(trajectory[3].content).toBe('Here is my response.');
  });

  it('should return empty trajectory for empty events', () => {
    const trajectory = computeTrajectoryFromRawEvents([]);
    expect(trajectory).toEqual([]);
  });

  it('should sort trajectory by timestamp', () => {
    const startTime = Date.now();
    // Events processed in correct order, but steps emitted with different timestamps
    // Testing that output trajectory is sorted by timestamp
    const events = [
      {
        type: AGUIEventType.RUN_STARTED,
        runId: 'run-1',
        threadId: 'thread-1',
        timestamp: startTime,
      },
      // Text message with later timestamp processed first
      {
        type: AGUIEventType.TEXT_MESSAGE_START,
        messageId: 'msg-1',
        timestamp: startTime + 500,
      },
      {
        type: AGUIEventType.TEXT_MESSAGE_CONTENT,
        messageId: 'msg-1',
        delta: 'Response',
        timestamp: startTime + 550,
      },
      {
        type: AGUIEventType.TEXT_MESSAGE_END,
        messageId: 'msg-1',
        timestamp: startTime + 600,
      },
      // Thinking message with earlier timestamp processed second
      {
        type: AGUIEventType.THINKING_TEXT_MESSAGE_START,
        timestamp: startTime + 100,
      },
      {
        type: AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta: 'Thinking',
        timestamp: startTime + 150,
      },
      {
        type: AGUIEventType.THINKING_TEXT_MESSAGE_END,
        timestamp: startTime + 200,
      },
    ];

    const trajectory = computeTrajectoryFromRawEvents(events as any);

    expect(trajectory).toHaveLength(2);
    // Thinking should come first (timestamp 100) even though it was processed second
    expect(trajectory[0].type).toBe('thinking');
    // Assistant should come second (timestamp 500)
    expect(trajectory[1].type).toBe('assistant');
  });
});
