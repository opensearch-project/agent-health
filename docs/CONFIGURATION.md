# Configuration Guide

Agent Health uses a unified configuration system with multiple tiers:

1. **`agent-health.config.json`** - Unified JSON config file (primary, auto-created)
2. **Environment Variables** - for quick overrides and secrets
3. **TypeScript Config File** - for power users with custom agents/connectors (optional)

Settings are consolidated into `agent-health.config.json`, which is created automatically on first startup. Priority: **file config > env vars > defaults**.

## Quick Start (Zero Config)

Most users can start immediately with no configuration:

```bash
# If you have AWS credentials configured (aws configure)
npx agent-health run -t demo-tc-1 -a claude-code
```

This works because:
- Claude Code uses your `AWS_PROFILE` automatically
- Travel Planner demo test cases are built-in
- File-based storage is used by default (no OpenSearch needed)
- Results shown in terminal

## Unified Config File (`agent-health.config.json`)

On first startup, Agent Health creates `agent-health.config.json` in your working directory. This file consolidates all settings that were previously scattered across environment variables and YAML files.

```json
{
  "storage": {
    "type": "file",
    "dataDir": ".agent-health-data"
  },
  "server": {
    "port": 4001
  },
  "debug": false
}
```

Settings saved through the UI (e.g., from the Settings page) are persisted to this file automatically.

### YAML to JSON Auto-Migration

If you have an existing `agent-health.yaml` configuration file, it will be automatically migrated to `agent-health.config.json` on the first startup. The migration is handled by `configMigration.ts` and preserves all your existing settings. The original YAML file is left in place for reference but is no longer read.

## File-Based Storage (Default)

By default, Agent Health uses **file-based storage** that requires no external services. Data is stored as JSON files in a `.agent-health-data/` directory:

```
.agent-health-data/
├── test-cases/       # Test case definitions
├── benchmarks/       # Benchmark configurations
├── runs/             # Evaluation run results
└── analytics/        # Analytics data
```

This means you can start using Agent Health immediately without setting up OpenSearch. To switch to OpenSearch storage, configure the `OPENSEARCH_STORAGE_*` environment variables (see below).

## Environment Variables

### AWS Credentials

Required for Claude Code agent and Bedrock judge.

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_PROFILE` | AWS profile to use | `default` |
| `AWS_REGION` | AWS region | `us-west-2` |
| `AWS_ACCESS_KEY_ID` | Explicit access key (alternative to profile) | - |
| `AWS_SECRET_ACCESS_KEY` | Explicit secret key | - |
| `AWS_SESSION_TOKEN` | Session token (for temporary credentials) | - |

**Note:** If you've run `aws configure`, credentials are auto-detected.

### OpenSearch Storage (Optional)

Override the default file-based storage with an OpenSearch cluster for shared, production-grade persistence. Without these settings, file-based storage is used automatically.

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_STORAGE_ENDPOINT` | Storage cluster URL | - |
| `OPENSEARCH_STORAGE_USERNAME` | Username | - |
| `OPENSEARCH_STORAGE_PASSWORD` | Password | - |
| `OPENSEARCH_STORAGE_TLS_SKIP_VERIFY` | Skip TLS verification | `false` |

### OpenSearch Observability (Optional)

View agent traces and logs. Only needed for ML-Commons agent.

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_LOGS_ENDPOINT` | Logs cluster URL | - |
| `OPENSEARCH_LOGS_USERNAME` | Username | - |
| `OPENSEARCH_LOGS_PASSWORD` | Password | - |
| `OPENSEARCH_LOGS_TRACES_INDEX` | Traces index pattern | `otel-v1-apm-span-*` |
| `OPENSEARCH_LOGS_INDEX` | Logs index pattern | `ml-commons-logs-*` |

### Agent Endpoints (Optional)

Override default agent endpoints.

| Variable | Description | Default |
|----------|-------------|---------|
| `TRAVEL_PLANNER_ENDPOINT` | Travel Planner demo agent URL (requires OTel Demo Docker) | `http://localhost:3000` |

To configure additional agents (LangGraph, ML-Commons, HolmesGPT, LiteLLM, Claude Code, etc.), use `agent-health.config.ts`. See [TypeScript Config File](#typescript-config-file-optional) below.

### Debug Logging

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG` | Enable verbose debug logging on server startup | `false` |

Debug logging can also be toggled at runtime via the Settings page "Verbose Logging" toggle or the `POST /api/debug` endpoint. When enabled, structured debug output appears in both the browser console and server terminal.

### Advanced Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_BACKEND_PORT` | Backend server port | `4001` |
| `BEDROCK_MODEL_ID` | Judge model ID | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |

## TypeScript Config File (Optional)

Create `agent-health.config.ts` for custom agents, models, or connectors.

### When to Use a Config File

- Adding custom agents
- Custom connectors
- CI/CD (version-controlled config)
- Custom test case locations

### When NOT to Use a Config File

- Just running Claude Code
- Using default file-based storage (works out of the box)
- Simple storage setup (use env vars for OpenSearch)
- Quick testing with Travel Planner demo

### Example Config

```typescript
// agent-health.config.ts
import { defineConfig } from '@opensearch-project/agent-health';

export default defineConfig({
  // Add custom agents (built-ins still work)
  agents: [
    {
      key: 'my-agent',
      name: 'My Custom Agent',
      connectorType: 'rest', // or 'agui', 'subprocess'
      endpoint: 'http://localhost:8080/chat',
      models: ['claude-sonnet-4'],
    },
  ],

  // Override storage (can also use env vars)
  storage: {
    endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT,
    username: 'admin',
    password: process.env.OPENSEARCH_STORAGE_PASSWORD,
  },

  // Custom test cases location
  testCases: './my-tests/*.yaml',
});
```

### Config File Options

| Option | Type | Description |
|--------|------|-------------|
| `agents` | `UserAgentConfig[]` | Custom agents (merged with defaults) |
| `models` | `UserModelConfig[]` | Custom models (merged with defaults) |
| `connectors` | `AgentConnector[]` | Custom connectors |
| `storage` | `StorageConfig` | OpenSearch storage config |
| `observability` | `ObservabilityConfig` | OpenSearch logs config |
| `testCases` | `string \| string[]` | Test case file patterns |
| `reporters` | `ReporterConfig[]` | Output reporters |
| `judge` | `JudgeConfig` | Judge model configuration |
| `extends` | `boolean` | Extend defaults (`true`) or replace (`false`) |

### Agent Config Options

```typescript
interface UserAgentConfig {
  key: string;              // Unique identifier
  name: string;             // Display name
  endpoint: string;         // URL or command name
  connectorType?: string;   // 'agui', 'rest', 'subprocess', 'claude-code', 'mock'
  models: string[];         // Supported model keys
  headers?: Record<string, string>;  // HTTP headers
  useTraces?: boolean;      // Enable trace collection
  connectorConfig?: any;    // Connector-specific config
  description?: string;     // Description
  enabled?: boolean;        // Enable/disable agent
}
```

## Built-in Agents

These agents work out of the box:

| Agent | Key | Connector | Notes |
|-------|-----|-----------|-------|
| Demo Agent | `demo` | `mock` | Simulated responses for testing |
| Claude Code | `claude-code` | `claude-code` | Requires `claude` CLI installed |
| Langgraph | `langgraph` | `agui-streaming` | AG-UI protocol |
| ML-Commons | `mlcommons-local` | `agui-streaming` | Local OpenSearch |
| HolmesGPT | `holmesgpt` | `agui-streaming` | AI investigation agent |

## Built-in Connectors

| Type | Protocol | Use Case |
|------|----------|----------|
| `agui-streaming` | AG-UI SSE | ML-Commons, Langgraph, HolmesGPT |
| `rest` | HTTP POST | Simple REST APIs |
| `subprocess` | CLI | Generic CLI tools |
| `claude-code` | CLI | Claude Code CLI specifically |
| `mock` | In-memory | Testing and demos |

## Configuration Hierarchy

Settings are loaded in this order (later overrides earlier):

```
1. Built-in defaults (lib/constants.ts)
      ↓
2. Environment variables (.env file)
      ↓
3. JSON config file (agent-health.config.json) - auto-created
      ↓
4. TypeScript config file (agent-health.config.ts) - OPTIONAL, for custom agents/connectors
```

**Note:** `agent-health.config.json` is the primary config file for runtime settings (storage, server, debug). The TypeScript config file (`agent-health.config.ts`) is used for advanced customization like custom agents, connectors, and models.

## Validation

Check your configuration:

```bash
npx agent-health doctor
```

This shows:
- Config file status
- AWS credentials
- Storage configuration
- Available agents and connectors
