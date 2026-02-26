# Agent Health - AI Assistant Instructions

Use these instructions to evaluate and improve your agent using the agent-health CLI.

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
        { "type": "action", "toolName": "search", "toolArgs": {...} },
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
