/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Init Command
 * Generate starter configuration files
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const TYPESCRIPT_CONFIG = `/*
 * Agent Health Configuration
 * See docs/CONFIGURATION.md for full options
 */

import { defineConfig, AGUIStreamingConnector, ClaudeCodeConnector } from '@opensearch-project/agent-health';

export default defineConfig({
  agents: [
    // ML-Commons agent (AG-UI streaming)
    {
      name: 'ml-commons',
      key: 'ml-commons',
      connector: new AGUIStreamingConnector(),
      endpoint: process.env.MLCOMMONS_ENDPOINT || 'https://localhost:9200/_plugins/_ml/agents/YOUR_AGENT_ID/_execute',
      auth: {
        type: 'basic',
        username: process.env.OPENSEARCH_USER || 'admin',
        password: process.env.OPENSEARCH_PASS || 'admin',
      },
      models: ['claude-sonnet'],
    },

    // Claude Code CLI agent (optional)
    // Uncomment to enable Claude Code comparison
    /*
    {
      name: 'claude-code',
      key: 'claude-code',
      connector: new ClaudeCodeConnector({
        env: {
          AWS_PROFILE: process.env.AWS_PROFILE || 'Bedrock',
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_REGION: process.env.AWS_REGION || 'us-west-2',
        },
      }),
      endpoint: 'claude', // Command name
      models: ['claude-sonnet-4'],
    },
    */
  ],

  // Test cases can be inline or loaded from files
  testCases: './test-cases/*.yaml',

  // Output reporters
  reporters: [
    ['console'],
    ['json', { output: 'report.json' }],
  ],

  // Judge configuration
  judge: {
    provider: 'bedrock',
    model: 'claude-sonnet',
    region: process.env.AWS_REGION || 'us-west-2',
  },
});
`;

const ENV_TEMPLATE = `# Agent Health Environment Configuration
# Copy this to .env and fill in your values

# ============ AWS Configuration ============
# For Bedrock judge and Claude Code CLI
AWS_PROFILE=Bedrock
AWS_REGION=us-west-2
# Or use explicit credentials:
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_SESSION_TOKEN=

# ============ OpenSearch/ML-Commons ============
# Agent endpoint
MLCOMMONS_ENDPOINT=https://localhost:9200/_plugins/_ml/agents/YOUR_AGENT_ID/_execute

# Storage cluster (for test cases, benchmarks persistence)
OPENSEARCH_STORAGE_URL=https://localhost:9200
OPENSEARCH_STORAGE_USER=admin
OPENSEARCH_STORAGE_PASS=admin

# Optional: Headers for ML-Commons agent data source access
# MLCOMMONS_HEADER_OPENSEARCH_URL=
# MLCOMMONS_HEADER_AUTHORIZATION=

# ============ Server Configuration ============
# Backend port (default: 4001)
# BACKEND_PORT=4001
`;

const SAMPLE_TEST_CASE = `# Sample Test Case
# Place in test-cases/ directory

id: sample-rca-001
name: Sample RCA Test Case
version: 1

labels:
  - category:RCA
  - difficulty:Medium

initialPrompt: |
  A customer reports that their web application is experiencing
  slow response times. The issue started approximately 2 hours ago.
  Please investigate and identify the root cause.

context:
  - description: Application logs
    value: |
      2024-01-15 10:00:00 ERROR: Connection timeout to database
      2024-01-15 10:00:05 WARN: Retry attempt 1 for DB connection
      2024-01-15 10:00:10 ERROR: Connection timeout to database

expectedOutcomes:
  - The agent should identify database connectivity issues
  - The agent should check database server health
  - The agent should suggest investigating network connectivity
`;

/**
 * Create the init command
 */
export function createInitCommand(): Command {
  const command = new Command('init')
    .description('Initialize configuration files')
    .option('--force', 'Overwrite existing files')
    .option('--with-examples', 'Include example test case')
    .action(async (options: { force?: boolean; withExamples?: boolean }) => {
      console.log(chalk.bold('\n  Agent Health - Initialize Configuration\n'));

      const cwd = process.cwd();
      const files: Array<{ path: string; content: string; name: string }> = [];

      // Config file
      files.push({
        path: resolve(cwd, 'agent-health.config.ts'),
        content: TYPESCRIPT_CONFIG,
        name: 'agent-health.config.ts',
      });

      // Env template
      files.push({
        path: resolve(cwd, '.env.example'),
        content: ENV_TEMPLATE,
        name: '.env.example',
      });

      // Sample test case
      if (options.withExamples) {
        const { mkdirSync } = await import('fs');
        const testCasesDir = resolve(cwd, 'test-cases');
        if (!existsSync(testCasesDir)) {
          mkdirSync(testCasesDir, { recursive: true });
        }
        files.push({
          path: resolve(testCasesDir, 'sample-rca.yaml'),
          content: SAMPLE_TEST_CASE,
          name: 'test-cases/sample-rca.yaml',
        });
      }

      // Write files
      let created = 0;
      let skipped = 0;

      for (const file of files) {
        if (existsSync(file.path) && !options.force) {
          console.log(chalk.yellow(`  ⚠ Skipped: ${file.name} (already exists, use --force to overwrite)`));
          skipped++;
        } else {
          writeFileSync(file.path, file.content);
          console.log(chalk.green(`  ✓ Created: ${file.name}`));
          created++;
        }
      }

      console.log('');

      if (created > 0) {
        console.log(chalk.gray('  Next steps:'));
        console.log(chalk.gray('    1. Copy .env.example to .env and fill in your values'));
        console.log(chalk.gray('    2. Update the config file with your agent endpoint'));
        console.log(chalk.gray('    3. Run `agent-health doctor` to verify configuration'));
        console.log(chalk.gray('    4. Run `agent-health run -t sample-rca-001` to test\n'));
      }

      if (skipped > 0) {
        console.log(chalk.yellow(`  ${skipped} file(s) skipped. Use --force to overwrite.\n`));
      }
    });

  return command;
}
