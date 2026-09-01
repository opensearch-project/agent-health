/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Kiro CLI Connector
 *
 * Specialized subprocess connector for `kiro-cli chat --no-interactive`.
 *
 * Why this exists
 * ---------------
 * The base `SubprocessConnector` parses Kiro's stdout as a stream of plain
 * text lines (assistant chunks). That works for live UI streaming but loses
 * all evidence of which tools the agent actually invoked. The judge then has
 * nothing to evidence-check against — a polished hallucinated narrative
 * scores the same as a tool-grounded investigation.
 *
 * Kiro DOES emit structured tool events, but on stderr in a line-oriented
 * format:
 *
 *     [tool] Running: <command_or_invocation>
 *     [tool] status: <Completed|Failed|Cancelled|...>
 *
 * This connector intercepts those stderr lines and converts them into
 * proper `action` + `tool_result` trajectory steps, so:
 *   - The judge can see what tools ran (and whether they succeeded).
 *   - SDK matchers like `expect(traj).to.haveCalledTool('glob')` actually
 *     have something to assert against.
 *   - A future "RCA + Grounded" evaluator can require that any factual
 *     claim be backed by at least one `tool_result` step.
 *
 * Stdout streaming behaviour (line-by-line `assistant` chunks plus a final
 * consolidated `response`) is inherited unchanged from the base class.
 */

import { ToolCallStatus } from '@/types';
import type { TrajectoryStep } from '@/types';
import { SubprocessConnector } from '@/connectors/subprocess';
import type {
  ConnectorAuth,
  ConnectorProgressCallback,
  SubprocessConfig,
} from '@/connectors/types';

/**
 * Default Kiro configuration.
 *
 * `--agent-engine v2` is required so slash commands like `/<slash-command> ...`
 * route through the agent registry. The default (v1) non-interactive parser
 * treats `/<word>` as an unknown subcommand and exits early.
 *
 * `--no-interactive` is required for headless invocation but suppresses
 * sqlite session persistence, which is why we rely on stderr `[tool]`
 * markers rather than the on-disk conversations_v2 table.
 */
const KIRO_DEFAULT_CONFIG: Partial<SubprocessConfig> = {
  command: 'kiro-cli',
  args: [
    'chat',
    '--agent-engine', 'v2',
    '--no-interactive',
    '--trust-all-tools',
  ],
  env: {},
  inputMode: 'arg',
  outputParser: 'streaming',
  timeout: 600000, // 10 minutes
};

export class KiroConnector extends SubprocessConnector {
  override readonly type = 'kiro' as const;
  override readonly name = 'Kiro CLI';

  override traceContext = { propagateEnv: true, serviceName: 'kiro-agent' };

  /** Carry-over for a partial last line on stderr stream */
  private stderrLineBuffer = '';

  /** Tool name from the last unmatched `[tool] Running:` line, used to
   *  attach the same toolName to the corresponding `[tool] status:` row. */
  private pendingToolName: string | null = null;

  constructor(config?: Partial<SubprocessConfig>) {
    super({ ...KIRO_DEFAULT_CONFIG, ...config });
  }

  /**
   * Convert kiro-cli's stderr `[tool]` markers into trajectory steps.
   *
   * Each chunk may straddle line boundaries, so we accumulate into
   * `stderrLineBuffer` and only consume complete lines (the trailing
   * partial line is held until the next chunk or `onBeforeStreamEnd`).
   */
  protected override parseStderrChunk(
    chunk: string,
    trajectory: TrajectoryStep[],
    onProgress?: ConnectorProgressCallback
  ): void {
    this.stderrLineBuffer += chunk;
    const lines = this.stderrLineBuffer.split('\n');
    this.stderrLineBuffer = lines.pop() || '';

    for (const raw of lines) {
      this.processStderrLine(raw, trajectory, onProgress);
    }
  }

  /**
   * Drain any held partial line from the stderr buffer and reset
   * per-run state, then defer to the base class to flush the
   * consolidated stdout response step.
   */
  protected override onBeforeStreamEnd(
    trajectory: TrajectoryStep[],
    onProgress?: ConnectorProgressCallback
  ): void {
    if (this.stderrLineBuffer.trim()) {
      this.processStderrLine(this.stderrLineBuffer, trajectory, onProgress);
    }
    this.stderrLineBuffer = '';
    this.pendingToolName = null;

    // Base class emits the consolidated `response` step from buffered stdout.
    super.onBeforeStreamEnd(trajectory, onProgress);
  }

  /**
   * Parse a single stderr line. Recognised forms:
   *
   *   [tool] Running: <command>          -> emit `action` step
   *   [tool] status: Completed           -> emit `tool_result` (SUCCESS)
   *   [tool] status: Failed              -> emit `tool_result` (FAILURE)
   *   [tool] status: <anything else>     -> emit `tool_result` (FAILURE)
   *
   * Other stderr lines (AWS SDK warnings, telemetry info, etc.) are ignored.
   */
  private processStderrLine(
    raw: string,
    trajectory: TrajectoryStep[],
    onProgress?: ConnectorProgressCallback
  ): void {
    // Drop NUL/control bytes that occasionally slip into stderr
    const line = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
    if (!line.startsWith('[tool]')) return;

    const m = line.match(/^\[tool\]\s+(Running|status):\s*(.*)$/i);
    if (!m) return;

    const kind = m[1].toLowerCase();
    const payload = m[2].trim();

    if (kind === 'running') {
      // Best-effort tool name: first whitespace-separated token. For
      // shell tool calls this is the command (e.g. `wc`, `find`); for
      // first-party tools (e.g. `glob`, `use_subagent`) it's the tool
      // name itself. We keep the full payload as `command` in toolArgs
      // so SDK matchers and judges can pattern-match on it.
      const toolName = payload.split(/\s+/)[0] || 'unknown';
      const toolArgs = { command: payload };
      this.pendingToolName = toolName;

      const step = this.createStep('action', JSON.stringify(toolArgs), {
        toolName,
        toolArgs,
      });
      trajectory.push(step);
      onProgress?.(step);
      return;
    }

    if (kind === 'status') {
      const success = /^(Completed|Success)/i.test(payload);
      const step = this.createStep(
        'tool_result',
        `status: ${payload}`,
        {
          status: success ? ToolCallStatus.SUCCESS : ToolCallStatus.FAILURE,
          toolName: this.pendingToolName ?? undefined,
        }
      );
      trajectory.push(step);
      onProgress?.(step);
      this.pendingToolName = null;
    }
  }

  override async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    return super.healthCheck(endpoint || 'kiro-cli', auth);
  }
}

/**
 * Default instance for convenience.
 */
export const kiroConnector = new KiroConnector();
