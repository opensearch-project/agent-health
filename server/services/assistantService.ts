/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Assistant Service - AI assistant powered by Claude CLI or fallback LLM provider
 *
 * Provides streaming conversational AI with in-memory session management.
 * Primary: spawns `claude` CLI with NDJSON streaming, using `--session-id`/`--resume` for continuity.
 *   The spawned CLI inherits the user's MCP servers from `~/.claude.json`
 *   (filesystem, git, github, chrome-devtools, etc.) and is allowed to use
 *   built-in tools (Bash, Read, Write, WebFetch, …). This makes the chat
 *   surface a real Claude Code session with the same tool access the user
 *   has on the command line.
 * Fallback: uses configured LLM judge provider (Bedrock or LiteLLM). The
 *   fallbacks have no tool access — they only see the inlined snapshot.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { loadConfigSync } from '@/lib/config/index';
import { debug } from '@/lib/debug';
import { readEnv } from '@/lib/envCompat';
import { getSkillPath } from '@/lib/packagePaths';
import { resolveAgentPath, discoverAgentPath, renderDiscoveryMarkdown } from '@/server/services/agentPath';
import serverConfig from '@/server/config/index';
import { buildInferenceConfig, resolveRegionAwareModelId } from '@/lib/bedrockCompat';
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { asyncTestCaseStorage } from '@/services/storage/asyncTestCaseStorage';
import type { AssistantMessage, AssistantContext, TrajectoryStep } from '@/types';

// ============================================================================
// Constants
// ============================================================================

/** Path to the AGENT_HEALTH.md skill file */
const AGENT_HEALTH_SKILL_PATH = getSkillPath('AGENT_HEALTH.md');

/** Session TTL: 30 minutes in milliseconds */
const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Per-turn timeout for the claude CLI process. Configurable via ASSISTANT_TIMEOUT_MS env.
 * Default raised from 10min → 30min because tool-using turns (especially
 * chrome-devtools navigations) can take significantly longer than pure-text turns.
 */
const CLAUDE_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.ASSISTANT_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 1_800_000;
})();

/**
 * Path to the MCP config the assistant spawns inherit. Defaults to the user's
 * `~/.claude.json` (which is what the standalone `claude` CLI reads), so any
 * MCP servers the user has set up — filesystem, git, github, chrome-devtools,
 * builder, context7, tumbler, workplace-chat, … — are available out of the box.
 * Override with ASSISTANT_MCP_CONFIG to point at a curated subset.
 */
function resolveMcpConfigPath(): string | null {
  const override = process.env.ASSISTANT_MCP_CONFIG;
  if (override && existsSync(override)) return override;
  const userConfig = resolve(homedir(), '.claude.json');
  if (existsSync(userConfig)) return userConfig;
  return null;
}

/** Cap for fallback (Bedrock/LiteLLM) message history per turn. */
const FALLBACK_HISTORY_CAP = 20;

/** Cap for the number of trajectory steps inlined in the context snapshot. */
const TRAJECTORY_SNAPSHOT_STEPS = 30;

/** Soft cap (chars) on each section of the inlined context snapshot. */
const SNAPSHOT_SECTION_CHAR_CAP = 8_000;

/**
 * Hard cap on how many comparison runs we'll fan out and inline into the
 * grounded snapshot. The comparison page can in principle compare any number
 * of runs (the URL is `?runs=a,b,c,...`) and a malicious or accidentally
 * long URL like `?runs=id1,id2,...,id1000` would otherwise trigger N
 * sequential storage fetches and produce a multi-megabyte system prompt that
 * blows past Claude's 200k-token context window. The CLI then errors out
 * with a context-length failure that surfaces in the UI as the unhelpful
 * "Assistant returned no text" message. 10 is enough for any realistic
 * comparison and small enough that the resulting snapshot stays well under
 * the section cap above. When truncated, we surface that fact explicitly
 * so the assistant can tell the user it only saw a subset.
 */
const COMPARISON_RUNS_MAX = 10;

// ============================================================================
// Session Store
// ============================================================================

interface Session {
  /** Stable UUID passed to `claude --session-id` on first turn, then `--resume` thereafter. */
  claudeSessionId: string;
  /** Whether the first claude turn has completed (controls --session-id vs --resume). */
  claudeStarted: boolean;
  messages: AssistantMessage[];
  lastAccessed: number;
}

const sessions = new Map<string, Session>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TTL_MS) {
      debug('Assistant', 'Expiring session:', sessionId);
      sessions.delete(sessionId);
    }
  }
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

function getSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      claudeSessionId: randomUUID(),
      claudeStarted: false,
      messages: [],
      lastAccessed: Date.now(),
    };
    sessions.set(sessionId, session);
  }
  session.lastAccessed = Date.now();
  return session;
}

// ============================================================================
// System Prompt + Grounded Context Snapshot
// ============================================================================

export function loadSkillContent(): string {
  try {
    return readFileSync(AGENT_HEALTH_SKILL_PATH, 'utf-8');
  } catch {
    debug('Assistant', 'AGENT_HEALTH.md not found at', AGENT_HEALTH_SKILL_PATH);
    return '';
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + `\n…(truncated ${s.length - max} chars)` : s;
}

function summarizeTrajectory(traj: TrajectoryStep[] | undefined): TrajectoryStep[] {
  if (!Array.isArray(traj) || traj.length === 0) return [];
  // Keep last N steps so the assistant sees how the run ended.
  return traj.slice(-TRAJECTORY_SNAPSHOT_STEPS);
}

/** Build a slim, snapshot-friendly view of a run report. */
function slimRun(run: any) {
  return {
    id: run.id,
    status: run.status,
    passFailStatus: run.passFailStatus,
    metrics: run.metrics,
    agentName: run.agentName,
    modelName: run.modelName,
    testCaseId: run.testCaseId,
    testCaseVersion: run.testCaseVersion,
    experimentId: run.experimentId,
    experimentRunId: run.experimentRunId,
    llmJudgeReasoning: run.llmJudgeReasoning,
    improvementStrategies: run.improvementStrategies,
    trajectory: summarizeTrajectory(run.trajectory),
    trajectoryTotalSteps: run.trajectory?.length ?? 0,
  };
}

/**
 * Fetch and inline run / benchmark / test case data so the assistant can answer
 * grounded questions without needing tool access.
 */
export async function loadContextSnapshot(context?: AssistantContext): Promise<string> {
  if (!context) return '';
  const sections: string[] = [];

  if (context.runId) {
    try {
      const run = await asyncRunStorage.getReportById(context.runId);
      if (run) {
        sections.push(
          `### Run ${run.id}\n\`\`\`json\n${truncate(JSON.stringify(slimRun(run), null, 2), SNAPSHOT_SECTION_CHAR_CAP)}\n\`\`\``
        );

        // Pull the linked test case so the assistant knows the prompt + expected outcomes.
        if (!context.testCaseId && run.testCaseId) {
          context = { ...context, testCaseId: run.testCaseId };
        }
      } else {
        sections.push(`### Run ${context.runId}\n_Run not found in storage._`);
      }
    } catch (err: any) {
      debug('Assistant', 'loadContextSnapshot run fetch failed:', err?.message);
      sections.push(`### Run ${context.runId}\n_Failed to load: ${err?.message || 'unknown error'}_`);
    }
  }

  // Comparison page: load every run the user is currently comparing so the
  // assistant can answer cross-run questions ("which tests passed for which
  // agent?") without needing tool access.
  if (Array.isArray(context.comparisonRunIds) && context.comparisonRunIds.length > 0) {
    const compared: any[] = [];
    const missing: string[] = [];
    // Cap the fan-out (see COMPARISON_RUNS_MAX). We slice the input list
    // BEFORE iterating so a 1000-id URL doesn't trigger 1000 storage reads.
    const allIds = context.comparisonRunIds;
    const idsToFetch = allIds.slice(0, COMPARISON_RUNS_MAX);
    const truncatedCount = allIds.length - idsToFetch.length;
    for (const id of idsToFetch) {
      try {
        const run = await asyncRunStorage.getReportById(id);
        if (run) {
          compared.push(slimRun(run));
        } else {
          missing.push(id);
        }
      } catch (err: any) {
        debug('Assistant', 'loadContextSnapshot comparison fetch failed for', id, err?.message);
        missing.push(id);
      }
    }
    if (compared.length > 0) {
      sections.push(
        `### Comparison Runs (${compared.length} of ${allIds.length})\n\`\`\`json\n${truncate(JSON.stringify(compared, null, 2), SNAPSHOT_SECTION_CHAR_CAP * 2)}\n\`\`\``
      );
    }
    if (missing.length > 0) {
      sections.push(`_Missing runs in comparison set: ${missing.join(', ')}_`);
    }
    if (truncatedCount > 0) {
      sections.push(
        `_Note: comparison set was truncated to the first ${COMPARISON_RUNS_MAX} of ${allIds.length} runs to keep the assistant's context within the model's limits. The remaining ${truncatedCount} run(s) were not loaded._`
      );
    }
  }

  if (context.testCaseId) {
    try {
      const tc = await asyncTestCaseStorage.getById(context.testCaseId);
      if (tc) {
        const slim = {
          id: tc.id,
          name: tc.name,
          description: tc.description,
          labels: tc.labels,
          currentVersion: tc.currentVersion,
          initialPrompt: tc.initialPrompt,
          expectedOutcomes: (tc.versions?.[tc.versions.length - 1] as any)?.expectedOutcomes,
        };
        sections.push(
          `### Test Case ${tc.id}\n\`\`\`json\n${truncate(JSON.stringify(slim, null, 2), SNAPSHOT_SECTION_CHAR_CAP)}\n\`\`\``
        );
      }
    } catch (err: any) {
      debug('Assistant', 'loadContextSnapshot test-case fetch failed:', err?.message);
    }
  }

  if (context.benchmarkId) {
    try {
      const bench = await asyncBenchmarkStorage.getById(context.benchmarkId, { fields: 'polling' });
      if (bench) {
        const slim = {
          id: bench.id,
          name: bench.name,
          description: bench.description,
          testCaseCount: bench.testCaseIds?.length,
          runs: (bench.runs || []).map((r: any) => ({
            id: r.id,
            createdAt: r.createdAt,
            status: r.status,
            agentKey: r.agentKey,
            modelId: r.modelId,
            stats: r.stats,
          })),
        };
        sections.push(
          `### Benchmark ${bench.id}\n\`\`\`json\n${truncate(JSON.stringify(slim, null, 2), SNAPSHOT_SECTION_CHAR_CAP)}\n\`\`\``
        );
      }
    } catch (err: any) {
      debug('Assistant', 'loadContextSnapshot benchmark fetch failed:', err?.message);
    }
  }

  return sections.length > 0
    ? `\n\n---\n\n## Live Data Snapshot (loaded from storage)\n\n${sections.join('\n\n')}`
    : '';
}

/**
 * Build the system prompt synchronously. For grounded context, callers should
 * await `loadContextSnapshot` separately and append (this keeps the function
 * sync-friendly for tests and the Bedrock/LiteLLM fallbacks).
 *
 * @param context        Page context (URL, benchmark/run/test-case IDs)
 * @param toolsAvailable Whether the spawned model has tool access. Controls
 *                       the tool-use policy section: Claude CLI (true) vs.
 *                       Bedrock/LiteLLM fallbacks (false).
 */
export function buildSystemPrompt(
  context?: AssistantContext,
  toolsAvailable: boolean = false
): string {
  const skillContent = loadSkillContent();
  const frontendPort = readEnv('AH_DEV_PORT', 'AGENT_HEALTH_DEV_PORT') || '4000';
  const backendPort = readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001';

  let systemPrompt = `You are an AI assistant for Agent Health, an evaluation framework for Root Cause Analysis (RCA) agents. Help users understand evaluation results, configure agents, interpret trajectories, and improve agent performance.

When a Live Data Snapshot is provided below, ground your answers in that data — quote judge reasoning verbatim where relevant, reference specific trajectory steps by index, and only speculate when data is missing. Be concise and helpful.`;

  if (toolsAvailable) {
    systemPrompt += `

## Tool Use Policy

You are running as a real Claude Code session embedded in the Agent Health web UI. You have full tool access — the same tools the user has on the command line:

- **Built-in:** Bash, Read, Write, Edit, WebFetch, Glob, Grep, TodoWrite, etc.
- **MCP servers** loaded from the user's \`~/.claude.json\`, typically including:
  - \`filesystem\` — file access rooted at the user's home directory
  - \`git\`, \`github\` — repository and PR/issue inspection
  - \`chrome-devtools\` — headless Chrome you can drive to navigate the running Agent Health UI, take screenshots, inspect the DOM, and read console output
  - any other MCPs the user has configured (context7, builder, tumbler, workplace-chat, …)

Use them. Don't ask permission — you are already authorized (\`--dangerously-skip-permissions\` is set for this session).

### How to investigate Agent Health questions

The user is running Agent Health locally:
- **Frontend** (Vite/React, hash router): http://localhost:${frontendPort}
- **Backend** (Express, REST): http://localhost:${backendPort}

Prefer hitting the backend API directly (faster and more structured than DOM scraping). Useful endpoints:
- \`GET /api/storage/runs/:id\` — single run report (includes trajectory, judge reasoning, metrics, pass/fail)
- \`GET /api/storage/runs/by-benchmark/:benchmarkId\` — all runs for a benchmark
- \`GET /api/storage/benchmarks/:id\` — benchmark definition + run summaries (use \`?fields=full\` for detail)
- \`GET /api/storage/test-cases/:id\` — test case definition with expected outcomes
- \`GET /api/storage/runs/iterations/:benchmarkId/:testCaseId\` — every run of a single test case in a benchmark
- \`GET /api/storage/runs/by-benchmark-run/:benchmarkId/:runId\` — all per-test-case results for one benchmark execution

### CRITICAL: Always Investigate — Never Ask the User to Paste Data

If the Live Data Snapshot below shows "Run not found" or is missing data you need, **use your tools to fetch it**. You have full API access. NEVER tell the user to "paste back" data, run CLI commands, or manually export results. Instead:

1. Identify what data is missing (run details, test cases, judge reasoning, evaluator config)
2. Fetch it yourself via \`curl http://localhost:${backendPort}/api/storage/...\`
3. If the benchmark ID is known, fetch all runs: \`curl http://localhost:${backendPort}/api/storage/runs/by-benchmark/<benchmarkId>\`
4. If a run ID fails, try listing runs for the benchmark and find matches by agent/timestamp
5. Read source code in the project if needed (evaluator templates, judge prompts, etc.)

Only state "data not available" if you've tried fetching and confirmed it doesn't exist.

Example workflow for "which tests passed for which agent?" on the comparison page:
1. Read the \`comparisonRunIds\` from the page context below.
2. For each run id, \`curl http://localhost:${backendPort}/api/storage/runs/by-benchmark-run/<benchmarkId>/<runId>\` to get the per-test-case pass/fail for that agent.
3. Cross-tabulate by \`testCaseId\` and present the result.

Reach for \`chrome-devtools\` (navigate, take_screenshot, evaluate_script) when the user is asking about something visual that the API can't capture — e.g. "what does the trajectory diff look like for test X?". The frontend route is hash-based, so URLs look like http://localhost:${frontendPort}/#/compare/<benchmarkId>?runs=<id1>,<id2>.

### Evaluator Architecture Knowledge

You have deep knowledge of the evaluation system. Use this to answer questions about judge quality, custom evaluators, and eval-vs-reality gaps.

**Default Judge (system-rca-default):**
- Pass threshold: 70% accuracy (permissive — agent can miss 30% of outcomes and still pass)
- Scoring: Each expectedOutcome scored individually: Fully achieved = 1.0, Partially = 0.5, Not = 0.0
- accuracy = (sum of scores / total outcomes) × 100
- Critical failures (wrong conclusions, hallucinations, missing steps) override to FAIL regardless of score
- Trajectory is compacted before judge sees it: content truncated to 500 chars, toolOutput to 1000 chars

**Built-in Alternative Evaluators:**
- \`system-factuality\`: 80% threshold, checks hallucination rate and source grounding
- \`system-tool-usage\`: 80% threshold, checks tool selection accuracy and redundant calls
- \`system-reasoning-depth\`: 75% threshold, checks logical coherence and step completeness
- \`system-safety\`: 90% threshold, checks safety score, bias, and guardrail adherence

**Custom Evaluators:**
Users can create custom evaluators with:
- A domain-specific \`systemPrompt\` (the judge instructions)
- Custom \`scoringConfig\` with weighted metrics and a custom passThreshold
- Custom \`inferenceConfig\` to override the judge model/provider

**When users ask about eval-vs-reality gaps, consider:**
1. Are expectedOutcomes too outcome-focused vs procedure-focused? (Judge rewards "got the right answer" without checking "used the right method")
2. Is the 70% threshold too permissive for the domain? (Critical domains like oncall need 85%+)
3. Does the domain have hard correctness rules the generic judge can't verify? (e.g., specific CLI syntax, routing tables, valid command names)
4. Is trajectory compaction hiding important details? (tool output truncation may obscure wrong commands)
5. Would a domain-specific evaluator with explicit rubric criteria perform better?

**Recommend custom evaluators when:**
- The domain has checkable rules (correct tool names, valid syntax, routing decisions)
- The default judge is too charitable (passing agents that fail in practice)
- Multiple dimensions matter independently (routing + tool correctness + diagnostic completeness)

Always finish with a complete written conclusion — don't end mid-thought.`;
  } else {
    systemPrompt += `

## Tool Use Policy

You are running through a fallback LLM provider (Bedrock or LiteLLM) with NO tool access — no Bash, Read, WebFetch, MCP servers, or function calls are available. Do NOT say "Let me check…" or "Let me search…" — those phrases produce dead ends.

Use ONLY the Live Data Snapshot below. If something is missing, state plainly what's missing and suggest what the user can fetch (CLI command, URL, file path) and paste back. Finish every answer with a complete written conclusion.`;
  }

  if (skillContent) {
    systemPrompt += `\n\n---\n\n## Agent Health Reference\n\n${skillContent}`;
  }

  // When AH_AGENT_PATH is configured, mount the user's agent repo so the
  // assistant grounds answers in the actual codebase. For the tools-enabled
  // path (Claude CLI), we hint that filesystem tools can drill deeper than
  // the snapshot we inject. For the fallback (no tools), the snapshot is
  // all we have.
  const agentPath = resolveAgentPath();
  if (agentPath) {
    const discovery = discoverAgentPath(agentPath);
    const overview = renderDiscoveryMarkdown(discovery);
    if (overview) {
      systemPrompt += `\n\n---\n\n## Agent Repository Context\n\n` +
        `The user has pointed agent-health at their agent repository. ` +
        `Treat the files below as authoritative source for the agent under evaluation. ` +
        `Reference real component/tool/file names from this repo when answering.` +
        (toolsAvailable
          ? ` You also have Read/Grep/Glob and the spawned CLI is rooted at this repo, so explore further as needed.`
          : ``) +
        `\n\n${overview}`;
    }
  }

  if (context) {
    systemPrompt += '\n\n---\n\n## Current Page Context\n';
    if (context.currentUrl) systemPrompt += `\nThe user is currently viewing: ${context.currentUrl}`;
    if (context.benchmarkId) systemPrompt += `\nActive benchmark ID: ${context.benchmarkId}`;
    if (context.runId) systemPrompt += `\nActive run ID: ${context.runId}`;
    if (context.traceId) systemPrompt += `\nActive trace ID: ${context.traceId}`;
    if (context.testCaseId) systemPrompt += `\nActive test case ID: ${context.testCaseId}`;
    if (context.comparisonRunIds && context.comparisonRunIds.length > 0) {
      systemPrompt += `\nComparison run IDs: ${context.comparisonRunIds.join(', ')}`;
    }
  }

  return systemPrompt;
}

// ============================================================================
// Claude CLI Availability Check
// ============================================================================

let claudeAvailableCache: boolean | null = null;

export function isClaudeAvailable(): boolean {
  if (claudeAvailableCache !== null) return claudeAvailableCache;
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    claudeAvailableCache = true;
    debug('Assistant', 'Claude CLI is available');
  } catch {
    claudeAvailableCache = false;
    debug('Assistant', 'Claude CLI is not available');
  }
  return claudeAvailableCache;
}

// ============================================================================
// Claude CLI Streaming (Primary)
// ============================================================================

/**
 * Build the env passed to the spawned `claude` child.
 *
 * IMPORTANT: strip CLAUDE_CODE_* / CLAUDECODE inheritance. If the server is started
 * from inside an active Claude Code session, those vars cause the nested CLI to
 * misbehave (the CLI explicitly refuses to run when CLAUDECODE=1).
 *
 * HOME is preserved so the spawned CLI can locate `~/.claude.json` and inherit
 * the user's MCP servers, login session, and AWS Bedrock routing.
 */
function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };

  // Remove all variables that signal "you are running inside another Claude session".
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      delete env[key];
    }
  }

  env.CLAUDE_CODE_USE_BEDROCK = '1';
  env.DISABLE_PROMPT_CACHING = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.DISABLE_TELEMETRY = '1';
  env.ANTHROPIC_API_KEY = '';

  if (process.env.AWS_PROFILE) env.AWS_PROFILE = process.env.AWS_PROFILE;
  if (process.env.AWS_REGION) env.AWS_REGION = process.env.AWS_REGION;

  return env;
}

function streamFromClaude(
  session: Session,
  message: string,
  systemPrompt: string,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): ChildProcess {
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--append-system-prompt', systemPrompt,
  ];

  // Inherit the user's MCP servers (filesystem, git, github, chrome-devtools, …)
  // from `~/.claude.json` so the assistant has the same tool access as the
  // standalone `claude` CLI. We pass --mcp-config explicitly because Claude CLI's
  // default project-scoped resolution may otherwise filter user-scoped MCPs.
  const mcpConfigPath = resolveMcpConfigPath();
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }

  // Use a stable session id so follow-up turns can --resume into the same conversation.
  if (session.claudeStarted) {
    args.push('--resume', session.claudeSessionId);
  } else {
    args.push('--session-id', session.claudeSessionId);
  }

  debug('Assistant', 'Spawning claude CLI', {
    sessionId: session.claudeSessionId,
    resume: session.claudeStarted,
    mcpConfig: mcpConfigPath,
  });

  const child = spawn('claude', args, {
    env: buildChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: CLAUDE_TIMEOUT_MS,
    // When AH_AGENT_PATH is configured, root the spawned claude CLI at the
    // user's agent repo so its built-in Read/Grep/Glob can browse the agent's
    // source. Otherwise fall back to the agent-health project root so any
    // project-scoped MCPs (e.g. a `.mcp.json` in the repo) are picked up.
    cwd: resolveAgentPath() || process.cwd(),
  });

  let fullResponse = '';
  let buffer = '';
  let stderr = '';
  let permissionDenials: any[] = [];

  const handleParsedLine = (parsed: any) => {
    // Real claude stream-json shape:
    //   {type:"assistant", message:{content:[{type:"text", text:"..."} | {type:"tool_use", ...}]}}
    if (parsed.type === 'assistant' && parsed.message?.content && Array.isArray(parsed.message.content)) {
      for (const block of parsed.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          fullResponse += block.text;
          onDelta(block.text);
        } else if (block?.type === 'tool_use') {
          // Tools are enabled in this session — surface a friendly inline
          // marker so the user can see what the assistant is doing while
          // the tool runs. The actual result will arrive in a subsequent
          // "user" / tool_result event and is rendered silently (the model
          // will summarize it in its next assistant text block).
          const toolName = typeof block.name === 'string' ? block.name : 'tool';
          const note = `\n\n_🔧 Using \`${toolName}\`…_\n\n`;
          fullResponse += note;
          onDelta(note);
        }
      }
      return;
    }

    // Tool results come back as `user` messages with `tool_result` content.
    // We don't render them inline (would clutter the chat) — the model will
    // summarize them in its next text block. But we do log for debug.
    if (parsed.type === 'user' && parsed.message?.content && Array.isArray(parsed.message.content)) {
      for (const block of parsed.message.content) {
        if (block?.type === 'tool_result') {
          debug('Assistant', 'tool_result for', block.tool_use_id, '(suppressed from UI)');
        }
      }
      return;
    }

    // Final result event — always carries the full assembled text + denial info.
    if (parsed.type === 'result') {
      if (Array.isArray(parsed.permission_denials)) {
        permissionDenials = parsed.permission_denials;
      }
      // If we never emitted any deltas (e.g. tool-call-only turn), seed from result.
      if (!fullResponse && typeof parsed.result === 'string' && parsed.result.length > 0) {
        fullResponse = parsed.result;
        onDelta(parsed.result);
      }
    }
  };

  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleParsedLine(JSON.parse(trimmed));
      } catch {
        debug('Assistant', 'Skipping unparseable NDJSON line:', trimmed.slice(0, 100));
      }
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('error', (error: Error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      claudeAvailableCache = null;
      onError('Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code');
    } else {
      onError(error.message);
    }
  });

  child.on('close', (code: number | null, signal: string | null) => {
    if (buffer.trim()) {
      try {
        handleParsedLine(JSON.parse(buffer.trim()));
      } catch {
        // Ignore trailing junk
      }
    }

    if (code !== 0) {
      const errorMsg = signal === 'SIGTERM'
        ? `Claude CLI timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`
        : stderr.trim() || `Claude CLI exited with code ${code}`;
      onError(errorMsg);
      return;
    }

    if (!fullResponse) {
      const stderrPreview = stderr.trim().slice(0, 500);
      const denialNote = permissionDenials.length > 0
        ? ` ${permissionDenials.length} tool call(s) were denied.`
        : '';
      onError(`Assistant returned no text.${denialNote}${stderrPreview ? ` Stderr: ${stderrPreview}` : ''}`);
      return;
    }

    // First successful turn (clean exit AND non-empty response) → switch to
    // `--resume` next time. Critical: if we set this before the empty-response
    // check above, a clean-exit-but-zero-output turn would mark the session
    // as started, and the *next* user message would `--resume <uuid>` against
    // a half-baked CLI session that never produced a real assistant turn.
    // The CLI then errors out or behaves unpredictably depending on version.
    session.claudeStarted = true;

    if (permissionDenials.length > 0) {
      const names = permissionDenials
        .map((d: any) => d?.tool_name || d?.toolName || 'unknown')
        .slice(0, 5)
        .join(', ');
      const note = `\n\n_Note: ${permissionDenials.length} tool call(s) were denied during this turn (${names})._`;
      fullResponse += note;
      onDelta(note);
    }

    onDone(fullResponse);
  });

  // For multi-turn via --resume, only send the latest user message — claude has the rest.
  child.stdin.on('error', () => { /* handled by 'close' */ });
  child.stdin.write(message);
  child.stdin.end();

  return child;
}

// ============================================================================
// Bedrock Fallback (Streaming)
// ============================================================================

async function streamFromBedrock(
  messages: AssistantMessage[],
  systemPrompt: string,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): Promise<void> {
  try {
    const { BedrockRuntimeClient, ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region: serverConfig.AWS_REGION });
    const appConfig = loadConfigSync();
    const modelId = resolveRegionAwareModelId(appConfig.judge?.model || serverConfig.BEDROCK_MODEL_ID);
    debug('Assistant', 'Using Bedrock model:', modelId);

    const trimmed = messages.slice(-FALLBACK_HISTORY_CAP);
    const bedrockMessages = trimmed.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: [{ text: msg.content }],
    }));

    const command = new ConverseStreamCommand({
      modelId,
      messages: bedrockMessages,
      system: [{ text: systemPrompt }],
      inferenceConfig: buildInferenceConfig(modelId, { maxTokens: 4096, temperature: 0.7 }),
    });
    const response = await client.send(command);

    let fullResponse = '';
    if (response.stream) {
      for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta && 'text' in event.contentBlockDelta.delta) {
          const text = event.contentBlockDelta.delta.text || '';
          fullResponse += text;
          onDelta(text);
        }
      }
    }
    onDone(fullResponse);
  } catch (error: any) {
    const msg = error.message || 'Unknown Bedrock error';
    if (msg.includes('ExpiredToken') || msg.includes('CredentialsProviderError')) {
      onError('AWS credentials expired or invalid. Please refresh your AWS credentials.');
    } else if (msg.includes('ThrottlingException')) {
      onError('Bedrock API rate limit exceeded. Please try again in a moment.');
    } else {
      onError(msg);
    }
  }
}

// ============================================================================
// LiteLLM Fallback (Non-streaming)
// ============================================================================

async function streamFromLiteLLM(
  messages: AssistantMessage[],
  systemPrompt: string,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): Promise<void> {
  try {
    const appConfig = loadConfigSync();
    const modelId = appConfig.judge?.model || 'gpt-4o';
    debug('Assistant', 'Using LiteLLM model:', modelId, 'endpoint:', serverConfig.OPENAI_COMPATIBLE_ENDPOINT);

    const trimmed = messages.slice(-FALLBACK_HISTORY_CAP);
    const litellmMessages = [
      { role: 'system', content: systemPrompt },
      ...trimmed.map((msg) => ({ role: msg.role, content: msg.content })),
    ];

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (serverConfig.OPENAI_COMPATIBLE_API_KEY) {
      headers['Authorization'] = `Bearer ${serverConfig.OPENAI_COMPATIBLE_API_KEY}`;
    }

    const res = await fetch(serverConfig.OPENAI_COMPATIBLE_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, messages: litellmMessages, temperature: 0.7, max_tokens: 4096 }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      onError(`LiteLLM responded ${res.status}: ${errorText}`);
      return;
    }

    const data = await res.json();
    const responseText: string = data.choices?.[0]?.message?.content ?? '';
    onDelta(responseText);
    onDone(responseText);
  } catch (error: any) {
    const msg = error.message || 'Unknown LiteLLM error';
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
      onError(`Cannot connect to LiteLLM endpoint (${serverConfig.OPENAI_COMPATIBLE_ENDPOINT}). Ensure the server is running.`);
    } else {
      onError(msg);
    }
  }
}

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Stream an assistant response for a given session and message.
 * Primary: claude CLI with --session-id / --resume continuity.
 * Fallback: configured LLM judge provider (Bedrock or LiteLLM).
 */
export function streamAssistantResponse(
  sessionId: string,
  message: string,
  context: AssistantContext | undefined,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): { abort: () => void } {
  const session = getSession(sessionId);

  const userMessage: AssistantMessage = {
    role: 'user',
    content: message,
    timestamp: new Date().toISOString(),
  };
  session.messages.push(userMessage);

  const handleDone = (fullResponse: string) => {
    session.messages.push({
      role: 'assistant',
      content: fullResponse,
      timestamp: new Date().toISOString(),
    });
    onDone(fullResponse);
  };

  const handleError = (error: string) => {
    const idx = session.messages.indexOf(userMessage);
    if (idx !== -1) session.messages.splice(idx, 1);
    onError(error);
  };

  let childProcess: ChildProcess | null = null;
  let aborted = false;

  // Build system prompt + grounded snapshot, then dispatch.
  // The fallback path uses the no-tools prompt; the Claude CLI path overrides
  // it below with the tools-enabled variant.
  //
  // Wrapped in try/catch around the entire IIFE body so that ANY uncaught
  // error — a synchronous throw from `loadConfigSync()`, a downstream
  // `streamFromBedrock`/`streamFromClaude` constructor that fails before
  // wiring up its own onError, etc. — surfaces to the caller via
  // `handleError` instead of becoming a silent unhandled promise rejection
  // that strands the UI in a perpetual "waiting for assistant" state.
  // The original code only caught `loadContextSnapshot` failures and would
  // swallow anything later in the dispatch chain.
  (async () => {
    try {
      const baseSystemPrompt = buildSystemPrompt(context, /* toolsAvailable */ false);
      let snapshot = '';
      try {
        snapshot = await loadContextSnapshot(context);
      } catch (err: any) {
        debug('Assistant', 'loadContextSnapshot failed:', err?.message);
        // Snapshot failure is non-fatal — we proceed without grounded context
        // rather than blocking the user's question. The CLI/LLM still gets
        // the base system prompt and conversation history.
      }
      const systemPrompt = baseSystemPrompt + snapshot;

      if (aborted) return;

      if (isClaudeAvailable()) {
        debug('Assistant', 'Using claude CLI for session:', sessionId);
        // Tools-enabled prompt for the real Claude Code session.
        const toolEnabledPrompt = buildSystemPrompt(context, /* toolsAvailable */ true) + snapshot;
        childProcess = streamFromClaude(session, message, toolEnabledPrompt, onDelta, handleDone, handleError);
        return;
      }

      const appConfig = loadConfigSync();
      const provider = appConfig.judge?.provider || 'bedrock';
      debug('Assistant', 'Claude CLI unavailable, falling back (provider:', provider, ')');

      if (provider === 'litellm' || provider === 'openai-compatible') {
        streamFromLiteLLM(session.messages, systemPrompt, onDelta, handleDone, handleError);
      } else {
        streamFromBedrock(session.messages, systemPrompt, onDelta, handleDone, handleError);
      }
    } catch (err: any) {
      // Last-ditch: nothing in the dispatch chain accepted responsibility for
      // this error. Tell the caller so the UI can render a real error state.
      // Skip if the user has already aborted — their abort intent supersedes
      // any in-flight failure and they don't want an error popup for a
      // request they cancelled.
      const msg = err?.message || String(err) || 'Assistant dispatch failed';
      debug('Assistant', 'Unhandled error in dispatch IIFE:', msg);
      if (!aborted) {
        handleError(msg);
      }
    }
  })();

  return {
    abort: () => {
      aborted = true;
      childProcess?.kill();
    },
  };
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
  debug('Assistant', 'Cleared session:', sessionId);
}

export function getSessionMessages(sessionId: string): AssistantMessage[] {
  const session = sessions.get(sessionId);
  return session ? [...session.messages] : [];
}
