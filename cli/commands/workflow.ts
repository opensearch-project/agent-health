/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workflow Command — run a deterministic agent workflow over a work source.
 *
 *   agent-health workflow run -f workflows/oncall-queue.workflow.ts \
 *     --mode new --since 24h --concurrency 4 --limit 5 [--no-dry-run]
 *
 * Loads a .workflow.{ts,js,mjs} file whose default export is a Workflow
 * (built with the `workflow()` SDK helper), then runs it. Scheduling is left
 * to cron — the cadence (every 5m in dev, nightly in prod) is a property of
 * the schedule, not this command.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import type { Workflow } from '@/lib/workflow/index.js';

interface WorkflowRunCliOptions {
  file: string;
  mode?: 'new' | 'existing' | 'both';
  since?: string;
  concurrency?: string;
  limit?: string;
  dryRun?: boolean;
  output?: string;
}

async function importWorkflow(absPath: string): Promise<Workflow> {
  const mod: any = await import(pathToFileURL(absPath).href);
  const candidate = mod?.default ?? mod?.workflow ?? mod;
  if (!candidate || typeof candidate.run !== 'function' || typeof candidate.step !== 'function') {
    throw new Error(
      `No workflow found in ${absPath}. The file must default-export a workflow(...) instance.`
    );
  }
  return candidate as Workflow;
}

export function createWorkflowCommand(): Command {
  const cmd = new Command('workflow').description('Run a deterministic agent workflow over a work source');

  cmd
    .command('run')
    .description('Run a workflow file (default export of workflow())')
    .requiredOption('-f, --file <path>', 'Path to a .workflow.{ts,js,mjs} file')
    .option('-m, --mode <mode>', 'new | existing | both', 'new')
    .option('-s, --since <duration>', 'Lookback window passed to the source (e.g. 24h, 5m)')
    .option('-c, --concurrency <n>', 'Max concurrent agent calls (overrides workflow config)')
    .option('-l, --limit <n>', 'Cap total items processed (e.g. 5 for a smoke loop)')
    .option('--no-dry-run', 'Actually raise PRs (default: dry-run, PRs are logged only)')
    .option('-o, --output <format>', 'table | json', 'table')
    .action(async (options: WorkflowRunCliOptions) => {
      const asJson = options.output === 'json';
      const absPath = resolve(options.file);
      if (!existsSync(absPath)) {
        const msg = `Workflow file not found: ${absPath}`;
        if (asJson) console.log(JSON.stringify({ error: msg }, null, 2));
        else console.log(chalk.red(`\n  ${msg}\n`));
        process.exitCode = 1;
        return;
      }

      if (!asJson) console.log(chalk.bold('\nAgent Health - Workflow\n'));

      let wf: Workflow;
      try {
        wf = await importWorkflow(absPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (asJson) console.log(JSON.stringify({ error: msg }, null, 2));
        else console.log(chalk.red(`  ${msg}\n`) +
          chalk.gray('  (For .ts files run via tsx, or compile to .mjs first.)\n'));
        process.exitCode = 1;
        return;
      }

      const concurrency = options.concurrency ? parseInt(options.concurrency, 10) : undefined;
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;
      // Fail fast on bad numeric flags (NaN / 0 / negative) instead of stalling
      // the pool or silently processing 0 items.
      for (const [flag, raw, val] of [
        ['--concurrency', options.concurrency, concurrency],
        ['--limit', options.limit, limit],
      ] as const) {
        if (val !== undefined && (!Number.isFinite(val) || val < 1)) {
          console.error(chalk.red(`  ${flag} must be a positive integer (got "${raw}")`));
          process.exitCode = 1;
          return;
        }
      }
      const dryRun = options.dryRun !== false; // --no-dry-run flips it

      if (!asJson) {
        console.log(chalk.gray(`  Workflow: ${wf.name}  (agent: ${wf.config.agent})`));
        console.log(chalk.gray(
          `  mode=${options.mode} since=${options.since ?? '-'} ` +
          `concurrency=${concurrency ?? wf.config.concurrency ?? 1} ` +
          `limit=${limit ?? '-'} dryRun=${dryRun}`
        ));
      }

      const result = await wf.run({
        mode: options.mode,
        since: options.since,
        concurrency,
        limit,
        dryRun,
      });

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Processed: ${result.staged.length} item(s)`));
      console.log(chalk.gray(`  Peak concurrency: ${result.peakConcurrency}`));
      console.log(chalk.gray(`  Feedback ledger entries: ${result.ledgerSize}`));
      console.log(chalk.gray(`  Clusters: ${result.clusters.length}  ·  PRs ${dryRun ? '(dry-run) ' : ''}raised: ${result.prsRaised}`));
      if (result.clusters.length > 0) {
        console.log(chalk.bold('\n  Consolidated fix-classes:'));
        for (const c of result.clusters) {
          console.log(`    • ${chalk.yellow(c.label)} — ${c.tickets.length} ticket(s)`);
        }
      }
      console.log();
    });

  return cmd;
}
