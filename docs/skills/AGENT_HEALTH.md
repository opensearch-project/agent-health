# Agent Health - AI Assistant Instructions

Use these instructions to evaluate and improve your agent using the agent-health CLI and server APIs.

---

## Setup By AI Assistant

Copy this file into your project so your AI coding assistant auto-loads it —
either from a local checkout or straight from GitHub.

### Claude Code
```bash
mkdir -p .claude/skills
curl -o .claude/skills/agent-health.md \
  https://raw.githubusercontent.com/opensearch-project/agent-health/main/docs/skills/AGENT_HEALTH.md
# or, from a checkout: cp docs/skills/AGENT_HEALTH.md .claude/skills/
```
Auto-discovered as a skill.

### Kiro
```bash
mkdir -p .kiro/steering
curl -o .kiro/steering/agent-health.md \
  https://raw.githubusercontent.com/opensearch-project/agent-health/main/docs/skills/AGENT_HEALTH.md
```
Auto-loaded as a steering file.

### Cursor / Windsurf / Others
Copy to project root, then tell your assistant: "Read AGENT_HEALTH.md and follow it"

---

## Quick start — what to ask your assistant

Once this file is loaded, just ask:

```
"Evaluate my agent using agent-health and fix any failures"
```

Or step by step:

```
"Run an agent-health benchmark against my agent"
"What failed and why?"
"Fix the high-priority issues"
"Re-run to verify"
```

What happens under the hood:

```
1. Assistant runs: npx agent-health benchmark ...
        ↓
2. Gets JSON with failures + judge feedback (matcherResults + improvementStrategies)
        ↓
3. Reads your agent code
        ↓
4. Makes fixes based on the improvement strategies
        ↓
5. Re-runs the benchmark to verify
```

---

## Prerequisites

### Storage (file-based by default; OpenSearch optional)

Agent Health uses **file-based storage by default** — results are written to a
local `.agent-health/data/` directory and `run` / `benchmark` work with **no
OpenSearch cluster required**. Point at OpenSearch only when you want shared,
production-grade persistence (multiple machines / a team dashboard).

To use OpenSearch instead of file storage, set:

| Variable | Description |
|---|---|
| `OPENSEARCH_STORAGE_ENDPOINT` | OpenSearch cluster URL (e.g. `https://search-my-cluster.us-west-2.es.amazonaws.com`) |
| `OPENSEARCH_STORAGE_USERNAME` | OpenSearch username (basic auth) |
| `OPENSEARCH_STORAGE_PASSWORD` | OpenSearch password (basic auth) |

SigV4 auth (AWS profile **or** the default credential chain; `es` domains or
`aoss` Serverless collections), `none` (no auth), and basic auth are all
supported, configurable via env vars, `agent-health.config.json`, or the
Settings UI — see [docs/CONFIGURATION.md](https://github.com/opensearch-project/agent-health/blob/main/docs/CONFIGURATION.md).

### AWS Credentials for LLM Judge (Required)

The Bedrock LLM judge scores evaluation results and needs AWS credentials to call Bedrock.

| Variable | Description |
|---|---|
| `AWS_PROFILE` | AWS profile with Bedrock access |
| `AWS_REGION` | AWS region for Bedrock (e.g. `us-west-2`) |
| `BEDROCK_MODEL_ID` | *(Optional)* Default judge model ID. Default: `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |

### `.env` File

The CLI automatically loads a `.env` file from the current working directory (the folder where commands are run). Create a `.env` file with all required variables:

```bash
# OpenSearch Storage
OPENSEARCH_STORAGE_ENDPOINT=https://search-my-cluster.us-west-2.es.amazonaws.com
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=your-password

# AWS / Bedrock
AWS_PROFILE=your-aws-profile
AWS_REGION=us-west-2
# BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0  # optional, this is the default
```

Alternatively, pass `--env-file <path>` to load a `.env` file from a different location.

### Doctor Check

After configuring your environment, verify everything is set up correctly:

```bash
npx @opensearch-project/agent-health doctor
```

This checks OpenSearch connectivity, AWS credentials, and Bedrock access. Fix any reported issues before proceeding.

---

## Commands

```bash
# Verify setup
npx @opensearch-project/agent-health doctor --output json

# Generate config files
npx @opensearch-project/agent-health init

# List available resources
npx @opensearch-project/agent-health list agents --output json
npx @opensearch-project/agent-health list test-cases --output json
npx @opensearch-project/agent-health list benchmarks --output json

# Run single test case
npx @opensearch-project/agent-health run -t <test-case-id> -a <agent-key> --output json

# Run full benchmark with export
npx @opensearch-project/agent-health benchmark -n <benchmark-name> -a <agent-key> --export results.json

# Import test cases from JSON file and run benchmark
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -a <agent-key>

# Import with a custom benchmark name
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -n "My Benchmark" -a <agent-key>

# Export test cases from a benchmark (produces import-compatible JSON)
npx @opensearch-project/agent-health export -b <benchmark-name> -o test-cases.json
```

---

## Code-based test SDK (write tests as files)

Besides JSON test cases, Agent Health has an **experimental code-based SDK** for
writing tests as `.eval.js` / `.eval.ts` files (Playwright-style `test()` /
`expect()` / fixtures / `judge()` / lifecycle hooks). Run them the same way you
run a JSON file:

```bash
# `-f` accepts BOTH JSON test-case files and code SDK (.eval.js / .eval.ts) files
npx @opensearch-project/agent-health benchmark -f ./examples/eval-files/demo.eval.js -a my-agent
```

They produce **per-matcher results** (`matcherResults[]`) instead of a single
pass/fail. Full guide: [docs/SDK.md](https://github.com/opensearch-project/agent-health/blob/main/docs/SDK.md).

---

## Improvement Workflow

### Step 0: Verify Setup
```bash
npx @opensearch-project/agent-health doctor --output json
```
Confirm all checks pass before proceeding. Fix any issues reported.

### Step 1: Baseline Evaluation
```bash
npx @opensearch-project/agent-health benchmark -n "My Benchmark" -a my-agent --export baseline.json
```

### Step 2: Analyze Failures
Read `baseline.json` and find entries where `passFailStatus: "failed"`.

Key fields to examine:
- `matcherResults[*].reasoning` - the canonical judge verdict + reasoning per matcher (`llmJudgeReasoning` is a legacy, deprecated shim carrying the same text)
- `improvementStrategies` - Specific recommendations with priority
- `trajectory` - Step-by-step agent execution

> Distinguish **`failed`** (the agent answered, judge scored it below threshold)
> from **errored** (`metricsStatus: "error"` — the *evaluator itself* could not
> run, e.g. a judge validation error). Errored runs are **excluded** from
> pass-rate aggregation; don't treat them as agent misses.

### Step 3: Fix Based on Strategies
Focus on `priority: "high"` issues first:
```json
{
  "category": "Tool Usage",
  "issue": "Agent called search without time filter",
  "recommendation": "Always include start_time and end_time parameters",
  "priority": "high"
}
```

Read the agent's code and implement the recommendation.

### Step 4: Verify Fix
```bash
npx @opensearch-project/agent-health benchmark -n "My Benchmark" -a my-agent --export after-fix.json
```

Compare `passRate` between baseline and after-fix.

### Step 5: Iterate
Repeat until all high-priority issues are resolved.

---

## Output Reference

### Benchmark Export Structure
```json
{
  "benchmark": { "id": "...", "name": "...", "testCaseCount": 10 },
  "runs": [{
    "agent": { "key": "my-agent", "name": "My Agent" },
    "passed": 7,
    "failed": 3,
    "passRate": 70,
    "reports": [{
      "testCaseId": "tc-001",
      "passFailStatus": "failed",
      "metricsStatus": "ready",
      "metrics": { "accuracy": 45 },
      "matcherResults": [
        { "method": "llm-judge", "description": "identifies the root cause", "pass": false, "score": 0.45, "reasoning": "The agent failed because..." }
      ],
      "llmJudgeReasoning": "The agent failed because...",
      "improvementStrategies": [{
        "category": "Tool Usage | Reasoning | Completeness",
        "issue": "What went wrong",
        "recommendation": "How to fix it",
        "priority": "high | medium | low"
      }],
      "trajectory": [
        { "type": "thinking", "content": "Agent's reasoning..." },
        { "type": "action", "toolName": "search", "toolArgs": {} },
        { "type": "tool_result", "content": "...", "status": "SUCCESS" },
        { "type": "response", "content": "Final answer..." }
      ]
    }]
  }]
}
```

### Metrics, scoring, and run status

- **Metrics are evaluator-defined and heterogeneous.** Only the *RCA Default*
  evaluator emits a metric named `accuracy`. Other evaluators emit their own
  metric names (`tool_selection_accuracy`, `reasoning_coherence`,
  `bias_detection`, …) and custom evaluators emit whatever their
  `scoringConfig` defines. Don't assume `metrics.accuracy` exists.
- **A run's overall score** is the rounded mean of whatever numeric metrics the
  run's evaluator emitted (`null`/`—` when none), not a single "accuracy".
- **`matcherResults[]` is the canonical judge surface.** Read the judge verdict
  + reasoning from `matcherResults` entries (`method: 'llm-judge'`). Each entry
  is a `MatcherResult`: `{ description, pass (boolean), score? (0–1), method,
  reasoning?, durationMs? }`. `llmJudgeReasoning` is still populated as a
  backward-compatible shim but is deprecated.
- **Run status:** `passed` / `failed` come from `passFailStatus`; a separate
  **`errored`** state (`metricsStatus: 'error'`) means the evaluator could not
  run and is excluded from pass-rate denominators.

---

## Tips

1. **Always use `--output json`** for reliable parsing
2. **Use `--export`** to get full reports with improvement strategies
3. **Fix high-priority issues first** - they cause actual failures
4. **Compare trajectories** between passing and failing cases
5. **Make incremental changes** - one fix, then re-test
6. **Don't over-engineer** - fix the specific issue identified

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npx agent-health` not found | `npm install -g @opensearch-project/agent-health` |
| "No agents configured" | `npx agent-health init` (creates config with sample agents) |
| Server / config issues | `npx agent-health doctor` (checks config + connectivity) |
| "OpenSearch storage not configured" | Fine for local use — file-based storage is the default. Set `OPENSEARCH_STORAGE_*` only for shared / production persistence. |

> **Note (benchmark execution vs. reads):** file-based storage covers reads,
> single `run`s, and sample data, but **executing a multi-case `benchmark`
> currently requires an OpenSearch storage client** — without one the execute
> path returns `Cannot execute in sample-only mode`. Point `OPENSEARCH_STORAGE_*`
> at a cluster (a local security-disabled Docker OpenSearch on plain HTTP with
> `authType=none` is enough) before running `benchmark`.

---

## Benchmarking a local (subprocess) agent — gotchas

When you wrap a local CLI agent (Kiro, Claude Code, Pi, or your own script) as a
**subprocess** agent and run a `benchmark`, these are the traps that bite first
— check them before blaming the agent:

1. **Pin a real judge model — don't leave it on `demo`.** The `demo` provider is
   a mock judge that returns high pass rates without calling an LLM, so a run
   can look like "100% pass" while nothing was actually judged. Set the run's
   judge model to a real Bedrock model, e.g.
   `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, and confirm it's invocable in
   your account (`aws bedrock ... ` / `doctor`). If your pass rate looks too
   good, check the judge provider first.
2. **Raise the subprocess timeout for slow agents.** The subprocess connector
   defaults to a 5-minute (`300000` ms) timeout. A real ops/RCA agent can run
   ~10 min. Set it in your agent's `connectorConfig`:
   ```ts
   { key: 'my-ops-agent', connectorType: 'subprocess',
     connectorConfig: { timeout: 1200000 /* 20 min */, /* ... */ } }
   ```
3. **Fail loud on a wrong agent name.** If your wrapper points at an agent key
   that doesn't exist, the underlying CLI may silently fall back to a default
   agent — so you benchmark the wrong thing. Echo the resolved agent name in
   your wrapper and eyeball the first trajectory.
4. **Long runs + CLI SSE disconnects.** On runs longer than a few minutes the
   CLI's streaming connection can drop and report `0/0` / `fetch failed` **while
   the server keeps going**. The results are still persisted — read them back
   from storage (`list runs` / the UI run inspector / `--export`) rather than
   trusting the CLI summary.
5. **Watch for a stale server on the port.** If you patch/upgrade the package
   but a previously-started `npx` server is still bound to port 4001, your runs
   are served by the old code. Confirm which process owns the port
   (`lsof -i :4001` / a `/proc` sweep) and restart the one you actually patched
   (the server loads `server/dist/app.js`, not `index.js`).
6. **Judge `CredentialsProviderError` after a session rotates.** If your AWS
   sandbox session rotates, `AWS_SHARED_CREDENTIALS_FILE` can point at a stale/
   empty file and the judge fails. Re-vend credentials and restart the server
   with the AWS env explicit (`aws sts get-caller-identity` to confirm first).
7. **Local OpenSearch dying (exit 255) = memory pressure.** Give the container
   enough heap and run it with `--restart=unless-stopped`.
8. **Case schema is strict.** Test cases need `expectedOutcomes` (a
   **string[]**, not a singular `expectedOutcome` string) and a capitalized
   `difficulty` (`Easy` | `Medium` | `Hard`). Validate your converter output
   against a known-good case before importing 16 of them.

---

## Server API Reference

The Agent Health server runs on port 4001 and exposes the following REST APIs. All endpoints return JSON unless noted (SSE endpoints return `text/event-stream`).

### Health & Configuration

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check → `{ status: 'ok', version, service: 'agent-health' }` |
| GET | `/api/agents` | List all agents → `{ agents: AgentConfig[], total }` |
| POST | `/api/agents/custom` | Add custom agent → `{ name, endpoint, connectorType?, useTraces? }` |
| DELETE | `/api/agents/custom/:id` | Remove custom agent |
| GET | `/api/models` | List all models → `{ models: ModelConfig[], total }` |
| GET | `/api/debug` | Debug status → `{ enabled: boolean }` |
| POST | `/api/debug` | Toggle debug → `{ enabled: boolean }` |

### Agent Execution & Evaluation

| Method | Path | Description |
|---|---|---|
| POST | `/api/agent` | Proxy agent request (SSE) → `{ endpoint, payload, headers?, agentKey? }` |
| POST | `/api/evaluate` | Run evaluation (SSE) → `{ testCaseId?, testCase?, agentKey, modelId }` |

### Judge

| Method | Path | Description |
|---|---|---|
| POST | `/api/judge` | Evaluate a captured trajectory → `{ trajectory, expectedOutcomes? \| expectedTrajectory?, modelId?, evaluatorId?, runId?, logs?, agents? }` → `JudgeResponse` `{ passFailStatus, metrics, llmJudgeReasoning, improvementStrategies }` |
| GET | `/api/judge/bedrock-models` | Discover Bedrock judge models (`ListInferenceProfiles`) |
| GET | `/api/judge/openai-compatible-models` | List OpenAI-compatible models → `{ models, endpoint, configured }` (renamed from `/api/judge/litellm-models`) |
| GET | `/api/judge/anthropic-models` | Discover Anthropic-direct models (needs `ANTHROPIC_API_KEY`) |
| GET | `/api/judge/github-models` | Discover GitHub Models / Copilot models (needs `GITHUB_TOKEN`) |

**On `/api/judge`, `modelId` is the *judge* model** — the trajectory is already
captured, so there is no agent invocation here, and `/api/judge` does **not**
take a `judgeModelId`. The agent-vs-judge model distinction (where `modelId`
is the *agent's* LLM and `judgeModelId` is the *judge's*) applies to the run
endpoints — `POST /api/evaluate` and `POST /api/storage/evaluation-runs` — and
the CLI (`-m` / `--judge-model`). Agentic-provider judges (`pi` / `agent` /
`agentic` / `claude-code`) pick their own model and ignore the judge model id.
The run-level `matcherResults[]` are assembled by the runner from the judge's
response (see [Output Reference](#output-reference)); the raw `/api/judge`
primitive returns `llmJudgeReasoning`.

### Traces & Metrics

| Method | Path | Description |
|---|---|---|
| POST | `/api/traces` | Fetch traces → `{ traceId?, runIds?, startTime?, endTime?, size? }` → `{ spans, total, hasMore }` |
| GET | `/api/traces/health` | Traces health → `{ status: 'ok' \| 'error' }` |
| GET | `/api/metrics/:runId` | Run metrics → `{ totalTokens, costUsd, durationMs, llmCalls, toolCalls }` |
| POST | `/api/metrics/batch` | Batch metrics → `{ runIds: string[] }` → `{ metrics[], aggregate }` |

### Logs

| Method | Path | Description |
|---|---|---|
| POST | `/api/logs` | Fetch logs → `{ runId?, query?, startTime?, endTime?, size? }` → `{ logs[], total }` |

### Observability

| Method | Path | Description |
|---|---|---|
| GET | `/api/observability/health` | Check observability data source health |
| POST | `/api/observability/test-connection` | Test connection to observability cluster |
| GET | `/api/observability/defaults` | Get default OTEL index patterns |

### Storage: Test Cases

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/test-cases` | List test cases (latest versions). Query: `ids?`, `fields?`, `size?`, `after?` |
| GET | `/api/storage/test-cases/:id` | Get latest version of test case |
| GET | `/api/storage/test-cases/:id/versions` | Get all versions |
| GET | `/api/storage/test-cases/:id/versions/:version` | Get specific version |
| POST | `/api/storage/test-cases` | Create test case (v1) |
| PUT | `/api/storage/test-cases/:id` | Update (creates new version) |
| DELETE | `/api/storage/test-cases/:id` | Delete all versions |
| POST | `/api/storage/test-cases/bulk` | Bulk create |

### Storage: Benchmarks

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/benchmarks` | List benchmarks. Query: `fields?`, `size?` |
| GET | `/api/storage/benchmarks/:id` | Get by ID. Query: `fields?`, `runsSize?`, `runsOffset?` |
| GET | `/api/storage/benchmarks/:id/export` | Export test cases as JSON |
| POST | `/api/storage/benchmarks` | Create → `{ name, description?, testCaseIds }` |
| PUT | `/api/storage/benchmarks/:id` | Update |
| PATCH | `/api/storage/benchmarks/:id/metadata` | Update metadata |
| DELETE | `/api/storage/benchmarks/:id` | Delete |
| POST | `/api/storage/benchmarks/:id/execute` | Execute benchmark (SSE) → `{ runConfig: RunConfigInput }` |
| DELETE | `/api/storage/benchmarks/:id/runs/:runId` | Delete specific run |
| POST | `/api/storage/benchmarks/:id/cancel` | Cancel execution |
| POST | `/api/storage/benchmarks/:id/refresh-all-stats` | Recompute all run stats |

### Storage: Runs (TestCaseRun)

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/runs` | List runs. Query: `size?`, `from?`, `fields?` |
| GET | `/api/storage/runs/:id` | Get run by ID |
| POST | `/api/storage/runs` | Create run |
| PATCH | `/api/storage/runs/:id` | Update run |
| DELETE | `/api/storage/runs/:id` | Delete run |
| POST | `/api/storage/runs/search` | Search with filters |
| GET | `/api/storage/runs/by-test-case/:testCaseId` | Runs for test case |
| GET | `/api/storage/runs/by-benchmark/:benchmarkId` | Runs for benchmark |
| GET | `/api/storage/runs/by-benchmark-run/:benchmarkId/:runId` | Results for benchmark run |
| GET | `/api/storage/runs/iterations/:benchmarkId/:testCaseId` | Iterations for test case in benchmark |
| POST | `/api/storage/runs/:id/annotations` | Add annotation |

### Storage: Analytics

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/analytics` | Query analytics. Filters: `experimentId?`, `testCaseId?`, `agentId?`, `modelId?` |
| GET | `/api/storage/analytics/aggregations` | Aggregated metrics |
| POST | `/api/storage/analytics/search` | Complex search with aggregations |

### Storage: Reports

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/benchmarks/:id/report` | Download report. Query: `format?` ('json'\|'html'\|'pdf') |

### Storage: Evaluators

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/evaluators` | List evaluators (5 built-in system + custom) |
| GET | `/api/storage/evaluators/:id` | Get evaluator (latest version) |
| GET | `/api/storage/evaluators/:id/versions` | List all versions (newest first) |
| GET | `/api/storage/evaluators/:id/versions/:version` | Get a specific version snapshot |
| POST | `/api/storage/evaluators` | Create custom evaluator |
| PUT | `/api/storage/evaluators/:id` | Update (creates a new immutable version) |
| DELETE | `/api/storage/evaluators/:id` | Delete custom evaluator (system evaluators are protected) |

### Storage: Evaluation Runs (code-based SDK)

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/evaluation-runs` | List evaluation runs |
| GET | `/api/storage/evaluation-runs/:id` | Get evaluation run |
| POST | `/api/storage/evaluation-runs` | Start a run (SSE). Accepts `sources: [{ type: 'code-import', filenames }]` for `.eval.js` / `.eval.ts` SDK files, plus `agentKey`, `modelId`, `judgeModelId?`, `evaluatorId?` |
| POST | `/api/storage/evaluation-runs/:id/cancel` | Cancel a run |
| POST | `/api/storage/evaluation-runs/:id/promote` | Promote a run |

### Comparison

| Method | Path | Description |
|---|---|---|
| POST | `/api/comparison/cluster-failures` | Cluster regressed cases into named failure patterns (`knowledge` / `tool_gap` / `reasoning` / `other`) |
| GET | `/api/comparison/clusters/:clusterId` | Fetch a previously computed cluster by id |

### Storage: Admin

| Method | Path | Description |
|---|---|---|
| GET | `/api/storage/health` | Storage backend health |
| POST | `/api/storage/test-connection` | Test storage connection |
| POST | `/api/storage/init` | Initialize indexes |
| GET | `/api/storage/config/status` | Config status |
| POST | `/api/storage/config/storage` | Update storage config |
| POST | `/api/storage/config/observability` | Update observability config |

### Assistant (NEW)

| Method | Path | Description |
|---|---|---|
| POST | `/api/assistant/chat` | Chat with AI assistant (SSE) → `{ sessionId, message, context }` → `{ type: 'delta'\|'done', content }` |
| DELETE | `/api/assistant/session/:sessionId` | Clear session |
| GET | `/api/assistant/health` | Check assistant availability |

---

## UI Pages

The evaluation surface lives under `/evaluations/*`. The app uses
`BrowserRouter` — plain paths, no `#` prefix.

| Page | Route | Description |
|---|---|---|
| Dashboard | `/` | Overview with agent stats, recent runs, system health |
| Benchmarks | `/evaluations/benchmarks` | List benchmarks with pass rates, run counts, version badges |
| Benchmark Runs | `/evaluations/benchmarks/:id/runs` | Runs for a benchmark (split / tabs layout) |
| Run Inspector | `/evaluations/benchmarks/:id/runs/:runId/inspect` | Per-test-case results, trajectory, judge, traces |
| Test Cases | `/evaluations/test-cases` | List / create / edit / version test cases |
| Test Case Detail | `/evaluations/test-cases/:id` | Definition + runs with an inline live-run panel |
| Eval Runs | `/evaluations/runs` · `/evaluations/runs/:id` | Code-import (SDK) and ad-hoc run results |
| Evaluators | `/evaluators` · `/evaluators/:id` | Manage evaluators; version history + Git-style diff |
| Compare | `/compare/:benchmarkId?runs=a,b` | Diagnosis surface: verdict strip, first-divergence, failure clusters |
| Agent Traces | `/agent-traces` | OpenTelemetry trace explorer (timeline / flow) |
| Coding Agents | `/coding-agents` | Coding Agent Analytics (Claude Code / Kiro / Codex) |
| Settings | `/settings` | Configure agents, models, storage, observability connections |
| Assistant | `/assistant` | Full-page AI chat interface for help and analysis |

---

## Common Tasks

### Ask about a benchmark's results
"What's the pass rate for benchmark bench-xxx? Which test cases are failing and why?"
→ The assistant will query `/api/storage/benchmarks/:id` and `/api/storage/runs/by-benchmark/:id`

### Interpret judge reasoning
"Why did test case tc-xxx fail in run run-xxx? What should I fix?"
→ The assistant reads `llmJudgeReasoning` and `improvementStrategies` from the run

### Write a test case
"Help me write a test case for testing log search with time filters"
→ The assistant creates a test case with prompt, context, expectedOutcomes, and labels

### Analyze traces
"What are the most expensive LLM calls in run run-xxx?"
→ The assistant queries `/api/traces` and `/api/metrics/:runId` to find token-heavy spans

### Compare runs
"Compare the results of run A vs run B in benchmark bench-xxx"
→ The assistant fetches both runs and diffs pass/fail status, accuracy, and strategies

### Diagnose eval-vs-reality gaps
"My agent passes 8/9 in evals but fails in real life — why?"
→ The assistant investigates: fetches the runs and test cases, examines judge reasoning and expectedOutcomes, checks whether the evaluator is appropriate for the domain, and recommends tightening outcomes or creating a custom evaluator

---

## Evaluator System

### How Evaluation Works

1. Agent runs against a test case → produces a **trajectory** (thinking, action, tool_result, response steps)
2. The **judge** (LLM) receives the trajectory + expectedOutcomes and scores each outcome
3. Each outcome: Fully achieved = 1.0, Partially = 0.5, Not achieved = 0.0
4. `accuracy = (sum of scores / total outcomes) × 100`
5. Pass/Fail determined by evaluator's `passThreshold` + critical failure checks

### Built-in Evaluators

| ID | Name | Threshold | Key Metrics |
|---|---|---|---|
| `system-rca-default` | RCA Default | 70% | accuracy |
| `system-factuality` | Factuality | 80% | factual_accuracy, hallucination_rate, source_grounding |
| `system-tool-usage` | Tool Usage | 80% | tool_selection_accuracy, redundant_calls, tool_ordering |
| `system-reasoning-depth` | Reasoning Depth | 75% | reasoning_coherence, step_completeness, logical_validity |
| `system-safety` | Safety | 90% | safety_score, bias_detection, guardrail_adherence |

### Custom Evaluators

Create custom evaluators via the UI or API for domain-specific scoring:

```json
{
  "name": "My Domain Evaluator",
  "systemPrompt": "You are evaluating an agent for [domain]. CRITICAL CRITERIA: ...",
  "scoringConfig": {
    "metrics": [
      { "name": "routing_accuracy", "weight": 0.4, "scale": 100 },
      { "name": "tool_correctness", "weight": 0.4, "scale": 100 },
      { "name": "diagnostic_completeness", "weight": 0.2, "scale": 100 }
    ],
    "passThreshold": 85,
    "scale": 100
  }
}
```

Assign to a benchmark run via `evaluatorId` in the run config.

### When to Recommend Custom Evaluators

- **Domain has hard correctness rules**: specific CLI commands, valid syntax, routing tables, API formats
- **Default judge is too charitable**: agents pass evals but fail in real-world usage (eval-vs-reality gap)
- **Multiple independent dimensions**: routing correctness AND tool syntax AND diagnostic completeness all matter
- **70% threshold is too low**: critical domains (oncall, security, compliance) need 85%+

### Common Eval-vs-Reality Gap Causes

1. **expectedOutcomes describe results, not procedures**: Judge rewards "got the right answer" without verifying "used the right method"
2. **70% threshold too permissive**: Missing 30% of steps may be catastrophic in practice
3. **No tool-correctness validation**: Generic judge can't verify domain-specific tool syntax
4. **Trajectory compaction hides details**: toolOutput truncated to 1000 chars, content to 500 chars — wrong commands may be invisible to judge
5. **Test cases cleaner than reality**: Hand-authored prompts include hints that real incidents don't
6. **Single-turn evaluation**: Real work is iterative; test cases may compress multi-step workflows

### Fix Strategies (in order)

1. **Tighten expectedOutcomes**: Add negative constraints ("do NOT use X"), require specific tool names, specify correct syntax
2. **Raise passThreshold**: Set to 85%+ for critical domains
3. **Use `system-tool-usage` as secondary evaluator**: Catches redundant/wrong tool calls
4. **Create domain-specific custom evaluator**: Include explicit rubric criteria the generic judge can't verify
