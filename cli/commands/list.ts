/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * List Command
 * Lists agents, test cases, benchmarks, connectors, and models
 *
 * Architecture: CLI → Server HTTP API
 * This command uses the server API for test cases and benchmarks to follow
 * the server-mediated architecture pattern. Agents, models, and connectors
 * are loaded from config (through server for agents/models, locally for connectors).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig, type ResolvedConfig } from '@/lib/config/index.js';
import { connectorRegistry } from '@/services/connectors/server.js';
import { ensureServer, createServerCleanup, type EnsureServerResult } from '@/cli/utils/serverLifecycle.js';
import { ApiClient, type ListResponseWithMeta } from '@/cli/utils/apiClient.js';
import type { StorageMetadata, TestCase, Benchmark } from '@/types/index.js';
import { formatJson, formatMarkdownTable, parseOutputFormat, OUTPUT_FORMAT_DESCRIPTION, type OutputFormat } from '@/cli/utils/formatOutput.js';

/**
 * Display storage status warnings based on metadata
 */
function displayStorageWarnings(meta: StorageMetadata): void {
  if (!meta.storageConfigured) {
    console.log(chalk.yellow('\n  ⚠ Storage not configured'));
    console.log(chalk.gray('    Showing sample data only. Set OPENSEARCH_STORAGE_* env vars for persistent storage.\n'));
  } else if (!meta.storageReachable) {
    console.log(chalk.yellow('\n  ⚠ Storage unreachable'));
    meta.warnings?.forEach(w => console.log(chalk.gray(`    - ${w}`)));
    console.log();
  }
}

/**
 * List all available agents via server API
 */
async function listAgents(format: OutputFormat, config: ResolvedConfig): Promise<void> {
  const serverResult = await ensureServer(config.server);
  const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

  try {
    const client = new ApiClient(serverResult.baseUrl);
    const agents = await client.listAgents();

    if (format === 'json') {
      console.log(formatJson(agents));
      return;
    }

    const headers = ['Key', 'Name', 'Connector', 'Endpoint'];
    const rows = agents.map(agent => [
      agent.key,
      agent.name,
      agent.connectorType || 'agui-streaming',
      agent.endpoint.substring(0, 47) + (agent.endpoint.length > 47 ? '...' : ''),
    ]);

    if (format === 'markdown') {
      console.log(formatMarkdownTable(headers, rows));
      return;
    }

    const table = new Table({
      head: headers.map(h => chalk.cyan(h)),
      colWidths: [15, 20, 15, 50],
      wordWrap: true,
    });
    for (const row of rows) {
      table.push(row);
    }

    console.log(chalk.bold('\nAvailable Agents:\n'));
    console.log(table.toString());
    console.log(chalk.gray(`\n  Total: ${agents.length} agents\n`));
  } catch (error: any) {
    console.error(chalk.red(`\n  Error: ${error.message}`));
    console.log(chalk.gray('  Is the server running? Start with: npm run dev:server\n'));
    process.exit(1);
  } finally {
    cleanup();
  }
}

/**
 * List all available test cases via server API
 */
async function listTestCases(format: OutputFormat, config: ResolvedConfig): Promise<void> {
  const serverResult = await ensureServer(config.server);
  const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

  try {
    const client = new ApiClient(serverResult.baseUrl);
    const response = await client.listTestCasesWithMeta();

    if (format !== 'markdown') {
      displayStorageWarnings(response.meta);
    }

    if (format === 'json') {
      console.log(formatJson(response));
      return;
    }

    const headers = ['ID', 'Name', 'Labels', 'Version', 'Source'];
    const rows = response.data.map(tc => {
      const isDemo = tc.id.startsWith('demo-');
      return [
        tc.id,
        tc.name,
        tc.labels?.slice(0, 3).join(', ') || '',
        `v${tc.currentVersion || 1}`,
        isDemo ? 'Sample' : 'Stored',
      ];
    });

    if (format === 'markdown') {
      console.log(formatMarkdownTable(headers, rows));
      return;
    }

    const table = new Table({
      head: headers.map(h => chalk.cyan(h)),
      colWidths: [25, 28, 28, 10, 10],
      wordWrap: true,
    });
    for (const row of rows) {
      table.push(row);
    }

    console.log(chalk.bold('\nAvailable Test Cases:\n'));
    console.log(table.toString());

    const { meta } = response;
    if (meta.realDataCount > 0 || meta.sampleDataCount > 0) {
      console.log(chalk.gray(`\n  Total: ${response.total} test cases (${meta.realDataCount} stored, ${meta.sampleDataCount} sample)\n`));
    } else {
      console.log(chalk.gray(`\n  Total: ${response.total} test cases\n`));
    }
  } catch (error: any) {
    console.error(chalk.red(`\n  Error: ${error.message}`));
    console.log(chalk.gray('  Is the server running? Start with: npm run dev:server\n'));
    process.exit(1);
  } finally {
    cleanup();
  }
}

/**
 * List all available benchmarks via server API
 */
async function listBenchmarks(format: OutputFormat, config: ResolvedConfig): Promise<void> {
  const serverResult = await ensureServer(config.server);
  const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

  try {
    const client = new ApiClient(serverResult.baseUrl);
    const response = await client.listBenchmarksWithMeta();

    if (format !== 'markdown') {
      displayStorageWarnings(response.meta);
    }

    if (format === 'json') {
      console.log(formatJson(response));
      return;
    }

    const headers = ['ID', 'Name', 'Test Cases', 'Created', 'Source'];
    const rows = response.data.map(b => {
      const isDemo = b.id.startsWith('demo-');
      return [
        b.id,
        b.name,
        b.testCaseIds.length.toString(),
        new Date(b.createdAt).toLocaleDateString(),
        isDemo ? 'Sample' : 'Stored',
      ];
    });

    if (format === 'markdown') {
      console.log(formatMarkdownTable(headers, rows));
      return;
    }

    const table = new Table({
      head: headers.map(h => chalk.cyan(h)),
      colWidths: [28, 28, 12, 22, 10],
      wordWrap: true,
    });
    for (const row of rows) {
      table.push(row);
    }

    console.log(chalk.bold('\nAvailable Benchmarks:\n'));
    console.log(table.toString());

    const { meta } = response;
    if (meta.realDataCount > 0 || meta.sampleDataCount > 0) {
      console.log(chalk.gray(`\n  Total: ${response.total} benchmarks (${meta.realDataCount} stored, ${meta.sampleDataCount} sample)\n`));
    } else {
      console.log(chalk.gray(`\n  Total: ${response.total} benchmarks\n`));
    }
  } catch (error: any) {
    console.error(chalk.red(`\n  Error: ${error.message}`));
    console.log(chalk.gray('  Is the server running? Start with: npm run dev:server\n'));
    process.exit(1);
  } finally {
    cleanup();
  }
}

/**
 * List all registered connectors (local registry)
 *
 * Note: Connectors are loaded from the local registry since they're
 * in-memory objects that can't be serialized over HTTP.
 */
function listConnectors(format: OutputFormat): void {
  const types = connectorRegistry.getRegisteredTypes();
  const connectors = types.map(type => {
    const connector = connectorRegistry.get(type);
    return {
      type,
      name: connector?.name || 'Unknown',
      streaming: connector?.supportsStreaming || false,
    };
  });

  if (format === 'json') {
    console.log(formatJson(connectors));
    return;
  }

  const headers = ['Type', 'Name', 'Streaming'];
  const rows = connectors.map(c => [
    c.type,
    c.name,
    c.streaming ? 'Yes' : 'No',
  ]);

  if (format === 'markdown') {
    console.log(formatMarkdownTable(headers, rows));
    return;
  }

  const table = new Table({
    head: headers.map(h => chalk.cyan(h)),
    colWidths: [20, 25, 12],
  });
  for (const row of rows) {
    table.push([
      row[0],
      row[1],
      row[2] === 'Yes' ? chalk.green('Yes') : chalk.gray('No'),
    ]);
  }

  console.log(chalk.bold('\nRegistered Connectors:\n'));
  console.log(table.toString());
  console.log(chalk.gray(`\n  Total: ${connectors.length} connectors\n`));
}

/**
 * List all models via server API
 */
async function listModels(format: OutputFormat, config: ResolvedConfig): Promise<void> {
  const serverResult = await ensureServer(config.server);
  const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

  try {
    const client = new ApiClient(serverResult.baseUrl);
    const models = await client.listModels();

    if (format === 'json') {
      console.log(formatJson(models));
      return;
    }

    const headers = ['Key', 'Display Name', 'Provider', 'Context'];
    const rows = models.map(m => [
      m.key,
      m.display_name || m.key,
      m.provider || 'bedrock',
      m.context_window ? `${Math.round(m.context_window / 1000)}k` : '-',
    ]);

    if (format === 'markdown') {
      console.log(formatMarkdownTable(headers, rows));
      return;
    }

    const table = new Table({
      head: headers.map(h => chalk.cyan(h)),
      colWidths: [25, 30, 12, 12],
      wordWrap: true,
    });
    for (const row of rows) {
      table.push(row);
    }

    console.log(chalk.bold('\nAvailable Models:\n'));
    console.log(table.toString());
    console.log(chalk.gray(`\n  Total: ${models.length} models\n`));
  } catch (error: any) {
    console.error(chalk.red(`\n  Error: ${error.message}`));
    console.log(chalk.gray('  Is the server running? Start with: npm run dev:server\n'));
    process.exit(1);
  } finally {
    cleanup();
  }
}

/**
 * Create the list command
 */
export function createListCommand(): Command {
  const command = new Command('list')
    .description('List available resources')
    .argument('<resource>', 'Resource type: agents, test-cases, benchmarks, connectors, models')
    .option('-o, --output <format>', OUTPUT_FORMAT_DESCRIPTION, 'table')
    .action(async (resource: string, options: { output: string }) => {
      const format = parseOutputFormat(options.output);

      // Load config (registers custom connectors)
      const config = await loadConfig();

      // Register custom connectors from config
      for (const connector of config.connectors) {
        connectorRegistry.register(connector);
      }

      switch (resource.toLowerCase()) {
        case 'agents':
          await listAgents(format, config);
          break;
        case 'test-cases':
        case 'testcases':
        case 'tc':
          await listTestCases(format, config);
          break;
        case 'benchmarks':
        case 'bench':
          await listBenchmarks(format, config);
          break;
        case 'connectors':
          listConnectors(format);
          break;
        case 'models':
          await listModels(format, config);
          break;
        default:
          console.error(chalk.red(`\n  Unknown resource type: ${resource}`));
          console.log(chalk.gray('  Available: agents, test-cases, benchmarks, connectors, models\n'));
          process.exit(1);
      }
    });

  return command;
}
