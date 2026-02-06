/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run Command
 * Run a single test case against one or more agents
 *
 * Architecture: CLI → Server HTTP API → OpenSearch
 * This command uses the server API for all operations to follow
 * the server-mediated architecture pattern.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { loadConfig, type ResolvedConfig } from '@/lib/config/index.js';
import { ensureServer, createServerCleanup } from '@/cli/utils/serverLifecycle.js';
import { ApiClient, type EvaluationResult, type EvaluationProgressEvent } from '@/cli/utils/apiClient.js';
import type { AgentConfig, TrajectoryStep } from '@/types/index.js';

// Import server connectors to ensure they're registered
import { connectorRegistry } from '@/services/connectors/server.js';

interface RunOptions {
  agent: string[];
  model?: string;
  output: string;
  verbose?: boolean;
}

/**
 * Find agent by key or name from config
 */
function findAgent(identifier: string, config: ResolvedConfig): AgentConfig | undefined {
  return config.agents.find(a =>
    a.key === identifier || a.name.toLowerCase() === identifier.toLowerCase()
  );
}

/**
 * Get default model for an agent
 */
function getDefaultModel(agent: AgentConfig): string {
  return agent.models[0] || 'claude-sonnet';
}

/**
 * Check if a command exists in PATH
 * Uses 'where' on Windows, 'which' on Unix
 */
async function commandExists(command: string): Promise<boolean> {
  const { execSync } = await import('child_process');
  const checkCommand = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
  try {
    execSync(checkCommand, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate agent requirements before running
 * Returns error message if validation fails, undefined if OK
 */
async function validateAgentRequirements(agent: AgentConfig): Promise<string | undefined> {
  // Check if claude-code agent has the claude command available
  if (agent.connectorType === 'claude-code') {
    if (!await commandExists('claude')) {
      return `Claude CLI not found in PATH. Install Claude Code CLI: https://claude.ai/code`;
    }
  }

  // Check if subprocess agent has required command
  if (agent.connectorType === 'subprocess' && agent.endpoint) {
    const command = agent.endpoint.split(' ')[0]; // Get first word as command
    if (!await commandExists(command)) {
      return `Command '${command}' not found in PATH`;
    }
  }

  return undefined;
}

/**
 * Run evaluation for a single agent via server API
 */
async function runForAgent(
  client: ApiClient,
  testCaseId: string,
  agent: AgentConfig,
  modelId: string,
  verbose: boolean
): Promise<EvaluationResult | null> {
  const spinner = ora(`Running ${agent.name}...`).start();

  try {
    const report = await client.runEvaluation(
      testCaseId,
      agent.key,
      modelId,
      (event: EvaluationProgressEvent) => {
        if (event.type === 'step' && verbose) {
          spinner.text = `${agent.name}: Step ${event.stepIndex + 1} (${event.step.type})`;
        } else if (event.type === 'started') {
          spinner.text = `${agent.name}: Started evaluation...`;
        }
      }
    );

    if (report.status === 'completed' && report.passFailStatus === 'passed') {
      spinner.succeed(`${agent.name}: ${chalk.green('PASSED')}`);
    } else if (report.status === 'completed') {
      spinner.succeed(`${agent.name}: ${chalk.red('FAILED')}`);
    } else {
      spinner.fail(`${agent.name}: ${chalk.yellow(report.status)}`);
    }

    return report;
  } catch (error) {
    spinner.fail(`${agent.name}: ${chalk.red('ERROR')}`);
    throw error;
  }
}

/**
 * Display results as table
 */
function displayTableResults(results: Array<{ agent: AgentConfig; report: EvaluationResult | null }>): void {
  const table = new Table({
    head: [
      chalk.cyan('Agent'),
      chalk.cyan('Status'),
      chalk.cyan('Accuracy'),
      chalk.cyan('Steps'),
      chalk.cyan('Report ID'),
    ],
    colWidths: [20, 12, 12, 10, 30],
  });

  for (const r of results) {
    if (!r.report) {
      table.push([
        r.agent.name,
        chalk.red('ERROR'),
        '-',
        '-',
        '-',
      ]);
      continue;
    }

    const statusStr = r.report.passFailStatus === 'passed'
      ? chalk.green('PASSED')
      : r.report.passFailStatus === 'failed'
        ? chalk.red('FAILED')
        : chalk.yellow(r.report.status);

    table.push([
      r.agent.name,
      statusStr,
      r.report.metrics?.accuracy ? `${Math.round(r.report.metrics.accuracy)}%` : '-',
      r.report.trajectorySteps.toString(),
      r.report.id?.substring(0, 27) + '...' || '-',
    ]);
  }

  console.log('\n');
  console.log(table.toString());
}

/**
 * Create the run command
 */
export function createRunCommand(): Command {
  const command = new Command('run')
    .description('Run a test case against agents')
    .requiredOption('-t, --test-case <id>', 'Test case ID or name')
    .option('-a, --agent <key>', 'Agent key (can be specified multiple times)', (val, arr: string[]) => [...arr, val], [])
    .option('-m, --model <id>', 'Model ID (uses agent default if not specified)')
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .option('-v, --verbose', 'Show detailed trajectory output')
    .action(async (options: RunOptions & { testCase: string }) => {
      console.log(chalk.bold('\nAgent Health - Test Case Runner\n'));

      // Load config (registers custom connectors)
      const config = await loadConfig();

      // Register custom connectors from config
      for (const connector of config.connectors) {
        connectorRegistry.register(connector);
      }

      // Ensure server is running
      const serverResult = await ensureServer(config.server);
      const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

      try {
        const client = new ApiClient(serverResult.baseUrl);

        // Verify server is healthy
        await client.checkHealth();

        // Find test case via server API
        const testCase = await client.findTestCase(options.testCase);
        if (!testCase) {
          console.error(chalk.red(`  Error: Test case not found: ${options.testCase}`));
          console.log(chalk.gray('  Use `agent-health list test-cases` to see available test cases\n'));
          process.exit(1);
        }

        console.log(chalk.gray(`  Test Case: ${testCase.name} (${testCase.id})`));
        console.log(chalk.gray(`  Server: ${serverResult.baseUrl}`));

        // Find agents from config (still use local config for agent validation)
        let agents: AgentConfig[] = [];
        if (options.agent.length === 0) {
          // Default to first agent
          agents = [config.agents[0]];
          console.log(chalk.gray(`  Agent: ${agents[0].name} (default)`));
        } else {
          for (const agentId of options.agent) {
            const agent = findAgent(agentId, config);
            if (!agent) {
              console.error(chalk.red(`  Error: Agent not found: ${agentId}`));
              console.log(chalk.gray('  Use `agent-health list agents` to see available agents\n'));
              process.exit(1);
            }
            agents.push(agent);
          }
          console.log(chalk.gray(`  Agents: ${agents.map(a => a.name).join(', ')}`));
        }

        console.log('');

        // Run evaluations via server API
        const results: Array<{ agent: AgentConfig; report: EvaluationResult | null }> = [];

        for (const agent of agents) {
          const modelId = options.model || getDefaultModel(agent);

          // Validate agent requirements before running
          const validationError = await validateAgentRequirements(agent);
          if (validationError) {
            console.error(chalk.red(`  Error: ${validationError}`));
            results.push({ agent, report: null });
            continue;
          }

          try {
            const report = await runForAgent(client, testCase.id, agent, modelId, options.verbose || false);
            results.push({ agent, report });
          } catch (error) {
            console.error(chalk.red(`  Error running ${agent.name}: ${error instanceof Error ? error.message : error}`));
            results.push({ agent, report: null });
          }
        }

        // Output results
        if (options.output === 'json') {
          console.log(JSON.stringify(results.map(r => ({
            agent: { key: r.agent.key, name: r.agent.name },
            report: r.report,
          })), null, 2));
        } else {
          displayTableResults(results);
        }
      } catch (error: any) {
        console.error(chalk.red(`\n  Error: ${error.message}`));
        console.log(chalk.gray('  Is the server running? Start with: npm run dev:server\n'));
        process.exit(1);
      } finally {
        cleanup();
      }
    });

  return command;
}
