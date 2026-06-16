/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * source() — register a work source from a plain .ts file. No interface to
 * implement: the fetch fn returns duck-typed { id, prompt, meta } objects.
 * Mirrors the test() registrar so source files feel like eval files.
 *
 * @example
 * ```ts
 * export const queue = source('dp-oncall-queue', async ({ since }) => {
 *   const tickets = await sim.queryFolder(MY_FOLDER, { since, open: true });
 *   return tickets.map(t => ({ id: t.id, prompt: t.url, meta: { cti: t.cti } }));
 * });
 * ```
 */

import type { SourceFetchFn, SourceHandle } from './types.js';

const registry = new Map<string, SourceHandle>();

export function source(name: string, fetch: SourceFetchFn): SourceHandle {
  if (!name || typeof name !== 'string') {
    throw new Error('source(name, fetch): name must be a non-empty string');
  }
  if (typeof fetch !== 'function') {
    throw new Error(`source('${name}', fetch): fetch must be a function`);
  }
  const handle: SourceHandle = { name, fetch };
  registry.set(name, handle);
  return handle;
}

/** Look up a registered source by name (used by the CLI `--source` flag). */
export function getSource(name: string): SourceHandle | undefined {
  return registry.get(name);
}

/** List registered source names. */
export function listSources(): string[] {
  return [...registry.keys()];
}

/** Test seam — drop all registrations. */
export function clearSources(): void {
  registry.clear();
}
