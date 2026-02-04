/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark Command
 * Run a full benchmark against one or more agents
 *
 * Architecture: CLI → Server HTTP API → OpenSearch
 * This command is a thin wrapper that delegates all logic to the server.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { writeFileSync } from 'fs';
import { loadConfig, DEFAULT_SERVER_CONFIG, type ResolvedConfig } from '@/lib/config/index.js';
import { ensureServer, createServerCleanup, isServerRunning, type EnsureServerResult } from '@/cli/utils/serverLifecycle.js';
import { ApiClient, type BenchmarkExecutionEvent } from '@/cli/utils/apiClient.js';
import { calculateRunStats, getReportIdsFromRun } from '@/lib/runStats.js';
import type { AgentConfig, Benchmark, BenchmarkRun, TestCaseRun, EvaluationReport } from '@/types/index.js';

interface BenchmarkOptions {
  agent: string[];
  model?: string;
  output: string;
  verbose?: boolean;
  export?: string;
  stopServer?: boolean;
}

interface AgentResults {
  agent: AgentConfig;
  run?: BenchmarkRun;
  runId?: string; // Track runId separately in case execution fails after run is created
  passed: number;
  failed: number;
  reports?: TestCaseRun[];
}

/**
 * Find agent by key or name
 */
function findAgent(identifier: string, config: ResolvedConfig): AgentConfig | undefined {
  return config.agents.find(
    (a) => a.key === identifier || a.name.toLowerCase() === identifier.toLowerCase()
  );
}

/**
 * Get default model for an agent
 */
function getDefaultModel(agent: AgentConfig): string {
  return agent.models[0] || 'claude-sonnet';
}

/**
 * Fetch reports for a run using the same approach as the UI.
 * Uses reportIds from run.results to fetch each report individually.
 */
async function fetchReportsForRun(
  api: ApiClient,
  run: BenchmarkRun
): Promise<Record<string, EvaluationReport | null>> {
  const reportIds = getReportIdsFromRun(run);
  const reportsMap: Record<string, EvaluationReport | null> = {};

  // Fetch all reports in parallel for efficiency
  await Promise.all(
    reportIds.map(async (reportId) => {
      reportsMap[reportId] = await api.getReportById(reportId);
    })
  );

  return reportsMap;
}

/**
 * Run benchmark for a single agent via server API
 */
async function runBenchmarkForAgent(
  api: ApiClient,
  agent: AgentConfig,
  modelId: string,
  benchmark: Benchmark,
  verbose: boolean
): Promise<AgentResults> {
  const results: AgentResults = {
    agent,
    passed: 0,
    failed: 0,
  };

  const totalTestCases = benchmark.testCaseIds.length;
  const spinner = ora(`Running ${agent.name} (0/${totalTestCases})`).start();

  // Track runId from started event so we have it even if execution fails
  let startedRunId: string | undefined;

  try {
    // Execute benchmark via server API (SSE stream)
    const completedRun = await api.executeBenchmark(
      benchmark.id,
      {
        name: `CLI Run - ${agent.name}`,
        agentKey: agent.key,
        modelId: modelId,
      },
      (event: BenchmarkExecutionEvent) => {
        if (event.type === 'started') {
          startedRunId = event.runId;
        } else if (event.type === 'progress') {
          const current = event.currentTestCaseIndex + 1;
          const testCaseName = event.currentTestCase?.name || `Test ${current}`;
          spinner.text = `${agent.name}: ${testCaseName} (${current}/${totalTestCases})`;

          if (verbose && event.result) {
            // Show result status in verbose mode
            const status = event.result.status === 'completed' ? chalk.green('✓') : chalk.red('✗');
            spinner.text = `${agent.name}: ${testCaseName} ${status} (${current}/${totalTestCases})`;
          }
        }
      }
    );

    results.run = completedRun;

    // Use shared stats calculation (same approach as UI)
    // Fetch reports using reportIds from run.results, then calculate stats
    const reportsMap = await fetchReportsForRun(api, completedRun);
    const stats = calculateRunStats(completedRun, reportsMap);

    results.passed = stats.passed;
    results.failed = stats.failed;

    // Store reports for export
    results.reports = Object.values(reportsMap).filter((r): r is TestCaseRun => r !== null);

    // Use pass rate from shared calculation
    const passRate = stats.passRate;

    if (passRate >= 80) {
      spinner.succeed(
        `${agent.name}: ${chalk.green(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)`
      );
    } else if (passRate >= 50) {
      spinner.warn(
        `${agent.name}: ${chalk.yellow(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)`
      );
    } else {
      spinner.fail(
        `${agent.name}: ${chalk.red(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Preserve runId even if execution failed (for URL output)
    if (startedRunId) {
      results.runId = startedRunId;

      // Try to recover partial results by fetching run state from server
      try {
        const run = await api.getRun(benchmark.id, startedRunId);
        if (run) {
          results.run = run;
          const reportsMap = await fetchReportsForRun(api, run);
          const stats = calculateRunStats(run, reportsMap);
          results.passed = stats.passed;
          results.failed = stats.failed;
          results.reports = Object.values(reportsMap).filter((r): r is TestCaseRun => r !== null);

          // Check if the run actually completed successfully (recovered after stream disconnect)
          if (run.status === 'completed' || run.status === 'cancelled') {
            const passRate = stats.passRate;
            if (passRate >= 80) {
              spinner.succeed(
                `${agent.name}: ${chalk.green(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)`
              );
            } else if (passRate >= 50) {
              spinner.warn(
                `${agent.name}: ${chalk.yellow(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)`
              );
            } else {
              spinner.fail(
                `${agent.name}: ${chalk.red(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)`
              );
            }
            return results; // Successfully recovered
          }
        }
      } catch {
        // Ignore errors during recovery - we'll show the original error below
      }
    }

    // Check if this was a stream disconnect (server may still be running)
    const isStreamError = errorMessage.includes('terminated') ||
                          errorMessage.includes('network') ||
                          errorMessage.includes('stream') ||
                          errorMessage.includes('aborted');

    if (isStreamError && startedRunId) {
      spinner.warn(`${agent.name}: ${chalk.yellow('Stream disconnected')} - server may still be processing`);
      console.log(chalk.gray(`  Check status: Use the UI to monitor progress`));
    } else {
      spinner.fail(`${agent.name}: ${chalk.red('Failed')} - ${errorMessage}`);
    }
  }

  return results;
}

/**
 * Display summary table
 */
function displaySummaryTable(allResults: AgentResults[], totalTestCases: number): void {
  const table = new Table({
    head: [
      chalk.cyan('Agent'),
      chalk.cyan('Passed'),
      chalk.cyan('Failed'),
      chalk.cyan('Pass Rate'),
      chalk.cyan('Run ID'),
    ],
    colWidths: [25, 10, 10, 12, 35],
  });

  for (const results of allResults) {
    const passRate = totalTestCases > 0 ? (results.passed / totalTestCases) * 100 : 0;
    const passRateColor = passRate >= 80 ? chalk.green : passRate >= 50 ? chalk.yellow : chalk.red;

    table.push([
      results.agent.name,
      chalk.green(results.passed.toString()),
      chalk.red(results.failed.toString()),
      passRateColor(`${passRate.toFixed(0)}%`),
      results.run?.id || results.runId || chalk.gray('N/A'),
    ]);
  }

  console.log('\n');
  console.log(chalk.bold('Benchmark Summary'));
  console.log(table.toString());
}

/**
 * Export results to JSON file
 */
function exportResults(
  benchmark: Benchmark,
  allResults: AgentResults[],
  exportPath: string
): void {
  const exportData = {
    benchmark: {
      id: benchmark.id,
      name: benchmark.name,
      testCaseCount: benchmark.testCaseIds.length,
    },
    runs: allResults.map((r) => ({
      agent: { key: r.agent.key, name: r.agent.name },
      runId: r.run?.id || r.runId,
      status: r.run?.status,
      passed: r.passed,
      failed: r.failed,
      passRate:
        benchmark.testCaseIds.length > 0 ? (r.passed / benchmark.testCaseIds.length) * 100 : 0,
      results: r.run?.results,
      reports: r.reports,
    })),
    exportedAt: new Date().toISOString(),
  };

  writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
  console.log(chalk.green(`\nResults exported to: ${exportPath}`));
}

/**
 * Create the benchmark command
 */
export function createBenchmarkCommand(): Command {
  const command = new Command('benchmark')
    .description('Run a benchmark against one or more agents')
    .option('-n, --name <name>', 'Benchmark name or ID (optional in quick mode)')
    .option(
      '-a, --agent <key>',
      'Agent key (can be specified multiple times)',
      (val, arr: string[]) => [...arr, val],
      []
    )
    .option('-m, --model <id>', 'Model ID (uses agent default if not specified)')
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .option('--export <path>', 'Export results to JSON file')
    .option('-v, --verbose', 'Show detailed output')
    .option('--stop-server', 'Stop the server after benchmark completes (default: keep running)')
    .action(async (options: BenchmarkOptions & { name?: string }) => {
      console.log(chalk.bold('\nAgent Health - Benchmark Runner\n'));

      // Load config
      const config = await loadConfig();
      const serverConfig = { ...DEFAULT_SERVER_CONFIG, ...config.server };
      const isCI = !!process.env.CI;

      // Check if server is already running (for smart defaults)
      const serverWasRunning = await isServerRunning(serverConfig.port);

      // Determine mode: quick mode if no server running and no benchmark name
      const quickMode = !options.name && !serverWasRunning;

      // If server is running but no benchmark name, show helpful error
      if (!options.name && serverWasRunning) {
        console.error(chalk.red('  Error: Benchmark name required when server is already running.'));
        console.log('');
        console.log(chalk.cyan('  Options:'));
        console.log(chalk.gray('    1. Specify a benchmark:  benchmark -n "Name" -a claude-code'));
        console.log(chalk.gray('    2. Stop the server and run in quick mode'));
        console.log(chalk.gray('    3. List available:       npx agent-health list benchmarks'));
        console.log('');
        process.exit(1);
      }

      if (quickMode) {
        console.log(chalk.cyan('  Running in quick mode (auto-creating benchmark from test cases)'));
      }

      // Ensure server is running
      const connectSpinner = ora('Connecting to server...').start();
      let serverResult: EnsureServerResult;
      let cleanup: () => void;
      // Clean up server: in CI, quick mode, or when --stop-server flag is used
      const shouldStopServer = isCI || quickMode || options.stopServer;

      try {
        serverResult = await ensureServer(serverConfig);
        cleanup = createServerCleanup(serverResult, shouldStopServer);

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
      }

      const api = new ApiClient(serverResult.baseUrl);

      try {
        // Verify server is healthy
        await api.checkHealth();

        let benchmark: Benchmark | null = null;

        if (quickMode) {
          // Quick mode: create benchmark from all test cases
          const testCasesSpinner = ora('Fetching test cases...').start();
          try {
            const testCases = await api.listTestCases();
            if (testCases.length === 0) {
              testCasesSpinner.fail('No test cases found');
              console.log(chalk.gray('  Add test cases via the UI or provide a file with -f option.'));
              process.exit(1);
            }
            testCasesSpinner.succeed(`Found ${testCases.length} test cases`);

            // Create temporary benchmark
            const createSpinner = ora('Creating quick benchmark...').start();
            benchmark = await api.createBenchmark({
              name: `quick-${Date.now()}`,
              description: 'Auto-generated benchmark for quick mode',
              testCaseIds: testCases.map((tc) => tc.id),
            });
            createSpinner.succeed(`Created benchmark: ${benchmark.name}`);
          } catch (error) {
            testCasesSpinner.fail(`Failed to create benchmark: ${error instanceof Error ? error.message : error}`);
            process.exit(1);
          }
        } else {
          // Named benchmark mode
          benchmark = await api.findBenchmark(options.name!);
          if (!benchmark) {
            console.error(chalk.red(`  Error: Benchmark not found: "${options.name}"`));
            console.log('');
            console.log(chalk.cyan('  The -n/--name option accepts:'));
            console.log(chalk.gray('    • Benchmark ID (e.g., demo-baseline)'));
            console.log(chalk.gray('    • Benchmark name (case-sensitive, e.g., "Baseline")'));
            console.log(chalk.gray('    • Path to JSON file (e.g., ./my-benchmark.json)'));
            console.log('');
            console.log(chalk.cyan('  Available benchmarks:'));
            console.log(chalk.gray('    npx agent-health list benchmarks'));
            console.log('');
            process.exit(1);
          }

          // Check if benchmark is sample data (read-only)
          if (benchmark.id.startsWith('demo-')) {
            console.error(chalk.red(`  Error: Cannot execute sample benchmarks.`));
            console.log(chalk.gray('  Sample data is read-only with pre-completed runs.'));
            console.log(chalk.gray('  Create a real benchmark in the UI to run evaluations.'));
            console.log('');
            process.exit(1);
          }
        }

        console.log(chalk.gray(`  Benchmark: ${benchmark.name} (${benchmark.id})`));
        console.log(chalk.gray(`  Test Cases: ${benchmark.testCaseIds.length}`));
        console.log(chalk.gray(`  Server: ${serverResult.baseUrl}`));

        // Find agents
        let agents: AgentConfig[] = [];
        if (options.agent.length === 0) {
          // Default to first enabled agent
          const enabledAgent = config.agents.find((a) => a.enabled !== false);
          if (!enabledAgent) {
            console.error(chalk.red('  Error: No enabled agents found in config.'));
            process.exit(1);
          }
          agents = [enabledAgent];
          console.log(chalk.gray(`  Agent: ${agents[0].name} (default)`));
        } else {
          for (const agentId of options.agent) {
            const agent = findAgent(agentId, config);
            if (!agent) {
              console.error(chalk.red(`  Error: Agent not found: ${agentId}`));
              console.log(chalk.gray('  Available agents:'));
              for (const a of config.agents) {
                console.log(chalk.gray(`    - ${a.name} (${a.key})`));
              }
              console.log('');
              process.exit(1);
            }
            agents.push(agent);
          }
          console.log(chalk.gray(`  Agents: ${agents.map((a) => a.name).join(', ')}`));
        }

        console.log('');

        // Run benchmark for each agent
        const allResults: AgentResults[] = [];

        for (const agent of agents) {
          const modelId = options.model || getDefaultModel(agent);
          const results = await runBenchmarkForAgent(
            api,
            agent,
            modelId,
            benchmark,
            options.verbose || false
          );
          allResults.push(results);
        }

        // Output results
        if (options.output === 'json') {
          const jsonOutput = allResults.map((r) => ({
            agent: { key: r.agent.key, name: r.agent.name },
            runId: r.run?.id || r.runId,
            passed: r.passed,
            failed: r.failed,
            passRate:
              benchmark.testCaseIds.length > 0
                ? (r.passed / benchmark.testCaseIds.length) * 100
                : 0,
            results: r.run?.results,
          }));
          console.log(JSON.stringify(jsonOutput, null, 2));
        } else {
          displaySummaryTable(allResults, benchmark.testCaseIds.length);
        }

        // Export if requested
        if (options.export) {
          exportResults(benchmark, allResults, options.export);
        }

        // Show links to view results
        console.log('');
        console.log(chalk.cyan('View results:'));
        for (const result of allResults) {
          const runId = result.run?.id || result.runId;
          if (runId) {
            console.log(chalk.gray(`  ${result.agent.name}: ${serverResult.baseUrl}/benchmarks/${benchmark.id}/runs/${runId}`));
          }
        }
        if (process.env.OPENSEARCH_DASHBOARDS_URL) {
          console.log(chalk.gray(`  OpenSearch Dashboards: ${process.env.OPENSEARCH_DASHBOARDS_URL}`));
        }

        // Show server status info if server will keep running
        if (serverResult.wasStarted && !shouldStopServer) {
          console.log('');
          console.log(chalk.gray(`Server still running on port ${serverConfig.port}`));
          console.log(chalk.gray(`  Use --stop-server flag to stop after benchmark`));
          console.log(chalk.gray(`  Or manually: kill $(lsof -t -i:${serverConfig.port})`));
        }
      } finally {
        // Cleanup server based on shouldStopServer flag
        cleanup!();
      }
    });

  return command;
}
