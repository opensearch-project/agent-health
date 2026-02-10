/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Subprocess Connector
 * Handles communication with CLI tools by spawning child processes
 */

import { spawn, ChildProcess } from 'child_process';
import type { TrajectoryStep } from '@/types';
import { BaseConnector } from '@/services/connectors/base/BaseConnector';
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
export class SubprocessConnector extends BaseConnector {
  readonly type: ConnectorProtocol = 'subprocess';
  override readonly name: string = 'Subprocess (CLI)';
  readonly supportsStreaming = true;

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
    if (request.testCase.context && request.testCase.context.length > 0) {
      const contextStr = request.testCase.context
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
    console.log('[Subprocess] ========== execute() STARTED ==========');
    const command = endpoint || this.config.command;
    const args = this.config.args || [];
    // Use pre-built payload from hook if available, otherwise build fresh
    const input = request.payload || this.buildPayload(request);

    console.log('[Subprocess] Command:', command);
    console.log('[Subprocess] Args:', args);
    console.log('[Subprocess] Input mode:', this.config.inputMode);
    console.log('[Subprocess] Output parser:', this.config.outputParser);
    console.log('[Subprocess] Timeout:', this.config.timeout);
    console.log('[Subprocess] Input (first 500 chars):', input.substring(0, 500));
    console.log('[Subprocess] Working dir:', this.config.workingDir || process.cwd());

    this.debug('Executing subprocess');
    this.debug('Command:', command);
    this.debug('Args:', args.join(' '));
    this.debug('Input:', input.substring(0, 200));

    // Merge environment variables
    const env = {
      ...process.env,
      ...this.buildAuthEnv(auth),
      ...this.config.env,
    };

    return new Promise((resolve, reject) => {
      const trajectory: TrajectoryStep[] = [];
      const rawOutput: Array<{ type: string; data: string; timestamp: number }> = [];
      let stdout = '';
      let stderr = '';
      let settled = false;

      // Build final args (add input as argument if inputMode is 'arg')
      const finalArgs = this.config.inputMode === 'arg'
        ? [...args, input]
        : args;

      console.log('[Subprocess] Spawning process...');
      console.log('[Subprocess] Full command:', command, finalArgs.join(' '));
      const proc = spawn(command, finalArgs, {
        env,
        cwd: this.config.workingDir,
        shell: true,
      });
      console.log('[Subprocess] Process spawned, PID:', proc.pid);

      // Set timeout
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.log('[Subprocess] TIMEOUT reached, killing process');
        proc.kill('SIGTERM');
        reject(new Error(`Subprocess timed out after ${this.config.timeout}ms`));
      }, this.config.timeout);

      // Send input via stdin if inputMode is 'stdin'
      if (this.config.inputMode === 'stdin') {
        console.log('[Subprocess] Writing input to stdin...');
        proc.stdin.write(input);
        proc.stdin.end();
        console.log('[Subprocess] stdin closed');
      }

      // Handle stdout
      proc.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log('[Subprocess] stdout received:', chunk.length, 'bytes');
        console.log('[Subprocess] stdout preview:', chunk.substring(0, 200));
        stdout += chunk;
        rawOutput.push({ type: 'stdout', data: chunk, timestamp: Date.now() });
        onRawEvent?.({ type: 'stdout', data: chunk });

        // For streaming mode, try to parse and emit steps
        if (this.config.outputParser === 'streaming') {
          this.parseStreamingOutput(chunk, trajectory, onProgress);
        }
      });

      // Handle stderr
      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log('[Subprocess] stderr received:', chunk.length, 'bytes');
        console.log('[Subprocess] stderr:', chunk);
        stderr += chunk;
        onRawEvent?.({ type: 'stderr', data: chunk });
        this.debug('stderr:', chunk);
      });

      // Handle process exit
      proc.on('close', (code: number, signal: string) => {
        console.log('[Subprocess] Process closed with code:', code, 'signal:', signal);
        clearTimeout(timeoutId);
        if (settled) return;
        settled = true;

        if (code !== 0) {
          // Non-zero exit code - create error response but don't reject
          console.log('[Subprocess] Non-zero exit code:', code);
          this.error(`Process exited with code ${code}`);
          this.error('stderr:', stderr);
        }

        // Parse final output
        const finalTrajectory = this.config.outputParser === 'streaming'
          ? trajectory
          : this.parseResponse({ stdout, stderr, exitCode: code });

        // Emit steps if not already streamed
        if (this.config.outputParser !== 'streaming') {
          finalTrajectory.forEach(step => onProgress?.(step));
        }

        console.log('[Subprocess] Resolving with trajectory of', finalTrajectory.length, 'steps');
        resolve({
          trajectory: finalTrajectory,
          runId: `subprocess-${Date.now()}`,
          rawEvents: rawOutput,
          metadata: {
            command,
            args: finalArgs,
            exitCode: code,
            stderr: stderr || undefined,
          },
        });
      });

      // Handle errors
      proc.on('error', (error: Error) => {
        console.log('[Subprocess] ERROR event:', error.message);
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
    console.log('[Subprocess] ========== execute() COMPLETED ==========');
  }

  /**
   * Parse streaming output and emit steps in real-time
   */
  protected parseStreamingOutput(
    chunk: string,
    trajectory: TrajectoryStep[],
    onProgress?: ConnectorProgressCallback
  ): void {
    // Default implementation treats each line as potential output
    // Subclasses can override for protocol-specific parsing
    const lines = chunk.split('\n').filter(line => line.trim());
    for (const line of lines) {
      const step = this.createStep('assistant', line);
      trajectory.push(step);
      onProgress?.(step);
    }
  }

  /**
   * Parse final subprocess output
   */
  parseResponse(data: { stdout: string; stderr: string; exitCode: number }): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    if (this.config.outputParser === 'json') {
      // Try to parse as JSON
      try {
        const parsed = JSON.parse(data.stdout);
        return this.parseJsonOutput(parsed);
      } catch {
        // Fall back to text parsing
        this.debug('Failed to parse JSON output, falling back to text');
      }
    }

    // Text parsing - treat entire output as response
    if (data.stdout.trim()) {
      steps.push(this.createStep('response', data.stdout.trim()));
    }

    // Add error if non-zero exit code
    if (data.exitCode !== 0 && data.stderr.trim()) {
      steps.push(this.createStep('tool_result', `Error: ${data.stderr.trim()}`, {
        status: 'FAILURE' as any,
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
      const proc = spawn('which', [command], { shell: true });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }
}

/**
 * Default instance for convenience
 */
export const subprocessConnector = new SubprocessConnector();
