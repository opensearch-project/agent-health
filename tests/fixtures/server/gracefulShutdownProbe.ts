/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Child-process probe (run via tsx by tests/unit/server/utils/gracefulShutdown.realProcess.test.ts).
 *
 * Starts a REAL http.Server on an ephemeral port and prints `LISTENING <port>`.
 * What it installs depends on argv[2]:
 *   defaults  — `installGracefulShutdown(server)` with NO options, so the real
 *               default `log` (console.log) and `exit` (process.exit) run.
 *   bare      — control: a bare `process.on('SIGTERM', () => {})` listener that
 *               never exits — the #576 bug class. Any SIGTERM listener
 *               suppresses Node's default termination, so this process must be
 *               seen to hang (the test proves it can tell the two apart).
 *   none      — control: no listener at all; Node's default disposition kills
 *               the process BY the signal (exit code null + signal SIGTERM), not
 *               with exit code 0.
 */

import { createServer } from 'http';
import { installGracefulShutdown } from '../../../server/utils/gracefulShutdown';

const mode = process.argv[2] ?? 'defaults';
const server = createServer((_req, res) => res.end('ok'));

// A real server always has something else keeping the event loop alive
// (periodic timers, pollers, child agents). Without this, a `exit` default
// that silently did nothing would still look like a clean exit 0 once the
// listener closed and the loop drained — the test could not tell.
setInterval(() => { /* keep the loop alive */ }, 1_000);

if (mode === 'defaults') {
  installGracefulShutdown(server);
} else if (mode === 'bare') {
  process.on('SIGTERM', () => { /* swallows the signal, never exits */ });
} else if (mode !== 'none') {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as { port: number };
  console.log(`LISTENING ${port}`);
});
