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
 * the user asks for a wider bind on purpose (`--host` / `HOST`), and a wider
 * bind is announced with a warning.
 */

export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Pick the address to bind: explicit CLI flag, then the `HOST` env var, then
 * loopback. Blank values are treated as unset.
 */
export function resolveBindHost(
  cliHost?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const flag = cliHost?.trim();
  if (flag) return flag;
  const fromEnv = env.HOST?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_BIND_HOST;
}

/** True for addresses only this machine can reach. */
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
    `Omit --host / HOST to bind loopback (${DEFAULT_BIND_HOST}) only.`
  );
}
