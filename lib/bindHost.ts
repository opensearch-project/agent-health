/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bind-address resolution shared by every server entry point (CLI `serve`,
 * the server `benchmark`/`run` auto-start, `server/index.ts`).
 *
 * The HTTP API is unauthenticated apart from the coding-agents endpoints
 * (`--api-key`), and a run invokes the configured agents and the Bedrock judge
 * with the machine's local credentials. So the server binds loopback unless
 * the user asks for a wider bind on purpose (`--host` / `AH_HOST`), and a
 * wider bind is announced with a warning.
 *
 * The generic `HOST` variable is deliberately NOT honoured: many tools read it
 * as their bind address, so it is often exported for unrelated reasons
 * (`HOST=0.0.0.0` in a dev container, `HOST=<hostname>` on some CI images),
 * and an inherited value must not silently widen this server's bind — the
 * detached server `benchmark` starts would expose the API with its only
 * warning in a log file. `hostEnvIgnoredNotice()` tells the user when that
 * variable was present.
 */

export const DEFAULT_BIND_HOST = '127.0.0.1';
export const BIND_HOST_ENV = 'AH_HOST';

/**
 * Pick the address to bind: explicit CLI flag, then `AH_HOST`, then loopback.
 * Blank values are treated as unset.
 */
export function resolveBindHost(
  cliHost?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const flag = cliHost?.trim();
  if (flag) return flag;
  const fromEnv = env[BIND_HOST_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_BIND_HOST;
}

/**
 * Notice for a non-loopback generic `HOST` that was present but ignored
 * (`undefined` otherwise). Not printed when the bind was set explicitly.
 */
export function hostEnvIgnoredNotice(
  cliHost?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (cliHost?.trim() || env[BIND_HOST_ENV]?.trim()) return undefined;
  const legacy = env.HOST?.trim();
  if (!legacy || isLoopbackHost(legacy)) return undefined;
  return `HOST=${legacy} is ignored (generic variable); the server binds ${DEFAULT_BIND_HOST}. Use --host or ${BIND_HOST_ENV} to bind elsewhere.`;
}

/**
 * True for addresses only this machine can reach. Meant for the address the
 * OS reports after `listen()` (`server.address().address`), which is already
 * normalised (`127.0.0.1`, `::1`), and for the user-supplied `--host` value.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
}

/** `http://<host>:<port>`, bracketing IPv6 literals. */
export function bindUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * Warning for a non-loopback bind; `undefined` when the bind is loopback-only.
 * Printed on stderr by every entry point so a wide bind is never silent.
 */
export function nonLoopbackBindWarning(host: string): string | undefined {
  if (isLoopbackHost(host)) return undefined;
  return (
    `WARNING: listening on ${host} — reachable from other machines. ` +
    `The API is unauthenticated (only the coding-agents endpoints honour --api-key): ` +
    `anyone who can reach this port can start runs with this machine's credentials, ` +
    `trigger judge calls and read all stored data. ` +
    `Omit --host / ${BIND_HOST_ENV} to bind loopback (${DEFAULT_BIND_HOST}) only.`
  );
}
