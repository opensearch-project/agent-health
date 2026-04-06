# Connector System (`services/connectors/`)

Pluggable abstraction for agent communication protocols.

## Key Files
- `types.ts`: `AgentConnector`, `ConnectorRequest`, `ConnectorResponse` interfaces
- `registry.ts`: Singleton `connectorRegistry` — `get()`, `getForAgent()`
- `base/BaseConnector.ts`: Abstract base with auth header building
- `index.ts`: Browser-safe exports (no Node.js deps)
- `server.ts`: All connectors including Node.js-only (subprocess, claude-code)

## Built-in Connectors

| Connector | Protocol | Use Case |
|-----------|----------|----------|
| `agui-streaming` | AG-UI SSE | ML-Commons agents (default) |
| `rest` | HTTP POST | Non-streaming REST APIs |
| `subprocess` | CLI | Command-line tools |
| `claude-code` | Claude CLI | Claude Code agent comparison |
| `mock` | In-memory | Demo and testing |

## Usage
```typescript
import { connectorRegistry } from '@/services/connectors';
const connector = connectorRegistry.getForAgent(agentConfig);
const response = await connector.execute(endpoint, request, auth, onProgress);
```

## Creating a Custom Connector
```typescript
import { BaseConnector } from '@/services/connectors';

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
