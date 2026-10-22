/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * installGracefulShutdown() with its DEFAULTS, in a REAL child Node process,
 * terminated by a REAL OS signal — no `exit`/`log` injection, no process.exit
 * spy, no `process.emit`. This is the end-to-end claim behind #576: a server
 * that installs the helper and receives SIGTERM logs the shutdown via
 * console.log, closes its listener and ends with exit code 0 (process.exit),
 * rather than hanging (any SIGTERM listener suppresses Node's default
 * termination) or dying by the signal (what Node does with no listener).
 *
 * Two controls prove the harness discriminates: a bare listener that never
 * exits is observed to hang, and no listener at all is observed to die BY the
 * signal (code null + signal SIGTERM, or 143 through the tsx launcher)
 * instead of exiting 0.
 *
 * In-process coverage of the same default-parameter lines lives in
 * gracefulShutdown.test.ts; jest cannot instrument this child.
 */

import { spawn, type ChildProcess } from 'child_process';
import { connect } from 'net';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PROBE = join(REPO_ROOT, 'tests', 'fixtures', 'server', 'gracefulShutdownProbe.ts');

interface Probe {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function connectResult(port: number): Promise<'connected' | string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
  });
}

async function startProbe(mode: 'defaults' | 'bare' | 'none'): Promise<Probe> {
  const child = spawn(
    process.execPath,
    [require.resolve('tsx/cli'), '--tsconfig', join(REPO_ROOT, 'tsconfig.json'), PROBE, mode],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stdout!.on('data', (chunk) => { out += String(chunk); });
  child.stderr!.on('data', (chunk) => { err += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`probe did not report LISTENING in time\nstdout:\n${out}\nstderr:\n${err}`)), 25_000);
    const check = () => {
      const match = /^LISTENING (\d+)$/m.exec(out);
      if (match) { clearTimeout(deadline); resolve(Number(match[1])); }
    };
    child.stdout!.on('data', check);
    void exited.then(() => { clearTimeout(deadline); reject(new Error(`probe exited early\nstdout:\n${out}\nstderr:\n${err}`)); });
  });
  return { child, port, stdout: () => out, stderr: () => err, exited };
}

describe('installGracefulShutdown defaults in a real process (real SIGTERM)', () => {
  jest.setTimeout(60_000);
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    children.length = 0;
  });

  it('default log + exit: SIGTERM is logged via console.log, the listener closes and the process exits 0', async () => {
    const probe = await startProbe('defaults');
    children.push(probe.child);
    expect(await connectResult(probe.port)).toBe('connected');

    const sentAt = Date.now();
    expect(probe.child.kill('SIGTERM')).toBe(true);
    // Bounded: a helper whose default `exit` did not terminate the process
    // must fail here, not at the jest timeout.
    const result = await Promise.race([
      probe.exited,
      sleep(10_000).then(() => 'still alive after 10s' as const),
    ]);
    const elapsed = Date.now() - sentAt;

    // Exited through process.exit(0) — not killed by the signal, not hung.
    expect(result).toEqual({ code: 0, signal: null });
    expect(elapsed).toBeLessThan(5_000); // well inside DEFAULT_SHUTDOWN_TIMEOUT_MS
    // The default `log` is console.log → child's stdout.
    expect(probe.stdout()).toContain('Received SIGTERM, shutting down gracefully...');
    expect(probe.stdout()).toContain('Server closed.');
    expect(probe.stdout()).not.toContain('did not finish');
    expect(probe.stderr()).toBe('');
    expect(await connectResult(probe.port)).toBe('ECONNREFUSED');
  });

  it('control: a bare SIGTERM listener that never exits keeps the process alive (what the helper replaces)', async () => {
    const probe = await startProbe('bare');
    children.push(probe.child);

    expect(probe.child.kill('SIGTERM')).toBe(true);
    const outcome = await Promise.race([probe.exited.then(() => 'exited' as const), sleep(1_500).then(() => 'alive' as const)]);

    expect(outcome).toBe('alive');
    expect(probe.child.exitCode).toBeNull();
    expect(await connectResult(probe.port)).toBe('connected'); // still serving
    expect(probe.stdout()).not.toContain('Received SIGTERM');
  });

  it('control: with no listener Node kills the process BY the signal, not exit 0', async () => {
    const probe = await startProbe('none');
    children.push(probe.child);

    expect(probe.child.kill('SIGTERM')).toBe(true);
    const result = await probe.exited;

    // Direct node: killed by the signal → { code: null, signal: 'SIGTERM' }. The
    // tsx launcher relays its child's death as 128 + SIGTERM(15) = 143. Either
    // way the process did not exit 0 and did not hang.
    expect([{ code: null, signal: 'SIGTERM' }, { code: 143, signal: null }]).toContainEqual(result);
    expect(probe.stdout()).not.toContain('Received SIGTERM');
  });
});
