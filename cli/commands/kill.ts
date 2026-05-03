/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Kill Command
 * Stop running agent processes (e.g., the observio sample agent)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { killObservioAgent, isPortFree, OBSERVIO_PORT } from '@/server/services/observioAgent.js';

export function createKillCommand(): Command {
  const command = new Command('kill')
    .description('Kill a running agent process')
    .argument('<target>', 'What to kill: sample-agent')
    .action(async (target: string) => {
      switch (target) {
        case 'sample-agent': {
          const free = await isPortFree(OBSERVIO_PORT);
          if (free) {
            console.log(chalk.yellow(`  No process found on port ${OBSERVIO_PORT}`));
            return;
          }
          const killed = await killObservioAgent();
          if (killed) {
            console.log(chalk.green('  ✓ Sample agent stopped'));
          } else {
            console.log(chalk.red('  ✗ Failed to stop sample agent'));
            process.exitCode = 1;
          }
          break;
        }
        default:
          console.error(chalk.red(`  Unknown target: ${target}`));
          console.log(`  Available targets: ${chalk.cyan('sample-agent')}`);
          process.exitCode = 1;
      }
    });

  return command;
}
