/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-run log capture (#612): while a run executes in the CLI, `console.log`
 * chatter goes to `<dir>/<runId>.log` (and to the terminal only when verbose);
 * warnings and errors always reach the terminal AND the file. Real files.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { startRunLogCapture, runLogDirFor } from '@/cli/utils/runLogCapture';

describe('startRunLogCapture', () => {
  let dir: string;
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  let terminal: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ah-runlog-'));
    terminal = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    console.log = terminal.log; console.warn = terminal.warn; console.error = terminal.error;
  });
  afterEach(() => {
    Object.assign(console, original);
    rmSync(dir, { recursive: true, force: true });
  });

  it('non-verbose: info lines go only to the file; warn/error go to both; stop() restores the console', () => {
    const t0 = new Date('2026-03-01T10:00:00.000Z');
    const capture = startRunLogCapture({ runId: 'eval-run-1/x', verbose: false, dir, now: () => t0 });
    expect(capture.logPath).toBe(path.join(dir, 'eval-run-1_x.log'));
    expect(existsSync(capture.logPath)).toBe(false); // lazy
    console.log('[EvaluationRunner] Starting run', 42);
    console.warn('⚠️  mock judge');
    console.error('boom', new Error('x').message);
    capture.stop();
    console.log('after stop');
    const lines = readFileSync(capture.logPath, 'utf-8').trim().split('\n');
    expect(lines).toEqual([
      '2026-03-01T10:00:00.000Z info  [EvaluationRunner] Starting run 42',
      '2026-03-01T10:00:00.000Z warn  ⚠️  mock judge',
      '2026-03-01T10:00:00.000Z error boom x',
    ]);
    expect(terminal.log).toHaveBeenCalledTimes(1);
    expect(terminal.log).toHaveBeenCalledWith('after stop');
    expect(terminal.warn).toHaveBeenCalledWith('⚠️  mock judge');
    expect(terminal.error).toHaveBeenCalledWith('boom', 'x');
  });

  it('verbose: info lines reach the terminal too; stop() is idempotent', () => {
    const capture = startRunLogCapture({ runId: 'r', verbose: true, dir });
    console.log('hello');
    expect(terminal.log).toHaveBeenCalledWith('hello');
    capture.stop();
    capture.stop();
    expect(console.log).toBe(terminal.log);
    expect(readFileSync(capture.logPath, 'utf-8')).toMatch(/ info  hello\n$/);
  });

  it('default directory is <cwd>/.agent-health/logs', () => {
    expect(runLogDirFor('/proj')).toBe(path.join('/proj', '.agent-health', 'logs'));
  });
});
