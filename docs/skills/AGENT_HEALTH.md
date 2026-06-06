# Agent Health - AI Assistant Instructions

Use these instructions to evaluate and improve your agent using the agent-health CLI and server APIs.

---

## Setup By AI Assistant

### Claude Code
```bash
mkdir -p .claude/skills
cp AGENT_HEALTH.md .claude/skills/
```
Auto-discovered as a skill.

### Kiro
```bash
mkdir -p .kiro/steering
cp AGENT_HEALTH.md .kiro/steering/
```
Auto-loaded as a steering file.

### Cursor / Windsurf / Others
Copy to project root, then tell your assistant: "Read AGENT_HEALTH.md and follow it"

---

## Prerequisites

### OpenSearch Storage (Required)

Evaluations **require** an OpenSearch cluster to store results. Without it, all `run` and `benchmark` commands will fail with:

> OpenSearch storage not configured. Cannot run evaluations without storage.

Required environment variables:

| Variable | Description |
|---|---|
| `OPENSEARCH_STORAGE_ENDPOINT` | OpenSearch cluster URL (e.g. `https://search-my-cluster.us-west-2.es.amazonaws.com`) |
| `OPENSEARCH_STORAGE_USERNAME` | OpenSearch username |
| `OPENSEARCH_STORAGE_PASSWORD` | OpenSearch password |

### AWS Credentials for LLM Judge (Required)

The Bedrock LLM judge scores evaluation results and needs AWS credentials to call Bedrock.

| Variable | Description |
|---|---|
| `AWS_PROFILE` | AWS profile with Bedrock access |
| `AWS_REGION` | AWS region for Bedrock (e.g. `us-west-2`) |
| `BEDROCK_MODEL_ID` | *(Optional)* Model ID for the judge. Default: `anthropic.claude-3-5-sonnet-20241022-v2:0` |

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
# BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0  # optional, this is the default
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
- `llmJudgeReasoning` - Why it failed
- `improvementStrategies` - Specific recommendations with priority
- `trajectory` - Step-by-step agent execution

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
      "metrics": { "accuracy": 45 },
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

---

## Tips

1. **Always use `--output json`** for reliable parsing
2. **Use `--export`** to get full reports with improvement strategies
3. **Fix high-priority issues first** - they cause actual failures
4. **Compare trajectories** between passing and failing cases
5. **Make incremental changes** - one fix, then re-test
6. **Don't over-engineer** - fix the specific issue identified

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
| POST | `/api/judge` | Evaluate trajectory → `{ trajectory, expectedOutcomes?, modelId }` → `{ passFailStatus, metrics, llmJudgeReasoning, improvementStrategies }` |
| GET | `/api/judge/litellm-models` | List LiteLLM models → `{ models: string[], endpoint, configured }` |

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

| Page | Route | Description |
|---|---|---|
| Dashboard | `/` | Overview with agent stats, recent runs, system health |
| Benchmarks | `/benchmarks` | List all benchmarks with pass rates, run counts |
| Benchmark Detail | `/benchmarks/:id` | Benchmark runs, test case results, comparison |
| Run Detail | `/benchmarks/:benchmarkId/runs/:runId` | Individual run results with trajectory, judge reasoning |
| Traces | `/traces` | OpenTelemetry trace explorer with timeline/flow views |
| Settings | `/settings` | Configure agents, models, storage, observability connections |
| Use Cases | `/settings` (tab) | Manage test cases (create, edit, version) |
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
