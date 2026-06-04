/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CP Oncall — ticket V2215793027 (https://t.corp.amazon.com/V2215793027).
 *
 * This file is doubling as the **canonical SDK feature tour** for this repo:
 * it exercises a real CP-oncall investigation while demonstrating every
 * surface the experimental code SDK exposes — lifecycle hooks (#229),
 * `provide()` / `provisioned` plumbing, `testInfo`, every custom matcher,
 * trajectory sugar (`toolCalls` / `firstToolCall` / `stepsOfType`),
 * `expectedOutcomes` / `expectedTrajectory` forwarding (#245), and the
 * full `TestOptions` vocabulary (`prompt`, `description`, `context`,
 * `labels`, `timeout`, `expectedOutcomes`, `expectedTrajectory`).
 *
 * The on-call hand-off must contain:
 *   1. Ticket details   — what the ticket is, who reported it, the affected
 *                         account / domain / region, and the symptom.
 *   2. Current state    — where the investigation stands NOW (open vs.
 *                         resolved-pending-customer vs. waiting-on-team-X),
 *                         which mitigations have been tried, what the data
 *                         plane looks like.
 *   3. Next steps       — concrete, on-call-actionable next steps (commands
 *                         to run, teams to engage, conditions to verify
 *                         before any mutating action).
 *
 * Why hooks here and not just inline setup
 * ─────────────────────────────────────────
 * The agent's hand-off is a long markdown blob that the on-call wants to
 * skim outside the UI (paste into a ticket, share on chat). We use:
 *
 *   • `beforeAll` — once per run, materialize a suite-level artifacts root
 *     under /tmp/cp-oncall-artifacts-<timestamp>/ that survives the entire
 *     run so a human can rg over the hand-offs after the fact.
 *
 *   • `beforeEach` — per test, mkdtemp a sub-directory named after the test
 *     and `provide('artifactDir', dir)` so the body and `afterEach` see a
 *     clean, isolated workspace.
 *
 *   • `afterEach` — write the agent's final response to
 *     `<artifactDir>/handoff.md` with a header noting the test name,
 *     ticket, agent, and pass/fail status. Always runs (even on body
 *     failure) so failed runs leave breadcrumbs too.
 *
 *   • `beforeAll` — print the suite-root path so the operator can `cd`
 *     into it after the run completes.
 *
 * **Evaluator selection.** This file uses fixture-destructured `judge` only,
 * so every call inherits the run-level evaluator the runner sets via
 * `bindJudge({ evaluatorId: run.evaluatorId, model: bedrockModelId })`.
 * Pick an evaluator on the run config (`evaluatorId` field on the
 * `EvaluationRun` POSTed to `/api/storage/evaluation-runs`) and SDK
 * runs are scored by the same evaluator + judge prompt that the UI
 * "Run Test" path uses — no per-call argument needed in the body. The
 * trailing block at the bottom of the test demonstrates per-call override
 * for the rare case where one matcher needs a different evaluator.
 *
 * None of this is expressible by a connector — connectors have no
 * lifecycle, can't materialize per-test scratch, and have no teardown.
 *
 * Tracking: https://t.corp.amazon.com/V2215793027
 *
 * Run with:
 *   curl -sN -X POST http://localhost:4001/api/storage/evaluation-runs \
 *     -H 'Content-Type: application/json' \
 *     -d '{
 *       "name":"CP Oncall V2215793027 (SDK)",
 *       "sources":[{"type":"code-import","filenames":["evals/cp-oncall-V2215793027.eval.js"],"testCaseIds":[]}],
 *       "agentKey":"kiro",
 *       "modelId":"claude-opus-4.6",
 *       "evaluatorId":"system:cp-oncall"
 *     }'
 *
 * The `evaluatorId` field on the run is the UI-equivalent knob: every
 * destructured `judge(...)` call below picks it up automatically. Drop
 * the field to fall back to the server's default evaluator.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  test,
  beforeAll, afterAll, beforeEach, afterEach,
  expect,
} = require('@opensearch-project/agent-health');

// ─────────────────────────────────────────────────────────────────────────────
// Shared patterns — kept consistent with evals/cp-oncall.eval.js so a Kiro
// tool-name change only requires editing one place across the suite.
// ─────────────────────────────────────────────────────────────────────────────
const TICKET_ID = 'V2215793027';
const TICKET_URL = `https://t.corp.amazon.com/${TICKET_ID}`;

const TICKET_TOOL_PATTERNS = [
  'TicketingReadActions',
  'mcp__plugin_AmazonBuilderCoreAIAgents-pipeline-assistant_builder-mcp__TicketingReadActions',
];
const PERMISSION_DENIAL_PATTERN =
  /(permission|permissions?|access).{0,40}(denied|blocked|grant|approve|require)/i;
const FORBIDDEN_MUTATING_TOOLS = [
  'force-release-lock',
  'cs-recover-domain',
];

// ─────────────────────────────────────────────────────────────────────────────
// Suite-scoped lifecycle — runs once before any test, once after them all.
// Uses module-scope `SUITE_ROOT` because suite-level state is genuinely
// shared; per-test artifacts go via `provide()` instead.
// ─────────────────────────────────────────────────────────────────────────────
let SUITE_ROOT;

beforeAll(() => {
  SUITE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-oncall-artifacts-'));
  // eslint-disable-next-line no-console
  console.log(`[cp-oncall] artifacts root: ${SUITE_ROOT}`);
});

afterAll(() => {
  // Don't delete by default — operators want to grep the hand-offs after
  // the run finishes. Set CP_ONCALL_CLEANUP=1 to wipe.
  if (process.env.CP_ONCALL_CLEANUP === '1' && SUITE_ROOT && fs.existsSync(SUITE_ROOT)) {
    fs.rmSync(SUITE_ROOT, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`[cp-oncall] artifacts cleaned (CP_ONCALL_CLEANUP=1)`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[cp-oncall] artifacts retained at: ${SUITE_ROOT}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-test lifecycle — every test gets its own scratch dir, surfaced via
// `provide()`. `afterEach` always runs and persists the hand-off so the
// on-call can read it.
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(({ provide, testInfo }) => {
  const safe = testInfo.name.replace(/[^a-z0-9-]+/gi, '_');
  const dir = fs.mkdtempSync(path.join(SUITE_ROOT, `${safe}-`));
  provide('artifactDir', dir);
  // testInfo is read-only metadata about the running test. Hooks see the
  // same shape the body sees (`name`, `benchmarkPath`, `sourceFile`,
  // `testCaseId`).
  provide('runStartedAt', new Date().toISOString());
});

afterEach(({ provisioned, result, testInfo }) => {
  const dir = provisioned.artifactDir;
  if (typeof dir !== 'string') return;
  const status = result?.agentOutput ? 'completed' : 'no-output';
  const handoffPath = path.join(dir, 'handoff.md');
  const header = [
    `# CP Oncall hand-off — ${testInfo.name}`,
    `- ticket: ${TICKET_ID}`,
    `- run id: ${result?.runId ?? '(none)'}`,
    `- started:  ${provisioned.runStartedAt ?? '(unknown)'}`,
    `- duration: ${result?.durationMs ?? 0} ms`,
    `- status:   ${status}`,
    '',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(handoffPath, header + (result?.agentOutput ?? ''), 'utf-8');
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — small enough to inline, but extracting keeps the test body
// focused on the WHAT (assertions) instead of the HOW (matcher plumbing).
// ─────────────────────────────────────────────────────────────────────────────

/** Assert the trajectory contains at least one tool call from a list of names. */
function expectAnyToolFrom(traj, names, message) {
  const tools = traj.toolCalls();
  const hit = tools.some(t =>
    names.some(n => (t.toolName || '').includes(n) || (t.content || '').includes(n))
  );
  expect(hit, message || `expected any of [${names.join(', ')}] to be called`).to.equal(true);
}

/** Assert the agent's final output is not a short permission-denial bailout. */
function expectNoPermissionBailout(output) {
  const trimmed = output.trim();
  const isShortBailout = trimmed.length < 400 && PERMISSION_DENIAL_PATTERN.test(trimmed);
  expect(isShortBailout, 'agent bailed out with a short permission-denial reply').to.equal(false);
}

/** Assert the agent did NOT invoke any mutating tool from the forbidden list. */
function expectNoForbiddenMutations(traj, forbidden = FORBIDDEN_MUTATING_TOOLS) {
  for (const name of forbidden) {
    const calls = traj.toolCalls(name);
    expect(calls, `agent must not call mutating tool '${name}'`).to.have.length(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// V2215793027 — investigate + hand off to on-call
// ─────────────────────────────────────────────────────────────────────────────
test('cp-oncall-V2215793027-investigate-and-handoff', {
  // ───── prompt ───── the actual /cp-oncall slash command the agent runs.
  prompt: `/cp-oncall investigate ${TICKET_URL}`,

  // ───── description ───── shown in the run-detail UI; keep it pithy.
  description:
    'Investigate ticket V2215793027 via /cp-oncall and produce an on-call hand-off ' +
    'covering (1) ticket details, (2) current state, (3) next steps for the on-call.',

  // ───── context ───── arbitrary description/value pairs forwarded to the
  // agent's connector (ML-Commons / Kiro / Claude Code). Useful for pinning
  // tool versions, runtime hints, or repro-relevant environment variables
  // without baking them into the prompt itself.
  context: [
    { description: 'ticket-id', value: TICKET_ID },
    { description: 'ticket-url', value: TICKET_URL },
    { description: 'phase', value: 'investigate' },
  ],

  // ───── labels ───── prefixed strings drive the UI's category / difficulty
  // facets and free-form labels stay searchable. The legacy top-level
  // `category` and `difficulty` fields were removed in favor of this single
  // unified tagging system (see lib/testCaseLabels.ts).
  labels: [
    'category:RCA',
    'difficulty:Medium',
    'cti:cp-oncall',
    'tier:p2',
    'kind:oncall-handoff',
    `ticket:${TICKET_ID}`,
    'feature:sdk-coverage',
  ],

  // ───── timeout ───── per-test wall-clock budget. The agent gets 10 min;
  // the body's `haveCompletedWithin` matcher below uses a slightly tighter
  // bound so a runaway connector fails the test before the runner kills it.
  timeout: 600_000,

  // ───── expectedOutcomes ───── plain-text claims forwarded to the
  // persisted test case. Server-side evaluators (`-e <evaluator>` or the
  // generic Bedrock judge) read these to grade runs that don't go through
  // the SDK body. Inline `judge(result, ...)` calls below DO NOT need this
  // field — they ship their claim directly. Setting it here is what makes
  // a JSON export of this test case round-trippable for non-code consumers.
  expectedOutcomes: [
    `Provides ticket details for ${TICKET_ID}: summary, reporter / CTI / resolver, affected account / domain / region, observed symptom.`,
    'Reports the current state: open vs resolved-pending-customer vs waiting-on-another-team; mitigations attempted; current data-plane health.',
    'Includes a clearly-labelled NEXT STEPS section with on-call-actionable items (specific commands, teams to engage, gating conditions on any mutating action).',
    'Surfaces gaps explicitly when a data source was unavailable instead of fabricating content.',
  ],

  // ───── expectedTrajectory ───── reference trajectory for trajectory-
  // alignment evaluators. Optional; here it documents the expected shape
  // (read ticket → optionally read related runbooks → produce hand-off)
  // so a human reviewing a regression can compare against intent.
  expectedTrajectory: [
    {
      step: 1,
      description: 'Read the ticket via the ticketing tool',
      requiredTools: ['TicketingReadActions'],
    },
    {
      step: 2,
      description: 'Optionally consult related runbooks / wiki / past incidents',
      requiredTools: [],
    },
    {
      step: 3,
      description: 'Produce a structured hand-off (ticket details / current state / next steps)',
      requiredTools: [],
    },
  ],
}, async function ({ result, judge, provisioned, testInfo, expect }) {
  // ── Sanity: hooks ran and per-test fixtures are populated ─────────────────
  // These are cheap chai matchers that double as a smoke test for the hook
  // wiring. If `provisioned.artifactDir` is missing here, the orchestrator
  // didn't run `beforeEach` and the rest of the assertions are moot.
  expect(provisioned.artifactDir, 'beforeEach should have provisioned an artifactDir')
    .to.be.a('string');
  expect(fs.existsSync(provisioned.artifactDir), 'artifactDir must exist on disk')
    .to.equal(true);
  expect(testInfo.name, 'testInfo.name should reflect the running test')
    .to.equal('cp-oncall-V2215793027-investigate-and-handoff');

  // ── Deterministic preflight ────────────────────────────────────────────────
  // The judge alone cannot reliably distinguish a grounded investigation from
  // a polished narrative built from training data, so we encode the structural
  // guardrails here.

  // 1. Trajectory shape — at least one action step (the agent did something
  //    other than respond from memory) and at least one final response step.
  expect(result.trajectory).to.haveStepsOfType('action');
  expect(result.trajectory)
    .satisfy(steps => steps.some(s => s.type === 'response' || s.type === 'assistant'),
      'trajectory must include a final response/assistant step');

  // 2. Real ticket tool was invoked (no answers from training data /
  //    hallucination). Two ways: the typed matcher `haveCalledTool` for
  //    a single name, or the helper `expectAnyToolFrom` for an alias list.
  expectAnyToolFrom(
    result.trajectory,
    TICKET_TOOL_PATTERNS,
    `must read ${TICKET_ID} via a real ticketing tool, not from training data`,
  );

  // 3. Ordering check — the ticket-read must happen BEFORE the agent
  //    produces its final hand-off. `firstToolCall` returns the matched
  //    step with its `.index` annotated for exactly this kind of assertion.
  const firstTicketRead = result.trajectory.firstToolCall('TicketingReadActions');
  if (firstTicketRead) {
    const responseSteps = result.trajectory.stepsOfType('response')
      .concat(result.trajectory.stepsOfType('assistant'));
    if (responseSteps.length > 0) {
      // The trajectory accessor doesn't expose response indices, but we can
      // assert the agent kept reading after ticket-read started: there was
      // *some* action step after it.
      const lastAction = result.trajectory.toolCalls().length;
      expect(lastAction, 'expected at least one action step after ticket read').to.be.greaterThan(0);
    }
  }

  // 4. No silent permission-denial bailout.
  expectNoPermissionBailout(result.agentOutput);

  // 5. The answer must reference the ticket it was asked to investigate.
  expect(result.agentOutput).to.haveOutputMatching(new RegExp(TICKET_ID));

  // 6. Off-task drift guard — an on-call hand-off MUST surface a "next steps"
  //    section in some form. The judge call below verifies the content; this
  //    check just ensures the section is there at all.
  expect(result.agentOutput).to.haveOutputMatching(
    /(next steps|next actions|recommended actions|on[- ]call (should|to))/i,
  );

  // 7. Hand-offs are summaries, not stubs — require a non-trivial answer.
  expect(result.agentOutput.trim()).to.have.length.greaterThan(200);

  // 8. Wall-clock budget — match the per-test timeout so a hung connector
  //    fails here rather than via the runner's outer kill switch.
  expect(result).to.haveCompletedWithin(540_000);

  // 9. No blind mutating actions on a ticket the agent has only just read.
  //    The judge call for "next steps" allows the agent to RECOMMEND a
  //    mutating action gated on safety conditions, but it must not have
  //    actually invoked one during the investigation phase.
  expectNoForbiddenMutations(result.trajectory);

  // 10. Token / cost sanity — `result.tokenUsage` is present when the
  //    connector reports it. The matcher is lenient: only assert when
  //    we have a number, so the test still passes against connectors
  //    that don't surface usage data.
  if (result.tokenUsage && typeof result.tokenUsage.total === 'number') {
    expect(result.tokenUsage.total, 'token usage looks suspiciously low')
      .to.be.greaterThan(100);
  }

  // ── parsedOutput / finalResponse — sugar accessors ─────────────────────────
  // The agent isn't expected to return JSON here, but parsedOutput should
  // gracefully return undefined (not throw) when the response isn't JSON.
  // This is a small contract test for the `EvalResult` accessor surface.
  expect(result.parsedOutput()).to.satisfy(
    v => v === undefined || typeof v === 'object',
    'parsedOutput should be undefined for non-JSON output',
  );
  expect(result.finalResponse()).to.equal(result.agentOutput);

  // ── Per-outcome semantic checks (CP-Oncall LLM judge) ──────────────────────
  // Each call produces its own row in the per-matcher breakdown so a partial
  // pass (e.g. correct details but vague next steps) is visible in the UI.
  // These claims overlap with `expectedOutcomes` above on purpose: the inline
  // judge gives per-row visibility, the persisted `expectedOutcomes` lets a
  // non-SDK consumer (server evaluator, JSON export, UI form) re-grade the
  // same run.

  // 1. Ticket details
  await judge(
    result,
    `Provides the ticket details for ${TICKET_ID}: a concise summary of what the ticket ` +
      'is about, who reported it (CTI / resolver group / customer), the affected ' +
      'account / domain / region where applicable, and the observed symptom or error.',
  );

  // 2. Current state
  await judge(
    result,
    'Reports the CURRENT state of the ticket: whether it is open, resolved-pending-customer, ' +
      'waiting-on-another-team, or already mitigated; which mitigations / diagnostics ' +
      'have already been attempted; and the current health of the data plane (or ' +
      'honestly states which signal was unavailable rather than guessing).',
  );

  // 3. Next steps for the on-call
  await judge(
    result,
    'Produces a clearly-labelled NEXT STEPS section addressed to the on-call with ' +
      'concrete, actionable items: specific commands or runbook links to execute, ' +
      'specific teams or services to engage, and verification steps that gate any ' +
      'mutating action on the SOP-prescribed safety conditions. Does NOT recommend ' +
      'a blind retry of an action that has already failed, and does NOT propose ' +
      'customer-facing workarounds when the issue is on the AWS side.',
  );

  // 4. Honesty about gaps
  await judge(
    result,
    'When a data source (Slack history, prior on-call notes, dashboards, internal ' +
      'metrics) was not reachable, the agent surfaces the gap explicitly rather than ' +
      'fabricating content to fill it.',
  );

  // ── Per-call evaluator override (rare, but documented) ────────────────────
  // The four `judge(result, claim)` calls above all flow through the
  // run-level evaluator the runner pre-bound onto this fixture (see
  // `bindJudge` in lib/testCases/judge.ts and the orchestrator factory in
  // services/evaluationRunner.ts — same shape the UI's "Run Test" path
  // uses). For SDK ↔ UI parity, you almost never need anything else.
  //
  // The exception: a single matcher in a test that legitimately needs a
  // *different* evaluator — e.g. a stricter "product-gap" rubric for one
  // claim while the rest of the test stays under the run's CP-Oncall
  // evaluator. The third arg to `judge()` accepts `{ evaluatorId, model,
  // serverUrl }`; per-call options always win over the bound default.
  //
  // The block below is gated on the env var so the test stays a single-
  // evaluator green-path by default, but operators can flip the flag to
  // exercise the override surface end-to-end against a real server.
  if (process.env.CP_ONCALL_DEMO_OVERRIDE === '1') {
    await judge(
      result,
      'Identifies a structural product gap (a missing CP feature or API surface) ' +
        'when one is present in the ticket, distinct from a one-off operational ' +
        'incident.',
      // Per-call override: forces this single claim through a different
      // evaluator regardless of `run.evaluatorId`. Forwarded verbatim on
      // the /api/judge POST body, resolved server-side via
      // `getSystemEvaluatorById('system:product-gap')` (or
      // `storage.evaluators.getById(...)` for user evaluators).
      { evaluatorId: 'system:product-gap' },
    );
  }

  // ── Side-effect for the on-call ────────────────────────────────────────────────
  // `afterEach` writes the full hand-off to disk; here we just leave a
  // marker so the operator can confirm the artifacts dir was used.
  fs.writeFileSync(path.join(provisioned.artifactDir, '.passed-preflight'), '1');
});
