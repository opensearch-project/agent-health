---
name: add-connector
description: Use when adding, modifying, or debugging agent connectors. Provides connector architecture, built-in types, and custom connector template.
---

## Connector System (`connectors/`)

Pluggable abstraction for agent communication protocols.

### Key Files
- `types.ts`: `AgentConnector`, `ConnectorRequest`, `ConnectorResponse` interfaces
- `registry.ts`: Singleton `connectorRegistry` — `get()`, `getForAgent()`
- `base/BaseConnector.ts`: Abstract base with auth header building
- `index.ts`: Browser-safe exports (no Node.js deps)
- `server.ts`: All connectors including Node.js-only (subprocess, claude-code)

### Built-in Connectors

| Connector | Protocol | Use Case |
|-----------|----------|----------|
| `agui-streaming` | AG-UI SSE | ML-Commons agents (default) |
| `rest` | HTTP POST | Non-streaming REST APIs |
| `openai-compatible` | OpenAI Chat Completions | LiteLLM, Ollama, vLLM |
| `langgraph` | LangGraph REST `/invoke` | Non-AG-UI LangGraph instances |
| `strands` | Bedrock Agent Runtime | Amazon Strands agents (server-only) |
| `subprocess` | CLI stdin/stdout | Generic command-line tools |
| `claude-code` | Claude CLI | Claude Code agent (extends `subprocess`) |
| `kiro` | Kiro CLI | Kiro coding agent (extends `subprocess`; parses `[tool]` stderr markers) |
| `pi` | Pi CLI | Pi coding agent (extends `subprocess`) |
| `mock` | In-memory | Demo and testing |

### Usage
```typescript
import { connectorRegistry } from '@/connectors';
const connector = connectorRegistry.getForAgent(agentConfig);
const response = await connector.execute(endpoint, request, auth, onProgress);
```

### Creating a Custom Connector
```typescript
import { BaseConnector } from '@/connectors';

class CustomConnector extends BaseConnector {
  readonly type = 'custom' as const;
  readonly name = 'My Custom Agent';
  readonly supportsStreaming = true;

  async execute(endpoint, request, auth, onProgress) {
    // Your protocol implementation
  }
}

connectorRegistry.register(new CustomConnector());
```

### Trace correlation & subprocess hooks

- **Trace context propagation** is handled by `BaseConnector` — set
  `connectorConfig.traceContext` so the agent's spans join the eval `test_case`
  trace tree:
  - `propagateEnv: true` → inject `TRACEPARENT` env into subprocess agents (`buildTraceparentEnv()`).
  - `propagateHeader: true` → inject a `traceparent` HTTP header into HTTP/SSE agents (`injectTraceparentHeaders()`).
  - `serviceName: '<otel-service-name>'` → service-name + time-window fallback. Defaults: `claude-code-agent`, `kiro-agent`, `pi-agent`, `observio-sample-agent`. See the "Trace correlation conventions" section in `AGENTS.md`.
- **Subprocess connectors** (`SubprocessConnector` subclasses) can override
  `parseStderrChunk(chunk)` to turn stderr markers into trajectory steps (how
  `kiro` surfaces `[tool] Running:` / `[tool] status:` as `action` +
  `tool_result` steps). The base class persists `stderr` to `rawOutput` and
  honors per-request `connectorConfig` overrides (`args` / `inputMode` / `timeout`).
