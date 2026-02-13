/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Migrate Command
 * One-time migration to add stats to existing benchmark runs
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '@/lib/config/index.js';
import { ensureServer, createServerCleanup } from '@/cli/utils/serverLifecycle.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import type { BenchmarkRun, EvaluationReport, RunStats } from '@/types/index.js';

/**
 * Compute stats from reports for a benchmark run
 */
function computeStatsFromReports(
  run: BenchmarkRun,
  reports: EvaluationReport[]
): RunStats {
  const reportsMap = new Map(reports.map(r => [r.id, r]));

  let passed = 0;
  let failed = 0;
  let pending = 0;
  const total = Object.keys(run.results || {}).length;

  Object.values(run.results || {}).forEach((result) => {
    if (result.status === 'pending' || result.status === 'running') {
      pending++;
      return;
    }

    if (result.status === 'failed' || result.status === 'cancelled') {
      failed++;
      return;
    }

    if (result.status === 'completed' && result.reportId) {
      const report = reportsMap.get(result.reportId);
      if (!report) {
        pending++;
        return;
      }

      // Check if evaluation is still pending (trace mode)
      if (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating') {
        pending++;
        return;
      }

      if (report.passFailStatus === 'passed') {
        passed++;
      } else {
        failed++;
      }
    } else {
      pending++;
    }
  });

  return { passed, failed, pending, total };
}

/**
 * Create the migrate command
 */
export function createMigrateCommand(): Command {
  const command = new Command('migrate')
    .description('One-time migration to add stats to existing benchmark runs')
    .option('--dry-run', 'Show what would be migrated without making changes')
    .option('-v, --verbose', 'Show detailed progress')
    .action(async (options: { dryRun?: boolean; verbose?: boolean }) => {
      console.log(chalk.cyan.bold('\n  Benchmark Stats Migration\n'));

      // Load config
      const config = await loadConfig();

      // Ensure server is running
      const serverResult = await ensureServer(config.server);
      const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

      try {
        const client = new ApiClient(serverResult.baseUrl);
        const spinner = ora('Fetching benchmarks...').start();

        // Fetch all benchmarks
        const benchmarks = await client.listBenchmarks();
        spinner.succeed(`Found ${benchmarks.length} benchmarks`);

        // Filter to non-sample benchmarks that have runs
        const migratable = benchmarks.filter(
          b => !b.id.startsWith('demo-') && (b.runs?.length ?? 0) > 0
        );

        if (migratable.length === 0) {
          console.log(chalk.yellow('\n  No benchmarks to migrate.\n'));
          console.log(chalk.gray('  Only user-created benchmarks with runs can be migrated.'));
          console.log(chalk.gray('  Sample data (demo-*) already has stats computed.\n'));
          return;
        }

        console.log(chalk.gray(`\n  Migrating ${migratable.length} benchmarks with runs...\n`));

        let totalRuns = 0;
        let migratedRuns = 0;
        let skippedRuns = 0;
        let errors = 0;

        for (const benchmark of migratable) {
          const runs = benchmark.runs || [];
          totalRuns += runs.length;

          if (options.verbose) {
            console.log(chalk.gray(`  Processing: ${benchmark.name} (${runs.length} runs)`));
          }

          for (const run of runs) {
            // Skip if already has stats
            if (run.stats && typeof run.stats.passed === 'number') {
              skippedRuns++;
              if (options.verbose) {
                console.log(chalk.gray(`    ✓ ${run.name} - already has stats`));
              }
              continue;
            }

            try {
              // Fetch reports for this run using search endpoint
              const reportsRes = await fetch(
                `${serverResult.baseUrl}/api/storage/runs/by-benchmark-run/${benchmark.id}/${run.id}`
              );
              if (!reportsRes.ok) {
                throw new Error(`Failed to fetch reports: ${reportsRes.status}`);
              }
              const { runs: reports } = await reportsRes.json();

              // Compute stats
              const stats = computeStatsFromReports(run, reports || []);

              if (options.verbose) {
                console.log(chalk.gray(
                  `    → ${run.name}: passed=${stats.passed}, failed=${stats.failed}, pending=${stats.pending}`
                ));
              }

              if (!options.dryRun) {
                // Update the run with stats
                const updateRes = await fetch(
                  `${serverResult.baseUrl}/api/storage/benchmarks/${benchmark.id}/runs/${run.id}/stats`,
                  {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(stats),
                  }
                );
                if (!updateRes.ok) {
                  const errorBody = await updateRes.text();
                  throw new Error(`Failed to update stats: ${errorBody}`);
                }
              }

              migratedRuns++;
            } catch (error) {
              errors++;
              const msg = error instanceof Error ? error.message : 'Unknown error';
              if (options.verbose) {
                console.log(chalk.red(`    ✗ ${run.name} - ${msg}`));
              }
            }
          }

          // Log progress per benchmark
          console.log(
            options.dryRun
              ? chalk.blue(`  [DRY RUN] ${benchmark.name} - ${runs.length} runs would be processed`)
              : chalk.green(`  ✓ ${benchmark.name} - ${runs.length} runs`)
          );
        }

        // Summary
        console.log(chalk.bold('\n  Migration Summary\n'));
        console.log(chalk.gray(`    Total runs:    ${totalRuns}`));
        console.log(chalk.green(`    Migrated:      ${migratedRuns}`));
        console.log(chalk.yellow(`    Already done:  ${skippedRuns}`));
        if (errors > 0) {
          console.log(chalk.red(`    Errors:        ${errors}`));
        }

        if (options.dryRun) {
          console.log(chalk.blue('\n  This was a dry run. No changes were made.'));
          console.log(chalk.blue('  Run without --dry-run to apply changes.\n'));
        } else {
          console.log(chalk.green('\n  Migration complete!\n'));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\n  Error: ${msg}\n`));
        process.exit(1);
      } finally {
        cleanup();
      }
    });

  return command;
}
