/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Command
 * Single command to evaluate and improve AgentSkills.
 * Usage: agent-health skill <path> [--auto] [--agent <key>] [--model <id>]
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { loadConfig } from '@/lib/config/index.js';
import { ensureServer, createServerCleanup } from '@/cli/utils/serverLifecycle.js';
import { parseOutputFormat, OUTPUT_FORMAT_DESCRIPTION, type OutputFormat } from '@/cli/utils/formatOutput.js';
import type { SkillEvalProgressEvent, SkillBenchmarkResult } from '@/types/index.js';

export function createSkillCommand(): Command {
  return new Command('skill')
    .description('Evaluate and improve an AgentSkill (A/B eval + propose improvements)')
    .argument('<path>', 'Path to skill directory (must contain SKILL.md)')
    .option('--auto', 'Auto-apply proposed improvements to SKILL.md')
    .option('-a, --agent <key>', 'Agent key (default: first claude-code agent)')
    .option('-j, --judge <id>', 'Judge model ID (default: first Bedrock model)')
    .option('-o, --output <format>', OUTPUT_FORMAT_DESCRIPTION, 'table')
    .action(async (skillPath: string, options: { auto?: boolean; agent?: string; judge?: string; output: string }) => {
      console.log(chalk.bold('\nAgent Health - Skill Evaluator\n'));

      const config = await loadConfig();
      const serverResult = await ensureServer(config.server);
      const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);

      try {
        // Step 1: Validate
        const validateSpinner = ora('Validating skill...').start();
        const validateRes = await fetch(`${serverResult.baseUrl}/api/skills/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: skillPath }),
        });

        const validation = await validateRes.json();

        if (!validation.valid) {
          validateSpinner.fail(chalk.red('Invalid skill'));
          for (const err of validation.errors) {
            console.log(chalk.red(`    - ${err}`));
          }
          process.exitCode = 1;
          return;
        }

        validateSpinner.succeed(
          chalk.green(`Valid skill: ${validation.skill.metadata.name}`) +
          chalk.gray(` — ${validation.skill.metadata.description}`)
        );

        if (validation.evalsFile) {
          console.log(chalk.gray(`  Evals: ${validation.evalsFile.evals.length} test cases`));
        } else {
          console.log(chalk.gray(`  Evals: none found (will auto-generate)`));
        }

        if (validation.warnings.length > 0) {
          for (const warn of validation.warnings) {
            console.log(chalk.yellow(`  ⚠ ${warn}`));
          }
        }

        // Step 2: Run eval + improvement cycle
        console.log('');
        const evalSpinner = ora('Starting evaluation...').start();

        const evalRes = await fetch(`${serverResult.baseUrl}/api/skills/eval`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: skillPath,
            agentKey: options.agent,
            modelId: options.judge,
            auto: options.auto,
          }),
        });

        if (!evalRes.ok) {
          const error = await evalRes.json();
          evalSpinner.fail(chalk.red(error.error || 'Evaluation failed'));
          if (error.details) {
            const details = Array.isArray(error.details) ? error.details : [error.details];
            for (const d of details) {
              console.log(chalk.red(`    - ${d}`));
            }
          }
          process.exitCode = 1;
          return;
        }

        // Consume SSE stream
        let benchmark: SkillBenchmarkResult | null = null;
        let improvement: { applied: boolean; changes: string; reasoning: string; improvedInstructions?: string } | null = null;
        const reader = evalRes.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const event: SkillEvalProgressEvent = JSON.parse(line.slice(6));
                switch (event.type) {
                  case 'started':
                    evalSpinner.text = `Evaluating "${event.skillName}" (${event.totalEvals} evals, iteration ${event.iteration})`;
                    break;
                  case 'eval_running':
                    evalSpinner.text = `Eval #${event.evalId} [${event.condition}]: running agent...`;
                    break;
                  case 'eval_grading':
                    evalSpinner.text = `Eval #${event.evalId} [${event.condition}]: grading...`;
                    break;
                  case 'eval_done':
                    evalSpinner.text = `Eval #${event.evalId} [${event.condition}]: ${chalk.cyan(`${Math.round(event.passRate * 100)}%`)}`;
                    break;
                  case 'improving':
                    evalSpinner.text = 'Analyzing failures and proposing improvements...';
                    break;
                  case 'improved':
                    improvement = event;
                    break;
                  case 'completed':
                    benchmark = event.benchmark;
                    break;
                  case 'error':
                    evalSpinner.fail(chalk.red(event.message));
                    process.exitCode = 1;
                    return;
                }
              } catch {
                // Ignore malformed SSE lines
              }
            }
          }
        }

        evalSpinner.succeed('Evaluation complete');

        // Step 3: Display results
        if (benchmark) {
          displayBenchmark(benchmark, parseOutputFormat(options.output));
        }

        // Step 4: Display improvement proposal
        if (improvement) {
          console.log('');
          if (improvement.applied) {
            console.log(chalk.green.bold('  ✓ Improvement applied to SKILL.md'));
            console.log(chalk.gray(`    Changes: ${improvement.changes}`));
            console.log(chalk.gray(`    Reasoning: ${improvement.reasoning}`));
          } else {
            console.log(chalk.yellow.bold('  ⬆ Improvement proposed (not applied)'));
            console.log(chalk.gray(`    Changes: ${improvement.changes}`));
            console.log(chalk.gray(`    Reasoning: ${improvement.reasoning}`));
            if (improvement.improvedInstructions) {
              console.log('');
              console.log(chalk.cyan('  Proposed instructions:'));
              console.log(chalk.gray('  ' + '─'.repeat(60)));
              const lines = improvement.improvedInstructions.split('\n');
              for (const l of lines) {
                console.log(chalk.white(`  ${l}`));
              }
              console.log(chalk.gray('  ' + '─'.repeat(60)));
              console.log(chalk.yellow(`\n  Run with ${chalk.bold('--auto')} to apply automatically.\n`));
            }
          }
        } else if (benchmark) {
          const delta = benchmark.run_summary.delta.pass_rate;
          if (delta >= 0) {
            console.log(chalk.green(`\n  Skill already performing well — no improvements needed.\n`));
          }
        }
      } finally {
        cleanup();
      }
    });
}

function displayBenchmark(benchmark: SkillBenchmarkResult, format: OutputFormat): void {
  const { run_summary } = benchmark;
  const delta = run_summary.delta;

  console.log(chalk.cyan(`\n  Skill: ${benchmark.skill_name} (iteration ${benchmark.iteration})`));
  console.log(chalk.gray(`  Agent: ${benchmark.agent_key} | Model: ${benchmark.model_id || 'default'}`));
  console.log(chalk.gray(`  Created: ${benchmark.created_at}`));

  if (format === 'json') {
    console.log(JSON.stringify(benchmark, null, 2));
    return;
  }

  const table = new Table({
    head: ['Metric', 'With Skill', 'Without Skill', 'Delta'].map(h => chalk.cyan(h)),
  });

  const fmtPct = (n: number) => `${Math.round(n * 100)}%`;
  const fmtTime = (n: number) => `${n.toFixed(1)}s`;
  const fmtTokens = (n: number) => Math.round(n).toString();
  const fmtDelta = (n: number, unit: string, higherIsBetter: boolean) => {
    const sign = n >= 0 ? '+' : '';
    const color = (higherIsBetter ? n >= 0 : n <= 0) ? chalk.green : chalk.red;
    return color(`${sign}${unit === '%' ? Math.round(n * 100) + '%' : n.toFixed(1) + unit}`);
  };

  table.push(
    ['Pass Rate', fmtPct(run_summary.with_skill.pass_rate.mean), fmtPct(run_summary.without_skill.pass_rate.mean), fmtDelta(delta.pass_rate, '%', true)],
    ['Time', fmtTime(run_summary.with_skill.time_seconds.mean), fmtTime(run_summary.without_skill.time_seconds.mean), fmtDelta(delta.time_seconds, 's', false)],
    ['Tokens', fmtTokens(run_summary.with_skill.tokens.mean), fmtTokens(run_summary.without_skill.tokens.mean), fmtDelta(delta.tokens, '', false)],
  );

  console.log('');
  console.log(table.toString());
  console.log(chalk.gray(`\n  Results: agent-health-data/skill-evals/${benchmark.skill_path}/iteration-${benchmark.iteration}/`));
}
