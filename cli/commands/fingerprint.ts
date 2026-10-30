/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `agent-health fingerprint <agentKey>` — print the agent-configuration
 * fingerprint of an agent AS CONFIGURED RIGHT NOW in the local
 * agent-health.config.ts (lib/agentFingerprint.ts), so a run's
 * `config <12-hex>` chip can be mapped back to the code that produced it.
 *
 * No server involved: the config is loaded from the current directory the
 * same way the server loads it, so the value matches what a run started
 * from this checkout would be stamped with. Typical loop:
 *
 *   $ agent-health fingerprint my-agent             # b8692d59c93a…
 *   $ $EDITOR agent-health.config.ts                # change the prompt
 *   $ agent-health fingerprint my-agent             # c86fc73c1047…  ← moved
 *   $ agent-health fingerprint my-agent --payload   # the exact redacted inputs
 *   $ agent-health fingerprint my-agent --compare b8692d59c93a   # exit 0 = same
 *
 * `--compare` accepts the full 64-hex fingerprint or the 12-hex short form
 * shown on the chip, and exits non-zero on mismatch so CI can gate on
 * "the config I'm about to measure is the one the baseline was measured
 * with".
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '@/lib/config/index.js';
import { getConfigFileInfo } from '@/lib/config/index.js';
import {
  buildFingerprintPayload,
  computeAgentFingerprint,
  canonicalStringify,
  resolveAgentConfigSource,
  AGENT_FINGERPRINT_SHORT_LENGTH,
} from '@/lib/agentFingerprint.js';
import { FINGERPRINT_INPUT_FIELDS } from '@/lib/agentFingerprintDiff.js';

export interface FingerprintCommandOptions {
  json?: boolean;
  payload?: boolean;
  compare?: string;
  endpoint?: string;
}

/** Exposed for tests; the command's action delegates here. */
export async function runFingerprintCommand(
  agentKey: string,
  options: FingerprintCommandOptions,
  io: { log: (s: string) => void; error: (s: string) => void } = { log: console.log, error: console.error },
): Promise<number> {
  const config = await loadConfig();
  const agent = config.agents.find(a => a.key === agentKey);
  if (!agent) {
    io.error(chalk.red(`  Unknown agent: ${agentKey}`));
    const keys = config.agents.map(a => a.key);
    if (keys.length > 0) io.error(chalk.gray(`  Configured agents: ${keys.join(', ')}`));
    else io.error(chalk.gray('  No agents configured — is there an agent-health.config.ts in this directory?'));
    return 1;
  }

  const fp = computeAgentFingerprint(agent, { agentEndpoint: options.endpoint });
  const configInfo = getConfigFileInfo();
  const source = await resolveAgentConfigSource(configInfo?.path);
  const payload = options.payload ? JSON.parse(canonicalStringify(buildFingerprintPayload(agent, { agentEndpoint: options.endpoint }))) : undefined;

  let compare: { expected: string; matches: boolean } | undefined;
  if (options.compare) {
    const expected = options.compare.trim().toLowerCase();
    const matches = expected.length >= AGENT_FINGERPRINT_SHORT_LENGTH && fp.agentFingerprint.startsWith(expected);
    compare = { expected, matches };
  }

  if (options.json) {
    io.log(JSON.stringify({
      agentKey,
      agentFingerprint: fp.agentFingerprint,
      agentFingerprintShort: fp.agentFingerprintShort,
      agentPromptHash: fp.agentPromptHash ?? null,
      agentConfigSource: source ?? null,
      ...(payload ? { payload } : {}),
      ...(compare ? { compare } : {}),
      computedAt: new Date().toISOString(),
    }, null, 2));
  } else {
    io.log('');
    io.log(chalk.bold(`  Agent configuration fingerprint — ${agentKey}`));
    io.log(chalk.gray('  SHA-256 of the connector-relevant, secret-redacted agent config (not a git commit).'));
    io.log('');
    io.log(`  ${chalk.cyan('Fingerprint')}   ${fp.agentFingerprint}  ${chalk.gray(`(chip: ${fp.agentFingerprintShort})`)}`);
    io.log(`  ${chalk.cyan('Prompt hash')}   ${fp.agentPromptHash ?? chalk.gray('no system prompt in connectorConfig')}`);
    if (source) {
      io.log(`  ${chalk.cyan('Config file')}   ${source.path}`);
      io.log(`  ${chalk.cyan('Repo commit')}   ${source.gitSha ?? chalk.gray('not a git checkout')}${source.dirty ? chalk.yellow('  (config file has uncommitted edits)') : ''}`);
    } else {
      io.log(`  ${chalk.cyan('Config file')}   ${chalk.gray('none found — built-in defaults')}`);
    }
    io.log('');
    io.log(chalk.gray('  Hashed inputs: ' + FINGERPRINT_INPUT_FIELDS.filter(f => f.key !== 'v').map(f => f.label.toLowerCase()).join(' · ')));
    io.log(chalk.gray('  Header/auth/env VALUES are redacted (names participate); rotating a credential does not move the hash.'));
    if (payload) {
      io.log('');
      io.log(chalk.bold('  Exact hashed payload (redacted, canonical key order):'));
      io.log(JSON.stringify(payload, null, 2).split('\n').map(l => `  ${l}`).join('\n'));
    }
    if (compare) {
      io.log('');
      if (compare.matches) io.log(chalk.green(`  ✓ ${compare.expected} matches the current config of ${agentKey}`));
      else io.log(chalk.yellow(`  ✗ ${compare.expected} does NOT match the current config (${fp.agentFingerprintShort}) — the prompt, model, tools or another connector field changed since that run`));
    }
    io.log('');
  }
  return compare && !compare.matches ? 2 : 0;
}

export function createFingerprintCommand(): Command {
  return new Command('fingerprint')
    .description('Print the agent-configuration fingerprint of an agent from the local agent-health.config.ts (what the run chip "config <hash>" refers to)')
    .argument('<agentKey>', 'Agent key from agent-health.config.ts')
    .option('--json', 'Machine-readable output')
    .option('--payload', 'Also print the exact (secret-redacted) inputs that were hashed')
    .option('--compare <fingerprint>', 'Compare against a run\'s fingerprint (full or 12-char short form); exit code 2 on mismatch')
    .option('--endpoint <url>', 'Mirror a run-level endpoint override')
    .action(async (agentKey: string, options: FingerprintCommandOptions) => {
      const code = await runFingerprintCommand(agentKey, options);
      if (code !== 0) process.exitCode = code;
    });
}
