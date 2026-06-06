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
import type { BenchmarkRun, EvaluationReport, EvaluationRun, RunStats, TestCaseSnapshot, TestCaseSource } from '@/types/index.js';

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

  // Subcommand: migrate evaluation-runs (extract embedded runs to top-level docs)
  command
    .command('evaluation-runs')
    .description('Migrate embedded benchmark runs to top-level EvaluationRun documents')
    .option('--dry-run', 'Show what would be migrated without making changes')
    .option('-v, --verbose', 'Show detailed progress')
    .action(async (opts: { dryRun?: boolean; verbose?: boolean }) => {
      console.log(chalk.cyan.bold('\n  Evaluation Runs Migration\n'));
      console.log(chalk.gray('  Extracts embedded benchmark.runs[] → top-level EvaluationRun documents\n'));

      const config = await loadConfig();
      const serverResult = await ensureServer(config.server);
      const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

      try {
        const client = new ApiClient(serverResult.baseUrl);
        const spinner = ora('Fetching benchmarks...').start();

        const benchmarks = await client.listBenchmarks();
        spinner.succeed(`Found ${benchmarks.length} benchmarks`);

        const withRuns = benchmarks.filter(b => (b.runs?.length ?? 0) > 0);

        if (withRuns.length === 0) {
          console.log(chalk.yellow('\n  No embedded runs found. Nothing to migrate.\n'));
          return;
        }

        let totalRuns = 0;
        let migrated = 0;
        let skipped = 0;
        let errors = 0;

        for (const benchmark of withRuns) {
          const runs = benchmark.runs || [];
          totalRuns += runs.length;

          for (const run of runs) {
            // Check if already migrated by querying the evaluation runs endpoint
            try {
              const checkRes = await fetch(
                `${serverResult.baseUrl}/api/storage/evaluation-runs/${run.id}`
              );
              if (checkRes.ok) {
                skipped++;
                if (opts.verbose) {
                  console.log(chalk.gray(`    ✓ ${run.id} already migrated`));
                }
                continue;
              }
            } catch {
              // Not found, proceed with migration
            }

            // Build EvaluationRun from embedded run
            const runAny = run as any;
            const evalRun: Partial<EvaluationRun> = {
              id: run.id,
              name: run.name || `Run ${run.id.slice(0, 8)}`,
              createdAt: run.createdAt,
              completedAt: runAny.completedAt,
              status: run.status,
              agentKey: runAny.config?.agentKey || run.agentKey || 'unknown',
              modelId: runAny.config?.modelId || run.modelId || 'unknown',
              sources: [{ type: 'benchmark', benchmarkId: benchmark.id }] as TestCaseSource[],
              trigger: 'api' as const,
              testCaseSnapshots: (run.testCaseSnapshots || []) as TestCaseSnapshot[],
              results: run.results || {},
              stats: run.stats,
              benchmarkId: benchmark.id,
            };

            if (opts.verbose) {
              console.log(chalk.gray(`    → Migrating ${run.id} (${evalRun.name})`));
            }

            if (!opts.dryRun) {
              try {
                const createRes = await fetch(
                  `${serverResult.baseUrl}/api/storage/evaluation-runs/${run.id}`,
                  {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(evalRun),
                  }
                );
                if (!createRes.ok) {
                  errors++;
                  if (opts.verbose) {
                    console.log(chalk.red(`    ✗ ${run.id} - could not create (${createRes.status})`));
                  }
                  continue;
                }
                migrated++;
              } catch (err) {
                errors++;
                if (opts.verbose) {
                  const msg = err instanceof Error ? err.message : 'Unknown error';
                  console.log(chalk.red(`    ✗ ${run.id} - ${msg}`));
                }
              }
            } else {
              migrated++;
            }
          }

          console.log(
            opts.dryRun
              ? chalk.blue(`  [DRY RUN] ${benchmark.name}: ${runs.length} runs`)
              : chalk.green(`  ✓ ${benchmark.name}: ${runs.length} runs`)
          );
        }

        console.log(chalk.bold('\n  Migration Summary\n'));
        console.log(chalk.gray(`    Total embedded runs: ${totalRuns}`));
        console.log(chalk.green(`    Migrated:           ${migrated}`));
        console.log(chalk.yellow(`    Already done:       ${skipped}`));
        if (errors > 0) {
          console.log(chalk.red(`    Errors:             ${errors}`));
        }

        if (opts.dryRun) {
          console.log(chalk.blue('\n  Dry run — no changes made. Run without --dry-run to apply.\n'));
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

  // Subcommand: migrate sdk-v2 (codemod eval files to control-inversion)
  command
    .command('sdk-v2 [files...]')
    .description('Codemod code-SDK eval files to the v2 agent.run() shape (RFC 004)')
    .option('--dry-run', 'Show the diff without writing changes')
    .option('-v, --verbose', 'Show per-test migration notes')
    .action(async (...args: any[]) => {
      // Commander always passes the Command instance as the LAST action arg
      // and the variadic positional as the first. Read options off the
      // command so flag binding is robust across commander arg shapes.
      const cmd = args[args.length - 1];
      const files: string[] = Array.isArray(args[0]) ? args[0] : [];
      // The parent `migrate` command also declares --dry-run, and commander
      // attributes the flag to the parent. Merge parent opts so --dry-run /
      // --verbose work whether commander binds them to this subcommand or up.
      const ownOpts = cmd && typeof cmd.opts === 'function' ? cmd.opts() : {};
      const parentOpts = cmd && cmd.parent && typeof cmd.parent.opts === 'function' ? cmd.parent.opts() : {};
      const opts: { dryRun?: boolean; verbose?: boolean } = { ...parentOpts, ...ownOpts };
      if (parentOpts.dryRun) opts.dryRun = true;
      if (parentOpts.verbose) opts.verbose = true;
      const { migrateEvalSource } = await import('@/lib/testCases/codemod.js');
      const fs = await import('fs');
      const fg = await import('fast-glob').then(m => m.default).catch(() => null);

      console.log(chalk.cyan.bold('\n  Code-SDK v2 migration (codemod)\n'));
      console.log(chalk.gray('  Rewrites `({ result }) => ...` bodies with a prompt to `({ agent }) => { const result = await agent.run(); ... }`\n'));

      // Resolve inputs: explicit files/globs, or default to **/*.eval.{js,ts}.
      const patterns = files && files.length > 0 ? files : ['**/*.eval.js', '**/*.eval.ts', '**/*.eval.mjs'];
      let targets: string[] = [];
      if (fg) {
        targets = await fg(patterns, { ignore: ['**/node_modules/**', '**/dist/**', '**/lib/dist/**'], absolute: false });
      } else {
        // Fallback: treat args as literal file paths.
        targets = patterns.filter(p => fs.existsSync(p));
      }
      if (targets.length === 0) {
        console.log(chalk.yellow('  No matching .eval files found.\n'));
        return;
      }

      let changedFiles = 0;
      let migratedTests = 0;
      for (const file of targets) {
        let src: string;
        try {
          src = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const { code, changed, notes } = migrateEvalSource(src, file);
        const migrated = notes.filter(n => n.startsWith('migrate')).length;
        migratedTests += migrated;
        if (changed) {
          changedFiles++;
          if (!opts.dryRun) fs.writeFileSync(file, code, 'utf-8');
          console.log((opts.dryRun ? chalk.blue('  would update ') : chalk.green('  updated ')) + chalk.bold(file) + chalk.gray(` (${migrated} test${migrated === 1 ? '' : 's'})`));
        } else if (opts.verbose) {
          console.log(chalk.gray(`  unchanged ${file}`));
        }
        if (opts.verbose) {
          for (const n of notes) console.log(chalk.gray(`      ${n}`));
        }
      }

      console.log(chalk.bold('\n  Summary\n'));
      console.log(chalk.gray(`    Files scanned:   ${targets.length}`));
      console.log(chalk.green(`    Files ${opts.dryRun ? 'to change' : 'changed'}:   ${changedFiles}`));
      console.log(chalk.green(`    Tests migrated:  ${migratedTests}`));
      if (opts.dryRun) {
        console.log(chalk.blue('\n  Dry run — no files written. Re-run without --dry-run to apply.\n'));
      } else {
        console.log(chalk.green('\n  Done. Review the diff and run your evals to verify.\n'));
      }
    });

  return command;
}
