/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Trace Judge (RFC 004 §4.4, #244).
 *
 * An LLM judge that verifies its claims against the run's REAL OTel spans/logs
 * — not just the trajectory text — by running pi's agent loop **in-process**
 * (via the pi SDK, `createAgentSession`) with a restricted, read-only,
 * run-scoped trace-tool pack (`query_spans` / `query_logs`).
 *
 * In-process (SDK) rather than spawning the pi CLI: no subprocess, no NDJSON
 * stdout parsing, no extension file, no env-var scoping, no PATH/bin lookup.
 * File-mode traces are read via exact canonical NDJSON mounts; cluster-mode
 * query tools capture `runId` via closure so the model cannot pivot to other
 * runs. pi ships as the optionalDependency `@earendil-works/pi-coding-agent`.
 */

import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from '@/server/services/bedrockService';
import { parseJudgeResponse } from '@/server/services/judgeResponseParser';
import { buildJudgeDebug } from '@/server/services/judgeDebug';
import { createTraceJudgeExtension } from '@/server/services/traceJudgeTools';
import { createEvidenceJudgeExtension } from '@/server/services/evidenceJudgeTools';
import { buildJudgeEvidence, removeJudgeEvidence, type JudgeTraceMode } from '@/server/services/judgeEvidence';
import { RESTRICTED_COMMANDS } from '@/server/services/restrictedBash';
import type { PiSdk } from '@/server/services/piSdkTypes';
import { Evaluator } from '@/types';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';
import { regionInferencePrefix } from '@/lib/bedrockCompat';

/**
 * Default base prompt used when no saved evaluator's `systemPrompt` is provided.
 * A runtime evidence/tool addendum is appended to whatever base is in effect
 * (default or saved evaluator), so custom prompts cannot erase the actual
 * tool and immutable-evidence contract.
 */
const DEFAULT_AGENT_TRACE_JUDGE_BASE_PROMPT = `You are an expert evaluator for observability and Root Cause Analysis (RCA) agents.

When you are done investigating, respond with ONLY a JSON object (no prose, optionally fenced in \`\`\`json):
{
  "pass_fail_status": "passed" | "failed",
  "accuracy": <0-100>,
  "reasoning": "<concise explanation grounded in what the tools showed>",
  "metrics": { "faithfulness": <0-100>, "latency_score": <0-100>, "trajectory_alignment_score": <0-100> },
  "improvement_strategies": []
}`;

/** The runtime state used to compose a truthful evidence/tool addendum. */
export interface AgentTraceJudgePromptState {
  registeredTools: readonly string[];
  evidenceEntries: readonly string[];
  traceMode: JudgeTraceMode;
  traceDataExists: boolean;
}

type TreeNode = { directories: Map<string, TreeNode>; files: Set<string> };

const ENTRY_DESCRIPTIONS: Record<string, string> = {
  'evidence': 'immutable evidence',
  'evidence/testcase.json': 'original prompt + expected outcomes',
  'evidence/run.json': 'run id, agent, timings, metadata',
  'evidence/trajectory.json': 'FULL trajectory array',
  'evidence/trajectory.ndjson': 'one complete step per line',
  'evidence/steps': 'one complete file per step',
  'evidence/spans.ndjson': 'canonical trace-store mount (read-only)',
  'evidence/logs.ndjson': 'canonical log-store mount (read-only)',
  'evidence/workspace': 'canonical run-workspace mount (read-only)',
  'scratch': 'writable temporary analysis files',
};

/** Render the entries that really exist/mount; no template-only filenames. */
export function renderJudgeEvidenceTree(entries: readonly string[]): string {
  const root: TreeNode = { directories: new Map(), files: new Set() };
  for (const rawEntry of [...new Set(entries)]) {
    const isDirectory = rawEntry.endsWith('/');
    const parts = rawEntry.replace(/\/$/, '').split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - (isDirectory ? 0 : 1); i++) {
      const part = parts[i];
      let child = node.directories.get(part);
      if (!child) {
        child = { directories: new Map(), files: new Set() };
        node.directories.set(part, child);
      }
      node = child;
    }
    if (!isDirectory) node.files.add(parts.at(-1)!);
  }

  const lines = ['./'];
  const render = (node: TreeNode, prefix: string, parentPath: string) => {
    const children = [
      ...[...node.directories.entries()].map(([name, child]) => ({ name, child, directory: true })),
      ...[...node.files].map((name) => ({ name, child: undefined, directory: false })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    children.forEach((entry, index) => {
      const last = index === children.length - 1;
      const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const description = ENTRY_DESCRIPTIONS[entryPath];
      lines.push(`${prefix}${last ? '└──' : '├──'} ${entry.name}${entry.directory ? '/' : ''}${description ? `  # ${description}` : ''}`);
      if (entry.child) render(entry.child, `${prefix}${last ? '    ' : '│   '}`, entryPath);
    });
  };
  render(root, '', '');
  return lines.join('\n');
}

/**
 * Compose the immutable runtime addendum from the judgment's actual tree,
 * registered tools, active trace backend, and reachable trace data.
 */
export function composeAgentTraceToolAddendum(state: AgentTraceJudgePromptState): string {
  if (!state.registeredTools.includes('bash')) {
    throw new Error('Agent evidence judge requires the registered bash tool');
  }
  const tools = [...new Set(state.registeredTools)];
  const tree = renderJudgeEvidenceTree(state.evidenceEntries);
  const traceFiles = ['evidence/spans.ndjson', 'evidence/logs.ndjson']
    .filter((entry) => state.evidenceEntries.includes(entry));

  let traceSection: string;
  if (!state.traceDataExists) {
    traceSection = 'no trace data exists for this run — judge from trajectory evidence';
  } else if (state.traceMode === 'file') {
    const files = traceFiles.map((entry) => `\`${entry}\``).join(' and ');
    traceSection = `Trace data is mounted directly from the canonical file store as ${files}; these virtual entries are read-only and are not copies.\n\nTrace/trajectory join example:\n- \`jq -s '.[0] as $steps | .[1:] | map({spanId, name, tool: ."gen_ai.tool.name"}) as $spans | {trajectorySteps: ($steps|length), spans: $spans}' evidence/trajectory.json evidence/spans.ndjson\``;
  } else if (state.traceMode === 'cluster') {
    const traceTools = tools.filter((tool) => tool === 'query_spans' || tool === 'query_logs');
    traceSection = traceTools.length
      ? `Trace data exists in the configured OpenSearch cluster and is not mounted in the evidence tree. Query it with ${traceTools.map((tool) => `\`${tool}\``).join(' and ')}; this is the interim interface until a PPL tool lands.`
      : 'Trace data exists in the configured OpenSearch cluster but no trace-query tool is registered for this judgment.';
  } else {
    traceSection = 'Trace data exists but its backend is unavailable to this judgment.';
  }

  return `

---

## Complete judgment evidence + restricted tools

The trajectory embedded in the user prompt may be truncated. The tree below is rendered from the complete entries actually materialized or mounted for this judgment. Use the \`bash\` tool to inspect it; this is a safe in-process interpreter, NOT an operating-system shell.

Registered judgment tools: ${tools.map((tool) => `\`${tool}\``).join(', ')}.

\`\`\`
${tree}
\`\`\`

\`evidence/\` is READ-ONLY. Writes/redirections are allowed only under \`scratch/\` (100 MB / 500-file quota). The working directory is fixed at the tree root; \`cd\` is not supported. Every physical path is realpath-confined to this tree and symlinks are rejected. Explicit virtual mounts resolve only to their declared canonical read-only files or workspace tree. Output is capped near 50 KB; narrow broad queries.

Available restricted bash commands: ${RESTRICTED_COMMANDS.map((command) => `\`${command}\``).join(', ')}. Sequences (\`;\`, \`&&\`, \`||\`), pipelines, quoted arguments, \`<\`, and \`>/>> scratch/...\` are supported. Variables/expansion, command substitution, backticks, globs, subshells, and background \`&\` are rejected.

Two jq examples:
- \`jq -r '.expectedOutcomes[]' evidence/testcase.json\`
- \`jq -r '.[] | select(.type=="action") | .toolName' evidence/trajectory.json | sort | uniq -c\`

${traceSection}

Before returning a verdict, you MUST use restricted \`bash\` to inspect \`evidence/testcase.json\` and the complete trajectory files (at least two focused commands). PREFER real evidence over the narrative. Confirm evidence before crediting a tool call, budget claim, file-safety claim, or root-cause claim.`;
}

/**
 * Dynamically load the pi SDK (optionalDependency). Throws a clear, actionable
 * error when it isn't installed rather than a raw module-not-found.
 *
 * The specifier is held in a variable (not a string literal) so tsc does NOT
 * statically resolve `@earendil-works/pi-coding-agent` at compile time — the
 * package is optional and may be absent (CI / platforms where its native
 * install scripts fail), and a literal `import()` would make the build require
 * it. The runtime result is cast to the local {@link PiSdk} surface.
 */
async function loadPiSdk(): Promise<PiSdk> {
  const PI_SDK_MODULE = '@earendil-works/pi-coding-agent';
  try {
    return (await import(PI_SDK_MODULE)) as unknown as PiSdk;
  } catch (err: any) {
    throw new Error(
      'Agent judge requires the optional dependency "@earendil-works/pi-coding-agent". ' +
        'Reinstall agent-health without --no-optional, or run `npm i @earendil-works/pi-coding-agent`. ' +
        `(${err?.message ?? String(err)})`
    );
  }
}

/** Strip the Bedrock inference-profile region prefix (us./eu./global./au.). */
function bedrockBaseId(id: string): string {
  return id.replace(/^(us|eu|global|au)\./, '');
}

/**
 * Compose the final system prompt the trace judge will see.
 *
 * Two-layer composition:
 *   1. Base prompt: the saved evaluator's `systemPrompt` (when non-empty),
 *      else the default. This is the surface the user iterates on.
 *   2. A runtime-composed addendum is ALWAYS appended on top. It describes
 *      only tools registered and files materialized/mounted for this exact
 *      judgment. A regression test pins that it survives custom base prompts.
 *
 * Exported for unit testing; production callers go through
 * {@link evaluateWithPiAgenticTrace}.
 */
export function buildAgentTraceJudgeSystemPrompt(
  evaluator: { systemPrompt?: string } | undefined,
  state: AgentTraceJudgePromptState
): string {
  const baseSystemPrompt =
    evaluator?.systemPrompt && evaluator.systemPrompt.trim().length > 0
      ? evaluator.systemPrompt
      : DEFAULT_AGENT_TRACE_JUDGE_BASE_PROMPT;
  return baseSystemPrompt + composeAgentTraceToolAddendum(state);
}

/**
 * Find the registry model matching the run's configured judge model id.
 *
 * Claude 4.x on Bedrock can only be invoked via an inference profile (a model
 * id prefixed with the region, e.g. `us.`/`global.`), NOT the bare id — the
 * bare id fails with "on-demand throughput isn't supported". So among models
 * sharing the requested base id we prefer, in order: the region-appropriate
 * profile, a `global.` profile, any prefixed profile, then the bare id.
 */
export function findRequestedModel<T extends { provider: string; id: string }>(
  models: T[],
  requestedId?: string
): T | undefined {
  if (!requestedId) return undefined;
  const want = bedrockBaseId(requestedId);
  const candidates = models.filter((m) => bedrockBaseId(m.id) === want);
  if (!candidates.length) return undefined;
  const rp = regionInferencePrefix();
  return (
    candidates.find((m) => m.id.startsWith(rp)) ??
    candidates.find((m) => m.id.startsWith('global.')) ??
    candidates.find((m) => bedrockBaseId(m.id) !== m.id) ?? // any inference-profile variant
    candidates[0]
  );
}

/** Pick a judge model from the available (credentialed) models, preferring a recent Claude. */
export function pickJudgeModel<T extends { provider: string; id: string }>(models: T[]): T | undefined {
  if (!models.length) return undefined;
  const score = (m: T) => {
    const id = m.id.toLowerCase();
    let s = 0;
    if (id.includes('sonnet')) s += 100;
    else if (id.includes('opus')) s += 90;
    else if (id.includes('claude')) s += 50;
    // Prefer an inference-profile (region-prefixed) Claude 4.x; the 4.x bare
    // ids fail on-demand on Bedrock, and the older 3.x models are penalized.
    if (id.includes('-4-5') || id.includes('-4-6')) s += 20;
    else if (id.includes('-4-') || id.includes('sonnet-4') || id.includes('opus-4')) s += 15;
    if (id.includes('claude-3') || id.includes('-3-5') || id.includes('-3-7')) s -= 40;
    // Prefer region/global inference profiles over bare ids (bare 4.x can't run on-demand).
    if (id.startsWith(regionInferencePrefix()) || id.startsWith('global.')) s += 8;
    else if (/^(eu|au|apac)\./.test(id)) s -= 8; // wrong-region profile
    return s;
  };
  return [...models].sort((a, b) => score(b) - score(a))[0];
}

/** Extract the final assistant text (the verdict JSON) from pi session messages. */
export function extractFinalAssistantText(messages: any[]): string {
  let last = '';
  for (const m of messages ?? []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('');
    if (text.trim()) last = text;
  }
  return last;
}

/**
 * Evaluate a trajectory with the agent trace judge (in-process pi SDK).
 *
 * The complete trajectory is materialized as immutable evidence before the
 * prompt's compact copy is built. A runId is optional: when absent, trace
 * tools report "no run id", while the restricted evidence tool remains fully
 * functional for trajectory-only judgment.
 *
 * @param request - The judge request; runId is optional trace correlation.
 * @param evaluator - Optional saved evaluator. When provided, its `systemPrompt`
 *   replaces the default base prompt; the runtime evidence/tool addendum is
 *   ALWAYS appended on top. Its `scoringConfig.metrics` drives dynamic metric
 *   extraction in the parsed response.
 */
export async function evaluateWithPiAgenticTrace(
  request: JudgeRequest,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs, runId, agents } = request;

  debug('AgentJudge', '========== AGENT TRACE JUDGE (in-process) ==========');
  debug('AgentJudge', 'runId:', runId ?? '(none)', 'trajectory steps:', trajectory.length);
  debug('AgentJudge', 'Evaluator:', evaluator ? `${evaluator.name} (${evaluator.id})` : '(none, using default prompt)');

  const userPrompt = buildEvaluationPrompt(trajectory, expectedOutcomes, expectedTrajectory, logs);
  const serverUrl =
    process.env.AH_JUDGE_SERVER_URL ||
    `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;
  const startTime = Date.now();
  const evidence = await buildJudgeEvidence(request, serverUrl);
  const bashCommands: string[] = [];
  const keepEvidence =
    request.keepEvidence === true ||
    ['1', 'true', 'yes'].includes(String(process.env.AH_JUDGE_KEEP_EVIDENCE ?? '').toLowerCase());
  const useClusterTraceTools = evidence.trace.mode === 'cluster' && evidence.trace.exists && !!runId;
  const registeredTools = useClusterTraceTools
    ? ['bash', 'query_spans', 'query_logs']
    : ['bash'];
  debug('AgentJudge', 'Evidence directory:', evidence.rootDir);
  debug('AgentJudge', 'Evidence files:', evidence.files);
  debug('AgentJudge', 'Evidence mounts:', evidence.mounts);
  debug('AgentJudge', 'Registered tools:', registeredTools);
  if (keepEvidence && evidence.mounts.length) {
    console.info(`[AgentJudge] Evidence mounts: ${JSON.stringify(evidence.mounts)}`);
  }

  try {
    const { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, getAgentDir } =
      await loadPiSdk();

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const available = await modelRegistry.getAvailable();
    // Prefer the exact model the run is configured to judge with; fall back to a
    // recent Claude from the credentialed models.
    const model = findRequestedModel(available, request.modelId) ?? pickJudgeModel(available);
    if (!model) {
      throw new Error(
        'Agent judge: no model available. Configure a default pi model (e.g. a Bedrock or Anthropic model with valid credentials).'
      );
    }
    debug('AgentJudge', 'model:', `${model.provider}/${model.id}`);

    const systemPrompt = buildAgentTraceJudgeSystemPrompt(evaluator, {
      registeredTools,
      evidenceEntries: evidence.files,
      traceMode: evidence.trace.mode,
      traceDataExists: evidence.trace.exists,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: evidence.rootDir,
      agentDir: getAgentDir(),
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        ...(useClusterTraceTools ? [createTraceJudgeExtension(runId, serverUrl, agents)] : []),
        createEvidenceJudgeExtension(evidence.rootDir, {
          mounts: evidence.mounts,
          onCommand: (command) => {
            bashCommands.push(command);
            debug('AgentJudge', 'restricted bash:', command);
            if (keepEvidence) console.info(`[AgentJudge] restricted bash: ${command}`);
          },
        }),
      ],
      // Full isolation for this HEADLESS in-process session. Only the inline
      // factories above register tools; all user extensions/built-ins stay disabled.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      model,
      authStorage,
      modelRegistry,
      resourceLoader,
      tools: registeredTools,
      sessionManager: SessionManager.inMemory(),
    });

    await session.prompt(userPrompt);
    const finalText = extractFinalAssistantText(session.messages);
    const duration = Date.now() - startTime;
    const parsed = parseJudgeResponse(finalText, { evaluator, duration, source: 'AgentJudge' });
    debug('AgentJudge', 'Pass/Fail:', parsed.passFailStatus, 'in', duration, 'ms');
    const judgeDebug = buildJudgeDebug({
      provider: 'agent',
      modelId: `${model.provider}/${model.id}`,
      evaluatorId: evaluator?.id,
      systemPrompt,
      userPrompt,
    });
    if (judgeDebug) {
      parsed.judgeDebug = {
        ...judgeDebug,
        toolCalls: bashCommands.map((command) => ({ tool: 'bash', command })),
      };
    }
    return { ...parsed, improvementStrategies: [] };
  } finally {
    if (keepEvidence) {
      console.info(`[AgentJudge] Keeping evidence directory: ${evidence.rootDir}`);
    } else {
      await removeJudgeEvidence(evidence);
    }
  }
}
