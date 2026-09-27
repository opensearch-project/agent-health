/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';
import { installGracefulShutdown, type ClosableServer } from '@/cli/utils/gracefulShutdown.js';

function makeProc() {
  const emitter = new EventEmitter();
  const exit = jest.fn();
  return {
    proc: { once: emitter.once.bind(emitter), exit },
    emit: (signal: string) => emitter.emit(signal),
    exit,
    listenerCount: (signal: string) => emitter.listenerCount(signal),
  };
}

function makeServer(opts: { closeImmediately?: boolean } = {}) {
  const closeCallbacks: Array<(err?: Error) => void> = [];
  const server: ClosableServer & { closeCallbacks: typeof closeCallbacks; closeIdleConnections: jest.Mock; close: jest.Mock } = {
    closeCallbacks,
    closeIdleConnections: jest.fn(),
    close: jest.fn((cb?: (err?: Error) => void) => {
      if (cb) {
        if (opts.closeImmediately) cb();
        else closeCallbacks.push(cb);
      }
    }),
  };
  return server;
}

/** Let the beforeExit promise chain settle (fake timers do not run microtasks). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('installGracefulShutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('registers SIGTERM and SIGINT handlers by default', () => {
    const { proc, listenerCount } = makeProc();
    installGracefulShutdown(makeServer(), { proc, log: () => {} });
    expect(listenerCount('SIGTERM')).toBe(1);
    expect(listenerCount('SIGINT')).toBe(1);
  });

  it('on SIGTERM: drops idle connections, closes the server and exits 0 once closed', async () => {
    const { proc, emit, exit } = makeProc();
    const server = makeServer();
    installGracefulShutdown(server, { proc, log: () => {} });

    emit('SIGTERM');

    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(exit).not.toHaveBeenCalled(); // in-flight requests still draining

    server.closeCallbacks[0]();
    await flushMicrotasks();
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('waits for beforeExit (telemetry flush) as well as the server close before exiting', async () => {
    const { proc, emit, exit } = makeProc();
    const server = makeServer({ closeImmediately: true });
    let finishFlush!: () => void;
    const beforeExit = jest.fn(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    installGracefulShutdown(server, { proc, beforeExit, log: () => {} });

    emit('SIGTERM');
    await flushMicrotasks();
    expect(beforeExit).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled(); // server closed, flush still pending

    finishFlush();
    await flushMicrotasks();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a failing beforeExit hook is logged and does not block the exit', async () => {
    const { proc, emit, exit } = makeProc();
    const server = makeServer({ closeImmediately: true });
    const log = jest.fn();
    installGracefulShutdown(server, { proc, beforeExit: () => Promise.reject(new Error('flush boom')), log });

    emit('SIGTERM');
    await flushMicrotasks();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('Shutdown hook failed: flush boom');
  });

  it('exits after the timeout even if the server never finishes closing (hung keep-alives)', async () => {
    const { proc, emit, exit } = makeProc();
    const server = makeServer();
    installGracefulShutdown(server, { proc, timeoutMs: 5000, log: () => {} });

    emit('SIGTERM');
    jest.advanceTimersByTime(4999);
    await flushMicrotasks();
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);

    // A late close callback must not exit twice.
    server.closeCallbacks[0]();
    await flushMicrotasks();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across repeated signals and works without closeIdleConnections (older Node)', async () => {
    const { proc, emit, exit } = makeProc();
    const server = makeServer({ closeImmediately: true });
    delete (server as Partial<typeof server>).closeIdleConnections;
    const log = jest.fn();
    const shutdown = installGracefulShutdown(server, { proc, log });

    emit('SIGINT');
    emit('SIGTERM');
    shutdown('SIGTERM');
    await flushMicrotasks();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('Received SIGINT');
  });
});
