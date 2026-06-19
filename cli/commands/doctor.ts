/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Doctor Command
 * Validate configuration, auth, and system requirements
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig, getConfigFileInfo, type ResolvedConfig } from '@/lib/config/index.js';
import { connectorRegistry } from '@/services/connectors/server.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: string[];
}

/**
 * Check if config file exists
 */
function checkConfigFile(): CheckResult {
  const configInfo = getConfigFileInfo();

  if (configInfo) {
    return {
      name: 'Config File',
      status: 'ok',
      message: `Found: ${configInfo.path.split('/').pop()}`,
      details: [`Format: ${configInfo.format}`],
    };
  }

  // No config file is fine - this is the expected case for most users
  return {
    name: 'Config File',
    status: 'ok',
    message: 'Using defaults + environment variables',
    details: [
      'Config file is optional (for custom agents)',
      'Run `agent-health init` to create one if needed',
    ],
  };
}

/**
 * Check environment file
 */
function checkEnvFile(): CheckResult {
  const envPath = resolve(process.cwd(), '.env');

  if (existsSync(envPath)) {
    return {
      name: 'Environment File',
      status: 'ok',
      message: 'Found: .env',
    };
  }

  // No .env file is fine - env vars can be set in shell or CI/CD
  return {
    name: 'Environment File',
    status: 'ok',
    message: 'Not using .env file',
    details: ['Env vars can be set in shell, CI/CD, or via --env-file'],
  };
}

/**
 * Check AWS credentials (validates they are not expired)
 */
async function checkAWSCredentials(): Promise<CheckResult> {
  const profile = process.env.AWS_PROFILE;
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

  const details: string[] = [];

  if (profile) {
    details.push(`AWS_PROFILE: ${profile}`);
  }
  if (accessKey) {
    details.push(`AWS_ACCESS_KEY_ID: ${accessKey.substring(0, 8)}...`);
  }
  if (region) {
    details.push(`AWS_REGION: ${region}`);
  }

  if (!profile && !accessKey) {
    return {
      name: 'AWS Credentials',
      status: 'warning',
      message: 'No AWS credentials detected',
      details: [
        'Set AWS_PROFILE or AWS_ACCESS_KEY_ID for Bedrock judge',
        'Claude Code connector also requires AWS credentials',
      ],
    };
  }

  // Validate credentials are not expired
  try {
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const provider = fromNodeProviderChain({
      ...(profile && { profile }),
    });
    const creds = await provider();
    if (creds.expiration && creds.expiration.getTime() < Date.now()) {
      return {
        name: 'AWS Credentials',
        status: 'error',
        message: 'AWS credentials are expired',
        details: [
          ...details,
          `Expired: ${creds.expiration.toISOString()}`,
          profile ? `Run: aws sso login --profile ${profile}` : 'Refresh your AWS credentials',
        ],
      };
    }
    return {
      name: 'AWS Credentials',
      status: 'ok',
      message: profile ? `Profile: ${profile} (validated)` : 'Using access key (validated)',
      details: details.length > 0 ? details : undefined,
    };
  } catch (err: any) {
    return {
      name: 'AWS Credentials',
      status: 'error',
      message: `AWS credentials invalid: ${err.message}`,
      details: [
        ...details,
        'Run: aws sts get-caller-identity to debug',
        profile ? `Run: aws sso login --profile ${profile}` : 'Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      ],
    };
  }
}

/**
 * Check Claude Code CLI
 */
async function checkClaudeCodeCLI(): Promise<CheckResult> {
  const { execSync } = await import('child_process');

  try {
    execSync('which claude', { stdio: 'pipe' });
    return {
      name: 'Claude Code CLI',
      status: 'ok',
      message: 'claude command available',
    };
  } catch {
    return {
      name: 'Claude Code CLI',
      status: 'warning',
      message: 'claude command not found',
      details: [
        'Install Claude Code: npm install -g @anthropic/claude-code',
        'Or skip if not using claude-code connector',
      ],
    };
  }
}

/**
 * Check agents configuration
 */
function checkAgents(config: ResolvedConfig): CheckResult {
  const agents = config.agents;
  const details: string[] = [];

  for (const agent of agents) {
    const connectorType = agent.connectorType || 'agui-streaming';
    const hasConnector = connectorRegistry.get(connectorType);
    const status = hasConnector ? '✓' : '✗';
    details.push(`${status} ${agent.name} (${connectorType})`);
  }

  return {
    name: 'Agents',
    status: 'ok',
    message: `${agents.length} agents configured`,
    details,
  };
}

/**
 * Check connectors
 */
function checkConnectors(): CheckResult {
  const types = connectorRegistry.getRegisteredTypes();

  return {
    name: 'Connectors',
    status: 'ok',
    message: `${types.length} connectors registered`,
    details: types.map(t => `✓ ${t}`),
  };
}

/**
 * Check OpenSearch storage
 */
function checkOpenSearchStorage(): CheckResult {
  const endpoint = process.env.OPENSEARCH_STORAGE_ENDPOINT;
  const user = process.env.OPENSEARCH_STORAGE_USERNAME;

  if (endpoint) {
    return {
      name: 'OpenSearch Storage',
      status: 'ok',
      message: `Configured: ${endpoint.substring(0, 50)}...`,
      details: user ? [`Username: ${user}`] : undefined,
    };
  }

  return {
    name: 'OpenSearch Storage',
    status: 'warning',
    message: 'Not configured (results won\'t persist)',
    details: [
      'Set OPENSEARCH_STORAGE_ENDPOINT, _USERNAME, _PASSWORD to save results',
      'Without storage, results are shown in terminal only',
    ],
  };
}

/**
 * Check OpenSearch observability (traces/logs)
 */
function checkOpenSearchObservability(): CheckResult {
  const endpoint = process.env.OPENSEARCH_LOGS_ENDPOINT;
  const user = process.env.OPENSEARCH_LOGS_USERNAME;

  if (endpoint) {
    return {
      name: 'OpenSearch Observability',
      status: 'ok',
      message: `Configured: ${endpoint.substring(0, 50)}...`,
      details: user ? [`Username: ${user}`] : undefined,
    };
  }

  return {
    name: 'OpenSearch Observability',
    status: 'ok',
    message: 'Not configured (optional)',
    details: [
      'Set OPENSEARCH_LOGS_ENDPOINT for agent traces',
      'Only needed for ML-Commons agent observability',
    ],
  };
}

/**
 * Check traces connectivity via the running server's health endpoint
 */
async function checkTracesConnectivity(): Promise<CheckResult> {
  const port = process.env.PORT || '4001';
  try {
    const response = await fetch(`http://localhost:${port}/api/traces/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json() as { status: string; backend?: string; error?: string; errorCategory?: string; suggestion?: string };

    if (data.status === 'ok') {
      return {
        name: 'Traces Connectivity',
        status: 'ok',
        message: data.backend === 'file'
          ? 'Local filesystem trace storage (agent-health-data/traces)'
          : 'OpenSearch traces index is accessible',
      };
    }

    if (data.status === 'sample_only') {
      return {
        name: 'Traces Connectivity',
        status: 'ok',
        message: 'Sample data only (no observability backend)',
      };
    }

    // Error with classification from the server
    const details: string[] = [];
    if (data.error) details.push(data.error);
    if (data.suggestion) details.push(data.suggestion);

    return {
      name: 'Traces Connectivity',
      status: 'error',
      message: data.errorCategory === 'auth'
        ? 'Authentication failed — credentials may be expired'
        : `Connection error: ${data.error || 'unknown'}`,
      details: details.length > 0 ? details : undefined,
    };
  } catch {
    return {
      name: 'Traces Connectivity',
      status: 'ok',
      message: 'Server not running (skipped)',
      details: ['Start the server first: npm run dev:server'],
    };
  }
}

/**
 * Display results
 */
function displayResults(results: CheckResult[]): void {
  console.log(chalk.bold('\n  Configuration Check\n'));

  for (const result of results) {
    const icon = {
      ok: chalk.green('✓'),
      warning: chalk.yellow('⚠'),
      error: chalk.red('✗'),
    }[result.status];

    const messageColor = {
      ok: chalk.green,
      warning: chalk.yellow,
      error: chalk.red,
    }[result.status];

    console.log(`  ${icon} ${chalk.bold(result.name)}: ${messageColor(result.message)}`);

    if (result.details) {
      for (const detail of result.details) {
        console.log(chalk.gray(`      ${detail}`));
      }
    }
  }

  console.log('');

  const errors = results.filter(r => r.status === 'error').length;
  const warnings = results.filter(r => r.status === 'warning').length;

  if (errors > 0) {
    console.log(chalk.red(`  ${errors} error(s) found. Fix these before running evaluations.\n`));
  } else if (warnings > 0) {
    console.log(chalk.yellow(`  ${warnings} warning(s). Some features may be limited.\n`));
  } else {
    console.log(chalk.green('  All checks passed!\n'));
  }
}

/**
 * Create the doctor command
 */
export function createDoctorCommand(): Command {
  const command = new Command('doctor')
    .description('Check configuration and system requirements')
    .option('-o, --output <format>', 'Output format: text, json', 'text')
    .action(async (options: { output: string }) => {
      const results: CheckResult[] = [];

      // Load config (registers custom connectors)
      const config = await loadConfig();

      // Register custom connectors from config
      for (const connector of config.connectors) {
        connectorRegistry.register(connector);
      }

      results.push(checkConfigFile());
      results.push(checkEnvFile());
      results.push(await checkAWSCredentials());
      results.push(await checkClaudeCodeCLI());
      results.push(checkAgents(config));
      results.push(checkConnectors());
      results.push(checkOpenSearchStorage());
      results.push(checkOpenSearchObservability());
      results.push(await checkTracesConnectivity());

      if (options.output === 'json') {
        console.log(JSON.stringify(results, null, 2));
      } else {
        displayResults(results);
      }
    });

  return command;
}
