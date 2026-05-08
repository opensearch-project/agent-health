/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Setup Telemetry Command
 * Configure Claude Code to send OpenTelemetry data to Agent Health's OpenSearch cluster
 * via the API Gateway proxy deployed by the Agent Health Observability CFN stack.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the bundled CFN template path (works from both source and dist) */
function getCfnTemplatePath(): string {
  // From cli/commands/ → ../../deployment/cloudformation/
  // From cli/dist/    → ../../deployment/cloudformation/
  const candidates = [
    join(__dirname, '..', '..', 'deployment', 'cloudformation', 'agent-health-observability.yaml'),
    join(__dirname, '..', 'deployment', 'cloudformation', 'agent-health-observability.yaml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]; // Return first for error messaging
}

/** Env vars we manage — used for detection and writing */
const TELEMETRY_ENV_VARS: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  // OTEL_EXPORTER_OTLP_ENDPOINT is set dynamically from the stack
};

/** Marker comment we add to rc files so we can detect our own block */
const RC_BLOCK_START = '# --- Agent Health: Claude Code Telemetry ---';
const RC_BLOCK_END = '# --- End Agent Health Telemetry ---';

/** Validate CLI option values to prevent shell injection */
function validateInput(value: string, label: string): void {
  if (/[;&|`$(){}[\]<>!#'"\\\n\r]/.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
}

/**
 * Detect the user's shell rc file
 */
function detectRcFile(): { shell: string; rcPath: string } {
  const shellEnv = process.env.SHELL || '';
  const home = homedir();

  if (shellEnv.includes('zsh')) {
    return { shell: 'zsh', rcPath: join(home, '.zshrc') };
  }
  if (shellEnv.includes('fish')) {
    return { shell: 'fish', rcPath: join(home, '.config', 'fish', 'config.fish') };
  }
  // Default to bash
  const bashrc = join(home, '.bashrc');
  const profile = join(home, '.bash_profile');
  // Prefer .bashrc if it exists, otherwise .bash_profile
  return { shell: 'bash', rcPath: existsSync(bashrc) ? bashrc : profile };
}

/**
 * Check if the rc file already has our telemetry block
 */
function rcFileHasTelemetryBlock(rcPath: string): boolean {
  if (!existsSync(rcPath)) return false;
  const content = readFileSync(rcPath, 'utf-8');
  return content.includes(RC_BLOCK_START);
}

/** Stack outputs we care about */
interface StackOutputs {
  otlpEndpoint: string;
  opensearchEndpoint?: string;
  region?: string;
}

/**
 * Fetch key outputs from the CloudFormation stack
 */
function getStackOutputs(stackName: string, region?: string, profile?: string): StackOutputs {
  validateInput(stackName, 'stack name');
  if (region) validateInput(region, 'region');
  if (profile) validateInput(profile, 'profile');

  const args = ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json'];
  if (region) args.push('--region', region);
  if (profile) args.push('--profile', profile);

  const result = spawnSync('aws', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (stderr.includes('Unable to locate credentials')) {
      throw new Error('AWS credentials not configured. Run `aws configure` or set AWS_PROFILE.');
    }
    if (stderr.includes('does not exist')) {
      const templatePath = getCfnTemplatePath();
      throw new Error(`Stack '${stackName}' not found. Deploy it first:\n    npx @goyamegh/agent-health setup-telemetry --deploy\n  Or manually:\n    aws cloudformation deploy --template-file ${templatePath} --stack-name ${stackName} --capabilities CAPABILITY_NAMED_IAM`);
    }
    throw new Error(stderr || `AWS CLI exited with code ${result.status}`);
  }

  const parsed = JSON.parse(result.stdout);
  const stacks = parsed.Stacks || [];
  if (stacks.length === 0) {
    throw new Error(`Stack '${stackName}' not found`);
  }

  const outputs: Array<{ OutputKey: string; OutputValue: string }> = stacks[0].Outputs || [];
  const outputMap = new Map(outputs.map(o => [o.OutputKey, o.OutputValue]));

  // Try both output key names — newer stacks use OTLPProxyApiEndpoint,
  // existing stacks use OTLPIngestEndpoint for the same API Gateway URL
  const otlpEndpoint = outputMap.get('OTLPProxyApiEndpoint') || outputMap.get('OTLPIngestEndpoint');
  if (!otlpEndpoint) {
    const available = outputs.map(o => o.OutputKey).join(', ');
    throw new Error(`Stack '${stackName}' has no OTLP endpoint output.\n    Available outputs: ${available}\n    Make sure the stack includes the API Gateway OTLP proxy.`);
  }

  // OpenSearch domain endpoint for server-side reading
  const opensearchEndpoint = outputMap.get('OpenSearchEndpoint') || outputMap.get('DomainEndpoint');
  const stackRegion = outputMap.get('Region') || region;

  return { otlpEndpoint, opensearchEndpoint, region: stackRegion };
}

const CONFIG_FILENAME = 'agent-health.config.json';

/**
 * Write the server-side observability config so Agent Health can read traces from OpenSearch.
 * Writes to CWD (where the server reads from) and also to ~ as a fallback.
 */
function writeServerConfig(opensearchEndpoint: string, region: string): string[] {
  const fullEndpoint = opensearchEndpoint.startsWith('https://') ? opensearchEndpoint : `https://${opensearchEndpoint}`;
  const observability = {
    endpoint: fullEndpoint,
    authType: 'sigv4',
    awsRegion: region,
    awsService: 'es',
  };

  const paths = [
    join(process.cwd(), CONFIG_FILENAME),
    join(homedir(), CONFIG_FILENAME),
  ];

  // Deduplicate if cwd === home
  const uniquePaths = [...new Set(paths)];
  const written: string[] = [];

  for (const configPath of uniquePaths) {
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch { /* start fresh */ }
    }
    config.observability = observability;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    written.push(configPath);
  }

  return written;
}

/**
 * Check if Claude Code CLI is installed
 */
function isClaudeInstalled(): boolean {
  const result = spawnSync('which', ['claude'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return result.status === 0;
}

/**
 * Check if AWS CLI is installed
 */
function isAwsCliInstalled(): boolean {
  const result = spawnSync('aws', ['--version'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return result.status === 0;
}

/**
 * Test connectivity to the OTLP endpoint
 */
async function testEndpoint(endpoint: string): Promise<{ ok: boolean; message: string }> {
  try {
    // Send a minimal OTLP traces request — the Lambda will accept it
    // even with empty data; we just want to confirm the endpoint is reachable
    const url = endpoint.replace(/\/+$/, '') + '/v1/traces';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: new Uint8Array(0),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // API Gateway returns 200 on success, 403 if auth required, etc.
    // Any HTTP response means the endpoint is reachable
    if (res.ok || res.status === 400) {
      return { ok: true, message: `Endpoint reachable (HTTP ${res.status})` };
    }
    if (res.status === 403) {
      return { ok: true, message: 'Endpoint reachable (HTTP 403 — IAM auth required, which is expected)' };
    }
    return { ok: false, message: `Endpoint returned HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { ok: false, message: 'Endpoint timed out after 10s' };
    }
    return { ok: false, message: `Connection failed: ${msg}` };
  }
}

/**
 * Build the env block to append to the rc file
 */
function buildRcBlock(endpoint: string): string {
  const lines = [
    RC_BLOCK_START,
    `export CLAUDE_CODE_ENABLE_TELEMETRY=1`,
    `export OTEL_METRICS_EXPORTER=otlp`,
    `export OTEL_LOGS_EXPORTER=otlp`,
    `export OTEL_TRACES_EXPORTER=otlp`,
    `export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`,
    `export OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    '',
    `# cc-otel: Launch Claude Code with telemetry enabled`,
    `alias cc-otel="export AWS_PROFILE=Bedrock && export CLAUDE_CODE_USE_BEDROCK=1 && export DISABLE_PROMPT_CACHING=1 && export DISABLE_ERROR_REPORTING=1 && export DISABLE_TELEMETRY=0 && export AWS_REGION=us-east-1 && export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 && export CLAUDE_CODE_ENABLE_TELEMETRY=1 && export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 && export OTEL_METRICS_EXPORTER=otlp && export OTEL_LOGS_EXPORTER=otlp && export OTEL_TRACES_EXPORTER=otlp && export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf && export OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} && claude"`,
    RC_BLOCK_END,
  ];
  return '\n' + lines.join('\n') + '\n';
}

/**
 * Create the setup-telemetry command
 */
export function createSetupTelemetryCommand(): Command {
  const command = new Command('setup-telemetry')
    .description('Configure Claude Code to send telemetry to Agent Health')
    .option('--stack <name>', 'CloudFormation stack name', 'AgentHealthObservability')
    .option('--region <region>', 'AWS region for the CloudFormation stack')
    .option('--profile <profile>', 'AWS CLI profile to use')
    .option('--endpoint <url>', 'OTLP endpoint URL (skip stack lookup)')
    .option('--dry-run', 'Show what would be written without making changes')
    .option('--skip-rc', 'Print env vars without writing to shell rc file')
    .option('--status', 'Check current telemetry configuration status')
    .option('--deploy', 'Deploy the CloudFormation stack before configuring telemetry')
    .option('--force', 'Replace existing telemetry block in shell rc file')
    .action(async (options: {
      stack: string;
      region?: string;
      profile?: string;
      endpoint?: string;
      dryRun?: boolean;
      skipRc?: boolean;
      status?: boolean;
      deploy?: boolean;
      force?: boolean;
    }) => {
      console.log(chalk.cyan.bold('\n  Agent Health — Claude Code Telemetry Setup\n'));

      // --status: just show current state
      if (options.status) {
        await showStatus();
        return;
      }

      // Step 1: Prerequisites
      console.log(chalk.bold('  Checking prerequisites...\n'));

      if (!isClaudeInstalled()) {
        console.log(chalk.yellow('  ⚠ Claude Code CLI not found'));
        console.log(chalk.gray('    Install: npm install -g @anthropic-ai/claude-code\n'));
      } else {
        console.log(chalk.green('  ✓ Claude Code CLI installed'));
      }

      // Step 2: Deploy the stack if requested
      if (options.deploy && !options.endpoint) {
        if (!isAwsCliInstalled()) {
          console.error(chalk.red('  ✗ AWS CLI not found. Install it first or use --endpoint <url>.\n'));
          process.exit(1);
        }
        console.log(chalk.green('  ✓ AWS CLI installed'));

        const templatePath = getCfnTemplatePath();
        if (!existsSync(templatePath)) {
          console.error(chalk.red(`\n  ✗ CFN template not found at ${templatePath}`));
          console.error(chalk.gray('    This can happen if running from source. Try: npx @goyamegh/agent-health setup-telemetry --deploy\n'));
          process.exit(1);
        }

        console.log(chalk.gray(`\n  Deploying stack ${chalk.bold(options.stack)}...`));
        console.log(chalk.gray(`  Template: ${templatePath}`));
        console.log(chalk.gray('  This may take 10-15 minutes on first deploy.\n'));

        const deployArgs = [
          'cloudformation', 'deploy',
          '--template-file', templatePath,
          '--stack-name', options.stack,
          '--capabilities', 'CAPABILITY_NAMED_IAM',
          '--no-fail-on-empty-changeset',
        ];
        if (options.region) deployArgs.push('--region', options.region);
        if (options.profile) deployArgs.push('--profile', options.profile);

        const deployResult = spawnSync('aws', deployArgs, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 20 * 60 * 1000, // 20 min timeout for CFN deploy
        });

        if (deployResult.status !== 0) {
          const stderr = (deployResult.stderr || '').trim();
          console.error(chalk.red(`\n  ✗ Stack deployment failed:\n    ${stderr}\n`));
          process.exit(1);
        }

        console.log(chalk.green(`  ✓ Stack ${options.stack} deployed successfully`));
      }

      // Step 3: Get the OTLP endpoint
      let endpoint: string;

      let stackOutputs: StackOutputs | null = null;

      if (options.endpoint) {
        endpoint = options.endpoint;
        console.log(chalk.green(`  ✓ Using provided endpoint: ${endpoint}`));
      } else {
        if (!isAwsCliInstalled()) {
          console.error(chalk.red('  ✗ AWS CLI not found. Install it or use --endpoint <url> to skip stack lookup.\n'));
          process.exit(1);
        }
        if (!options.deploy) console.log(chalk.green('  ✓ AWS CLI installed'));

        console.log(chalk.gray(`\n  Reading stack outputs from ${chalk.bold(options.stack)}...`));
        try {
          stackOutputs = getStackOutputs(options.stack, options.region, options.profile);
          endpoint = stackOutputs.otlpEndpoint;
          console.log(chalk.green(`  ✓ OTLP endpoint: ${endpoint}`));
          if (stackOutputs.opensearchEndpoint) {
            console.log(chalk.green(`  ✓ OpenSearch endpoint: ${stackOutputs.opensearchEndpoint}`));
          }
        } catch (err) {
          console.error(chalk.red(`\n  ✗ ${err instanceof Error ? err.message : err}\n`));
          process.exit(1);
        }
      }

      validateInput(endpoint, 'endpoint');

      // Step: Test OTLP connectivity
      console.log(chalk.gray('\n  Testing OTLP endpoint connectivity...'));
      const connectivity = await testEndpoint(endpoint);
      if (connectivity.ok) {
        console.log(chalk.green(`  ✓ ${connectivity.message}`));
      } else {
        console.log(chalk.yellow(`  ⚠ ${connectivity.message}`));
        console.log(chalk.gray('    Telemetry may not work until the endpoint is reachable.'));
      }

      // Step: Write server-side config (so Agent Health can read traces from OpenSearch)
      if (stackOutputs?.opensearchEndpoint) {
        const effectiveRegion = stackOutputs.region || options.region;
        if (effectiveRegion) {
          if (options.dryRun) {
            console.log(chalk.yellow('\n  Dry run — would write server config:'));
            console.log(chalk.gray(`    OpenSearch endpoint: ${stackOutputs.opensearchEndpoint}`));
            console.log(chalk.gray(`    Auth: SigV4, Region: ${effectiveRegion}\n`));
          } else {
            const configPaths = writeServerConfig(stackOutputs.opensearchEndpoint, effectiveRegion);
            for (const p of configPaths) {
              console.log(chalk.green(`  ✓ Server config written to ${p}`));
            }
            console.log(chalk.gray(`    Agent Health server will read traces from this OpenSearch domain.`));
          }
        } else {
          console.log(chalk.yellow('\n  ⚠ Could not determine region for server config. Set --region explicitly.'));
        }
      }

      // Step: Write to shell rc file
      const { shell, rcPath } = detectRcFile();
      console.log(chalk.gray(`\n  Detected shell: ${shell} → ${rcPath}`));

      if (options.dryRun) {
        console.log(chalk.yellow('\n  Dry run — would append to ' + rcPath + ':\n'));
        console.log(chalk.gray(buildRcBlock(endpoint)));
        console.log(chalk.yellow('  No changes made.\n'));
        return;
      }

      if (options.skipRc) {
        console.log(chalk.yellow('\n  Add these to your shell profile:\n'));
        console.log(chalk.gray(buildRcBlock(endpoint)));
        return;
      }

      if (rcFileHasTelemetryBlock(rcPath)) {
        if (options.force) {
          // Remove existing block and replace with new one
          const content = readFileSync(rcPath, 'utf-8');
          const regex = new RegExp(`${RC_BLOCK_START}[\\s\\S]*?${RC_BLOCK_END}\\n?`, 'g');
          const cleaned = content.replace(regex, '');
          writeFileSync(rcPath, cleaned + buildRcBlock(endpoint), 'utf-8');
          console.log(chalk.green(`\n  ✓ Telemetry env vars updated in ${rcPath}`));
        } else {
          console.log(chalk.yellow(`\n  ⚠ Telemetry block already exists in ${rcPath}`));
          console.log(chalk.gray(`    Use --force to replace it, or manually remove the block between "${RC_BLOCK_START}" and "${RC_BLOCK_END}".\n`));
        }
      } else {
        appendFileSync(rcPath, buildRcBlock(endpoint));
        console.log(chalk.green(`\n  ✓ Telemetry env vars written to ${rcPath}`));
      }

      // Step 5: Next steps
      console.log(chalk.cyan.bold('\n  Next steps:\n'));
      console.log(chalk.gray(`    1. Reload your shell:  ${chalk.white(`source ${rcPath}`)}`));
      console.log(chalk.gray(`    2. Start Claude Code:  ${chalk.white('cc-otel')} (launches Claude with telemetry)`));
      console.log(chalk.gray(`    3. View traces:        ${chalk.white('http://localhost:4001/coding-agents')}`));
      console.log(chalk.gray(`\n    The ${chalk.white('cc-otel')} alias combines Bedrock auth + OTel telemetry + Claude launch.\n`));
    });

  return command;
}

/**
 * Show current telemetry configuration status
 */
async function showStatus(): Promise<void> {
  console.log(chalk.bold('  Current Telemetry Status\n'));

  // Check env vars
  const checks: Array<{ name: string; envVar: string; expected?: string }> = [
    { name: 'Telemetry enabled', envVar: 'CLAUDE_CODE_ENABLE_TELEMETRY', expected: '1' },
    { name: 'Traces exporter', envVar: 'OTEL_TRACES_EXPORTER', expected: 'otlp' },
    { name: 'Logs exporter', envVar: 'OTEL_LOGS_EXPORTER', expected: 'otlp' },
    { name: 'Metrics exporter', envVar: 'OTEL_METRICS_EXPORTER', expected: 'otlp' },
    { name: 'OTLP protocol', envVar: 'OTEL_EXPORTER_OTLP_PROTOCOL' },
    { name: 'OTLP endpoint', envVar: 'OTEL_EXPORTER_OTLP_ENDPOINT' },
  ];

  let allOk = true;

  for (const check of checks) {
    const value = process.env[check.envVar];
    if (!value) {
      console.log(chalk.yellow(`  ⚠ ${check.name}: ${chalk.gray('not set')} (${check.envVar})`));
      allOk = false;
    } else if (check.expected && value !== check.expected) {
      console.log(chalk.yellow(`  ⚠ ${check.name}: ${value} (expected ${check.expected})`));
      allOk = false;
    } else {
      console.log(chalk.green(`  ✓ ${check.name}: ${value}`));
    }
  }

  // Check Claude Code
  console.log('');
  if (isClaudeInstalled()) {
    console.log(chalk.green('  ✓ Claude Code CLI installed'));
  } else {
    console.log(chalk.yellow('  ⚠ Claude Code CLI not found'));
    allOk = false;
  }

  // Check rc file
  const { rcPath } = detectRcFile();
  if (rcFileHasTelemetryBlock(rcPath)) {
    console.log(chalk.green(`  ✓ Telemetry block in ${rcPath}`));
  } else {
    console.log(chalk.yellow(`  ⚠ No telemetry block in ${rcPath}`));
    allOk = false;
  }

  // Test endpoint if configured
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    console.log(chalk.gray('\n  Testing endpoint...'));
    const result = await testEndpoint(endpoint);
    if (result.ok) {
      console.log(chalk.green(`  ✓ ${result.message}`));
    } else {
      console.log(chalk.yellow(`  ⚠ ${result.message}`));
      allOk = false;
    }
  }

  console.log('');
  if (allOk) {
    console.log(chalk.green('  All checks passed! Telemetry is configured.\n'));
  } else {
    console.log(chalk.yellow('  Some checks failed. Run `agent-health setup-telemetry` to fix.\n'));
  }
}
