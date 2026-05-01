/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configure Command
 * Import infrastructure configuration from CloudFormation stacks or manual input.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync, spawnSync } from 'child_process';

const CONFIG_FILENAME = 'agent-health.config.json';

interface CFNOutput {
  OutputKey: string;
  OutputValue: string;
  Description?: string;
}

interface CFNStack {
  StackName: string;
  StackStatus: string;
  Outputs?: CFNOutput[];
}

/**
 * Read and parse the config JSON file, returning {} if it doesn't exist.
 */
function readConfig(): Record<string, unknown> {
  const filePath = join(process.cwd(), CONFIG_FILENAME);
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Config file must contain a JSON object: ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse ${filePath}: ${err.message}. Fix the JSON syntax or delete the file to start fresh.`);
    }
    throw err;
  }
}

/**
 * Write config back to disk, preserving sibling keys.
 */
function writeConfig(config: Record<string, unknown>): void {
  const filePath = join(process.cwd(), CONFIG_FILENAME);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Validate CLI option values to prevent shell injection */
function validateInput(value: string, label: string): void {
  if (/[;&|`$(){}[\]<>!#'"\\\n\r]/.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
}

/**
 * Fetch CloudFormation stack outputs using the AWS CLI.
 * Uses spawnSync with argument array to prevent shell injection.
 */
function getStackOutputs(stackName: string, region?: string, profile?: string): CFNOutput[] {
  validateInput(stackName, 'stack name');
  if (region) validateInput(region, 'region');
  if (profile) validateInput(profile, 'profile');

  const args = ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json'];
  if (region) args.push('--region', region);
  if (profile) args.push('--profile', profile);

  try {
    const result = spawnSync('aws', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      if (stderr.includes('Unable to locate credentials')) {
        throw new Error('AWS credentials not configured. Run `aws configure` or set AWS_PROFILE.');
      }
      throw new Error(stderr || `AWS CLI exited with code ${result.status}`);
    }

    const parsed = JSON.parse(result.stdout);
    const stacks: CFNStack[] = parsed.Stacks || [];

    if (stacks.length === 0) {
      throw new Error(`Stack '${stackName}' not found`);
    }

    const stack = stacks[0];
    if (!stack.Outputs || stack.Outputs.length === 0) {
      throw new Error(`Stack '${stackName}' has no outputs (status: ${stack.StackStatus})`);
    }

    return stack.Outputs;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('not found') || err.message.includes('credentials') || err.message.includes('Invalid'))) {
      throw err;
    }
    throw new Error(`Failed to describe stack '${stackName}': ${err instanceof Error ? err.message : err}`);
  }
}

export function createConfigureCommand(): Command {
  const cmd = new Command('configure')
    .description('Configure Agent Health from infrastructure outputs')
    .option('--from-stack <stackName>', 'Import observability config from a CloudFormation stack')
    .option('--region <region>', 'AWS region for the CloudFormation stack')
    .option('--profile <profile>', 'AWS CLI profile to use')
    .option('--dry-run', 'Show what would be written without making changes')
    .action(async (options) => {
      if (options.fromStack) {
        await configureFromStack(options.fromStack, options.region, options.profile, options.dryRun);
      } else {
        console.log(chalk.yellow('\n  No configuration source specified.\n'));
        console.log(chalk.gray('  Usage:'));
        console.log(chalk.gray('    agent-health configure --from-stack <stack-name>'));
        console.log(chalk.gray('    agent-health configure --from-stack AgentHealthObservability --region us-west-2'));
        console.log(chalk.gray('    agent-health configure --from-stack AgentHealthObservability --dry-run\n'));
      }
    });

  return cmd;
}

async function configureFromStack(stackName: string, region?: string, profile?: string, dryRun?: boolean): Promise<void> {
  console.log(chalk.cyan(`\n  Importing configuration from CloudFormation stack: ${chalk.bold(stackName)}\n`));

  // Check AWS CLI is available
  try {
    execSync('aws --version', { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    console.error(chalk.red('  AWS CLI is not installed. Install it from https://aws.amazon.com/cli/\n'));
    process.exit(1);
  }

  // Fetch stack outputs
  let outputs: CFNOutput[];
  try {
    outputs = getStackOutputs(stackName, region, profile);
  } catch (err) {
    console.error(chalk.red(`  ${err instanceof Error ? err.message : err}\n`));
    process.exit(1);
  }

  // Extract relevant outputs
  const outputMap = new Map(outputs.map(o => [o.OutputKey, o.OutputValue]));

  const endpoint = outputMap.get('OpenSearchEndpoint');
  const osisEndpoint = outputMap.get('OSISTraceIngestEndpoint') || outputMap.get('OSISIngestEndpoint');
  const stackRegion = outputMap.get('Region') || region;
  const ingestionRoleArn = outputMap.get('IngestionRoleArn');

  if (!endpoint) {
    console.error(chalk.red('  Stack does not have an OpenSearchEndpoint output.'));
    console.error(chalk.gray('  Available outputs: ' + outputs.map(o => o.OutputKey).join(', ') + '\n'));
    process.exit(1);
  }

  // Build observability config
  const observabilityConfig: Record<string, unknown> = {
    endpoint,
    authType: 'sigv4',
    awsRegion: stackRegion,
    awsService: 'es',
    tlsSkipVerify: false,
  };

  console.log(chalk.green('  Stack outputs found:'));
  console.log(chalk.gray(`    OpenSearch Endpoint:  ${endpoint}`));
  if (osisEndpoint) {
    console.log(chalk.gray(`    OSIS Ingest Endpoint: ${osisEndpoint}`));
  }
  if (stackRegion) {
    console.log(chalk.gray(`    Region:               ${stackRegion}`));
  }
  if (ingestionRoleArn) {
    console.log(chalk.gray(`    Ingestion Role:       ${ingestionRoleArn}`));
  }
  console.log();

  if (dryRun) {
    console.log(chalk.yellow('  Dry run — would write this to agent-health.config.json:\n'));
    console.log(chalk.gray(JSON.stringify({ observability: observabilityConfig }, null, 2)));
    console.log();
    return;
  }

  // Read existing config, merge, and write
  const config = readConfig();

  if (config.observability) {
    console.log(chalk.yellow('  Existing observability config found — overwriting.\n'));
  }

  config.observability = observabilityConfig;
  writeConfig(config);

  console.log(chalk.green(`  ✓ Observability config written to ${CONFIG_FILENAME}\n`));

  if (osisEndpoint) {
    console.log(chalk.cyan('  Next step: Configure your agent to send traces to:'));
    console.log(chalk.bold(`    OTEL_EXPORTER_OTLP_ENDPOINT=${osisEndpoint}\n`));
  }

  if (ingestionRoleArn) {
    console.log(chalk.gray(`  Your agents should assume this role for SigV4 auth:`));
    console.log(chalk.gray(`    ${ingestionRoleArn}\n`));
  }

  console.log(chalk.green('  Done! Start Agent Health with: npx @opensearch-project/agent-health\n'));
}
