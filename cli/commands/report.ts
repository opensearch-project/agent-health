/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Report Command
 * Generate downloadable reports for benchmark runs
 *
 * Architecture: CLI → Server HTTP API (report endpoint)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { loadConfig, DEFAULT_SERVER_CONFIG } from '@/lib/config/index';
import { ensureServer, createServerCleanup, type EnsureServerResult } from '@/cli/utils/serverLifecycle';
import { ApiClient } from '@/cli/utils/apiClient';

interface ReportOptions {
  benchmark: string;
  runs?: string;
  format: string;
  output?: string;
  stdout?: boolean;
}

/**
 * Create the report command
 */
export function createReportCommand(): Command {
  const command = new Command('report')
    .description('Generate a report for a benchmark')
    .requiredOption('-b, --benchmark <id>', 'Benchmark name or ID')
    .option('-r, --runs <ids>', 'Comma-separated run IDs (default: all runs)')
    .option('-f, --format <type>', 'Report format: json, html, pdf', 'html')
    .option('-o, --output <file>', 'Output file path (auto-generates filename if omitted)')
    .option('--stdout', 'Write to stdout (JSON format only)')
    .action(async (options: ReportOptions) => {
      // Load config
      const config = await loadConfig();
      const serverConfig = { ...DEFAULT_SERVER_CONFIG, ...config.server };

      // Ensure server is running
      const connectSpinner = ora('Connecting to server...').start();
      let serverResult: EnsureServerResult;
      let cleanup: () => void;

      try {
        serverResult = await ensureServer(serverConfig);
        cleanup = createServerCleanup(serverResult, false);

        if (serverResult.wasStarted) {
          connectSpinner.succeed(`Started server on port ${serverConfig.port}`);
        } else {
          connectSpinner.succeed(`Connected to existing server on port ${serverConfig.port}`);
        }
      } catch (error) {
        connectSpinner.fail(
          `Failed to connect to server: ${error instanceof Error ? error.message : error}`
        );
        process.exit(1);
        return;
      }

      const api = new ApiClient(serverResult.baseUrl);

      try {
        // Find benchmark by name or ID
        const spinner = ora('Finding benchmark...').start();
        const benchmark = await api.findBenchmark(options.benchmark);
        if (!benchmark) {
          spinner.fail(`Benchmark not found: "${options.benchmark}"`);
          // Diagnostics go to stderr: with --stdout, stdout is the report channel.
          console.error('');
          console.error(chalk.cyan('  Available benchmarks:'));
          console.error(chalk.gray('    npx agent-health list benchmarks'));
          console.error('');
          process.exit(1);
          return;
        }
        spinner.succeed(`Found benchmark: ${benchmark.name} (${benchmark.id})`);

        // Build report URL
        const params = new URLSearchParams({ format: options.format });
        if (options.runs) {
          params.set('runIds', options.runs);
        }

        const reportSpinner = ora(`Generating ${options.format.toUpperCase()} report...`).start();

        // Fetch report from server
        const url = `${serverResult.baseUrl}/api/storage/benchmarks/${encodeURIComponent(benchmark.id)}/report?${params.toString()}`;
        const response = await fetch(url);

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
          reportSpinner.fail(`Report generation failed: ${errorBody.error}`);
          process.exit(1);
          return;
        }

        // Get filename from Content-Disposition header or generate one
        const contentDisposition = response.headers.get('content-disposition') || '';
        const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
        const defaultFilename = filenameMatch?.[1] || `report.${options.format}`;

        if (options.stdout) {
          // Write ONLY the report body to stdout. Spinners and every
          // [ServerLifecycle]/[Config] diagnostic are on stderr, so
          // `report -f json --stdout | jq` parses.
          const text = await response.text();
          reportSpinner.stop();
          process.stdout.write(text);
        } else {
          // Write to file
          const outputPath = options.output || defaultFilename;
          const contentType = response.headers.get('content-type') || '';

          if (contentType.includes('application/pdf')) {
            const buffer = Buffer.from(await response.arrayBuffer());
            writeFileSync(outputPath, buffer);
          } else {
            const text = await response.text();
            writeFileSync(outputPath, text);
          }

          reportSpinner.succeed(`Report saved to: ${outputPath}`);
        }
      } finally {
        cleanup!();
      }
    });

  return command;
}
