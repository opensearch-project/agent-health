/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * workflow() — a deterministic series of steps with stochastic agent nodes.
 *
 * The shell (steps, concurrency fan-out, ledger, staging, consolidation) is
 * deterministic; the only non-deterministic nodes are the agent calls
 * (`runAgent`, and the Step-B `deriveAgentEdits`). This mirrors durable
 * workflow engines: deterministic control flow, stochastic activities.
 *
 * @example
 * ```ts
 * export default workflow('oncall-queue-and-improve', { agent: 'aos-oncall', concurrency: 4 })
 *   .step('fix-the-queue', async (wf) => {
 *     await wf.forEach(queue, { since: '24h' }, async (ticket) => {
 *       const run = await wf.runAgent(ticket, { feedback: wf.ledger(), writes: 'shadow' });
 *       wf.stage({ item: ticket, run });
 *     });
 *   })
 *   .step('consolidate-and-pr', async (wf) => {
 *     for (const c of await wf.consolidate(wf.staged()))
 *       await wf.raisePR(c.fix, { title: `fix: ${c.label}`, body: wf.ledger().render() });
 *   });
 * ```
 */

import type {
  AgentRunResult,
  Cluster,
  PRRequest,
  RunAgentOptions,
  SourceHandle,
  StagedItem,
  WorkItem,
  WorkflowConfig,
} from './types.js';
import { FeedbackLedger } from './ledger.js';
import { mapPool, type PoolStats } from './pool.js';
import { consolidate as consolidateFn } from './consolidate.js';

/** Seams the runner/CLI/tests can inject (agent invocation, PR raising, steering). */
export interface WorkflowRunOptions {
  since?: string;
  /** Overrides config.concurrency for this run. */
  concurrency?: number;
  /** Cap total items processed (e.g. `--limit 5` for a smoke loop). */
  limit?: number;
  mode?: 'new' | 'existing' | 'both';
  /** Don't raise PRs — log what would be raised. Default true for safety. */
  dryRun?: boolean;
  /** Replace the agent invocation (tests / headless). Defaults to connector resolution. */
  invoke?: (item: WorkItem, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** Replace PR raising (tests / GitHub wiring). Defaults to a dry-run log. */
  onPR?: (pr: PRRequest, artifact: unknown) => Promise<void>;
  /** Per-item human steering — return text to append to the ledger. */
  steer?: (run: AgentRunResult) => Promise<string | void> | string | void;
}

export interface ForEachOptions {
  since?: string;
  concurrency?: number;
  limit?: number;
}

export interface WorkflowContext {
  readonly config: WorkflowConfig;
  /** The run's cumulative feedback ledger (stable across steps). */
  ledger(): FeedbackLedger;
  /** Fan out over a source at bounded concurrency, invoking `handler` per item. */
  forEach(
    handle: SourceHandle,
    opts: ForEachOptions,
    handler: (item: WorkItem) => Promise<void>
  ): Promise<void>;
  /** Invoke the agent once for a work item. */
  runAgent(item: WorkItem, opts?: RunAgentOptions): Promise<AgentRunResult>;
  /** Stash a candidate fix without raising a PR. */
  stage(s: { item: WorkItem; run: AgentRunResult; signature?: string }): void;
  staged(): StagedItem[];
  /** Cluster staged fixes → one per fix-class. */
  consolidate(staged: StagedItem[]): Promise<Cluster[]>;
  /** Raise (or, in dry-run, log) a PR. */
  raisePR(artifact: unknown, pr: PRRequest): Promise<void>;

  // ── Step B (improve-the-agent) — depends on PR #267 profile primitives ──
  guidedSessions(opts?: { since?: string }): Promise<unknown[]>;
  profile(session: unknown, opts?: { feedback?: FeedbackLedger }): Promise<unknown>;
  deriveAgentEdits(
    profiles: unknown[],
    opts?: { repo?: string; ledger?: FeedbackLedger }
  ): Promise<unknown>;
}

export interface WorkflowResult {
  name: string;
  staged: StagedItem[];
  clusters: Cluster[];
  ledgerSize: number;
  prsRaised: number;
  peakConcurrency: number;
}

type StepFn = (wf: WorkflowContext) => Promise<void> | void;

export interface Workflow {
  readonly name: string;
  readonly config: WorkflowConfig;
  step(name: string, fn: StepFn): Workflow;
  run(opts?: WorkflowRunOptions): Promise<WorkflowResult>;
}

/** Derive a clustering signature for a run (cti → diagnosis line → unknown). */
function deriveSignature(item: WorkItem, output: string): string {
  const cti = item.meta?.['cti'];
  if (typeof cti === 'string' && cti.trim()) return cti.trim();
  const firstLine = (output || '').split('\n').map((l) => l.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : 'unknown';
}

/** Default agent invocation: resolve the connector from config and execute. */
async function connectorInvoke(
  config: WorkflowConfig,
  item: WorkItem,
  opts: RunAgentOptions
): Promise<AgentRunResult> {
  const [{ loadConfig }, { getConnectorForAgent }] = await Promise.all([
    import('@/lib/config/index.js'),
    import('@/services/connectors/registry.js'),
  ]);
  // Importing the connectors barrel auto-registers the browser-safe connectors
  // (agui, mock, rest, ...). server.js adds the server-only ones (claude-code,
  // subprocess, strands). Both are needed depending on the agent's connector.
  await import('@/services/connectors/index.js');
  try {
    await import('@/services/connectors/server.js');
  } catch {
    /* server-only connectors unavailable in this context — browser-safe still work */
  }
  const resolved = await loadConfig();
  const agent = resolved.agents.find(
    (a) => a.key === config.agent || a.name.toLowerCase() === config.agent.toLowerCase()
  );
  if (!agent) {
    throw new Error(
      `workflow agent '${config.agent}' not found in config. ` +
        `Define it in agent-health.config.ts (connectorType: 'claude-code' for aos-oncall).`
    );
  }

  // Inject cumulative feedback as context the agent reads this run.
  const feedbackText = opts.feedback?.render();
  const context = feedbackText
    ? [{ description: 'Cumulative oncall feedback', value: feedbackText }]
    : [];

  const connector = getConnectorForAgent(agent as any);
  const testCase = {
    id: item.id,
    name: item.id,
    description: '',
    initialPrompt: item.prompt,
    context,
  } as any;

  const modelId = Object.keys(resolved.models)[0] || 'claude-sonnet';
  const response = await connector.execute(
    agent.endpoint as string,
    { testCase, modelId, connectorConfig: (agent as any).connectorConfig },
    { type: 'none' } as any
  );

  const output = response.trajectory
    .filter((s) => s.type === 'response' || s.type === 'assistant')
    .map((s) => (s as any).content || '')
    .join('\n')
    .trim();

  return {
    item,
    trajectory: response.trajectory,
    output,
    runId: response.runId,
    signature: deriveSignature(item, output),
    traceIds: response.runId ? [response.runId] : [],
  };
}

export function workflow(name: string, config: WorkflowConfig): Workflow {
  const steps: Array<{ name: string; fn: StepFn }> = [];

  const wf: Workflow = {
    name,
    config,
    step(stepName: string, fn: StepFn): Workflow {
      steps.push({ name: stepName, fn });
      return wf;
    },
    async run(runOpts: WorkflowRunOptions = {}): Promise<WorkflowResult> {
      const ledger = new FeedbackLedger();
      const stagedItems: StagedItem[] = [];
      let clusters: Cluster[] = [];
      let prsRaised = 0;
      const stats: PoolStats = { peakConcurrency: 0 };
      const dryRun = runOpts.dryRun ?? true;

      const invoke =
        runOpts.invoke ?? ((item, o) => connectorInvoke(config, item, o));

      const ctx: WorkflowContext = {
        config,
        ledger: () => ledger,

        async forEach(handle, opts, handler) {
          const since = opts.since ?? runOpts.since;
          const all = await handle.fetch({ since });
          // Dedup on id, then cap with limit (CLI --limit / opts.limit).
          const seen = new Set<string>();
          const deduped = all.filter((i) => {
            if (seen.has(i.id)) return false;
            seen.add(i.id);
            return true;
          });
          const limit = opts.limit ?? runOpts.limit;
          const items =
            typeof limit === 'number' ? deduped.slice(0, limit) : deduped;
          const concurrency =
            opts.concurrency ?? runOpts.concurrency ?? config.concurrency ?? 1;
          await mapPool(items, concurrency, (item) => handler(item), stats);
        },

        runAgent(item, opts = {}) {
          return invoke(item, { writes: 'shadow', ...opts });
        },

        stage(s) {
          const signature = s.signature ?? s.run.signature;
          stagedItems.push({ item: s.item, run: s.run, signature });
        },

        staged: () => stagedItems,

        async consolidate(staged) {
          clusters = await consolidateFn(staged);
          return clusters;
        },

        async raisePR(artifact, pr) {
          prsRaised++;
          if (runOpts.onPR) {
            await runOpts.onPR(pr, artifact);
            return;
          }
          if (dryRun) {
            // eslint-disable-next-line no-console
            console.log(
              `[workflow:${name}] (dry-run) would raise PR: ${pr.title}` +
                (pr.repo ? ` → ${pr.repo}` : '')
            );
            return;
          }
          throw new Error(
            'raisePR: no onPR handler and dryRun=false. Wire a GitHub PR ' +
              'handler via run({ onPR }) or run with --dry-run.'
          );
        },

        // ── Step B stubs — wired once PR #267 profile primitives land ──
        async guidedSessions() {
          console.warn(
            `[workflow:${name}] guidedSessions() is not wired yet ` +
              '(depends on PR #267 profile primitives). Returning [].'
          );
          return [];
        },
        async profile() {
          throw new Error(
            'wf.profile() not implemented yet — depends on PR #267 ' +
              '(spansToTrajectory + the profile command exported to the SDK).'
          );
        },
        async deriveAgentEdits() {
          throw new Error(
            'wf.deriveAgentEdits() not implemented yet — this is the headless ' +
              'reasoner node (turns profiles + ledger into repo edits).'
          );
        },
      };

      // Expose steer so a step's handler can append per-item feedback.
      // (Steps call ctx.runAgent then optionally ctx.ledger().append(...).)
      if (runOpts.steer) {
        const baseRunAgent = ctx.runAgent.bind(ctx);
        ctx.runAgent = async (item, opts) => {
          const run = await baseRunAgent(item, opts);
          const fb = await runOpts.steer!(run);
          if (typeof fb === 'string' && fb.trim()) {
            ledger.append(fb, { ticketId: item.id });
          }
          return run;
        };
      }

      for (const s of steps) {
        await s.fn(ctx);
      }

      return {
        name,
        staged: stagedItems,
        clusters,
        ledgerSize: ledger.size,
        prsRaised,
        peakConcurrency: stats.peakConcurrency,
      };
    },
  };

  return wf;
}
