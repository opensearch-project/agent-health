# Configuration Guide

Agent Health uses a two-tier configuration system:

1. **Environment Variables** - for quick setup (most users)
2. **TypeScript Config File** - for power users (optional)

## Quick Start (Zero Config)

Most users can start immediately with no configuration:

```bash
# If you have AWS credentials configured (aws configure)
npx agent-health run -t demo-tc-1 -a claude-code
```

This works because:
- Claude Code uses your `AWS_PROFILE` automatically
- Demo test cases are built-in
- Results shown in terminal

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

Save test results, benchmarks, and history. Without storage, results are shown in terminal only.

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
| `LANGGRAPH_ENDPOINT` | Langgraph agent URL | `http://localhost:3000` |
| `MLCOMMONS_ENDPOINT` | ML-Commons agent URL | `http://localhost:9200/...` |
| `HOLMESGPT_ENDPOINT` | HolmesGPT agent URL | `http://localhost:5050/...` |

### ML-Commons Headers (Optional)

Headers for ML-Commons agent to access data sources.

| Variable | Description |
|----------|-------------|
| `MLCOMMONS_HEADER_OPENSEARCH_URL` | Data source OpenSearch URL |
| `MLCOMMONS_HEADER_AUTHORIZATION` | Basic auth header |
| `MLCOMMONS_HEADER_AWS_REGION` | AWS region for SigV4 |
| `MLCOMMONS_HEADER_AWS_SERVICE_NAME` | AWS service name |
| `MLCOMMONS_HEADER_AWS_ACCESS_KEY_ID` | Access key for SigV4 |
| `MLCOMMONS_HEADER_AWS_SECRET_ACCESS_KEY` | Secret key for SigV4 |
| `MLCOMMONS_HEADER_AWS_SESSION_TOKEN` | Session token for SigV4 |

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
- Simple storage setup (use env vars)
- Quick testing

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
| HolmesGPT | `holmesgpt` | `agui-streaming` | AI RCA agent |

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
2. Environment variables
      ↓
3. Config file (agent-health.config.ts) - OPTIONAL
```

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
