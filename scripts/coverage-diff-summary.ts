/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI entry for scripts/coverageDiffSummary.ts — see that file for the
 * options. Run with `npx tsx scripts/coverage-diff-summary.ts …`.
 */

import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { run } from './coverageDiffSummary.js';

const isDirectRun = (() => {
  try {
    return process.argv[1] ? pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url : false;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    const { markdown, warnings } = run(process.argv.slice(2));
    for (const w of warnings) process.stderr.write(`coverage-diff-summary: ${w}\n`);
    process.stdout.write(markdown);
  } catch (err) {
    process.stderr.write(`coverage-diff-summary: ${(err as Error).message}\n`);
    process.exitCode = 2;
  }
}
