# Agent Health: NPX CLI Tool

## Overview

Package the AgentEval application as an NPX-runnable CLI tool. Agent and judge model selection is done in the UI.

**Package name**: `@opensearch-project/agent-health`

---

## Key Concept: Sample Data Always Visible

Sample data (`demo-*` prefixed items) is **always included** in API responses:

- **5 sample test cases** - RCA scenarios for e-commerce
- **1 sample experiment** - With completed runs
- **5 sample runs** - With realistic trajectories and judge evaluations
- **Sample traces** - OTel spans linked to runs

When OpenSearch is configured, real data is merged with sample data. Sample data is **read-only** - write operations to `demo-*` IDs are rejected.

---

## Quick Start

```bash
# Start the server
npx @opensearch-project/agent-health

# With custom port
npx @opensearch-project/agent-health --port 3000

# With environment file
npx @opensearch-project/agent-health --env-file .env
```

Configuration is done via:
- **UI dropdowns** - Select agent and judge model in the interface
- **Environment variables** - Configure OpenSearch storage, AWS credentials via `.env` file

---

## Architecture

```
@opensearch-project/agent-health
├── bin/
│   └── cli.js                    # Entry point (#!/usr/bin/env node)
├── cli/
│   ├── index.ts                  # Main CLI - starts server
│   ├── demo/
│   │   ├── sampleTestCases.ts    # 5 embedded test cases (always visible)
│   │   ├── sampleExperiments.ts  # 1 sample experiment (always visible)
│   │   ├── sampleRuns.ts         # 5 runs with trajectories (always visible)
│   │   └── sampleTraces.ts       # OTel spans for sample runs (always visible)
│   └── utils/
│       └── startServer.ts        # Server startup utility
├── server/                        # Backend (Express)
│   ├── services/
│   │   └── opensearchClient.ts   # Returns null if not configured
│   └── routes/
│       └── storage/              # All routes merge sample + real data
├── dist/                          # Built frontend
└── package.json
```

---

## Storage Behavior

| OpenSearch | Sample Data | Real Data | Writes |
|-----------|-------------|-----------|--------|
| Not configured | Yes | No | Rejected |
| Configured | Yes | Yes | Allowed |

**Key behavior:**
- Sample data (`demo-*`) is **always** returned by APIs
- OpenSearch is **optional** - APIs work without it
- Write operations require OpenSearch to be configured
- Write operations to `demo-*` IDs always rejected (read-only)

---

## Sample Test Cases

5 pre-configured RCA scenarios based on e-commerce observability:

| ID | Name | Difficulty |
|----|------|------------|
| demo-otel-001 | Payment Service Latency Spike | Medium |
| demo-otel-002 | Cart Service Error Rate Spike | Medium |
| demo-otel-003 | Database Connection Pool Exhaustion | Hard |
| demo-otel-004 | Recommendation Service Cold Start | Medium |
| demo-otel-005 | Cascading Failure Investigation | Hard |

Each includes prompt, context, and expected outcomes.

---

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --port <num>` | Server port | 4001 |
| `-e, --env-file <path>` | Load environment variables from file | - |
| `--no-browser` | Don't open browser automatically | false |

**Examples:**
```bash
# Start on custom port
npx @opensearch-project/agent-health --port 3000

# Start without opening browser
npx @opensearch-project/agent-health --no-browser

# Use custom environment file
npx @opensearch-project/agent-health --env-file .env.production
```

---

## Configuration

Configuration is done via environment variables (`.env` file):

```bash
# AWS credentials for Bedrock Judge
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret

# OpenSearch Storage (optional - for persisting data)
OPENSEARCH_STORAGE_ENDPOINT=http://localhost:9200
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=admin

# Traces (optional)
OPENSEARCH_LOGS_ENDPOINT=http://localhost:9200
OPENSEARCH_LOGS_TRACES_INDEX=otel-v1-apm-span-*
```

**Note:** Storage is optional. When not configured, sample data is displayed.

---

## What Gets Packaged

### NPM Package Contents
```json
{
  "files": [
    "bin/",
    "cli/dist/",
    "server/dist/",
    "dist/"
  ]
}
```

### Size Estimate
- Frontend build: ~2MB
- Server build: ~500KB
- CLI + sample data: ~300KB
- **Total: ~3MB**

---

## Development

### Building
```bash
npm run build:cli      # Build CLI only
npm run build:all      # Build everything (UI + server + CLI)
```

### Testing Locally
```bash
npm link
agent-health
```

### Publishing
```bash
npm run prepublishOnly
npm publish --access public
```

---

## Security

1. **Config file permissions** - 600 on ~/.agent-health/config.json
2. **AWS credentials** - Uses default credential chain, never stored in config
3. **OpenSearch auth optional** - For localhost dev without security
4. **Sample data is synthetic** - No sensitive information
