/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `agent-health serve` must stop on SIGTERM/SIGINT. `createApp()` registers a
 * `process.once('SIGTERM')` tracer-flush hook, which disables Node's default
 * terminate-on-signal; without an explicit shutdown handler the CLI server
 * ignored SIGTERM (quick mode's `stopServer` was a no-op). See
 * cli/utils/serverShutdown.ts.
 */

import { installShutdownHandlers } from '@/cli/utils/serverShutdown';

describe('installShutdownHandlers', () => {
  const registered: Record<string, Array<() => void>> = {};
  let onSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    registered.SIGTERM = [];
    registered.SIGINT = [];
    onSpy = jest.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
      (registered[event] ??= []).push(handler);
      return process;
    }) as any);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    jest.useFakeTimers();
  });

  afterEach(() => {
    onSpy.mockRestore();
    exitSpy.mockRestore();
    jest.useRealTimers();
  });

  it('registers SIGTERM and SIGINT handlers that close the listener and exit 0 once closed', () => {
    const close = jest.fn((cb?: () => void) => cb?.());
    installShutdownHandlers({ close });

    expect(registered.SIGTERM).toHaveLength(1);
    expect(registered.SIGINT).toHaveLength(1);

    registered.SIGTERM[0]();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    // A second signal while shutting down does not close twice.
    registered.SIGINT[0]();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits after the 5s backstop even if the listener never finishes closing', () => {
    const close = jest.fn(); // never calls back — an in-flight SSE stream keeps the server open
    installShutdownHandlers({ close });

    registered.SIGINT[0]();
    expect(exitSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5000);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
