/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { KiroConnector, kiroConnector } from '@/connectors/kiro';
import type { ConnectorRequest, ConnectorAuth } from '@/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';
import { ToolCallStatus } from '@/types';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

/**
 * Unit tests for the Kiro connector.
 *
 * The base SubprocessConnector covers spawn/stdin/stdout streaming. These
 * tests focus exclusively on the Kiro-specific behaviour: parsing
 * `[tool] Running:` / `[tool] status:` markers from stderr into structured
 * `action` + `tool_result` trajectory steps.
 */
describe('KiroConnector', () => {
  let connector: KiroConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;
  let mockProcess: any;

  beforeEach(() => {
    connector = new KiroConnector();

    mockTestCase = {
      id: 'tc-1',
      name: 'kiro test',
      initialPrompt: 'hello',
      expectedOutcomes: [],
      labels: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as TestCase;
    mockAuth = { type: 'none' };

    mockProcess = new EventEmitter();
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockProcess.stdin = { write: jest.fn(), end: jest.fn() };
    mockProcess.pid = 999;
    mockProcess.kill = jest.fn();

    (spawn as jest.Mock).mockReset();
    (spawn as jest.Mock).mockReturnValue(mockProcess);

    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildReq(): ConnectorRequest {
    return {
      testCase: mockTestCase,
      modelId: undefined,
      agentKey: 'kiro',
      payload: 'hello',
    } as ConnectorRequest;
  }

  /**
   * Drive the mock process: emit stdout/stderr chunks and close it.
   * `chunks` is an array of [streamName, data] tuples emitted in order
   * with a microtask gap so the connector's per-chunk handlers run.
   */
  async function runMock(
    chunks: Array<['stdout' | 'stderr', string]>,
    exitCode = 0
  ): Promise<{ trajectory: TrajectoryStep[]; rawEvents: any[] }> {
    const stepLog: TrajectoryStep[] = [];
    const rawLog: any[] = [];

    const promise = connector.execute(
      'kiro-cli',
      buildReq(),
      mockAuth,
      (s) => stepLog.push(s),
      (e) => rawLog.push(e),
    );

    // Allow execute() to attach event listeners before we emit
    await Promise.resolve();

    for (const [stream, data] of chunks) {
      mockProcess[stream].emit('data', Buffer.from(data));
      await Promise.resolve();
    }
    mockProcess.emit('close', exitCode, null);
    const result = await promise;
    return { trajectory: result.trajectory, rawEvents: result.rawEvents || [] };
  }

  describe('properties', () => {
    it('declares type "kiro"', () => {
      expect(connector.type).toBe('kiro');
    });
    it('has the human-readable name "Kiro CLI"', () => {
      expect(connector.name).toBe('Kiro CLI');
    });
    it('exports a default singleton instance', () => {
      expect(kiroConnector).toBeInstanceOf(KiroConnector);
    });
  });

  describe('stderr [tool] marker parsing', () => {
    it('emits one action + one tool_result for a single completed tool', async () => {
      const { trajectory } = await runMock([
        ['stdout', 'Today is Monday.\n'],
        ['stderr', '[tool] Running: date\n[tool] status: Completed\n'],
      ]);

      const actions = trajectory.filter(s => s.type === 'action');
      const toolResults = trajectory.filter(s => s.type === 'tool_result');
      expect(actions).toHaveLength(1);
      expect(actions[0].toolName).toBe('date');
      expect(actions[0].toolArgs).toEqual({ command: 'date' });

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolName).toBe('date');
      expect(toolResults[0].status).toBe(ToolCallStatus.SUCCESS);
    });

    it('emits FAILURE status for non-Completed/Success outcomes', async () => {
      const { trajectory } = await runMock([
        ['stderr', '[tool] Running: bad-cmd\n[tool] status: Failed\n'],
        ['stdout', 'Sorry, the tool failed.\n'],
      ]);
      const toolResults = trajectory.filter(s => s.type === 'tool_result');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].status).toBe(ToolCallStatus.FAILURE);
      expect(toolResults[0].toolName).toBe('bad-cmd');
    });

    it('handles multiple sequential tool calls', async () => {
      const { trajectory } = await runMock([
        ['stderr', '[tool] Running: find /tmp -name "*.md"\n'],
        ['stderr', '[tool] status: Completed\n'],
        ['stderr', '[tool] Running: wc -l /tmp/foo.md\n'],
        ['stderr', '[tool] status: Completed\n'],
        ['stdout', 'Found 1 file with 42 lines.\n'],
      ]);
      const actions = trajectory.filter(s => s.type === 'action');
      const toolResults = trajectory.filter(s => s.type === 'tool_result');
      expect(actions.map(a => a.toolName)).toEqual(['find', 'wc']);
      expect(toolResults).toHaveLength(2);
      expect(toolResults.every(r => r.status === ToolCallStatus.SUCCESS)).toBe(true);
    });

    it('reassembles tool markers split across stderr chunks', async () => {
      // Real-world stderr arrives in arbitrary chunk boundaries; we must buffer.
      const { trajectory } = await runMock([
        ['stderr', '[tool] Running: gl'],
        ['stderr', 'ob *.sop.md\n[tool'],
        ['stderr', '] status: Comp'],
        ['stderr', 'leted\n'],
        ['stdout', 'OK\n'],
      ]);
      const actions = trajectory.filter(s => s.type === 'action');
      expect(actions).toHaveLength(1);
      expect(actions[0].toolName).toBe('glob');
      expect(actions[0].toolArgs).toEqual({ command: 'glob *.sop.md' });
      const toolResults = trajectory.filter(s => s.type === 'tool_result');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].status).toBe(ToolCallStatus.SUCCESS);
    });

    it('ignores non-[tool] stderr lines (AWS warnings, telemetry, etc.)', async () => {
      const { trajectory } = await runMock([
        ['stderr', '2026-06-01T04:28Z WARN aws_runtime: profile [plugins] ignored\n'],
        ['stderr', '2026-06-01T04:28Z INFO fig_telemetry::endpoint: Resolving endpoint\n'],
        ['stderr', '[tool] Running: ls /tmp\n[tool] status: Completed\n'],
        ['stdout', 'A list.\n'],
      ]);
      const actions = trajectory.filter(s => s.type === 'action');
      expect(actions).toHaveLength(1);
      expect(actions[0].toolName).toBe('ls');
    });

    it('does not emit any action / tool_result step when stderr has no markers', async () => {
      const { trajectory } = await runMock([
        ['stderr', 'just some warnings\n'],
        ['stdout', 'Hello there.\n'],
      ]);
      expect(trajectory.filter(s => s.type === 'action')).toHaveLength(0);
      expect(trajectory.filter(s => s.type === 'tool_result')).toHaveLength(0);
      // But still emits the consolidated final response
      expect(trajectory.find(s => s.type === 'response')?.content).toContain('Hello there');
    });

    it('persists stderr chunks in rawEvents for downstream debugging', async () => {
      const { rawEvents } = await runMock([
        ['stdout', 'final\n'],
        ['stderr', '[tool] Running: date\n[tool] status: Completed\n'],
      ]);
      const stderrEvents = rawEvents.filter(e => e.type === 'stderr');
      expect(stderrEvents.length).toBeGreaterThan(0);
      const joined = stderrEvents.map(e => e.data).join('');
      expect(joined).toContain('[tool] Running: date');
    });

    it('resets pending tool state between separate runs', async () => {
      // First run: Running without a status (e.g. process killed mid-tool)
      await runMock([
        ['stderr', '[tool] Running: find /\n'],
        ['stdout', 'aborted\n'],
      ], 1);

      // Second run: must NOT carry the dangling Running over as a stale toolName
      const { trajectory } = await runMock([
        ['stderr', '[tool] Running: ls\n[tool] status: Completed\n'],
        ['stdout', 'done\n'],
      ]);
      const actions = trajectory.filter(s => s.type === 'action');
      const toolResults = trajectory.filter(s => s.type === 'tool_result');
      // Exactly one action ('ls') and one tool_result, both for 'ls'
      expect(actions.map(a => a.toolName)).toEqual(['ls']);
      expect(toolResults.map(r => r.toolName)).toEqual(['ls']);
    });
  });

  describe('stream end behaviour', () => {
    it('flushes a stderr partial line on close', async () => {
      // Marker arrives without a trailing newline; onBeforeStreamEnd must process it
      const { trajectory } = await runMock([
        ['stderr', '[tool] Running: echo hi\n[tool] status: Completed'],
        ['stdout', 'final\n'],
      ]);
      const toolResults = trajectory.filter(s => s.type === 'tool_result');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].status).toBe(ToolCallStatus.SUCCESS);
    });

    it('emits a final consolidated response step from stdout', async () => {
      const { trajectory } = await runMock([
        ['stdout', 'Line one\n'],
        ['stdout', 'Line two\n'],
      ]);
      const response = trajectory.find(s => s.type === 'response');
      expect(response).toBeDefined();
      expect(response!.content).toContain('Line one');
      expect(response!.content).toContain('Line two');
    });
  });
});
