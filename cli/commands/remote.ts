/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI commands for managing remote server connections.
 * Reads/writes the remoteServers section of agent-health.config.json.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const CONFIG_FILENAME = 'agent-health.config.json';

interface RemoteServer {
  name: string;
  url: string;
  apiKey?: string;
}

function getConfigPath(): string {
  return path.join(process.cwd(), CONFIG_FILENAME);
}

function readConfig(): Record<string, unknown> {
  const filePath = getConfigPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function getRemoteServers(config: Record<string, unknown>): RemoteServer[] {
  return Array.isArray(config.remoteServers) ? config.remoteServers : [];
}

export function createRemoteCommand(): Command {
  const remote = new Command('remote')
    .description('Manage remote agent-health server connections');

  remote
    .command('add')
    .description('Add a remote server')
    .requiredOption('--name <name>', 'Display name for the server')
    .requiredOption('--url <url>', 'Server URL (e.g. http://10.0.1.50:4001)')
    .option('--api-key <key>', 'API key for authentication')
    .action((options) => {
      const config = readConfig();
      const servers = getRemoteServers(config);

      if (servers.some(s => s.name === options.name)) {
        console.error(chalk.red(`\n  Error: Server "${options.name}" already exists. Use 'remote remove' first.\n`));
        process.exit(1);
      }

      const server: RemoteServer = { name: options.name, url: options.url.replace(/\/$/, '') };
      if (options.apiKey) server.apiKey = options.apiKey;

      servers.push(server);
      config.remoteServers = servers;
      writeConfig(config);

      console.log(chalk.green(`\n  Added remote server: ${options.name} (${options.url})\n`));
    });

  remote
    .command('remove')
    .description('Remove a remote server')
    .argument('<name>', 'Server name to remove')
    .action((name: string) => {
      const config = readConfig();
      const servers = getRemoteServers(config);
      const idx = servers.findIndex(s => s.name === name);

      if (idx === -1) {
        console.error(chalk.red(`\n  Error: Server "${name}" not found.\n`));
        process.exit(1);
      }

      servers.splice(idx, 1);
      config.remoteServers = servers;
      writeConfig(config);

      console.log(chalk.green(`\n  Removed remote server: ${name}\n`));
    });

  remote
    .command('list')
    .description('List configured remote servers')
    .action(() => {
      const config = readConfig();
      const servers = getRemoteServers(config);

      if (servers.length === 0) {
        console.log(chalk.gray('\n  No remote servers configured.\n'));
        console.log(chalk.gray('  Add one with: agent-health remote add --name <name> --url <url>\n'));
        return;
      }

      console.log(chalk.cyan(`\n  Remote Servers (${servers.length}):\n`));
      for (const s of servers) {
        const auth = s.apiKey ? chalk.green(' [auth]') : chalk.gray(' [no auth]');
        console.log(`  ${chalk.bold(s.name)}  ${s.url}${auth}`);
      }
      console.log('');
    });

  remote
    .command('test')
    .description('Test connectivity to all remote servers')
    .action(async () => {
      const config = readConfig();
      const servers = getRemoteServers(config);

      if (servers.length === 0) {
        console.log(chalk.gray('\n  No remote servers configured.\n'));
        return;
      }

      console.log(chalk.cyan(`\n  Testing ${servers.length} remote server(s)...\n`));

      for (const s of servers) {
        try {
          const headers: Record<string, string> = {};
          if (s.apiKey) headers['Authorization'] = `Bearer ${s.apiKey}`;

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);

          const response = await fetch(`${s.url}/api/coding-agents/available`, {
            headers,
            signal: controller.signal,
          });
          clearTimeout(timer);

          if (response.ok) {
            const data = await response.json() as { agents?: Array<{ name: string }> };
            const agentCount = data.agents?.length ?? 0;
            console.log(chalk.green(`  ✓ ${s.name} — OK (${agentCount} agents detected)`));
          } else {
            console.log(chalk.red(`  ✗ ${s.name} — HTTP ${response.status} ${response.statusText}`));
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ✗ ${s.name} — ${msg}`));
        }
      }
      console.log('');
    });

  return remote;
}
