/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AG UI Event to TrajectoryStep Converter
 * Converts streaming AG UI events from the agent into TrajectoryStep format
 */

import { v4 as uuidv4 } from 'uuid';
import { TrajectoryStep, ToolCallStatus } from '@/types';
import { debug } from '@/lib/debug';
import { AGUIEvent, AGUIEventType } from '@/types/agui';
import type {
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageEndEvent,
} from '@ag-ui/core';

interface TextMessageState {
  messageId: string;
  startTime: number;
  content: string;
}

interface ToolState {
  messageId: string;
  toolName: string;
  toolArgs: any;
  argsAccumulator: string; // Accumulate delta strings before parsing
  startTime: number;
  actionStepId: string;
}

interface ThinkingMessageState {
  startTime: number;
  content: string;
}

export class AGUIToTrajectoryConverter {
  private currentTextMessage: TextMessageState | null = null;
  private activeTools: Map<string, ToolState> = new Map();
  private hasEmittedAction = false;
  private runFinished = false;
  private pendingTextIsResponse = false;
  private runId: string | null = null;
  private threadId: string | null = null;

  // Thinking state tracking
  private isThinking = false;
  private currentThinkingMessage: ThinkingMessageState | null = null;

  /**
   * Process a single AG UI event and convert it to TrajectoryStep(s)
   * Returns an array of steps (usually 0 or 1, sometimes more)
   */
  processEvent(event: AGUIEvent): TrajectoryStep[] {
    debug('Converter', `Event: ${event.type}`, JSON.stringify(event).substring(0, 300));

    let steps: TrajectoryStep[] = [];

    switch (event.type) {
      case AGUIEventType.RUN_STARTED:
        steps = this.handleRunStarted(event);
        break;

      case AGUIEventType.RUN_FINISHED:
        steps = this.handleRunFinished(event);
        break;

      case AGUIEventType.RUN_ERROR:
        steps = this.handleRunError(event);
        break;

      case AGUIEventType.TEXT_MESSAGE_START:
        steps = this.handleTextMessageStart(event);
        break;

      case AGUIEventType.TEXT_MESSAGE_CONTENT:
        steps = this.handleTextMessageContent(event);
        break;

      case AGUIEventType.TEXT_MESSAGE_END:
        steps = this.handleTextMessageEnd(event);
        break;

      case AGUIEventType.ACTIVITY_SNAPSHOT:
        steps = this.handleActivitySnapshot(event);
        break;

      case AGUIEventType.ACTIVITY_DELTA:
        steps = this.handleActivityDelta(event);
        break;

      case AGUIEventType.TOOL_CALL_START:
        steps = this.handleToolCallStart(event);
        break;

      case AGUIEventType.TOOL_CALL_ARGS:
        steps = this.handleToolCallArgs(event);
        break;

      case AGUIEventType.TOOL_CALL_END:
        steps = this.handleToolCallEnd(event);
        break;

      case AGUIEventType.TOOL_CALL_RESULT:
        steps = this.handleToolCallResult(event);
        break;

      // Thinking events - extended reasoning from the model
      case AGUIEventType.THINKING_START:
        steps = this.handleThinkingStart(event);
        break;

      case AGUIEventType.THINKING_END:
        steps = this.handleThinkingEnd(event);
        break;

      case AGUIEventType.THINKING_TEXT_MESSAGE_START:
        steps = this.handleThinkingTextMessageStart(event);
        break;

      case AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT:
        steps = this.handleThinkingTextMessageContent(event);
        break;

      case AGUIEventType.THINKING_TEXT_MESSAGE_END:
        steps = this.handleThinkingTextMessageEnd(event);
        break;

      default:
        debug('Converter', `Skipped unhandled event: ${event.type}`);
        break;
    }

    if (steps.length > 0) {
      debug('Converter', `Generated ${steps.length} step(s):`, steps.map(s => `${s.type}${s.toolName ? `:${s.toolName}` : ''}`).join(', '));
    }

    return steps;
  }

  private handleRunStarted(event: any): TrajectoryStep[] {
    this.runId = event.runId;
    this.threadId = event.threadId;
    debug('Converter', `Run started - runId: ${this.runId}, threadId: ${this.threadId}`);

    // Reset state for new run
    this.currentTextMessage = null;
    this.activeTools.clear();
    this.hasEmittedAction = false;
    this.runFinished = false;
    this.pendingTextIsResponse = false;
    this.isThinking = false;
    this.currentThinkingMessage = null;
    return [];
  }

  getRunId(): string | null {
    return this.runId;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  private handleRunFinished(event: any): TrajectoryStep[] {
    this.runFinished = true;
    if (this.currentTextMessage) {
      this.pendingTextIsResponse = true;
    }
    return [];
  }

  private handleRunError(event: any): TrajectoryStep[] {
    console.error('[Converter] Run error:', event.message);
    return [{
      id: uuidv4(),
      timestamp: event.timestamp,
      type: 'tool_result',
      content: `Error: ${event.message}`,
      status: ToolCallStatus.FAILURE,
    }];
  }

  private handleTextMessageStart(event: TextMessageStartEvent): TrajectoryStep[] {
    debug('Converter', `Text message start: ${event.messageId}`);
    this.currentTextMessage = {
      messageId: event.messageId,
      startTime: event.timestamp,
      content: '',
    };
    return [];
  }

  private handleTextMessageContent(event: TextMessageContentEvent): TrajectoryStep[] {
    if (this.currentTextMessage && this.currentTextMessage.messageId === event.messageId) {
      this.currentTextMessage.content += event.delta;
    }
    return [];
  }

  private handleTextMessageEnd(event: TextMessageEndEvent): TrajectoryStep[] {
    if (!this.currentTextMessage || this.currentTextMessage.messageId !== event.messageId) {
      debug('Converter', `Text end for unknown message: ${event.messageId}`);
      return [];
    }

    const latencyMs = event.timestamp - this.currentTextMessage.startTime;
    const content = this.currentTextMessage.content.trim();

    // Determine step type based on context
    let stepType: 'assistant' | 'response';

    if (this.pendingTextIsResponse || this.runFinished) {
      stepType = 'response';
    } else {
      stepType = 'assistant';
    }

    debug('Converter', `Classification: ${stepType} (runFinished=${this.runFinished}, pendingResponse=${this.pendingTextIsResponse}, hasAction=${this.hasEmittedAction})`);

    // Skip empty assistant messages
    if (stepType === 'assistant' && content.length === 0) {
      debug('Converter', 'Skipping empty assistant message');
      this.currentTextMessage = null;
      return [];
    }

    const step: TrajectoryStep = {
      id: uuidv4(),
      timestamp: event.timestamp,
      type: stepType,
      content,
      latencyMs,
    };

    this.currentTextMessage = null;
    return [step];
  }

  private handleActivitySnapshot(event: ActivitySnapshotEvent): TrajectoryStep[] {
    const toolName = this.extractToolName(event.content.title);
    const toolArgs = this.parseToolArgs(event.content.description);
    const actionStepId = uuidv4();

    this.activeTools.set(event.messageId, {
      messageId: event.messageId,
      toolName,
      toolArgs,
      argsAccumulator: '',
      startTime: event.timestamp,
      actionStepId,
    });

    this.hasEmittedAction = true;

    debug('Converter', `Tool action: ${toolName}`, toolArgs);

    return [{
      id: actionStepId,
      timestamp: event.timestamp,
      type: 'action',
      content: `Calling ${toolName}...`,
      toolName,
      toolArgs,
    }];
  }

  private handleActivityDelta(event: ActivityDeltaEvent): TrajectoryStep[] {
    const toolState = this.activeTools.get(event.messageId);
    if (!toolState) return [];

    const isCompletion = event.patch.some(
      op => op.path === '/icon' && (op.value === 'CheckCircle' || op.value === 'Check')
    );

    if (!isCompletion) return [];

    const descriptionPatch = event.patch.find(op => op.path === '/description');
    const resultContent = descriptionPatch?.value || 'Tool execution completed';
    const latencyMs = event.timestamp - toolState.startTime;

    this.activeTools.delete(event.messageId);

    return [{
      id: uuidv4(),
      timestamp: event.timestamp,
      type: 'tool_result',
      content: resultContent,
      status: ToolCallStatus.SUCCESS,
      latencyMs,
    }];
  }

  private handleToolCallStart(event: ToolCallStartEvent): TrajectoryStep[] {
    const actionStepId = uuidv4();

    // Set up tool state but DON'T emit action step yet
    // We'll emit it when we have complete args (after all TOOL_CALL_ARGS deltas)
    this.activeTools.set(event.toolCallId, {
      messageId: event.toolCallId,
      toolName: event.toolCallName,
      toolArgs: {},
      argsAccumulator: '', // Will accumulate delta strings
      startTime: event.timestamp,
      actionStepId,
    });

    this.hasEmittedAction = true;
    debug('Converter', `Tool call started: ${event.toolCallName} (${event.toolCallId})`);

    // Don't emit action step here - wait until we have complete args
    return [];
  }

  private handleToolCallArgs(event: ToolCallArgsEvent): TrajectoryStep[] {
    const toolState = this.activeTools.get(event.toolCallId);
    if (toolState) {
      // Accumulate delta strings - don't try to parse yet
      // The deltas are streamed partial strings that form complete JSON when concatenated
      toolState.argsAccumulator += event.delta;
      debug('Converter', `Tool args delta accumulated (${toolState.argsAccumulator.length} chars total)`);
    }
    return [];
  }

  /**
   * Handle TOOL_CALL_END - emits the action step with complete args
   * This is called when the agent is done sending tool call arguments
   * and expects the client to execute the tool
   */
  private handleToolCallEnd(event: ToolCallEndEvent): TrajectoryStep[] {
    const toolState = this.activeTools.get(event.toolCallId);
    if (!toolState) {
      debug('Converter', `Tool call end for unknown tool: ${event.toolCallId}`);
      return [];
    }

    // Parse accumulated args now that we have all deltas
    let parsedArgs: any = {};
    if (toolState.argsAccumulator) {
      try {
        parsedArgs = JSON.parse(toolState.argsAccumulator);
        debug('Converter', `Tool args parsed: ${JSON.stringify(parsedArgs).substring(0, 200)}`);
      } catch {
        // Store the raw string as a fallback
        parsedArgs = { _raw: toolState.argsAccumulator };
      }
    }
    toolState.toolArgs = parsedArgs;

    const latencyMs = event.timestamp - toolState.startTime;

    // Emit the action step now with complete args
    const actionStep: TrajectoryStep = {
      id: toolState.actionStepId,
      timestamp: toolState.startTime,
      type: 'action',
      content: `Calling ${toolState.toolName}...`,
      toolName: toolState.toolName,
      toolArgs: parsedArgs,
      latencyMs,
    };

    debug('Converter', `Tool call end: ${toolState.toolName} - action step emitted with args`);

    // Mark that we've emitted the action (so handleToolCallResult doesn't duplicate)
    toolState.actionStepId = ''; // Clear to indicate action was already emitted

    return [actionStep];
  }

  private handleToolCallResult(event: ToolCallResultEvent): TrajectoryStep[] {
    const toolState = this.activeTools.get(event.toolCallId);
    if (!toolState) return [];

    const latencyMs = event.timestamp - toolState.startTime;
    const steps: TrajectoryStep[] = [];

    // Check if action step was already emitted by handleToolCallEnd
    const actionAlreadyEmitted = !toolState.actionStepId;

    if (!actionAlreadyEmitted) {
      // Parse accumulated args now that we have all deltas
      let parsedArgs: any = {};
      if (toolState.argsAccumulator) {
        try {
          parsedArgs = JSON.parse(toolState.argsAccumulator);
          debug('Converter', `Tool args parsed: ${JSON.stringify(parsedArgs).substring(0, 200)}`);
        } catch {
          // Store the raw string as a fallback
          parsedArgs = { _raw: toolState.argsAccumulator };
        }
      }
      toolState.toolArgs = parsedArgs;

      // Emit the action step now that we have complete args
      steps.push({
        id: toolState.actionStepId,
        timestamp: toolState.startTime,
        type: 'action',
        content: `Calling ${toolState.toolName}...`,
        toolName: toolState.toolName,
        toolArgs: parsedArgs,
      });
    }

    // Parse result content
    let resultContent: string;
    try {
      const parsed = JSON.parse(event.content);
      resultContent = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
    } catch (e) {
      resultContent = event.content;
    }

    // Emit the tool_result step
    steps.push({
      id: uuidv4(),
      timestamp: event.timestamp,
      type: 'tool_result',
      content: resultContent,
      status: ToolCallStatus.SUCCESS,
      latencyMs,
    });

    this.activeTools.delete(event.toolCallId);

    debug('Converter', `Tool call result: ${toolState.toolName} -> ${steps.length} steps emitted (action already emitted: ${actionAlreadyEmitted})`);
    return steps;
  }

  // ============ THINKING Event Handlers ============

  private handleThinkingStart(event: any): TrajectoryStep[] {
    this.isThinking = true;
    debug('Converter', 'Thinking started');
    return [];
  }

  private handleThinkingEnd(event: any): TrajectoryStep[] {
    this.isThinking = false;
    debug('Converter', 'Thinking ended');
    return [];
  }

  private handleThinkingTextMessageStart(event: ThinkingTextMessageStartEvent): TrajectoryStep[] {
    this.currentThinkingMessage = {
      startTime: event.timestamp || Date.now(),
      content: '',
    };
    debug('Converter', 'Thinking text message started');
    return [];
  }

  private handleThinkingTextMessageContent(event: ThinkingTextMessageContentEvent): TrajectoryStep[] {
    if (this.currentThinkingMessage) {
      this.currentThinkingMessage.content += event.delta;
    }
    return [];
  }

  private handleThinkingTextMessageEnd(event: ThinkingTextMessageEndEvent): TrajectoryStep[] {
    if (!this.currentThinkingMessage) {
      debug('Converter', 'Thinking text end with no active thinking message');
      return [];
    }

    const content = this.currentThinkingMessage.content.trim();
    if (content.length === 0) {
      debug('Converter', 'Skipping empty thinking message');
      this.currentThinkingMessage = null;
      return [];
    }

    const latencyMs = (event.timestamp || Date.now()) - this.currentThinkingMessage.startTime;

    const step: TrajectoryStep = {
      id: uuidv4(),
      timestamp: this.currentThinkingMessage.startTime,
      type: 'thinking',
      content,
      latencyMs,
    };

    debug('Converter', `Thinking message completed: ${content.length} chars`);
    this.currentThinkingMessage = null;
    return [step];
  }

  private extractToolName(title: string): string {
    const runningMatch = title.match(/^Running\s+(.+)$/);
    if (runningMatch) return runningMatch[1];

    const completedMatch = title.match(/^(.+)\s+completed$/i);
    if (completedMatch) return completedMatch[1];

    return title;
  }

  private parseToolArgs(description: string): any {
    try {
      const args: any = {};
      const pairs = description.match(/(\w+):\s*("(?:[^"]|\\")*"|\w+)/g);

      if (pairs) {
        pairs.forEach(pair => {
          const [key, rawValue] = pair.split(':').map(s => s.trim());
          let value: any = rawValue;

          if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
            value = rawValue.slice(1, -1);
          } else if (rawValue === 'true') {
            value = true;
          } else if (rawValue === 'false') {
            value = false;
          } else if (!isNaN(Number(rawValue))) {
            value = Number(rawValue);
          }

          args[key] = value;
        });
        return args;
      }

      return { description };
    } catch (e) {
      return { description };
    }
  }
}

/**
 * Compute trajectory from raw AG-UI events
 * Use this to derive trajectory on-demand instead of storing both
 */
export function computeTrajectoryFromRawEvents(rawEvents: AGUIEvent[]): TrajectoryStep[] {
  const converter = new AGUIToTrajectoryConverter();
  const trajectory: TrajectoryStep[] = [];

  for (const event of rawEvents) {
    const steps = converter.processEvent(event);
    trajectory.push(...steps);
  }

  // Sort by timestamp to ensure correct chronological order
  // This is necessary because some events (like THINKING_TEXT_MESSAGE_END)
  // arrive after other events (like ACTIVITY_SNAPSHOT) even though they
  // logically occurred earlier based on their timestamps
  trajectory.sort((a, b) => a.timestamp - b.timestamp);

  return trajectory;
}
