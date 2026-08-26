/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Import Command
 * Imports test cases from external evaluation frameworks (e.g., HolmesGPT).
 *
 * Architecture: Fetches from GitHub or local path, converts to Agent Health format,
 * outputs JSON compatible with `benchmark -f`.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { convertAllFromLocal, convertAllFromGitHub } from '@/cli/converters/index.js';

const SUPPORTED_FORMATS = ['holmesgpt'] as const;
type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/**
 * Create the import command
 */
export function createImportCommand(): Command {
  const command = new Command('import')
    .description(
      'Convert test cases from an external evaluation framework (e.g. holmesgpt) into ' +
        "agent-health's format. For test cases already in agent-health's native JSON " +
        "format, use 'benchmark -f <file>' directly instead."
    )
    .argument('[source]', 'Local path to fixtures directory (alias for --source; positional wins if both given)')
    .requiredOption('--from <format>', `Source format (${SUPPORTED_FORMATS.join(', ')})`)
    .option('--source <path>', 'Local path to fixtures directory (fetches from GitHub if omitted)')
    .option('-o, --output <file>', 'Output JSON file path (default: <format>-test-cases.json)')
    .option('--dry-run', 'Show conversion summary without writing files')
    .option('--repo <owner/name>', 'GitHub repository, GitHub-fetching formats only (e.g. holmesgpt) (default: robusta-dev/holmesgpt)')
    .option('--branch <name>', 'GitHub branch, GitHub-fetching formats only (e.g. holmesgpt) (default: master)')
    .action(async (
      sourceArg: string | undefined,
      options: {
        from: string;
        source?: string;
        output?: string;
        dryRun?: boolean;
        repo?: string;
        branch?: string;
      }
    ) => {
      const format = options.from.toLowerCase();

      if (!SUPPORTED_FORMATS.includes(format as SupportedFormat)) {
        console.error(chalk.red(`\n  Error: Unsupported format '${format}'`));
        console.log(chalk.gray(`  Supported formats: ${SUPPORTED_FORMATS.join(', ')}\n`));
        process.exit(1);
      }

      // Positional [source] is an alias for --source; the positional wins if both
      // are given (rather than erroring), since it's unambiguous which one the
      // caller meant to be authoritative.
      const source = sourceArg ?? options.source;
      const output = options.output ?? `${format}-test-cases.json`;

      console.log(chalk.cyan.bold('\n  Agent Health - Import Test Cases\n'));

      if (format === 'holmesgpt') {
        await importHolmesGPT({ ...options, source, output });
      }
    });

  return command;
}

async function importHolmesGPT(options: {
  source?: string;
  output: string;
  dryRun?: boolean;
  repo?: string;
  branch?: string;
}): Promise<void> {
  const spinner = ora();

  try {
    if (options.source) {
      // Local import
      spinner.start(`Reading test cases from ${options.source}...`);
      const result = convertAllFromLocal(options.source);
      spinner.succeed(`Found ${result.testCases.length} test case(s)`);
      outputResults(result.testCases, result.skipped, result.errors, options);
    } else {
      // GitHub import
      const repo = options.repo || 'robusta-dev/holmesgpt';
      const branch = options.branch || 'master';
      spinner.start(`Fetching test cases from GitHub (${repo}@${branch})...`);

      const result = await convertAllFromGitHub(repo, branch, (current, total) => {
        spinner.text = `Fetching test cases from GitHub (${current}/${total})...`;
      });
      spinner.succeed(`Fetched and converted ${result.testCases.length} test case(s)`);
      outputResults(result.testCases, result.skipped, result.errors, options);
    }
  } catch (error: any) {
    spinner.fail('Import failed');
    console.error(chalk.red(`\n  Error: ${error.message}\n`));
    process.exit(1);
  }
}

function outputResults(
  testCases: import('@/lib/testCaseValidation').ValidatedTestCaseInput[],
  skipped: Array<{ path: string; reason: string }>,
  errors: Array<{ path: string; error: string }>,
  options: { output: string; dryRun?: boolean }
): void {
  // Print summary
  console.log(chalk.gray(`  Converted: ${testCases.length}`));
  if (skipped.length > 0) {
    console.log(chalk.gray(`  Skipped:   ${skipped.length}`));
  }
  if (errors.length > 0) {
    console.log(chalk.red(`  Errors:    ${errors.length}`));
    for (const err of errors) {
      console.log(chalk.red(`    - ${err.path}: ${err.error}`));
    }
  }

  if (options.dryRun) {
    console.log(chalk.gray('\n  Dry run — no files written.\n'));

    // Show a sample test case
    if (testCases.length > 0) {
      console.log(chalk.cyan('  Sample test case:'));
      console.log(chalk.gray(`  ${JSON.stringify(testCases[0], null, 2).split('\n').join('\n  ')}\n`));
    }
    return;
  }

  // Write output file
  writeFileSync(options.output, JSON.stringify(testCases, null, 2) + '\n', 'utf-8');
  console.log(chalk.green(`\n  Output: ${chalk.bold(options.output)}`));
  console.log(
    chalk.gray(
      `\n  Next step: run a benchmark with these test cases:\n` +
        `    ${chalk.cyan(`agent-health benchmark -f ${options.output} -a holmesgpt -n "HolmesGPT Evaluations"`)}\n`
    )
  );

  // A partial import (some fixtures failed to convert/validate) should not
  // report success to CI or scripting callers — the output file is still
  // written (best-effort partial corpus for inspection), but the process
  // exits non-zero so automation notices instead of silently benchmarking
  // an incomplete set.
  if (errors.length > 0) {
    process.exit(1);
  }
}
