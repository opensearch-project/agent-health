#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Health CLI
 * Main entry point for the NPX command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { config as loadDotenv } from 'dotenv';
import open from 'open';
import ora from 'ora';
import { startServer } from './utils/startServer.js';
import {
  createListCommand,
  createRunCommand,
  createBenchmarkCommand,
  createExportCommand,
  createReportCommand,
  createDoctorCommand,
  createInitCommand,
  createMigrateCommand,
  createCompareServicesCommand,
  createRemoteCommand,
} from './commands/index.js';

// Get package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// From cli/dist/ go up two levels to package root
const packageJsonPath = join(__dirname, '..', '..', 'package.json');

let version = '0.1.0';
try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  version = packageJson.version;
} catch {
  // Use default version if package.json not found
}

/**
 * Load environment variables from a file
 * Supports .env format (dotenv compatible)
 */
function loadEnvFile(envPath: string): void {
  const absolutePath = resolve(process.cwd(), envPath);

  if (!existsSync(absolutePath)) {
    console.error(chalk.red(`\n  Error: Environment file not found: ${absolutePath}\n`));
    process.exit(1);
  }

  const result = loadDotenv({ path: absolutePath });

  if (result.error) {
    console.error(chalk.red(`\n  Error loading environment file: ${result.error.message}\n`));
    process.exit(1);
  }

  console.log(chalk.gray(`  Loaded environment from: ${envPath}`));
}

// Auto-load .env file BEFORE parsing commands (so all subcommands get env vars)
const defaultEnvPath = resolve(process.cwd(), '.env');
if (existsSync(defaultEnvPath)) {
  loadDotenv({ path: defaultEnvPath });
}

// Create the CLI program
const program = new Command();

program
  .name('agent-health')
  .description('Agent Health Evaluation Framework - Evaluate and monitor AI agent performance')
  .version(version)
  // Enable subcommands to handle their own options (prevents parent options from shadowing)
  .enablePositionalOptions()
  .passThroughOptions();

// CLI options for default action (when no subcommand is specified)
program
  .option('-p, --port <number>', 'Server port', '4001')
  .option('-e, --env-file <path>', 'Load environment variables from file (e.g., .env)')
  .option('--no-browser', 'Do not open browser automatically')
  .option('--headless', 'Run API server only (no frontend, no browser)')
  .option('--api-key <key>', 'Require API key for coding-agents endpoints');

program.action(async (options) => {
  console.log(chalk.cyan.bold(`\n  Agent Health v${version} - AI Agent Evaluation Framework\n`));

  // Show directory paths for debugging
  console.log(chalk.gray(`  Working directory: ${process.cwd()}`));
  console.log(chalk.gray(`  Package directory: ${__dirname}`));

  // Load explicit env file if specified (override auto-loaded)
  if (options.envFile) {
    loadEnvFile(options.envFile);
  } else if (existsSync(defaultEnvPath)) {
    console.log(chalk.gray('  Auto-loaded .env from current directory'));
  }

  const port = parseInt(options.port, 10);
  const headless = options.headless || false;
  const spinner = ora(headless ? 'Starting headless API server...' : 'Starting server...').start();

  try {
    // Start the server
    await startServer({ port, headless, apiKey: options.apiKey });
    spinner.succeed(headless ? 'Headless API server started' : 'Server started');

    if (headless) {
      console.log(chalk.green(`\n  API server running on http://0.0.0.0:${port}`));
      if (options.apiKey) console.log(chalk.gray('  API key authentication enabled'));
      console.log(chalk.gray('  Mode: headless (API only, no frontend)\n'));
    } else {
      console.log(chalk.gray('\n  Configuration:'));
      console.log(chalk.gray(`    Storage: Sample data (configure OpenSearch for persistence)`));
      console.log(chalk.gray(`    Agent: Select in UI (Demo Agent for mock, real agents require endpoints)`));
      console.log(chalk.gray(`    Judge: Select in UI (Demo Judge for mock, Bedrock requires AWS creds)\n`));

      const url = `http://localhost:${port}`;
      console.log(chalk.green(`  Server running at ${chalk.bold(url)}\n`));
      console.log(chalk.green(`  Demo data loaded`));

      if (options.browser !== false) {
        console.log(chalk.gray('  Opening browser...'));
        await open(url);
      }
    }

    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

  } catch (error) {
    spinner.fail('Failed to start server');
    console.error(chalk.red(`\n  Error: ${error instanceof Error ? error.message : error}\n`));
    process.exit(1);
  }
});

// Register subcommands
program.addCommand(createListCommand());
program.addCommand(createRunCommand());
program.addCommand(createBenchmarkCommand());
program.addCommand(createExportCommand());
program.addCommand(createReportCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createInitCommand());
program.addCommand(createMigrateCommand());
program.addCommand(createCompareServicesCommand());
program.addCommand(createRemoteCommand());

// Add serve command as an alias for the default action
program
  .command('serve')
  .description('Start the Agent Health server (same as default action)')
  .option('-p, --port <number>', 'Server port', '4001')
  .option('--no-browser', 'Do not open browser automatically')
  .option('--headless', 'Run API server only (no frontend, no browser)')
  .option('--api-key <key>', 'Require API key for coding-agents endpoints')
  .action(async (options) => {
    console.log(chalk.cyan.bold(`\n  Agent Health v${version} - AI Agent Evaluation Framework\n`));

    const port = parseInt(options.port, 10);
    const headless = options.headless || false;
    const spinner = ora(headless ? 'Starting headless API server...' : 'Starting server...').start();

    try {
      await startServer({ port, headless, apiKey: options.apiKey });
      spinner.succeed(headless ? 'Headless API server started' : 'Server started');

      const url = `http://localhost:${port}`;
      if (headless) {
        console.log(chalk.green(`  API server running on http://0.0.0.0:${port}`));
        if (options.apiKey) console.log(chalk.gray('  API key authentication enabled'));
        console.log(chalk.gray('  Mode: headless (API only, no frontend)\n'));
      } else {
        console.log(chalk.green(`  Server running at ${chalk.bold(url)}\n`));

        if (options.browser !== false) {
          console.log(chalk.gray('  Opening browser...'));
          await open(url);
        }
      }

      console.log(chalk.gray('  Press Ctrl+C to stop\n'));
    } catch (error) {
      spinner.fail('Failed to start server');
      console.error(chalk.red(`\n  Error: ${error instanceof Error ? error.message : error}\n`));
      process.exit(1);
    }
  });

// Handle unknown commands
program.on('command:*', (operands) => {
  const unknownCommand = operands[0];
  const availableCommands = program.commands.map(cmd => cmd.name());
  console.error(chalk.red(`\n  Error: Unknown command '${unknownCommand}'`));
  console.log('');
  console.log(chalk.cyan('  Available commands:'));
  for (const cmd of availableCommands) {
    console.log(chalk.gray(`    - ${cmd}`));
  }
  console.log('');
  console.log(chalk.gray(`  Run ${chalk.cyan('agent-health --help')} for usage information.\n`));
  process.exitCode = 1;
});

// Parse command line arguments
program.parse();
