/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Version-mismatch restart decision — pure, dependency-free, unit-testable.
 *
 * When the CLI's version differs from the server's (`npx …@latest` after a
 * release), `ensureServer` restarts the server on the CLI's version. Doing
 * that blindly kills whatever the old server is executing (issue #612,
 * problem 5). The server reports what it is executing on `/health`
 * (`activeRuns`, read from its in-memory executor registries — never from
 * storage, whose `running` docs can be stale leftovers of a crashed process).
 * This module decides, from that field, whether the restart is safe.
 *
 * Extracted into its own module (no `import.meta`) so it can be imported by
 * ts-jest unit tests; `serverLifecycle.ts` uses ESM-only constructs that the
 * CommonJS test transform can't parse.
 */

export interface ActiveRunRef {
  id: string;
  kind: string;
}

/** `/health.activeRuns` as reported by servers that have the field. */
export interface ActiveRunsSummary {
  count: number;
  runs: ActiveRunRef[];
}

export type VersionMismatchDecision =
  /** Nothing in flight — kill the old server and start the CLI's version. */
  | { action: 'restart' }
  /** The server is executing runs that a restart would lose. */
  | { action: 'refuse'; reason: 'in-flight'; activeRuns: ActiveRunsSummary }
  /** The server predates the field, so we cannot tell. Refuse: an unverifiable restart is the bug we are fixing. */
  | { action: 'refuse'; reason: 'unknown' };

/**
 * Parse the `activeRuns` block of a `/health` payload. Returns undefined for
 * servers that don't report it (older builds) or report it malformed — both
 * are treated as "unknown" by `decideVersionMismatchRestart`.
 */
export function parseActiveRuns(value: unknown): ActiveRunsSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { count, runs } = value as { count?: unknown; runs?: unknown };
  if (!Number.isInteger(count) || (count as number) < 0 || !Array.isArray(runs)) return undefined;
  const refs: ActiveRunRef[] = [];
  for (const entry of runs) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== 'string' || !id) return undefined;
    const kind = (entry as { kind?: unknown }).kind;
    refs.push({ id, kind: typeof kind === 'string' ? kind : 'run' });
  }
  return { count: count as number, runs: refs };
}

export function decideVersionMismatchRestart(params: {
  activeRuns: ActiveRunsSummary | undefined;
}): VersionMismatchDecision {
  const { activeRuns } = params;
  if (!activeRuns) return { action: 'refuse', reason: 'unknown' };
  if (activeRuns.count > 0) return { action: 'refuse', reason: 'in-flight', activeRuns };
  return { action: 'restart' };
}

function stopHint(serverPid?: number): string {
  if (!serverPid) return `stop the server explicitly and re-run this command`;
  const command = process.platform === 'win32' ? `taskkill /PID ${serverPid} /F` : `kill ${serverPid}`;
  return `stop the server explicitly (${command}) and re-run this command`;
}

/**
 * Human-readable error thrown when the restart is refused. Kept here so the
 * message is unit-testable without importing serverLifecycle.ts.
 */
export function restartRefusedError(params: {
  port: number;
  serverVersion?: string;
  cliVersion: string;
  serverPid?: number;
  decision: Exclude<VersionMismatchDecision, { action: 'restart' }>;
}): string {
  const { port, serverVersion, cliVersion, serverPid, decision } = params;
  const versions =
    `  server version : ${serverVersion ?? 'unknown'}` + (serverPid ? ` (pid ${serverPid})` : '') + `\n` +
    `  CLI version    : ${cliVersion}\n`;

  if (decision.reason === 'unknown') {
    return (
      `Refusing to restart the server on port ${port}: it does not report which runs it is ` +
      `executing (older build), so this CLI cannot tell whether a restart would lose a run in progress.\n` +
      versions +
      `Check for running runs in the UI at http://localhost:${port}; when none are running, ` +
      `${stopHint(serverPid)} — it will start v${cliVersion}.`
    );
  }

  const { count, runs } = decision.activeRuns;
  const listed = runs.map((run) => `  - ${run.kind} run ${run.id}`).join('\n');
  const more = count > runs.length ? `\n  … and ${count - runs.length} more` : '';
  return (
    `Refusing to restart the server on port ${port}: it is executing ${count} run${count === 1 ? '' : 's'} ` +
    `that a restart would lose.\n` +
    versions +
    `  in flight      :\n${listed}${more}\n` +
    `Wait for ${count === 1 ? 'it' : 'them'} to finish (progress: http://localhost:${port}), then re-run this ` +
    `command — it will restart the server on v${cliVersion}.\n` +
    `To abandon ${count === 1 ? 'it' : 'them'} instead, ${stopHint(serverPid)}.`
  );
}
