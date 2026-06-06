/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves how to invoke the `pi` CLI used by the pi/agent judges.
 *
 * Prefers the **bundled** `@earendil-works/pi-coding-agent` from `node_modules`
 * (declared as an optionalDependency of agent-health) so the agent judge is
 * self-contained — no global `pi` install required. Falls back to a `pi`
 * binary on `PATH` when the package isn't installed (e.g. a slim install that
 * skipped optional deps, or a dev using their own pi).
 *
 * Isolated into its own module because it uses `import.meta.url` (to locate
 * the installed package relative to this file), which Jest's CJS transform
 * can't handle — so this module is mocked via `moduleNameMapper`.
 */

import { dirname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const PI_PKG = '@earendil-works/pi-coding-agent';

export interface PiCommand {
  /** Executable to spawn (node for the bundled cli.js, else the `pi` binary). */
  command: string;
  /** Args to prepend before the pi args (the cli.js path, or nothing). */
  prefixArgs: string[];
  /** True when resolved from the bundled package rather than PATH. */
  bundled: boolean;
}

/**
 * Find the installed pi package directory by walking up from this module
 * looking for `node_modules/<PI_PKG>`. Uses a directory walk + `fs` rather
 * than `require.resolve` because pi's `exports` map blocks deep imports
 * (`require.resolve('<pkg>/package.json')` throws ERR_PACKAGE_PATH_NOT_EXPORTED),
 * and `fs` doesn't honor `exports`. Handles both the dev repo layout and
 * hoisted/nested `node_modules` when installed as a dependency.
 */
function findPiPackageDir(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, 'node_modules', PI_PKG, 'package.json');
      if (existsSync(candidate)) return dirname(candidate);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url unavailable in some bundles */
  }
  return undefined;
}

/** Resolve the bundled `@earendil-works/pi-coding-agent` CLI, or fall back to PATH `pi`. */
export function resolvePiCommand(): PiCommand {
  const pkgDir = findPiPackageDir();
  if (pkgDir) {
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
      const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
      if (binRel) {
        const binAbs = isAbsolute(binRel) ? binRel : join(pkgDir, binRel);
        if (existsSync(binAbs)) {
          return { command: process.execPath, prefixArgs: [binAbs], bundled: true };
        }
      }
    } catch {
      /* malformed package — fall through to PATH */
    }
  }
  return { command: 'pi', prefixArgs: [], bundled: false };
}
