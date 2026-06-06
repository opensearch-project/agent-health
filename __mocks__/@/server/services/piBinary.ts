/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest mock for piBinary — the real module uses import.meta.url, which Jest's
 * CJS transform cannot handle. Returns the PATH-`pi` form so integration tests
 * that spawn pi keep their existing expectations.
 */
export interface PiCommand {
  command: string;
  prefixArgs: string[];
  bundled: boolean;
}

export function resolvePiCommand(): PiCommand {
  return { command: 'pi', prefixArgs: [], bundled: false };
}
