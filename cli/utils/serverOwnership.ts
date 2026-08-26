/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server ownership decision — pure, dependency-free, unit-testable.
 *
 * A server already listening on the target port may be a FOREIGN instance
 * (a live demo, another checkout) that merely occupies the port. Reusing it
 * would route this run into the other instance's storage, and a version
 * mismatch would `killServerOnPort()` and take it down. We use the /health
 * `instance.cwd` to decide what to do BEFORE any reuse/kill happens.
 *
 * Extracted into its own module (no `import.meta`) so it can be imported by
 * ts-jest unit tests; `serverLifecycle.ts` uses ESM-only constructs that the
 * CommonJS test transform can't parse.
 */

export type OwnershipAction =
  /** Throw — a foreign server occupies the port and override is not set. */
  | 'refuse'
  /** Reuse the foreign server (explicit AH_REUSE_FOREIGN_SERVER override). */
  | 'reuse-foreign'
  /** Ours, or identity unknown — continue to the normal version/reuse logic. */
  | 'proceed';

export interface OwnershipDecision {
  action: OwnershipAction;
}

/**
 * Decide how to treat a server already running on the target port.
 *
 * @param serverCwd  cwd reported by the running server (/health instance.cwd);
 *                   undefined/empty for older servers that lack the identity
 *                   block — ownership is then unverifiable.
 * @param myCwd      cwd of the current CLI process (process.cwd()).
 * @param allowForeign  true when AH_REUSE_FOREIGN_SERVER opts into reuse.
 */
export function decideServerOwnership(params: {
  serverCwd?: string;
  myCwd: string;
  allowForeign: boolean;
}): OwnershipDecision {
  const { serverCwd, myCwd, allowForeign } = params;
  const foreign =
    typeof serverCwd === 'string' && serverCwd.length > 0 && serverCwd !== myCwd;

  if (foreign && !allowForeign) return { action: 'refuse' };
  if (foreign && allowForeign) return { action: 'reuse-foreign' };
  // Same cwd, or no identity to compare → fall through to version/reuse logic.
  return { action: 'proceed' };
}

/**
 * Human-readable error thrown when a foreign server is refused. Kept here so
 * the message is unit-testable without importing serverLifecycle.ts.
 */
export function foreignServerError(params: {
  port: number;
  myCwd: string;
  serverCwd?: string;
  serverPid?: number;
}): string {
  const { port, myCwd, serverCwd, serverPid } = params;
  return (
    `Refusing to use the server already running on port ${port}: it was ` +
    `started from a different directory.\n` +
    `  this checkout : ${myCwd}\n` +
    `  server cwd    : ${serverCwd}` +
    (serverPid ? ` (pid ${serverPid})` : '') +
    `\n` +
    `Reusing it would write this run into the other instance's storage, ` +
    `and a version mismatch would kill it.\n` +
    `Fix: run on a free port (e.g. AH_PORT=<port> or -p <port>), stop the ` +
    `other server, or set AH_REUSE_FOREIGN_SERVER=1 to override intentionally.`
  );
}
