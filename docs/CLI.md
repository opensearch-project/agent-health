<!--
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
-->

# CLI Reference

## Quick Start

```bash
npx @opensearch-project/agent-health                    # Start server + open UI
npx @opensearch-project/agent-health run -t <id>        # Run single test case
npx @opensearch-project/agent-health benchmark           # Run all test cases (quick mode)
npx @opensearch-project/agent-health benchmark -f <file> # Import test cases from file and run
```

## Installation

```bash
npm install -g @opensearch-project/agent-health   # Global install
npx @opensearch-project/agent-health <command>    # No install required
```

---

## Commands

### serve (default)

Start the web server. This is the default action when no subcommand is specified.

```
agent-health [serve] [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <n>` | Server port | `4001` |
| `-e, --env-file <path>` | Load env file | `.env` |
| `--no-browser` | Skip auto-open browser | - |

```bash
agent-health --port 8080 --env-file prod.env
agent-health serve -p 8080 --no-browser
```

---

### list

List available resources.

```
agent-health list <resource> [-o table|json]
```

| Resource | Aliases | Description |
|----------|---------|-------------|
| `agents` | | Configured agents |
| `connectors` | | Available connectors |
| `models` | | Available models |
| `test-cases` | `testcases`, `tc` | Stored test cases |
| `benchmarks` | `bench` | Stored benchmarks |

```bash
agent-health list agents
agent-health list tc -o json
agent-health list bench
```

---

### run

Run a single test case evaluation.

```
agent-health run -t <test-case> [options]
```

| Option | Description |
|--------|-------------|
| `-t, --test-case <id>` | Test case ID or name **(required)** |
| `-a, --agent <key>` | Agent key (repeatable for comparison) |
| `-m, --model <id>` | Agent's LLM model id (agent default if omitted) |
| `-e, --evaluator <id>` | Evaluator ID (RCA Default if omitted) |
| `--judge-model <id>` | Judge LLM model id, distinct from `-m`. Falls back to the evaluator's `inferenceConfig.modelId`, then `BEDROCK_MODEL_ID`. Ignored by agentic judges (`pi`/`agent`/`agentic`/`claude-code`). |
| `-o, --output <fmt>` | Output: `table`, `json` |
| `-v, --verbose` | Show full trajectory |

```bash
agent-health run -t demo-otel-001 -a ml-commons -v
agent-health run -t demo-otel-001 -a ml-commons -a claude-code  # compare agents
```

---

### benchmark

Run a benchmark (batch of test cases) against one or more agents.

```
agent-health benchmark [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --name <name>` | Benchmark name or ID | - |
| `-f, --file <path>` | Test-case file to import and benchmark (repeatable). Accepts **JSON** test cases *and* **code SDK** files (`.eval.js` / `.eval.ts`) | - |
| `-d, --dir <path>` | Directory of test-case JSON files (repeatable) | - |
| `-t, --test-case <id>` | Specific stored test case ID (repeatable) | - |
| `--label <label>` | Filter stored test cases by label (repeatable, AND logic) | - |
| `-a, --agent <key>` | Agent key (repeatable) | First enabled agent |
| `-m, --model <id>` | Agent's LLM model id | Agent default |
| `-e, --evaluator <id>` | Evaluator ID | RCA Default |
| `--judge-model <id>` | Judge LLM model id, distinct from `-m` (see `run` above) | Evaluator / `BEDROCK_MODEL_ID` |
| `-c, --concurrency <n>` | Test cases to run in parallel | `1` |
| `-o, --output <fmt>` | Output: `table`, `json` | `table` |
| `--export <path>` | Export results to file | - |
| `--format <type>` | Report format for `--export`: `json`, `html`, `pdf` | `json` |
| `-v, --verbose` | Show per-test-case results and errors | - |
| `--stop-server` | Stop the server after benchmark completes | Keep running |

**Modes:**
- **Quick mode** (no `-n`, no `-f`): Auto-creates a benchmark from all stored test cases
- **Named mode** (`-n <name>`): Runs a specific existing benchmark
- **File mode** (`-f <path>`): Imports test cases from a JSON file **or runs a code SDK file** (`.eval.js` / `.eval.ts` — see [SDK.md](./SDK.md)), creates a benchmark, and runs it

```bash
agent-health benchmark                                           # quick mode
agent-health benchmark -n "Baseline" -a ml-commons               # named mode
agent-health benchmark -f ./test-cases.json -a pulsar -v         # file mode (JSON)
agent-health benchmark -f ./examples/eval-files/demo.eval.js -a observio       # file mode (code SDK)
agent-health benchmark -f ./test-cases.json -n "My Run" -a pulsar --export results.json
agent-health benchmark -n "Baseline" -e system-tool-usage -c 4   # custom evaluator, 4 in parallel
agent-health benchmark -n "Baseline" --export report.html --format html
```

---

### export

Export benchmark test cases as import-compatible JSON.

```
agent-health export -b <benchmark> [options]
```

| Option | Description |
|--------|-------------|
| `-b, --benchmark <id-or-name>` | Benchmark ID or name **(required)** |
| `-o, --output <file>` | Output file path (default: `<benchmark-name>.json`) |
| `--stdout` | Write to stdout instead of file |

The exported JSON can be re-imported with `benchmark -f`.

```bash
agent-health export -b "Baseline" -o test-cases.json
agent-health export -b bench-123 --stdout | jq '.[] | .name'
```

---

### report

Generate a downloadable report for benchmark runs.

```
agent-health report -b <benchmark> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-b, --benchmark <id>` | Benchmark name or ID **(required)** | - |
| `-r, --runs <ids>` | Comma-separated run IDs | All runs |
| `-f, --format <type>` | Report format: `json`, `html`, `pdf` | `html` |
| `-o, --output <file>` | Output file path | Auto-generated |
| `--stdout` | Write to stdout (JSON format only) | - |

```bash
agent-health report -b "Baseline"                          # HTML report (all runs)
agent-health report -b "Baseline" -f pdf -o report.pdf     # PDF report
agent-health report -b "Baseline" -r run-123,run-456       # Specific runs
agent-health report -b "Baseline" -f json --stdout         # JSON to stdout
```

---

### doctor

Check system configuration and connectivity.

```
agent-health doctor [-o text|json]
```

**Checks:**
- Config file (`agent-health.config.ts`)
- Environment file (`.env`)
- AWS credentials (for Bedrock judge)
- Claude Code CLI
- Configured agents
- Available connectors
- OpenSearch Storage (test cases, benchmarks)
- OpenSearch Observability (traces, logs)

```
$ agent-health doctor

✓ Config File: Found: agent-health.config.ts
✓ AWS Credentials: Profile: Bedrock
✓ Agents: 3 agents configured
⚠ OpenSearch Storage: Not configured
⚠ OpenSearch Observability: Not configured
```

---

### init

Initialize project configuration files.

```
agent-health init [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing files |
| `--with-examples` | Include sample test case |

**Creates:** `agent-health.config.ts`, `.env.example`

```bash
agent-health init
agent-health init --force --with-examples
```

---

### migrate

One-time migration to add stats to existing benchmark runs. Only needed if you have benchmarks created before stats tracking was added.

```
agent-health migrate [options]
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would be migrated without making changes |
| `-v, --verbose` | Show detailed progress |

```bash
agent-health migrate --dry-run     # Preview changes
agent-health migrate -v            # Run migration with details
```

---

### configure

Import observability config from infrastructure outputs (e.g. a CloudFormation
stack) into `agent-health.config.json`.

```
agent-health configure --from-stack <stack-name> [options]
```

| Option | Description |
|--------|-------------|
| `--from-stack <name>` | Import observability config from a CloudFormation stack |
| `--region <region>` | AWS region for the stack |
| `--profile <profile>` | AWS CLI profile to use |
| `--dry-run` | Show what would be written without making changes |

```bash
agent-health configure --from-stack AgentHealthObservability --region us-west-2
agent-health configure --from-stack AgentHealthObservability --dry-run
```

---

### setup-telemetry

Configure Claude Code to send OpenTelemetry traces/logs to Agent Health (writes
the `cc-otel` shell alias / env). See [docs/CLAUDE_CODE_TELEMETRY.md](./CLAUDE_CODE_TELEMETRY.md).

```
agent-health setup-telemetry [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--stack <name>` | CloudFormation stack name to read the OTLP endpoint from | `AgentHealthObservability` |
| `--endpoint <url>` | OTLP endpoint URL (skip the stack lookup) | - |
| `--region <region>` | AWS region for the stack | - |
| `--profile <profile>` | AWS CLI profile to use | - |
| `--deploy` | Deploy the CloudFormation stack before configuring | - |
| `--status` | Check current telemetry configuration status | - |
| `--skip-rc` | Print env vars without writing to the shell rc file | - |
| `--force` | Replace an existing telemetry block in the rc file | - |
| `--dry-run` | Show what would be written without making changes | - |

```bash
agent-health setup-telemetry            # configure cc-otel telemetry
agent-health setup-telemetry --status   # show current config + checklist
```

---

### remote

Manage connections to remote agent-health servers (multi-machine Coding Agent
Analytics aggregation).

```
agent-health remote <add|remove|list|test>
```

| Subcommand | Description |
|-----------|-------------|
| `add` | Add a remote server |
| `remove` | Remove a remote server |
| `list` | List configured remote servers |
| `test` | Test connectivity to all remote servers |

---

### skill

Evaluate and improve an [AgentSkill](https://agentskills.io/) / Claude Code
skill via an A/B benchmark (runs with vs without the skill injected) and
optionally propose an improved `SKILL.md`. See [docs/SKILLS.md](./SKILLS.md).

```
agent-health skill <path-to-skill-dir> [options]
```

| Option | Description |
|--------|-------------|
| `<path>` | Path to skill directory (must contain `SKILL.md`) **(required)** |
| `--auto` | Auto-apply proposed improvements to `SKILL.md` |
| `-a, --agent <key>` | Agent key (default: first claude-code agent) |
| `-j, --judge <id>` | Judge model ID (default: first Bedrock model) |
| `-o, --output <fmt>` | Output: `table`, `json` |

```bash
agent-health skill ./my-skill
agent-health skill ./my-skill --auto -a claude-code
```

---

### compare-services

Compare error patterns between two services from trace data.

```
agent-health compare-services -s <service1,service2> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --services <a,b>` | Comma-separated service names **(required)** | - |
| `--start <time>` | Start time (ISO 8601 or relative like `1h`, `24h`) | - |
| `--end <time>` | End time (ISO 8601) | now |
| `--limit <n>` | Max spans to fetch per service | `1000` |

```bash
agent-health compare-services -s "lambda-api,eks-api" --start 24h
```

---

### kill

Kill a running agent process (e.g. the built-in Observio sample agent).

```
agent-health kill <target>      # target: sample-agent
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AWS_PROFILE` | AWS profile for Bedrock judge |
| `AWS_REGION` | AWS region |
| `DEBUG` | Enable verbose debug logging (`true`/`false`) |
| `MLCOMMONS_ENDPOINT` | ML-Commons agent URL |
| **Storage (Basic Auth)** | |
| `OPENSEARCH_STORAGE_ENDPOINT` | Storage cluster URL |
| `OPENSEARCH_STORAGE_USERNAME` | Storage auth user |
| `OPENSEARCH_STORAGE_PASSWORD` | Storage auth password |
| **Storage (AWS SigV4)** | |
| `OPENSEARCH_STORAGE_AUTH_TYPE` | Auth type: `none` \| `basic` \| `sigv4` |
| `OPENSEARCH_STORAGE_AWS_REGION` | AWS region (required for SigV4) |
| `OPENSEARCH_STORAGE_AWS_PROFILE` | AWS profile name (optional) |
| `OPENSEARCH_STORAGE_AWS_SERVICE` | `es` (managed) or `aoss` (serverless) |
| **Observability (Basic Auth)** | |
| `OPENSEARCH_LOGS_ENDPOINT` | Logs cluster URL |
| `OPENSEARCH_LOGS_USERNAME` | Logs auth user |
| `OPENSEARCH_LOGS_PASSWORD` | Logs auth password |
| **Observability (AWS SigV4)** | |
| `OPENSEARCH_LOGS_AUTH_TYPE` | Auth type: `none` \| `basic` \| `sigv4` |
| `OPENSEARCH_LOGS_AWS_REGION` | AWS region (required for SigV4) |
| `OPENSEARCH_LOGS_AWS_PROFILE` | AWS profile name (optional) |
| `OPENSEARCH_LOGS_AWS_SERVICE` | `es` (managed) or `aoss` (serverless) |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error |

---

## Output Formats

Most commands support `-o, --output`:

| Format | Use case |
|--------|----------|
| `table` | Human-readable (default) |
| `json` | Machine-readable, scripting |
