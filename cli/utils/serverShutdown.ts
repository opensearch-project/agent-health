/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Make `agent-health serve` (and the server the CLI auto-starts for quick /
 * file mode) actually stop on SIGTERM / SIGINT.
 *
 * `createApp()` registers a `process.once('SIGTERM')` hook to flush the eval
 * tracer. Registering ANY handler disables Node's default terminate-on-signal
 * behaviour, and that hook never exits — so without an explicit shutdown here
 * the process ignored SIGTERM entirely: `createServerCleanup` → `stopServer`
 * (quick mode, `--stop-server`, CI) left the server it had started running
 * forever, and `kill <pid>` on a `serve` process did nothing. `server/index.ts`
 * (the `npm run server` entry) has always had this handler; the CLI entry did
 * not. Pinned by tests/integration/surface-matrix/cli-server-lifecycle.
 */
export function installShutdownHandlers(server: { close(cb?: () => void): unknown }): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // SIGINT + SIGTERM back-to-back: close once
    shuttingDown = true;
    console.log(`\n  Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
