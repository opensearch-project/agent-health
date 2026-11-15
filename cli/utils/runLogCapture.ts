/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-run log capture for the CLI executor (#612).
 *
 * The shared runner, the connectors and the judge report their progress with
 * `console.log` — fine in a server log, noise on a user's terminal next to a
 * spinner. While a run executes in the CLI process those info lines go to a
 * per-run log file (`<cwd>/.agent-health/logs/<runId>.log`) and are shown on
 * the terminal only in verbose mode. Warnings and errors (`console.warn` /
 * `console.error` — e.g. the mock-judge notice, hook failures) always reach
 * the terminal AND the file, so nothing a user must see is hidden.
 */

import { appendFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { format } from 'util';

export interface RunLogCapture {
  /** Absolute path of the log file (created lazily on the first line). */
  readonly logPath: string;
  /** Restore the console. Idempotent. */
  stop(): void;
}

/** Default log directory: `<cwd>/.agent-health/logs`. */
export function runLogDirFor(cwd: string = process.cwd()): string {
  return path.join(cwd, '.agent-health', 'logs');
}

export function startRunLogCapture(options: { runId: string; verbose: boolean; dir?: string; now?: () => Date }): RunLogCapture {
  const dir = options.dir ?? runLogDirFor();
  const logPath = path.join(dir, `${options.runId.replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  const now = options.now ?? (() => new Date());
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  let dirReady = false;
  const write = (level: string, args: unknown[]): void => {
    try {
      if (!dirReady) { mkdirSync(dir, { recursive: true }); dirReady = true; }
      appendFileSync(logPath, `${now().toISOString()} ${level.padEnd(5)} ${format(...(args as [unknown, ...unknown[]]))}\n`);
    } catch { /* logging must never break a run */ }
  };
  console.log = (...args: unknown[]) => { write('info', args); if (options.verbose) original.log(...args); };
  console.info = (...args: unknown[]) => { write('info', args); if (options.verbose) original.info(...args); };
  console.debug = (...args: unknown[]) => { write('debug', args); if (options.verbose) original.debug(...args); };
  console.warn = (...args: unknown[]) => { write('warn', args); original.warn(...args); };
  console.error = (...args: unknown[]) => { write('error', args); original.error(...args); };
  let stopped = false;
  return {
    logPath,
    stop() {
      if (stopped) return;
      stopped = true;
      console.log = original.log; console.info = original.info; console.warn = original.warn;
      console.error = original.error; console.debug = original.debug;
    },
  };
}
