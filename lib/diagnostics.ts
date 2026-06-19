/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Startup-diagnostic gating.
 *
 * Informational startup lines (`[Connectors] … registered`, `[Config] …`) are
 * useful in interactive use and in the long-running server's own log stream,
 * but they MUST NOT corrupt machine-readable CLI output. `console.log` writes
 * to stdout, which is exactly the channel `agent-health list … --output json`
 * needs to keep clean for `| jq` / `python -m json.tool`.
 *
 * `canLogStartupDiagnosticsToStdout()` decides whether those lines may go to
 * stdout. It returns false (suppress) when the current invocation is a CLI
 * command whose stdout is being consumed by a machine:
 *   - `--output json` / `-o json` / `--output=json` was requested, or
 *   - `--quiet` / `-q`, or
 *   - stdout is not an interactive TTY (piped to `| jq`, redirected to a file).
 *
 * The long-running server is exempt: its stdout IS its log stream (often a
 * non-TTY pipe under a process manager / tunnel), so its startup diagnostics
 * always pass through.
 */
export function canLogStartupDiagnosticsToStdout(): boolean {
  // Server process: stdout is its own log stream, not the CLI's data channel.
  if (isServerProcess()) return true;

  const args = process.argv.slice(2);

  // Explicit quiet.
  if (args.includes('--quiet') || args.includes('-q')) return false;

  // Structured output requested (the documented breakage: list … --output json).
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--output' || a === '-o') && /^json$/i.test(args[i + 1] ?? '')) return false;
    if (/^--output=json$/i.test(a)) return false;
  }

  // Piped or redirected stdout (| jq, > file): keep it machine-clean.
  if (process.stdout.isTTY !== true) return false;

  return true;
}

function isServerProcess(): boolean {
  if (process.env.AGENT_HEALTH_SERVER === '1') return true;
  const entry = process.argv[1] ?? '';
  // server/dist/index.js (built) or server.ts / server/index.ts (tsx dev).
  return /(?:^|[/\\])server[/\\](?:dist[/\\])?index\.(?:js|ts)$/.test(entry)
    || /(?:^|[/\\])server\.ts$/.test(entry);
}

/**
 * Convenience: emit an informational startup diagnostic to stdout, but only
 * when it won't corrupt machine-readable output (see
 * `canLogStartupDiagnosticsToStdout`). A no-op otherwise.
 */
export function logStartupDiagnostic(...args: unknown[]): void {
  if (canLogStartupDiagnosticsToStdout()) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}
