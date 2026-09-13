/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Subprocess Connector
 * Handles communication with CLI tools by spawning child processes
 */

import { spawn, ChildProcess } from 'child_process';
import { ToolCallStatus } from '@/types';
import type { TrajectoryStep } from '@/types';
import { BaseConnector } from '@/services/connectors/base/BaseConnector';
import { agentPromptContext } from '@/services/connectors/types';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
  SubprocessConfig,
  ConnectorProtocol,
} from '@/services/connectors/types';

/**
 * Per-invocation streaming state.
 *
 * The connector registry hands out a SINGLETON connector instance that every
 * concurrent evaluation task shares. Any mutable field on the instance is
 * therefore shared across in-flight `execute()` calls — line buffers, the
 * captured session id, pending tool names… — and under `concurrency > 1`
 * one run's data lands on another run's report (measured live: 11/62
 * reports of a subprocess-agent benchmark carried a sibling case's
 * `sessionId`, so the trace poller then judged them on the sibling's
 * spans). Everything a single execution accumulates while parsing its own
 * child process's stdout/stderr MUST live on this object, which is created
 * per `execute()` call and threaded through every parse hook.
 *
 * Subclasses extend it via the `TState` generic and `createExecutionState()`.
 */
export interface SubprocessExecutionState {
  /** Clean stdout lines accumulated during streaming (base text parser). */
  streamBuffer: string[];
}

/**
 * The effective, immutable configuration for ONE `execute()` call:
 * constructor defaults overlaid with the request's `connectorConfig` (and, for
 * subclasses, whatever `resolveExecutionConfig()` derives from it). Resolved
 * once per call and captured by that call's closures — `this.config` (the
 * shared defaults) is never written during execution, so concurrent runs on
 * the shared singleton cannot see each other's args/env/timeout.
 */
export type ResolvedSubprocessConfig = Readonly<SubprocessConfig>;

/**
 * Default subprocess configuration
 */
const DEFAULT_SUBPROCESS_CONFIG: SubprocessConfig = {
  command: '',
  args: [],
  env: {},
  inputMode: 'stdin',
  outputParser: 'text',
  timeout: 300000, // 5 minutes
};

/**
 * Subprocess Connector for CLI tools
 * Spawns a child process and captures output
 */
export class SubprocessConnector<
  TState extends SubprocessExecutionState = SubprocessExecutionState,
> extends BaseConnector {
  readonly type: ConnectorProtocol = 'subprocess';
  override readonly name: string = 'Subprocess (CLI)';
  readonly supportsStreaming = true;

  /**
   * Default trace-context strategy for subprocess agents: propagate via the
   * W3C TRACEPARENT env var. Subclasses (Claude Code, Kiro, Pi) override
   * `serviceName` to point at their OpenSearch service.name for Strategy C.
   */
  override traceContext = { propagateEnv: true };

  protected config: SubprocessConfig;

  constructor(config?: Partial<SubprocessConfig>) {
    super();
    this.config = { ...DEFAULT_SUBPROCESS_CONFIG, ...config };
  }

  /**
   * Build input for the subprocess
   */
  buildPayload(request: ConnectorRequest): string {
    // Build a simple prompt string for CLI tools
    let prompt = request.testCase.initialPrompt;

    // Add context if available
    if (agentPromptContext(request.testCase.context).length > 0) {
      const contextStr = agentPromptContext(request.testCase.context)
        .map(c => `${c.description}: ${c.value}`)
        .join('\n');
      prompt = `Context:\n${contextStr}\n\nQuestion: ${prompt}`;
    }

    return prompt;
  }

  /**
   * Execute subprocess and capture output
   */
  async execute(
    endpoint: string, // For subprocess, this is the command name
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    this.debug('========== execute() STARTED ==========');

    // Fresh per-invocation parse state. Never stored on `this` — see
    // `SubprocessExecutionState` for why (shared singleton, concurrent runs).
    const state = this.createExecutionState();

    // Resolve the effective config for THIS call without touching
    // `this.config`. Every read below (spawn args, env, timeout, cwd, parser
    // mode — including the ones inside the async stdout/stderr/close
    // callbacks) goes through this local snapshot, so a concurrent
    // `execute()` on the shared singleton can never redirect them. (The
    // previous mutate-then-restore-in-`finally` pattern only held because no
    // `await` sat between the write and the synchronous reads; it silently
    // broke the moment a callback read `this.config` after the first await.)
    const config = this.resolveExecutionConfig(request);

    const command = endpoint || config.command;
    const args = config.args || [];
    // Use pre-built payload from hook if available, otherwise build fresh
    const input = request.payload || this.buildPayload(request);

    // Generate runId before spawning so the subprocess can include it in OTel spans
    const runId = `subprocess-${Date.now()}`;

    this.debug('Command:', command);
    this.debug('Args:', args);
    this.debug('Input mode:', config.inputMode);
    this.debug('Output parser:', config.outputParser);
    this.debug('Timeout:', config.timeout);
    this.debug('Input (first 500 chars):', input.substring(0, 500));
    this.debug('Working dir:', config.workingDir || process.cwd());
    this.debug('Run ID:', runId);

    // Merge environment variables.
    // AGENT_EVAL_RUN_ID is passed so the subprocess can set gen_ai.request.id
    // in its OTel spans, enabling trace correlation in the traces view.
    const env = {
      ...process.env,
      ...this.buildAuthEnv(auth),
      ...config.env,
      // W3C trace context (Strategy A): TRACEPARENT/TRACESTATE from the active
      // eval `test_case` span. Agents whose OTel SDK honors TRACEPARENT (pi —
      // verified) emit their spans under the eval span's traceId, giving the
      // trace poller an exact, window-free correlator. Despite the
      // `traceContext.propagateEnv` contract, this helper was never actually
      // wired into the spawn env before — subprocess agents silently ran
      // without trace context.
      ...this.buildTraceparentEnv(),
      AGENT_EVAL_RUN_ID: runId,
    };

    return new Promise((resolve, reject) => {
      const trajectory: TrajectoryStep[] = [];
      const rawOutput: Array<{ type: string; data: string; timestamp: number }> = [];
      let stdout = '';
      let stderr = '';
      let settled = false;

      // Build final args (add input as argument if inputMode is 'arg').
      //
      // We spawn with `shell: false` (the default) and pass `args` as an
      // array. The OS exec syscall delivers each array element as a separate
      // argv slot to the child binary verbatim, with NO shell interpretation
      // — so spaces, slashes, quotes, backticks, `$()`, `;`, `&`, and other
      // shell metacharacters in the prompt are passed through as literal
      // bytes instead of being evaluated. This is the only safe way to pass
      // user-controlled prompt strings to spawn().
      //
      // Historical note: an earlier version used `shell: true` and a
      // hand-rolled `shellQuote` that only escaped single quotes. That left
      // a command-injection hole — a prompt containing `'$(rm -rf ~)'` would
      // get evaluated by /bin/sh. Switching to `shell: false` removes the
      // attack surface entirely; quoting is no longer the connector's job.
      const finalArgs = config.inputMode === 'arg'
        ? [...args, input]
        : args;

      this.debug('Spawning process...');
      this.debug('Full command:', command, finalArgs.join(' '));
      const proc = spawn(command, finalArgs, {
        env,
        cwd: config.workingDir,
        shell: false,
      });
      this.debug('Process spawned, PID:', proc.pid);

      // Set timeout
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.debug('TIMEOUT reached, killing process');
        proc.kill('SIGTERM');
        reject(new Error(`Subprocess timed out after ${config.timeout}ms`));
      }, config.timeout);

      // Send input via stdin if inputMode is 'stdin'
      if (config.inputMode === 'stdin') {
        this.debug('Writing input to stdin...');
        proc.stdin.write(input);
        proc.stdin.end();
        this.debug('stdin closed');
      }

      // Handle stdout
      proc.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        this.debug('stdout received:', chunk.length, 'bytes');
        this.debug('stdout preview:', chunk.substring(0, 200));
        stdout += chunk;
        rawOutput.push({ type: 'stdout', data: chunk, timestamp: Date.now() });
        onRawEvent?.({ type: 'stdout', data: chunk });

        // For streaming mode, try to parse and emit steps
        if (config.outputParser === 'streaming') {
          this.parseStreamingOutput(chunk, trajectory, onProgress, state);
        }
      });

      // Handle stderr.
      //
      // We push stderr chunks into rawOutput (alongside stdout) so the saved
      // benchmark report retains them. Without this, agents that emit
      // structured tool events on stderr (e.g. kiro-cli's `[tool] Running:`
      // markers) leave no audit trail in the persisted run, and the LLM judge
      // is forced to grade the agent's narrative alone.
      //
      // We also delegate streaming-mode subclasses a hook (`parseStderrChunk`)
      // so they can convert stderr-borne events into trajectory steps in
      // real time. The default implementation is a no-op for connectors
      // (claude-code, plain text CLIs) that don't carry events on stderr.
      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        this.debug('stderr received:', chunk.length, 'bytes');
        this.debug('stderr:', chunk);
        stderr += chunk;
        rawOutput.push({ type: 'stderr', data: chunk, timestamp: Date.now() });
        onRawEvent?.({ type: 'stderr', data: chunk });

        if (config.outputParser === 'streaming') {
          this.parseStderrChunk(chunk, trajectory, onProgress, state);
        }
      });

      // Handle process exit
      proc.on('close', (code: number, signal: string) => {
        this.debug('Process closed with code:', code, 'signal:', signal);
        clearTimeout(timeoutId);
        if (settled) return;
        settled = true;

        if (code !== 0) {
          // Non-zero exit code - create error response but don't reject
          this.debug('Non-zero exit code:', code);
          this.error(`Process exited with code ${code}`);
          this.error('stderr:', stderr);
        }

        // Flush subclass buffers before finalizing streaming trajectory
        if (config.outputParser === 'streaming') {
          this.onBeforeStreamEnd(trajectory, onProgress, state);

          // Surface error when streaming produced no steps
          if (code !== 0 && trajectory.length === 0) {
            const errorContent = stderr.trim()
              ? `Error: Process exited with code ${code}. ${stderr.trim()}`
              : `Error: Process exited with code ${code}`;
            const errorStep = this.createStep('tool_result', errorContent, {
              status: ToolCallStatus.FAILURE,
            });
            trajectory.push(errorStep);
            onProgress?.(errorStep);
          }
        }

        // Parse final output
        const finalTrajectory = config.outputParser === 'streaming'
          ? trajectory
          : this.parseResponse({ stdout, stderr, exitCode: code }, config);

        // Emit steps if not already streamed
        if (config.outputParser !== 'streaming') {
          finalTrajectory.forEach(step => onProgress?.(step));
        }

        this.debug('Resolving with trajectory of', finalTrajectory.length, 'steps');
        resolve({
          trajectory: finalTrajectory,
          runId,
          rawEvents: rawOutput,
          metadata: {
            command,
            args: finalArgs,
            exitCode: code,
            stderr: stderr || undefined,
            ...this.extraResultMetadata(state),
          },
        });
      });

      // Handle errors
      proc.on('error', (error: Error) => {
        this.debug('ERROR event:', error.message);
        clearTimeout(timeoutId);
        if (settled) return;
        settled = true;

        // Provide more helpful error messages for common failures
        let errorMsg = `Failed to spawn subprocess: ${error.message}`;
        if (error.message.includes('ENOENT')) {
          errorMsg = `Command '${command}' not found. Is it installed and in PATH?`;
          console.error(`[Subprocess] ENOENT error - command '${command}' not found in PATH`);
        } else if (error.message.includes('EACCES')) {
          errorMsg = `Permission denied executing '${command}'. Check file permissions.`;
          console.error(`[Subprocess] EACCES error - permission denied for '${command}'`);
        } else if (error.message.includes('EPERM')) {
          errorMsg = `Operation not permitted for '${command}'. May require elevated privileges.`;
          console.error(`[Subprocess] EPERM error - operation not permitted`);
        }

        reject(new Error(errorMsg));
      });
    });
    this.debug('========== execute() COMPLETED ==========');
  }

  /**
   * Create the per-invocation parse state for one `execute()` call.
   * Subclasses that buffer anything while streaming (partial NDJSON lines,
   * pending tool names, captured ids) override this to add their fields —
   * and must NOT keep that data on the instance.
   */
  protected createExecutionState(): TState {
    return { streamBuffer: [] } as unknown as TState;
  }

  /**
   * Resolve the effective config for one `execute()` call: constructor
   * defaults overlaid with the request's `connectorConfig` (so any agent
   * registered with `connectorType: 'subprocess'` can specify command / args /
   * inputMode / outputParser / timeout / workingDir / env per agent). Pure —
   * MUST NOT write to `this.config`. Subclasses override to translate their
   * own `connectorConfig` shape (Claude Code flags, Pi package/model) into the
   * base fields, typically by calling `super.resolveExecutionConfig()` on a
   * request whose `connectorConfig` has been rewritten into base shape.
   */
  protected resolveExecutionConfig(request: ConnectorRequest): ResolvedSubprocessConfig {
    const o = (request.connectorConfig || {}) as Partial<SubprocessConfig>;
    return {
      ...this.config,
      ...(o.command !== undefined ? { command: o.command as string } : {}),
      ...(o.args !== undefined ? { args: [...(o.args as string[])] } : { args: [...(this.config.args || [])] }),
      env: { ...(this.config.env || {}), ...((o.env as Record<string, string>) || {}) },
      ...(o.inputMode !== undefined ? { inputMode: o.inputMode } : {}),
      ...(o.outputParser !== undefined ? { outputParser: o.outputParser } : {}),
      ...(o.timeout !== undefined ? { timeout: o.timeout as number } : {}),
      ...(o.workingDir !== undefined ? { workingDir: o.workingDir as string } : {}),
    };
  }

  /**
   * Parse a stderr chunk in streaming mode. Default is a no-op.
   *
   * Override in subclasses for CLIs that carry tool-event markers on stderr.
   * Implementations should buffer partial lines (chunks rarely align with
   * line boundaries) in `state` and emit steps via `onProgress` AND push them
   * onto `trajectory` so they appear in the final response.
   */
  protected parseStderrChunk(
    _chunk: string,
    _trajectory: TrajectoryStep[],
    _onProgress: ConnectorProgressCallback | undefined,
    _state: TState
  ): void {
    // No-op by default; KiroConnector overrides this.
  }

  /**
   * Subclass hook: extra protocol-specific fields to merge into the
   * connector result `metadata`, read from the per-invocation `state` (Claude
   * Code surfaces its captured `sessionId` for Strategy D trace correlation).
   * Default: none.
   */
  protected extraResultMetadata(_state: TState): Record<string, any> {
    return {};
  }

  /**
   * Parse streaming output and emit steps in real-time.
   *
   * For plain-text CLIs (Kiro etc.) we:
   *   1. strip ANSI escape codes (color, cursor moves, spinner frames)
   *   2. drop lines that are empty / pure control characters / spinner glyphs
   *   3. emit each surviving line as an `assistant` step immediately
   *   4. buffer the cleaned text so `onBeforeStreamEnd()` can emit a final
   *      `response` step containing the full coherent answer (good for the
   *      judge) — without losing the live stream.
   */
  protected parseStreamingOutput(
    chunk: string,
    trajectory: TrajectoryStep[],
    onProgress: ConnectorProgressCallback | undefined,
    state: TState
  ): void {
    // Legacy subclasses compiled against the pre-`state` signature call
    // `super.parseStreamingOutput(chunk, trajectory, onProgress)`; tolerate
    // the missing argument by falling back to a throwaway buffer rather than
    // crashing mid-stream (they lose the consolidated `response` step, which
    // is what they had before this hook existed).
    const buf = state?.streamBuffer ?? [];
    // Strip ANSI: CSI sequences (\x1b[...m, cursor moves, etc.) and OSC
    const stripped = chunk
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // OSC ... BEL
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')            // CSI
      .replace(/\x1b[=>NOP\\]/g, '')                     // single-char escapes
      .replace(/\r/g, '\n');                             // normalize CR to NL

    const lines = stripped.split('\n');
    for (const raw of lines) {
      // Drop control chars, BEL, spinner braille glyphs, and trim
      const line = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
      if (!line) continue;
      // Skip pure-spinner lines (just braille dots / progress glyphs)
      if (/^[⠁-⣿\s]+$/.test(line)) continue;
      // Skip very short lines that are likely artifacts
      if (line.length < 2 && !/[A-Za-z0-9]/.test(line)) continue;

      buf.push(line);
      const step = this.createStep('assistant', line);
      trajectory.push(step);
      onProgress?.(step);
    }
  }

  /**
   * On stream end: emit a consolidated `response` step containing the full
   * clean output. Streaming gave the user real-time visibility; this final
   * step gives the judge a single coherent answer to grade against.
   */
  protected onBeforeStreamEnd(
    trajectory: TrajectoryStep[],
    onProgress: ConnectorProgressCallback | undefined,
    state: TState
  ): void {
    if (state?.streamBuffer?.length) {
      const finalText = state.streamBuffer.join('\n').trim();
      state.streamBuffer = [];
      if (finalText) {
        const step = this.createStep('response', finalText);
        trajectory.push(step);
        onProgress?.(step);
      }
    }
  }

  /**
   * Parse final subprocess output
   */
  parseResponse(
    data: { stdout: string; stderr: string; exitCode: number },
    config: ResolvedSubprocessConfig = this.config
  ): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    if (config.outputParser === 'json') {
      // Try to parse as JSON
      try {
        const parsed = JSON.parse(data.stdout);
        return this.parseJsonOutput(parsed);
      } catch {
        // Fall back to text parsing
        this.debug('Failed to parse JSON output, falling back to text');
      }
    }

    // Text parsing - treat entire output as response (only on success)
    if (data.stdout.trim() && data.exitCode === 0) {
      steps.push(this.createStep('response', data.stdout.trim()));
    }

    // Add error if non-zero exit code
    if (data.exitCode !== 0) {
      const errorContent = data.stderr.trim()
        ? `Error: Process exited with code ${data.exitCode}. ${data.stderr.trim()}`
        : data.stdout.trim()
          ? `Error: Process exited with code ${data.exitCode}. stdout: ${data.stdout.trim()}`
          : `Error: Process exited with code ${data.exitCode} (no output)`;
      steps.push(this.createStep('tool_result', errorContent, {
        status: ToolCallStatus.FAILURE,
      }));
    }

    return steps;
  }

  /**
   * Parse JSON output into trajectory steps
   */
  protected parseJsonOutput(data: any): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    if (data.thinking) {
      steps.push(this.createStep('thinking', data.thinking));
    }

    if (data.steps && Array.isArray(data.steps)) {
      for (const step of data.steps) {
        steps.push(this.createStep(step.type || 'assistant', step.content, {
          toolName: step.toolName,
          toolArgs: step.toolArgs,
        }));
      }
    }

    if (data.response || data.answer || data.content) {
      steps.push(this.createStep('response', data.response || data.answer || data.content));
    }

    return steps;
  }

  /**
   * Health check - verify command exists
   */
  async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    const command = endpoint || this.config.command;
    if (!command) return false;

    return new Promise((resolve) => {
      // shell: false to avoid metacharacter expansion on the command name.
      // `which` itself is invoked from PATH; a malicious endpoint string
      // (e.g. `kiro-cli; rm -rf ~`) would have been evaluated under shell:
      // true, but here it's passed as a literal argv slot to `which` which
      // will simply return non-zero for a name that doesn't exist on PATH.
      const proc = spawn('which', [command], { shell: false });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }
}

/**
 * Default instance for convenience
 */
export const subprocessConnector = new SubprocessConnector();
