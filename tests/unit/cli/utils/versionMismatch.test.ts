/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the ensureServer() VERSION-MISMATCH restart decision.
 *
 * The decision logic is extracted into cli/utils/versionMismatch.ts (a pure,
 * import.meta-free module) so it can be imported under ts-jest — serverLifecycle.ts
 * itself uses ESM-only constructs the CommonJS test transform can't parse. The
 * wiring (probe → decision → kill or throw) is covered end-to-end with real
 * processes by tests/integration/cli/cliUpgradeKeepsRuns.integration.test.ts.
 *
 * Issue #612, problem 5: a CLI whose version differs from the server's used to
 * kill the server unconditionally, losing any run it was executing.
 */

import {
  decideVersionMismatchRestart,
  parseActiveRuns,
  restartRefusedError,
  validPid,
} from '@/cli/utils/versionMismatch';

describe('parseActiveRuns()', () => {
  it('reads the /health activeRuns block', () => {
    expect(parseActiveRuns({ count: 2, runs: [{ id: 'run-1', kind: 'benchmark' }, { id: 'eval-run-2', kind: 'evaluation' }] }))
      .toEqual({ count: 2, runs: [{ id: 'run-1', kind: 'benchmark' }, { id: 'eval-run-2', kind: 'evaluation' }] });
  });

  it('keeps count when the listed ids are capped', () => {
    expect(parseActiveRuns({ count: 25, runs: [{ id: 'run-1', kind: 'benchmark' }] }))
      .toEqual({ count: 25, runs: [{ id: 'run-1', kind: 'benchmark' }] });
  });

  it('returns undefined for servers that predate the field or report it malformed', () => {
    expect(parseActiveRuns(undefined)).toBeUndefined();
    expect(parseActiveRuns(null)).toBeUndefined();
    expect(parseActiveRuns('3')).toBeUndefined();
    expect(parseActiveRuns({ count: '3', runs: [] })).toBeUndefined();
    expect(parseActiveRuns({ count: -1, runs: [] })).toBeUndefined();
    expect(parseActiveRuns({ count: 1 })).toBeUndefined();
    expect(parseActiveRuns({ count: 1, runs: [{ kind: 'benchmark' }] })).toBeUndefined();
    expect(parseActiveRuns({ count: 1, runs: [{ id: '' }] })).toBeUndefined();
  });

  it('rejects a summary that lists more runs than it counts (contradictory evidence is no evidence)', () => {
    expect(parseActiveRuns({ count: 0, runs: [{ id: 'run-live', kind: 'benchmark' }] })).toBeUndefined();
  });

  it('rejects ids/kinds that are not printable bounded tokens (they are echoed into the terminal)', () => {
    expect(parseActiveRuns({ count: 1, runs: [{ id: 'run-1\u001b[2Jx', kind: 'benchmark' }] })).toBeUndefined();
    expect(parseActiveRuns({ count: 1, runs: [{ id: 'x'.repeat(201), kind: 'benchmark' }] })).toBeUndefined();
    expect(parseActiveRuns({ count: 1, runs: [{ id: 'run-1', kind: 'bench\nmark' }] }))
      .toEqual({ count: 1, runs: [{ id: 'run-1', kind: 'run' }] });
  });

  it('tolerates a missing kind', () => {
    expect(parseActiveRuns({ count: 1, runs: [{ id: 'run-1' }] })).toEqual({ count: 1, runs: [{ id: 'run-1', kind: 'run' }] });
  });
});

describe('decideVersionMismatchRestart()', () => {
  it('RESTARTS when the server reports nothing in flight', () => {
    expect(decideVersionMismatchRestart({ activeRuns: { count: 0, runs: [] } })).toEqual({ action: 'restart' });
  });

  it('REFUSES when the server is executing runs', () => {
    const activeRuns = { count: 1, runs: [{ id: 'run-1', kind: 'benchmark' }] };
    expect(decideVersionMismatchRestart({ activeRuns })).toEqual({ action: 'refuse', reason: 'in-flight', activeRuns });
  });

  it('REFUSES when the server does not report the field (older build) — unknown is not safe', () => {
    expect(decideVersionMismatchRestart({ activeRuns: undefined })).toEqual({ action: 'refuse', reason: 'unknown' });
  });
});

describe('validPid()', () => {
  it('accepts only a real process id', () => {
    expect(validPid(4242)).toBe(4242);
    expect(validPid(1)).toBeUndefined();
    expect(validPid(0)).toBeUndefined();
    expect(validPid(-1)).toBeUndefined();
    expect(validPid(1.5)).toBeUndefined();
    expect(validPid('4242')).toBeUndefined();
    expect(validPid(undefined)).toBeUndefined();
  });
});

describe('restartRefusedError()', () => {
  it('never prints a kill hint for a bogus pid (kill -1 would signal every process)', () => {
    const message = restartRefusedError({
      port: 4001, serverVersion: '0.9.1', cliVersion: '0.9.2', serverPid: -1,
      decision: { action: 'refuse', reason: 'unknown' },
    });
    expect(message).not.toContain('kill');
    expect(message).not.toContain('(pid');
    expect(message).toContain('stop the server explicitly and re-run this command');
  });

  it('gives the Windows stop command on win32', () => {
    const message = restartRefusedError({
      port: 4001, serverVersion: '0.9.1', cliVersion: '0.9.2', serverPid: 4242, platform: 'win32',
      decision: { action: 'refuse', reason: 'unknown' },
    });
    expect(message).toContain('taskkill /PID 4242 /F');
    expect(message).not.toContain('kill 4242');
  });

  it('names the in-flight runs, both versions, the pid, and what to do', () => {
    const message = restartRefusedError({
      port: 4001,
      serverVersion: '0.9.1',
      cliVersion: '0.9.2',
      serverPid: 4242,
      decision: {
        action: 'refuse',
        reason: 'in-flight',
        activeRuns: { count: 2, runs: [{ id: 'run-abc', kind: 'benchmark' }, { id: 'eval-run-def', kind: 'evaluation' }] },
      },
    });
    expect(message).toContain('Refusing to restart the server on port 4001');
    expect(message).toContain('executing 2 runs that a restart would lose');
    expect(message).toContain('server version : 0.9.1 (pid 4242)');
    expect(message).toContain('CLI version    : 0.9.2');
    expect(message).toContain('- benchmark run run-abc');
    expect(message).toContain('- evaluation run eval-run-def');
    expect(message).toContain('Wait for them to finish');
    expect(message).toContain('http://localhost:4001');
    expect(message).toContain('restart the server on v0.9.2');
    expect(message).toContain('kill 4242');
    expect(message).not.toContain('more');
  });

  it('uses singular wording and says how many ids were not listed', () => {
    const message = restartRefusedError({
      port: 4001,
      serverVersion: '0.9.1',
      cliVersion: '0.9.2',
      decision: {
        action: 'refuse',
        reason: 'in-flight',
        activeRuns: { count: 21, runs: [{ id: 'run-abc', kind: 'benchmark' }] },
      },
    });
    expect(message).toContain('… and 20 more');
    expect(message).not.toContain('(pid');
    expect(message).toContain('stop the server explicitly and re-run this command');
  });

  it('explains the older-server case and how to proceed', () => {
    const message = restartRefusedError({
      port: 4001,
      serverVersion: '0.9.1',
      cliVersion: '0.9.2',
      serverPid: 4242,
      decision: { action: 'refuse', reason: 'unknown' },
    });
    expect(message).toContain('does not report which runs it is executing (older build)');
    expect(message).toContain('server version : 0.9.1 (pid 4242)');
    expect(message).toContain('CLI version    : 0.9.2');
    expect(message).toContain('Check for running runs in the UI at http://localhost:4001');
    expect(message).toContain('kill 4242');
    expect(message).toContain('it will start v0.9.2');
  });
});
