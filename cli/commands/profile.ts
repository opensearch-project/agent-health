/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Profile Command — agent profiling
 *
 * Profiles a *live coding-agent session* the way a CPU/JVM profiler profiles a
 * running process: it samples the session's execution (OTel traces) and hands
 * back a report of where the agent went wrong and what to fix in its own
 * codebase. It assembles the context a reasoner needs:
 *   - the customer's chosen evaluator (the profiling rubric) resolved by `-e`
 *   - the session's trajectory, reconstructed from OTel spans
 *   - a deterministic signal scan over the session
 *
 * Designed to be invoked from *inside* a coding session (Claude Code / Kiro /
 * pi) — the agent already has the live chat + the codebase, so this command
 * supplies only the half it can't see (traces + rubric) and hands back a plan
 * the agent applies. See docs/skills/AGENT_PROFILE.md.
 *
 * Usage:
 *   agent-health profile -e <evaluator-id> [--session <id>] [--output json]
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig } from '@/lib/config/index.js';
import { projectDataDir } from '@/lib/config/statePaths.js';
import { ensureServer, createServerCleanup } from '@/cli/utils/serverLifecycle.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import { spansToTrajectory, scanSessionSignals } from '@/services/traces/spansToTrajectory.js';
import type { Evaluator, Span } from '@/types/index.js';

/** Where the PreToolUse hook (installed by `agent-health setup`) records the id. */
const SESSION_FILE = join('.claude', 'agent-health', 'current-session');

/**
 * Resolve the current coding-agent session id.
 *  1. explicit `--session`
 *  2. the file the setup hook writes (deterministic, authoritative)
 *  3. fallback: newest Claude Code transcript for this cwd (heuristic)
 */
function resolveSessionId(explicit?: string): { sessionId: string | null; source: string } {
  if (explicit) return { sessionId: explicit, source: 'flag' };

  if (existsSync(SESSION_FILE)) {
    const id = readFileSync(SESSION_FILE, 'utf-8').trim();
    if (id) return { sessionId: id, source: 'hook' };
  }

  // Heuristic fallback: ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl,
  // newest by mtime. cwd-slug = cwd with non-alphanumerics → '-'.
  try {
    const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
    const dir = join(homedir(), '.claude', 'projects', slug);
    if (existsSync(dir)) {
      const newest = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) return { sessionId: newest.f.replace(/\.jsonl$/, ''), source: 'transcript' };
    }
  } catch {
    /* ignore — fall through to null */
  }

  return { sessionId: null, source: 'none' };
}

/** Sum a numeric span attribute across spans (tolerant of string values). */
function sumAttr(spans: Span[], keys: string[]): number {
  let total = 0;
  for (const s of spans) {
    for (const k of keys) {
      const v = s.attributes?.[k];
      if (v != null && !isNaN(Number(v))) { total += Number(v); break; }
    }
  }
  return total;
}

export function createProfileCommand(): Command {
  return new Command('profile')
    .description('Profile a live agent session and surface what to fix in its codebase (uses your evaluator as the rubric)')
    .option('-e, --evaluator <id>', 'Evaluator id to use as the profiling rubric (default: system-rca-default)')
    .option('-s, --session <id>', 'Coding-agent session id (default: auto-detected)')
    .option('-f, --feedback <text>', 'Your upfront steering/feedback on the session (e.g. "focus on routing; it ignored the SOP")')
    .option('--service <name>', 'OTel service name to filter spans (default: claude-code)', 'claude-code')
    .option('-o, --output <format>', 'Output format: table | json', 'table')
    .action(async (options: { evaluator?: string; session?: string; feedback?: string; service: string; output: string }) => {
      const asJson = options.output === 'json';
      if (!asJson) console.log(chalk.bold('\nAgent Health - Profile\n'));

      const { sessionId, source } = resolveSessionId(options.session);
      if (!sessionId) {
        const msg = 'Could not determine the current session id. Pass --session <id>, or run `agent-health setup` to install the session hook.';
        if (asJson) console.log(JSON.stringify({ error: msg }, null, 2));
        else console.log(chalk.red(`  ${msg}\n`));
        process.exitCode = 1;
        return;
      }
      if (!asJson) console.log(chalk.gray(`  Session: ${sessionId} (via ${source})`));

      const config = await loadConfig();
      const serverResult = await ensureServer(config.server);
      const cleanup = createServerCleanup(serverResult, config.server.reuseExistingServer === false);
      const client = new ApiClient(serverResult.baseUrl);

      try {
        // 1. Resolve the evaluator (the profiling rubric).
        const evaluatorId = options.evaluator || 'system-rca-default';
        const spinner = asJson ? null : ora('Resolving evaluator...').start();
        const { evaluators } = await client.listEvaluators();
        const evaluator: Evaluator | undefined = evaluators.find(e => e.id === evaluatorId);
        if (!evaluator) {
          const msg = `Evaluator not found: ${evaluatorId}`;
          spinner?.fail(chalk.red(msg));
          if (asJson) console.log(JSON.stringify({ error: msg }, null, 2));
          process.exitCode = 1;
          return;
        }
        spinner && (spinner.text = 'Fetching session traces...');

        // 2. Fetch the session's spans. The session id is globally unique, so we
        // do NOT filter by service name here — that would wrongly exclude spans
        // whose service is `claude-code-agent` (agent-health connector) vs
        // `claude-code` (native telemetry). Service is only a fallback discriminator.
        const traceResult = await client.fetchTraces({ sessionId, size: 1000 });
        const spans = (traceResult.spans || []) as Span[];
        if (spans.length === 0) {
          const msg = `No spans found for session ${sessionId}. Is telemetry flowing? (see: agent-health setup-telemetry)`;
          spinner?.fail(chalk.yellow(msg));
          if (asJson) console.log(JSON.stringify({ error: msg, sessionId }, null, 2));
          process.exitCode = 1;
          return;
        }

        // 3. Reconstruct trajectory + scan signals (the "profile").
        spinner && (spinner.text = 'Profiling session...');
        const trajectory = spansToTrajectory(spans, options.service);
        const signals = scanSessionSignals(spans, options.service);

        const startTimes = spans.map(s => new Date(s.startTime).getTime()).filter(n => !isNaN(n));
        const endTimes = spans.map(s => new Date(s.endTime).getTime()).filter(n => !isNaN(n));
        const durationMs = startTimes.length && endTimes.length
          ? Math.max(...endTimes) - Math.min(...startTimes) : 0;
        const tokens = sumAttr(spans, ['gen_ai.usage.input_tokens', 'input_tokens'])
          + sumAttr(spans, ['gen_ai.usage.output_tokens', 'output_tokens']);
        // Report the service name actually seen on the spans (e.g. `claude-code`
        // for native telemetry vs `claude-code-agent` for the connector), reading
        // whichever attribute key the span carries (`service.name` or `serviceName`).
        const svcSpan = spans.find(s => s.attributes?.['service.name'] || s.attributes?.['serviceName']);
        const observedService = String(
          svcSpan?.attributes?.['service.name'] ?? svcSpan?.attributes?.['serviceName'] ?? options.service
        );

        spinner?.succeed('Session profiled');

        // 4. Assemble the profile (the context the reasoner needs).
        const profile = {
          session: {
            sessionId,
            serviceName: observedService,
            // Distinct trace ids in this session — the anchor for verified
            // evidence: open these in the Agent Health Traces tab to confirm a
            // finding (a Claude Code session can span multiple traces).
            traceIds: [...new Set(spans.map(s => s.traceId).filter(Boolean))],
            spanCount: spans.length,
            trajectorySteps: trajectory.length,
            durationMs,
            tokens,
          },
          evaluator: {
            id: evaluator.id,
            name: evaluator.name,
            systemPrompt: evaluator.systemPrompt,
            metrics: evaluator.scoringConfig?.metrics ?? [],
            passThreshold: evaluator.scoringConfig?.passThreshold,
          },
          signals,
          // Optional upfront human steering — the context traces alone can't
          // capture ("focus on routing", "it ignored the SOP"). Weighted
          // heavily by the reasoner, above the deterministic signals.
          userFeedback: options.feedback || undefined,
          trajectory,
          instructions: [
            'You are improving the agent whose session is profiled above, in ITS OWN codebase.',
            options.feedback
              ? `The user gave this upfront feedback — treat it as the PRIMARY lens, above the signals: "${options.feedback}"`
              : 'No upfront user feedback was given; rely on the rubric + signals.',
            'Using the evaluator.systemPrompt as your rubric, review:',
            '  (a) the trajectory below, (b) the signals, (c) the userFeedback (if any),',
            '  (d) the CURRENT CHAT you already have, and (e) the codebase in the cwd.',
            'Produce a prioritized list of concrete edits. For each: the file to change,',
            'what to change, why (tie it to the user feedback, a signal, or a rubric criterion +',
            'cite the evidence: the session.traceIds / the signal that triggered it), and priority.',
            'Make minimal, generalizable changes on a branch — do not edit the working tree directly.',
          ].join('\n'),
        };

        // 5. Persist + emit.
        const outDir = join(projectDataDir(), 'profiles', sessionId);
        mkdirSync(outDir, { recursive: true });
        const outFile = join(outDir, 'profile.json');
        writeFileSync(outFile, JSON.stringify(profile, null, 2));

        if (asJson) {
          console.log(JSON.stringify(profile, null, 2));
          return;
        }

        // Human-readable summary.
        console.log(chalk.cyan(`\n  Evaluator: ${evaluator.name} (${evaluator.id})`));
        if (options.feedback) console.log(chalk.magenta(`  Your feedback: "${options.feedback}"`));
        console.log(chalk.gray(
          `  ${profile.session.spanCount} spans · ${profile.session.trajectorySteps} steps · ` +
          `${(durationMs / 1000).toFixed(1)}s · ${tokens.toLocaleString()} tokens`
        ));

        if (signals.length === 0) {
          console.log(chalk.green('\n  No notable signals — the session looks clean.'));
          console.log(chalk.gray('  (Nothing obvious to fix from traces alone; the rubric review may still find subtler issues.)'));
        } else {
          console.log(chalk.bold('\n  Signals:'));
          for (const s of signals) {
            const color = s.severity === 'high' ? chalk.red : s.severity === 'medium' ? chalk.yellow : chalk.gray;
            console.log(`    ${color(`[${s.severity}]`)} ${s.title}${s.count > 1 ? chalk.gray(` (×${s.count})`) : ''}`);
            if (s.evidence) console.log(chalk.gray(`           ${s.evidence}`));
          }
        }

        console.log(chalk.gray(`\n  Profile written: ${outFile}`));
        console.log(chalk.cyan('\n  Next: with the evaluator rubric + this profile + the current chat + the codebase,'));
        console.log(chalk.cyan('  propose concrete edits (file, change, why, priority) and apply them on a branch.\n'));
      } finally {
        cleanup();
      }
    });
}
