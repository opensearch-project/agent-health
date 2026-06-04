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
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { loadConfig, DEFAULT_SERVER_CONFIG, type ResolvedConfig } from '@/lib/config/index.js';
import { ensureServer, createServerCleanup, isServerRunning, type EnsureServerResult } from '@/cli/utils/serverLifecycle.js';
import { ApiClient, ServerError, type BenchmarkExecutionEvent } from '@/cli/utils/apiClient.js';
import { validateTestCasesArrayJson, type ValidatedTestCaseInput } from '@/lib/testCaseValidation.js';
import { calculateRunStats, getReportIdsFromRun } from '@/lib/runStats.js';
import { formatJson, formatMarkdownTable, parseOutputFormat, OUTPUT_FORMAT_DESCRIPTION, type OutputFormat } from '@/cli/utils/formatOutput.js';
import type { AgentConfig, Benchmark, BenchmarkRun, TestCase, TestCaseRun, EvaluationReport, TestCaseSource } from '@/types/index.js';
import { existsSync, statSync } from 'fs';
import { isCodeFile } from '@/lib/testCases/loader.js';

interface BenchmarkOptions {
  agent: string[];
  model?: string;
  evaluator?: string;
  output: string;
  verbose?: boolean;
  export?: string;
  format: string;
  stopServer?: boolean;
  file?: string | string[];
  dir?: string[];
  testCase?: string[];
  label?: string[];
  concurrency: string;
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
 * Get default model key from config
 */
function getDefaultModel(config: ResolvedConfig): string {
  return Object.keys(config.models)[0] || 'claude-sonnet';
}

/**
 * Check if a string looks like a file path (ends with .json)
 */
export function isFilePath(value: string): boolean {
  return value.toLowerCase().endsWith('.json') || isCodeFile(value);
}

/**
 * Load and validate test cases from a JSON file
 */
export function loadAndValidateTestCasesFile(filePath: string): ValidatedTestCaseInput[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read file: ${filePath} (${err instanceof Error ? err.message : err})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in file: ${filePath}`);
  }

  const result = validateTestCasesArrayJson(parsed);
  if (!result.valid || !result.data) {
    const msgs = result.errors.map(e => e.path ? `${e.path}: ${e.message}` : e.message).join('\n  ');
    throw new Error(`Validation failed for ${filePath}:\n  ${msgs}`);
  }

  return result.data;
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
  verbose: boolean,
  concurrency?: number,
  evaluatorId?: string
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
        ...(concurrency && concurrency > 1 ? { concurrency } : {}),
        ...(evaluatorId ? { evaluatorId } : {}),
      },
      (event: BenchmarkExecutionEvent) => {
        if (event.type === 'started') {
          startedRunId = event.runId;
        } else if (event.type === 'progress') {
          const current = event.currentTestCaseIndex + 1;
          const completed = event.completedCount ?? 0;
          const testCaseName = event.currentTestCase?.name || `Test ${current}`;

          if (event.result) {
            const status = event.result.status === 'completed' ? chalk.green('✓') : chalk.red('✗');
            spinner.text = `${agent.name}: ${testCaseName} ${status} (${completed}/${totalTestCases} evaluated)`;

            // Show per-test-case errors in verbose mode
            if (verbose && event.result.status === 'failed' && event.result.error) {
              spinner.info(`${agent.name}: ${testCaseName} ${chalk.red('✗')} - ${event.result.error}`);
              spinner.start(`${agent.name}: (${completed}/${totalTestCases} evaluated)`);
            }
          } else {
            spinner.text = `${agent.name}: ${testCaseName} — evaluating... (${completed}/${totalTestCases} done)`;
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

    // Issue #242: when the evaluator couldn't produce verdicts on some runs,
    // call them out explicitly so users don't conflate "evaluator misconfigured"
    // with "agent scored 0".
    const erroredSuffix = stats.errored > 0
      ? chalk.yellow(` (${stats.errored} errored — evaluator could not run)`)
      : '';

    if (passRate >= 80) {
      spinner.succeed(
        `${agent.name}: ${chalk.green(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)${erroredSuffix}`
      );
    } else if (passRate >= 50) {
      spinner.warn(
        `${agent.name}: ${chalk.yellow(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)${erroredSuffix}`
      );
    } else {
      spinner.fail(
        `${agent.name}: ${chalk.red(`${stats.passed}/${stats.total} passed`)} (${passRate}% pass rate)${erroredSuffix}`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isServerError = error instanceof ServerError;

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

          // Run failed - show the error from the run if available
          if (run.status === 'failed') {
            const runError = run.error || errorMessage;
            spinner.fail(`${agent.name}: ${chalk.red('Failed')} - ${runError}`);
            if (stats.passed > 0 || stats.failed > 0) {
              console.log(chalk.gray(`  Partial results: ${stats.passed} passed, ${stats.failed} failed out of ${stats.total}`));
            }
            return results;
          }
        }
      } catch {
        // Ignore errors during recovery - we'll show the original error below
      }
    }

    // Server-sent errors are definitive failures - show the error directly
    if (isServerError) {
      spinner.fail(`${agent.name}: ${chalk.red('Failed')} - ${errorMessage}`);
    } else {
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

    // Print helpful hints based on the error
    const lowerError = errorMessage.toLowerCase();
    if (lowerError.includes('401') || lowerError.includes('403') || lowerError.includes('unauthorized') || lowerError.includes('forbidden') || lowerError.includes('token') || lowerError.includes('auth')) {
      console.log(chalk.gray(`  Hint: This looks like an authentication issue. Check your agent-health.config.ts`));
      console.log(chalk.gray(`        (headers, hooks.beforeRequest, or credentials) and re-run.`));
    } else if (lowerError.includes('econnrefused') || lowerError.includes('enotfound') || lowerError.includes('connect')) {
      console.log(chalk.gray(`  Hint: Could not connect to the agent endpoint. Verify the endpoint in agent-health.config.ts`));
      console.log(chalk.gray(`        is reachable: npx @opensearch-project/agent-health doctor`));
    } else if (lowerError.includes('not found') || lowerError.includes('agent not found')) {
      console.log(chalk.gray(`  Hint: Agent key not found. List available agents: npx @opensearch-project/agent-health list agents`));
    } else if (lowerError.includes('hook') || lowerError.includes('beforerequest')) {
      console.log(chalk.gray(`  Hint: The beforeRequest hook in agent-health.config.ts threw an error.`));
      console.log(chalk.gray(`        Check the hook logic and any external services it calls.`));
    }
    if (errorMessage !== 'terminated') {
      console.log(chalk.gray(`  Debug: Run with DEBUG=true for verbose server logs`));
    }
  }

  return results;
}

/**
 * Build summary rows (shared between table and markdown)
 */
function buildSummaryRows(allResults: AgentResults[], totalTestCases: number): string[][] {
  return allResults.map(results => {
    const passRate = totalTestCases > 0 ? (results.passed / totalTestCases) * 100 : 0;
    return [
      results.agent.name,
      results.passed.toString(),
      results.failed.toString(),
      `${passRate.toFixed(0)}%`,
      results.run?.id || results.runId || 'N/A',
    ];
  });
}

/**
 * Display summary table or markdown
 */
function displaySummary(allResults: AgentResults[], totalTestCases: number, format: OutputFormat): void {
  const headers = ['Agent', 'Passed', 'Failed', 'Pass Rate', 'Run ID'];
  const rows = buildSummaryRows(allResults, totalTestCases);

  if (format === 'markdown') {
    console.log('\n');
    console.log('## Benchmark Summary\n');
    console.log(formatMarkdownTable(headers, rows));
    return;
  }

  const table = new Table({
    head: headers.map(h => chalk.cyan(h)),
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
 * Export results to file
 * When format is 'json', exports raw results directly.
 * For other formats, calls the server report API endpoint.
 */
async function exportResults(
  benchmark: Benchmark,
  allResults: AgentResults[],
  exportPath: string,
  format: string,
  serverBaseUrl: string
): Promise<void> {
  if (format !== 'json') {
    // Use server report API for non-JSON formats
    const runIds = allResults
      .map((r) => r.run?.id || r.runId)
      .filter((id): id is string => !!id);

    const params = new URLSearchParams({ format });
    if (runIds.length > 0) {
      params.set('runIds', runIds.join(','));
    }

    const url = `${serverBaseUrl}/api/storage/benchmarks/${encodeURIComponent(benchmark.id)}/report?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error(chalk.red(`\nExport failed: ${errorBody.error}`));
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/pdf')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(exportPath, buffer);
    } else {
      const text = await response.text();
      writeFileSync(exportPath, text);
    }
  } else {
    // Direct JSON export (existing behavior)
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
  }

  console.log(chalk.green(`\nResults exported to: ${exportPath}`));
}

/**
 * Create the benchmark command
 */
/**
 * Unified evaluation-run mode: uses the new /api/storage/evaluation-runs endpoint.
 * Triggered when new source flags are used (-d, -t, --label, or multiple -f).
 */
async function runUnifiedMode(
  options: BenchmarkOptions & { name?: string },
  config: ResolvedConfig,
  serverConfig: any,
  isCI: boolean,
  fileArray: string[]
): Promise<void> {
  // Build sources from flags
  const sources: TestCaseSource[] = [];

  if (options.name && !isFilePath(options.name)) {
    // -n flag: will be resolved server-side
    const api = new ApiClient(`http://localhost:${serverConfig.port}`);
    const benchmark = await api.findBenchmark(options.name);
    if (!benchmark) {
      console.error(chalk.red(`  Error: Benchmark not found: "${options.name}"`));
      process.exit(1);
    }
    sources.push({ type: 'benchmark', benchmarkId: benchmark.id });
  }

  if (fileArray.length > 0) {
    for (const f of fileArray) {
      if (!existsSync(f)) {
        console.error(chalk.red(`  Error: File not found: ${f}`));
        process.exit(1);
      }
    }
    sources.push({ type: 'file-import', filenames: fileArray, testCaseIds: [] });
  }

  if (options.dir && options.dir.length > 0) {
    for (const d of options.dir) {
      if (!existsSync(d) || !statSync(d).isDirectory()) {
        console.error(chalk.red(`  Error: Directory not found: ${d}`));
        process.exit(1);
      }
    }
    sources.push({ type: 'directory-import', dirPaths: options.dir, testCaseIds: [] });
  }

  if (options.testCase && options.testCase.length > 0) {
    sources.push({ type: 'test-case-ids', ids: options.testCase });
  }

  if (options.label && options.label.length > 0) {
    sources.push({ type: 'label-filter', labels: options.label });
  }

  if (sources.length === 0) {
    console.error(chalk.red('  Error: No test case sources specified.'));
    console.log(chalk.gray('  Use -n, -f, -d, -t, or --label to specify sources.'));
    process.exit(1);
  }

  // Ensure server is running
  const connectSpinner = ora('Connecting to server...').start();
  let serverResult: EnsureServerResult;
  let cleanup: () => void;
  const shouldStopServer = isCI || options.stopServer;

  try {
    serverResult = await ensureServer(serverConfig);
    cleanup = createServerCleanup(serverResult, shouldStopServer);
    connectSpinner.succeed(serverResult.wasStarted
      ? `Started server on port ${serverConfig.port}`
      : `Connected to existing server on port ${serverConfig.port}`);
  } catch (error) {
    connectSpinner.fail(`Failed to connect: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const api = new ApiClient(serverResult.baseUrl);

  // Find agent
  let agentKey: string;
  if (options.agent.length === 0) {
    const enabledAgent = config.agents.find(a => a.enabled !== false);
    if (!enabledAgent) {
      console.error(chalk.red('  Error: No enabled agents found.'));
      process.exit(1);
    }
    agentKey = enabledAgent.key;
    console.log(chalk.gray(`  Agent: ${enabledAgent.name} (default)`));
  } else {
    agentKey = options.agent[0];
    console.log(chalk.gray(`  Agent: ${agentKey}`));
  }

  const modelId = options.model || getDefaultModel(config);
  const concurrency = Math.max(1, Math.min(20, parseInt(options.concurrency, 10) || 1));

  // Determine benchmark association
  let benchmarkId: string | undefined;
  if (options.name && !isFilePath(options.name)) {
    const benchmark = await api.findBenchmark(options.name);
    benchmarkId = benchmark?.id;
  }

  console.log(chalk.gray(`  Sources: ${sources.length} source(s)`));
  console.log(chalk.gray(`  Model: ${modelId}`));
  if (concurrency > 1) console.log(chalk.gray(`  Concurrency: ${concurrency}`));
  if (benchmarkId) console.log(chalk.gray(`  Benchmark: ${options.name}`));
  else console.log(chalk.gray(`  Mode: Ad-hoc (no benchmark association)`));
  console.log('');

  // Execute via evaluation-runs API (SSE)
  const spinner = ora('Starting evaluation run...').start();

  try {
    const response = await fetch(`${serverResult.baseUrl}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `CLI Run - ${agentKey} - ${new Date().toISOString()}`,
        sources,
        agentKey,
        modelId,
        evaluatorId: options.evaluator,
        concurrency,
        benchmarkId,
        trigger: 'cli',
      }),
    });

    if (!response.ok || !response.body) {
      const errText = await response.text();
      spinner.fail(`Evaluation run failed: ${errText}`);
      process.exit(1);
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalTestCases = 0;
    let completedCount = 0;
    let runId = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7);
          continue;
        }
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));

            if (data.runId && data.testCases) {
              // Started event
              runId = data.runId;
              totalTestCases = data.testCases.length;
              spinner.text = `Running evaluation (0/${totalTestCases})`;
            } else if (data.completedCount !== undefined) {
              // Progress event
              completedCount = data.completedCount;
              spinner.text = `Running evaluation (${completedCount}/${totalTestCases})`;
            } else if (data.status === 'completed' || data.status === 'cancelled') {
              // Completed event
              break;
            } else if (data.error) {
              spinner.fail(`Run failed: ${data.error}`);
              process.exit(1);
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }

    spinner.succeed(`Evaluation run completed (${completedCount}/${totalTestCases} test cases)`);

    // Fetch final run state
    const finalRun = await fetch(`${serverResult.baseUrl}/api/storage/evaluation-runs/${runId}`);
    if (finalRun.ok) {
      const run = await finalRun.json();
      const passed = Object.values(run.results || {}).filter((r: any) => r.status === 'completed').length;
      const failed = Object.values(run.results || {}).filter((r: any) => r.status === 'failed').length;

      console.log('');
      console.log(chalk.bold('  Results:'));
      console.log(`    ${chalk.green('✓ Passed:')} ${passed}`);
      console.log(`    ${chalk.red('✗ Failed:')} ${failed}`);
      console.log(`    ${chalk.gray('Total:')} ${totalTestCases}`);
      if (!benchmarkId) {
        console.log('');
        console.log(chalk.gray(`  This was an ad-hoc run (ID: ${runId}).`));
        console.log(chalk.gray('  Promote to benchmark with: -n "Benchmark Name"'));
      }
    }
  } catch (error) {
    spinner.fail(`Evaluation run error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  cleanup!();
}

export function createBenchmarkCommand(): Command {
  const command = new Command('benchmark')
    .description('Run a benchmark against one or more agents')
    .option('-n, --name <name>', 'Benchmark name or ID (also associates run with benchmark)')
    .option(
      '-f, --file <path>',
      'JSON file(s) of test cases (repeatable)',
      (val: string, arr: string[]) => [...arr, val],
      []
    )
    .option(
      '-d, --dir <path>',
      'Directory of test case JSON files (repeatable)',
      (val: string, arr: string[]) => [...arr, val],
      []
    )
    .option(
      '-t, --test-case <id>',
      'Specific test case ID (repeatable)',
      (val: string, arr: string[]) => [...arr, val],
      []
    )
    .option(
      '--label <label>',
      'Filter by label (repeatable, AND logic)',
      (val: string, arr: string[]) => [...arr, val],
      []
    )
    .option(
      '-a, --agent <key>',
      'Agent key (can be specified multiple times)',
      (val: string, arr: string[]) => [...arr, val],
      []
    )
    .option('-m, --model <id>', 'Model ID (uses agent default if not specified)')
    .option('-e, --evaluator <id>', 'Evaluator ID (uses RCA default if not specified)')
    .option('-o, --output <format>', OUTPUT_FORMAT_DESCRIPTION, 'table')
    .option('--export <path>', 'Export results to file')
    .option('--format <type>', 'Report format for --export: json (default), html, pdf', 'json')
    .option('-c, --concurrency <n>', 'Number of test cases to run in parallel (default: 1)', '1')
    .option('-v, --verbose', 'Show detailed output')
    .option('--stop-server', 'Stop the server after benchmark completes (default: keep running)')
    .action(async (options: BenchmarkOptions & { name?: string }) => {
      console.log(chalk.bold('\nAgent Health - Benchmark Runner\n'));

      // Load config
      const config = await loadConfig();
      const serverConfig = { ...DEFAULT_SERVER_CONFIG, ...config.server };
      const isCI = !!process.env.CI;

      // Detect "unified mode" — new flags that use the evaluation-runs API
      const fileArray = Array.isArray(options.file) ? options.file : (options.file ? [options.file] : []);
      const hasNewFlags = (options.dir && options.dir.length > 0) ||
        (options.testCase && options.testCase.length > 0) ||
        (options.label && options.label.length > 0) ||
        fileArray.length > 1;

      if (hasNewFlags || (fileArray.length > 0 && (options.dir?.length || options.testCase?.length || options.label?.length))) {
        // Unified evaluation-run mode — delegate to new API
        await runUnifiedMode(options, config, serverConfig, isCI, fileArray);
        return;
      }

      // Check if server is already running (for smart defaults)
      const serverWasRunning = await isServerRunning(serverConfig.port);

      // Determine file path: explicit -f flag, or -n value that looks like a file (legacy single-file mode)
      const filePath = fileArray[0] || (options.name && isFilePath(options.name) ? options.name : undefined);
      const fileMode = !!filePath;

      // Determine mode: quick mode if no server running, no benchmark name, and no file
      const quickMode = !options.name && !fileMode && !serverWasRunning;

      // If server is running but no benchmark name and no file, show helpful error
      if (!options.name && !fileMode && serverWasRunning) {
        console.error(chalk.red('  Error: Benchmark name required when server is already running.'));
        console.log('');
        console.log(chalk.cyan('  Options:'));
        console.log(chalk.gray('    1. Specify a benchmark:  benchmark -n "Name" -a claude-code'));
        console.log(chalk.gray('    2. Import from file:     benchmark -f ./test-cases.json -a mock'));
        console.log(chalk.gray('    3. Stop the server and run in quick mode'));
        console.log(chalk.gray('    4. List available:       npx agent-health list benchmarks'));
        console.log('');
        process.exit(1);
      }

      if (fileMode) {
        console.log(chalk.cyan(`  Running in file mode (importing test cases from ${filePath})`));
      } else if (quickMode) {
        console.log(chalk.cyan('  Running in quick mode (auto-creating benchmark from test cases)'));
      }

      // Ensure server is running
      const connectSpinner = ora('Connecting to server...').start();
      let serverResult: EnsureServerResult;
      let cleanup: () => void;
      // Clean up server: in CI, quick/file mode, or when --stop-server flag is used
      const shouldStopServer = isCI || quickMode || fileMode || options.stopServer;

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
        // Multiple benchmarks may be derived from a single SDK file (one
        // per `describe()` block, plus a file-default for orphan tests).
        // benchmarksToRun is the list we hand to the agent loop below.
        let benchmarksToRun: Benchmark[] = [];

        if (fileMode) {
          // File mode: import test cases (JSON or code-based .eval.js/.ts)
          // and create/reuse one or more benchmarks. Both paths produce the
          // same upstream behavior — Benchmark + nested BenchmarkRun — so
          // the resulting runs land in the same UI list, share the same
          // RunInspectorPage, and support compare/promote/etc.
          const importSpinner = ora(`Loading test cases from ${filePath}...`).start();
          try {
            let upsertInputs: Array<Partial<TestCase>>;
            // For SDK files: groups maps describe-name -> test names;
            // orphans is the list of test names with no describe.
            let groups: Map<string, string[]> = new Map();
            let orphans: string[] = [];

            if (isCodeFile(filePath!)) {
              const { loadTestCasesFromModule } = await import('@/lib/testCases/loader.js');
              const { getCategoryFromLabels, getDifficultyFromLabels } = await import('@/lib/testCaseLabels.js');
              const loaded = await loadTestCasesFromModule(filePath!);
              const sourceFile = path.relative(process.cwd(), loaded.filePath);
              groups = loaded.benchmarks;
              const inGroup = new Set<string>();
              for (const list of groups.values()) {
                for (const name of list) inGroup.add(name);
              }
              orphans = loaded.testCases.filter(tc => !inGroup.has(tc.name)).map(tc => tc.name);
              upsertInputs = loaded.testCases.map(tc => {
                const labels = tc.options.labels;
                const category = getCategoryFromLabels(labels);
                const difficulty = getDifficultyFromLabels(labels);
                return {
                  name: tc.name,
                  ...(category ? { category: category as any } : {}),
                  ...(difficulty ? { difficulty: difficulty as any } : {}),
                  initialPrompt: tc.options.prompt,
                  context: tc.options.context,
                  labels,
                  sourceFile,
                  sourceHash: tc.hash,
                  description: tc.options.description,
                  // Forward expectedOutcomes / expectedTrajectory — see
                  // services/sourceResolver.ts for rationale. Without
                  // these, the CLI's import path stripped them out and a
                  // server-side evaluator (`-e <evaluator>`) couldn't
                  // grade a code-SDK test (issue #245).
                  ...(tc.options.expectedOutcomes ? { expectedOutcomes: tc.options.expectedOutcomes } : {}),
                  ...(tc.options.expectedTrajectory ? { expectedTrajectory: tc.options.expectedTrajectory } : {}),
                };
              });
            } else {
              const validatedTestCases = loadAndValidateTestCasesFile(filePath!);
              upsertInputs = validatedTestCases.map(tc => tc as unknown as Partial<TestCase>);
              orphans = upsertInputs.map(tc => (tc as any).name);
            }

            importSpinner.succeed(`Loaded ${upsertInputs.length} test cases from ${filePath}`);

            const uploadSpinner = ora('Importing test cases to server...').start();
            const bulkResult = await api.bulkCreateTestCases(upsertInputs as any);
            // SDK upsert path returns `updated` / `unchanged` alongside
            // `created`; surface the breakdown so the operator can see which
            // records were reused vs. version-bumped vs. freshly created. JSON
            // imports leave `updated` undefined and fall through to the legacy
            // "Imported N test cases" line.
            if (typeof bulkResult.updated === 'number') {
              uploadSpinner.succeed(
                `Imported: ${bulkResult.created} created, ${bulkResult.updated} updated, ${bulkResult.unchanged ?? 0} unchanged`
              );
            } else {
              uploadSpinner.succeed(`Imported ${bulkResult.created} test cases`);
            }

            // Map test case name -> stored id for quick lookups
            const idByName = new Map(bulkResult.testCases.map(tc => [tc.name, tc.id]));

            // Build the list of benchmarks. Two paths:
            //  - SDK with describe(): one benchmark per describe group
            //  - JSON or SDK without describe(): single file-default benchmark
            const fileDefaultName = options.name || path.basename(filePath!, path.extname(filePath!));
            const benchmarkSpecs: Array<{ name: string; description: string; testCaseNames: string[] }> = [];
            for (const [groupName, testNames] of groups) {
              benchmarkSpecs.push({
                name: groupName,
                description: `From describe("${groupName}") in ${filePath}`,
                testCaseNames: testNames,
              });
            }
            if (orphans.length > 0) {
              benchmarkSpecs.push({
                name: fileDefaultName,
                description: `Imported from ${filePath}`,
                testCaseNames: orphans,
              });
            }
            // Defensive: if everything wound up in describes and there are no
            // orphans, the file-default benchmark is empty — skip it. If a
            // file is somehow empty of tests, the loader would have already
            // thrown earlier.
            if (benchmarkSpecs.length === 0) {
              throw new Error(`No test cases to run from ${filePath}`);
            }

            const createSpinner = ora(`Creating ${benchmarkSpecs.length} benchmark(s)...`).start();
            // Self-heal source path used below — only meaningful for SDK/code
            // imports (`isCodeFile(filePath)` is true). For JSON imports we
            // leave it undefined and the merge stays a plain set-union.
            const sdkSourceFile = isCodeFile(filePath!)
              ? path.relative(process.cwd(), path.resolve(filePath!))
              : undefined;
            for (const spec of benchmarkSpecs) {
              const tcIds = spec.testCaseNames.map(n => idByName.get(n)).filter((x): x is string => !!x);
              if (tcIds.length === 0) continue;
              const existingBenchmark = await api.findBenchmark(spec.name);
              let bm: Benchmark;
              if (existingBenchmark) {
                // Merge with existing testCaseIds so cross-file contributions
                // to the same describe-named benchmark stack. For SDK imports,
                // also self-heal: drop any pre-existing IDs whose stored
                // (name, sourceFile) matches a freshly upserted canonical ID
                // — those are duplicates left over from the pre-fix bug where
                // the bulk endpoint always called bulkCreate and minted fresh
                // IDs for every run, growing benchmark.testCaseIds unbounded.
                const existingIds = existingBenchmark.testCaseIds || [];
                let prunedIds = existingIds;
                if (sdkSourceFile && existingIds.length > 0) {
                  const canonicalNames = new Set(spec.testCaseNames);
                  const canonicalIdSet = new Set(tcIds);
                  // Distinguish three outcomes per fetch so a transient
                  // network blip can never silently delete a valid benchmark
                  // reference:
                  //   - { kind: 'found', tc }   → evaluate the prune predicate
                  //   - { kind: 'missing' }     → confirmed 404, drop the dangling ref
                  //   - { kind: 'error', err }  → fetch threw (network / 5xx);
                  //                              KEEP the id, log a warning,
                  //                              skip pruning for this item
                  type FetchResult =
                    | { kind: 'found'; tc: TestCase }
                    | { kind: 'missing' }
                    | { kind: 'error'; err: unknown };
                  const fetched: FetchResult[] = await Promise.all(
                    existingIds.map(async (id): Promise<FetchResult> => {
                      try {
                        // api.getTestCase returns null on 404 and throws on
                        // any other non-OK / network failure — we rely on
                        // that distinction here.
                        const tc = await api.getTestCase(id);
                        return tc ? { kind: 'found', tc } : { kind: 'missing' };
                      } catch (err) {
                        return { kind: 'error', err };
                      }
                    })
                  );
                  let transientErrors = 0;
                  prunedIds = existingIds.filter((id, i) => {
                    const r = fetched[i];
                    if (r.kind === 'error') {
                      transientErrors++;
                      return true; // keep — don't prune on transient failures
                    }
                    if (r.kind === 'missing') {
                      return false; // confirmed 404 — drop dangling ref
                    }
                    const tc = r.tc;
                    const isStaleSdkBloat =
                      tc.sourceFile === sdkSourceFile &&
                      canonicalNames.has(tc.name) &&
                      !canonicalIdSet.has(id);
                    return !isStaleSdkBloat;
                  });
                  if (transientErrors > 0) {
                    console.log(
                      chalk.yellow(
                        `  Note: ${transientErrors} TestCase fetch(es) failed during self-heal — ` +
                          `keeping those IDs to avoid corrupting benchmark.testCaseIds on a network blip.`
                      )
                    );
                  }
                  const droppedCount = existingIds.length - prunedIds.length;
                  if (droppedCount > 0) {
                    console.log(
                      chalk.gray(
                        `  Self-healed "${spec.name}": pruned ${droppedCount} stale TestCase ID(s) ` +
                          `from "${sdkSourceFile}" left over from pre-fix runs.`
                      )
                    );
                  }
                }
                const merged = Array.from(new Set([...prunedIds, ...tcIds]));
                bm = await api.updateBenchmark(existingBenchmark.id, { testCaseIds: merged });
              } else {
                bm = await api.createBenchmark({
                  name: spec.name,
                  description: spec.description,
                  testCaseIds: tcIds,
                });
              }
              benchmarksToRun.push(bm);
            }
            createSpinner.succeed(`Prepared ${benchmarksToRun.length} benchmark(s) for execution`);
          } catch (error) {
            importSpinner.fail(`File import failed: ${error instanceof Error ? error.message : error}`);
            process.exit(1);
          }
        } else if (quickMode) {
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
            const bm = await api.createBenchmark({
              name: `quick-${Date.now()}`,
              description: 'Auto-generated benchmark for quick mode',
              testCaseIds: testCases.map((tc) => tc.id),
            });
            benchmarksToRun.push(bm);
            createSpinner.succeed(`Created benchmark: ${bm.name}`);
          } catch (error) {
            testCasesSpinner.fail(`Failed to create benchmark: ${error instanceof Error ? error.message : error}`);
            process.exit(1);
          }
        } else {
          // Named benchmark mode
          const bm = await api.findBenchmark(options.name!);
          if (!bm) {
            console.error(chalk.red(`  Error: Benchmark not found: "${options.name}"`));
            console.log('');
            console.log(chalk.cyan('  The -n/--name option accepts:'));
            console.log(chalk.gray('    • Benchmark ID (e.g., demo-baseline)'));
            console.log(chalk.gray('    • Benchmark name (case-sensitive, e.g., "Baseline")'));
            console.log('');
            console.log(chalk.cyan('  Or import from file:'));
            console.log(chalk.gray('    benchmark -f ./test-cases.json -a mock'));
            console.log('');
            console.log(chalk.cyan('  Available benchmarks:'));
            console.log(chalk.gray('    npx agent-health list benchmarks'));
            console.log('');
            process.exit(1);
          }

          // Check if benchmark is sample data (read-only)
          if (bm.id.startsWith('demo-')) {
            console.error(chalk.red(`  Error: Cannot execute sample benchmarks.`));
            console.log(chalk.gray('  Sample data is read-only with pre-completed runs.'));
            console.log(chalk.gray('  Create a real benchmark in the UI to run evaluations.'));
            console.log('');
            process.exit(1);
          }
          benchmarksToRun.push(bm);
        }

        if (benchmarksToRun.length === 0) {
          console.error(chalk.red('  Error: No benchmarks to run.'));
          process.exit(1);
        }

        // Print summary of what we're going to run
        for (const bm of benchmarksToRun) {
          console.log(chalk.gray(`  Benchmark: ${bm.name} (${bm.id}) — ${bm.testCaseIds.length} test cases`));
        }
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
              console.log(chalk.gray('  To add a custom agent, configure it in agent-health.config.ts'));
              console.log(chalk.gray('  Generate one with: npx @opensearch-project/agent-health init'));
              console.log('');
              process.exit(1);
            }
            agents.push(agent);
          }
          console.log(chalk.gray(`  Agents: ${agents.map((a) => a.name).join(', ')}`));
        }

        console.log('');

        // Parse concurrency option
        const concurrency = Math.max(1, Math.min(20, parseInt(options.concurrency, 10) || 1));
        if (concurrency > 1) {
          console.log(chalk.gray(`  Concurrency: ${concurrency}`));
        }

        // Run each benchmark for each agent. With describe()-grouped SDK
        // files, benchmarksToRun contains one entry per describe block; for
        // JSON or named-benchmark or quick mode it's a single benchmark.
        const allResults: AgentResults[] = [];
        let totalTestCasesAcrossBenchmarks = 0;

        for (const benchmark of benchmarksToRun) {
          if (benchmarksToRun.length > 1) {
            console.log('');
            console.log(chalk.bold(`Benchmark: ${benchmark.name}`));
          }
          totalTestCasesAcrossBenchmarks += benchmark.testCaseIds.length;
          for (const agent of agents) {
            const modelId = options.model || getDefaultModel(config);
            const results = await runBenchmarkForAgent(
              api,
              agent,
              modelId,
              benchmark,
              options.verbose || false,
              concurrency,
              options.evaluator
            );
            // Annotate the result so the summary can attribute it to the right benchmark
            (results as any).benchmark = benchmark;
            allResults.push(results);
          }
        }

        // Use the first benchmark for output backward-compat where the
        // existing summary helpers assume a single benchmark. Multi-bench
        // summary lines were already printed above per-benchmark.
        const benchmark = benchmarksToRun[0];

        // Output results
        const outputFormat = parseOutputFormat(options.output);
        if (outputFormat === 'json') {
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
          console.log(formatJson(jsonOutput));
        } else {
          displaySummary(allResults, benchmark.testCaseIds.length, outputFormat);
        }

        // Export if requested
        if (options.export) {
          await exportResults(benchmark, allResults, options.export, options.format, serverResult.baseUrl);
        }

        // Show links to view results
        console.log('');
        console.log(chalk.cyan('View results:'));
        for (const result of allResults) {
          const runId = result.run?.id || result.runId;
          const bm = (result as any).benchmark || benchmark;
          if (runId) {
            console.log(chalk.gray(`  ${result.agent.name} (${bm.name}): ${serverResult.baseUrl}/evaluations/benchmarks/${bm.id}/runs/${runId}`));
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
