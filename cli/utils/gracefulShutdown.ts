/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Graceful shutdown for the in-process `agent-health serve` server.
 *
 * `createApp()` registers a `process.once('SIGTERM')` listener to flush the
 * evaluation tracer. Registering ANY signal listener replaces Node's default
 * "terminate on SIGTERM" behaviour, and that listener never exits — so a
 * `serve` process simply ignored SIGTERM: it kept listening, and every CLI
 * flow that stops the server it started (`benchmark` quick/file mode, CI,
 * `--stop-server`) hung forever waiting on the child's stdio pipes while the
 * server lived on as an orphan. This mirrors `server/index.ts`'s shutdown:
 * stop accepting connections, exit when the server closes, and never wait
 * longer than `timeoutMs` for in-flight requests.
 *
 * Kept dependency-free so it can be unit-tested with a fake server/process.
 */

export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
  /** Node ≥18.2: drop idle keep-alive sockets so close() can complete. */
  closeIdleConnections?(): void;
}

export interface ShutdownProcess {
  once(signal: string, listener: () => void): unknown;
  exit(code?: number): never | void;
}

export interface GracefulShutdownOptions {
  proc?: ShutdownProcess;
  signals?: string[];
  /** Upper bound on how long to wait for in-flight requests (default 5s). */
  timeoutMs?: number;
  /**
   * Awaited (alongside the server close) before exiting — e.g. the app's
   * telemetry flush, so the last evaluation spans are exported instead of
   * being dropped by process.exit. Bounded by `timeoutMs`; errors are logged.
   */
  beforeExit?: () => Promise<unknown> | unknown;
  log?: (message: string) => void;
}

/**
 * Install SIGTERM/SIGINT handlers that close `server` and exit the process.
 * Returns the handler so callers/tests can trigger it directly.
 */
export function installGracefulShutdown(
  server: ClosableServer,
  options: GracefulShutdownOptions = {}
): (signal: string) => void {
  const proc = options.proc ?? process;
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const timeoutMs = options.timeoutMs ?? 5000;
  const log = options.log ?? ((m: string) => console.log(m));

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n  Received ${signal}, shutting down server...`);

    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      proc.exit(0);
    };

    // Exit once BOTH the server has closed and beforeExit has settled — or
    // when the timeout fires, whichever comes first.
    let pending = 2;
    const done = () => { if (--pending === 0) exit(); };

    Promise.resolve()
      .then(() => options.beforeExit?.())
      .catch((err) => log(`  Shutdown hook failed: ${err instanceof Error ? err.message : String(err)}`))
      .then(done);

    server.closeIdleConnections?.();
    server.close(() => {
      log('  Server closed.');
      done();
    });
    const fallback = setTimeout(exit, timeoutMs);
    (fallback as { unref?: () => void }).unref?.();
  };

  for (const signal of signals) {
    proc.once(signal, () => shutdown(signal));
  }
  return shutdown;
}
