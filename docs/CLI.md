<!--
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
-->

# CLI Reference

## Quick Start

```bash
npx @opensearch-project/agent-health              # Start server
npx @opensearch-project/agent-health run -t <id>  # Run single test case
npx @opensearch-project/agent-health benchmark    # Run all test cases
```

## Installation

```bash
npm install -g @opensearch-project/agent-health   # Global install
npx @opensearch-project/agent-health <command>    # No install required
```

---

## Commands

### serve (default)

Start the web server.

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
```

---

### list

List available resources.

```
agent-health list <resource> [-o table|json]
```

| Resource | Description |
|----------|-------------|
| `agents` | Configured agents |
| `connectors` | Available connectors |
| `models` | Available models |
| `test-cases` | Stored test cases |
| `benchmarks` | Stored benchmarks |

```bash
agent-health list agents
agent-health list connectors -o json
```

---

### run

Run a single test case.

```
agent-health run -t <test-case> [options]
```

| Option | Description |
|--------|-------------|
| `-t, --test-case <id>` | Test case ID or name **(required)** |
| `-a, --agent <key>` | Agent key (repeatable for comparison) |
| `-m, --model <id>` | Model override |
| `-o, --output <fmt>` | Output: `table`, `json` |
| `-v, --verbose` | Show full trajectory |

```bash
agent-health run -t demo-otel-001 -a ml-commons -v
agent-health run -t demo-otel-001 -a ml-commons -a claude-code  # compare
```

---

### benchmark

Run a benchmark (batch of test cases).

```
agent-health benchmark [options]
```

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | Benchmark name/ID (omit for quick mode) |
| `-a, --agent <key>` | Agent key (repeatable) |
| `-m, --model <id>` | Model override |
| `-o, --output <fmt>` | Output: `table`, `json` |
| `--export <path>` | Export results to JSON file |
| `-v, --verbose` | Show per-test-case progress |

**Modes:**
- **Quick mode** (no `-n`): Runs all test cases
- **Named mode** (`-n <name>`): Runs specific benchmark

```bash
agent-health benchmark                           # quick mode
agent-health benchmark -n "Baseline" -a ml-commons --export results.json
```

---

### doctor

Check system configuration.

```
agent-health doctor [-o text|json]
```

**Checks:** config file, `.env`, AWS credentials, Claude CLI, agents, connectors, OpenSearch.

```
✓ Config File: Found: agent-health.yaml
✓ AWS Credentials: Profile: Bedrock
⚠ OpenSearch Storage: Not configured
```

---

### init

Initialize project configuration.

```
agent-health init [options]
```

| Option | Description |
|--------|-------------|
| `--yaml` | Generate YAML config (default: TypeScript) |
| `--force` | Overwrite existing files |
| `--with-examples` | Include sample test case |

**Creates:** `agent-health.config.ts` (or `.yaml`), `.env.example`

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AWS_PROFILE` | AWS profile for Bedrock judge |
| `AWS_REGION` | AWS region |
| `MLCOMMONS_ENDPOINT` | ML-Commons agent URL |
| `OPENSEARCH_STORAGE_URL` | Storage cluster URL |
| `OPENSEARCH_STORAGE_USER` | Storage auth user |
| `OPENSEARCH_STORAGE_PASS` | Storage auth password |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error |

---

## Output Formats

All commands support `-o, --output`:

| Format | Use case |
|--------|----------|
| `table` | Human-readable (default) |
| `json` | Machine-readable, scripting |
