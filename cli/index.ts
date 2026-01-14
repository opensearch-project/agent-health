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

// Get package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', 'package.json');

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

// Create the CLI program
const program = new Command();

program
  .name('agent-health')
  .description('Agent Health Evaluation Framework - Evaluate and monitor AI agent performance')
  .version(version);

// CLI options
program
  .option('-p, --port <number>', 'Server port', '4001')
  .option('-e, --env-file <path>', 'Load environment variables from file (e.g., .env)')
  .option('--no-browser', 'Do not open browser automatically');

program.action(async (options) => {
  console.log(chalk.cyan.bold(`\n  Agent Health v${version} - AI Agent Evaluation Framework\n`));

  // Load environment file if specified
  if (options.envFile) {
    loadEnvFile(options.envFile);
  } else {
    // Auto-detect .env file in current directory
    const defaultEnvPath = resolve(process.cwd(), '.env');
    if (existsSync(defaultEnvPath)) {
      loadDotenv({ path: defaultEnvPath });
      console.log(chalk.gray('  Auto-loaded .env from current directory'));
    }
  }

  const port = parseInt(options.port, 10);
  const spinner = ora('Starting server...').start();

  try {
    // Start the server
    await startServer({ port });
    spinner.succeed('Server started');

    console.log(chalk.gray('\n  Configuration:'));
    console.log(chalk.gray(`    Storage: Sample data (configure OpenSearch for persistence)`));
    console.log(chalk.gray(`    Agent: Select in UI (Demo Agent for mock, real agents require endpoints)`));
    console.log(chalk.gray(`    Judge: Select in UI (Demo Judge for mock, Bedrock requires AWS creds)\n`));

    const url = `http://localhost:${port}`;
    console.log(chalk.green(`  Server running at ${chalk.bold(url)}\n`));

    if (options.browser !== false) {
      console.log(chalk.gray('  Opening browser...'));
      await open(url);
    }

    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

  } catch (error) {
    spinner.fail('Failed to start server');
    console.error(chalk.red(`\n  Error: ${error instanceof Error ? error.message : error}\n`));
    process.exit(1);
  }
});

// Parse command line arguments
program.parse();
