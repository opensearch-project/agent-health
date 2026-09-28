<!--
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
-->

# Connector Development Guide

This guide explains how to create custom connectors for Agent Health to support different agent protocols.

## Overview

Connectors are protocol adapters that handle communication with different types of AI agents. Each connector implements a standard interface that converts between Agent Health's internal request/response format and the agent's native protocol.

## Built-in Connectors

| Type | Protocol | Use Case | Browser-safe |
|------|----------|----------|:---:|
| `agui-streaming` | AG-UI SSE | ML-Commons agents (default) | Yes |
| `rest` | HTTP POST | Non-streaming REST APIs | Yes |
| `openai-compatible` | OpenAI Chat Completions | LiteLLM, Ollama, vLLM | Yes |
| `langgraph` | LangGraph REST `/invoke` | Non-AG-UI LangGraph instances | Yes |
| `strands` | Bedrock Agent Runtime | Amazon Strands agents (requires AWS SDK) | No |
| `subprocess` | CLI stdin/stdout | Command-line tools | No |
| `claude-code` | Claude Code CLI | Claude Code agent comparison | No |
| `kiro` | Kiro CLI | Kiro coding agent (parses `[tool]` stderr markers) | No |
| `pi` | Pi CLI | Pi coding agent | No |
| `mock` | In-memory | Demo and testing | Yes |

## Creating a Custom Connector

### 1. Extend BaseConnector

```typescript
import { BaseConnector } from '@/services/connectors';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/services/connectors/types';
import type { TrajectoryStep } from '@/types';

export class MyConnector extends BaseConnector {
  // Unique connector type identifier
  readonly type = 'my-connector' as const;

  // Human-readable name
  readonly name = 'My Custom Connector';

  // Whether this connector supports streaming progress updates
  readonly supportsStreaming = true;

  /**
   * Build the payload to send to the agent
   */
  buildPayload(request: ConnectorRequest): any {
    return {
      prompt: request.testCase.initialPrompt,
      context: request.testCase.context,
      model: request.modelId,
    };
  }

  /**
   * Execute the agent request
   */
  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const payload = this.buildPayload(request);
    const headers = this.buildAuthHeaders(auth);
    const trajectory: TrajectoryStep[] = [];

    // Make your API call here
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    onRawEvent?.(data);

    // Parse the response into trajectory steps
    const steps = this.parseResponse(data);
    steps.forEach(step => {
      trajectory.push(step);
      onProgress?.(step);
    });

    return {
      trajectory,
      runId: data.runId || null,
      rawEvents: [data],
    };
  }

  /**
   * Parse agent response into trajectory steps
   */
  parseResponse(data: any): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    // Add thinking step
    if (data.thinking) {
      steps.push(this.createStep('thinking', data.thinking));
    }

    // Add tool calls
    if (data.toolCalls) {
      for (const call of data.toolCalls) {
        steps.push(this.createStep('action', `Calling ${call.name}`, {
          toolName: call.name,
          toolArgs: call.args,
        }));
        if (call.result) {
          steps.push(this.createStep('tool_result', call.result, {
            status: 'SUCCESS',
          }));
        }
      }
    }

    // Add final response
    if (data.response) {
      steps.push(this.createStep('response', data.response));
    }

    return steps;
  }
}
```

### 2. Register the Connector

```typescript
import { connectorRegistry } from '@/services/connectors';
import { MyConnector } from './MyConnector';

// Register on module load
connectorRegistry.register(new MyConnector());
```

### 3. Use in Agent Configuration

```typescript
// In lib/constants.ts or your config file
const agent: AgentConfig = {
  key: 'my-agent',
  name: 'My Agent',
  endpoint: 'https://api.example.com/agent',
  connectorType: 'my-connector',
  models: ['claude-sonnet'],
};
```

## Connector Interface

### Required Properties

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ConnectorProtocol` | Unique identifier for the connector |
| `name` | `string` | Human-readable display name |
| `supportsStreaming` | `boolean` | Whether the connector supports real-time progress |

### Required Methods

#### `buildPayload(request: ConnectorRequest): any`

Transforms the standard request into your agent's expected format.

**Parameters:**
- `request`: Contains `testCase`, `modelId`, `threadId`, `runId`

**Returns:** Payload object in your agent's format

#### `execute(...): Promise<ConnectorResponse>`

Main execution method that calls the agent and processes the response.

**Parameters:**
- `endpoint`: The agent's URL or command
- `request`: The connector request
- `auth`: Authentication configuration
- `onProgress`: Optional callback for streaming updates
- `onRawEvent`: Optional callback for raw protocol events

**Returns:** `ConnectorResponse` with trajectory, runId, and metadata

#### `parseResponse(data: any): TrajectoryStep[]`

Converts the raw agent response into standardized trajectory steps.

### Helper Methods (from BaseConnector)

#### `createStep(type, content, options?)`

Creates a trajectory step with proper ID and timestamp.

```typescript
const step = this.createStep('action', 'Querying database', {
  toolName: 'sql_query',
  toolArgs: { query: 'SELECT * FROM users' },
});
```

#### `buildAuthHeaders(auth: ConnectorAuth)`

Builds HTTP headers from authentication configuration.

```typescript
const headers = this.buildAuthHeaders(auth);
// Returns: { 'Authorization': 'Bearer xxx' } or similar
```

#### `buildAuthEnv(auth: ConnectorAuth)`

Builds environment variables for subprocess connectors.

## Authentication Types

| Type | Description | Fields |
|------|-------------|--------|
| `none` | No authentication | `headers` (passthrough) |
| `basic` | HTTP Basic Auth | `username`, `password` or `token` |
| `bearer` | Bearer token | `token` |
| `api-key` | API key header | `token`, `headerName` |
| `aws-sigv4` | AWS Signature V4 | `awsRegion`, `awsService`, `awsAccessKeyId`, `awsSecretAccessKey`, `awsSessionToken` |

### AWS SigV4 Authentication

AWS SigV4 is used in two contexts:

1. **OpenSearch cluster connections** (storage and observability) — handled by the `opensearchClientFactory.ts` using `@opensearch-project/opensearch/aws-v3` and the AWS credential provider chain. Configure via environment variables (`OPENSEARCH_STORAGE_AUTH_TYPE=sigv4`) or the Settings UI.

2. **Connector-level auth** (agent endpoints) — handled by `BaseConnector.buildAuthHeaders()` and `buildAuthEnv()`. When `auth.type` is `aws-sigv4`, the connector passes AWS credentials as environment variables for subprocess connectors or headers for HTTP connectors.

For OpenSearch clusters, SigV4 supports the full AWS credential chain:
- AWS profile (`awsProfile` / `OPENSEARCH_STORAGE_AWS_PROFILE`)
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`)
- IAM roles (EC2 instance profile, ECS task role, etc.)

Set `awsService` to `es` for managed OpenSearch domains or `aoss` for OpenSearch Serverless collections.

## Streaming Support

For connectors that support streaming, emit progress updates as they arrive:

```typescript
async execute(endpoint, request, auth, onProgress, onRawEvent) {
  const eventSource = new EventSource(endpoint);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onRawEvent?.(data);

    // Emit progress for each event
    if (data.type === 'thinking') {
      const step = this.createStep('thinking', data.content);
      onProgress?.(step);
    }
  };

  // Wait for completion
  return new Promise((resolve) => {
    eventSource.addEventListener('done', () => {
      resolve({ trajectory, runId, rawEvents });
    });
  });
}
```

## Browser vs Server Connectors

Some connectors require Node.js APIs (like `child_process`) and cannot run in the browser:

**Browser-safe connectors** (in `services/connectors/index.ts`):
- `agui-streaming`
- `rest`
- `openai-compatible`
- `langgraph`
- `mock`

**Server-only connectors** (in `services/connectors/server.ts`):
- `subprocess`
- `claude-code`
- `kiro`
- `pi`
- `strands` (requires `@aws-sdk/client-bedrock-agent-runtime`)

If your connector needs Node.js APIs, export it from `server.ts` only.

## Testing Connectors

```typescript
import { MyConnector } from './MyConnector';

describe('MyConnector', () => {
  const connector = new MyConnector();

  it('should build correct payload', () => {
    const request = {
      testCase: { initialPrompt: 'Test prompt', context: [] },
      modelId: 'test-model',
    };

    const payload = connector.buildPayload(request);

    expect(payload.prompt).toBe('Test prompt');
  });

  it('should parse response into trajectory', () => {
    const data = {
      thinking: 'Analyzing...',
      response: 'The answer is 42',
    };

    const steps = connector.parseResponse(data);

    expect(steps).toHaveLength(2);
    expect(steps[0].type).toBe('thinking');
    expect(steps[1].type).toBe('response');
  });
});
```

## Custom Payload Mapping

Some agents require specific payload structures beyond the standard `prompt` + `context` format. For example, agents may need:
- Custom system prompts
- Template overrides (planner prompts, reflection prompts)
- Agent-specific configuration fields

### Use Case: Agent with Custom Prompts

For an agent like PER (Planner-Executor-Reflector) that expects this payload:

```json
{
  "parameters": {
    "context": "# Investigation Context...",
    "question": "Why the train ticket website is abnormal...",
    "system_prompt": "# Investigation Planner Agent...",
    "planner_prompt_template": "## AVAILABLE TOOLS...",
    "planner_with_history_template": "...",
    "reflect_prompt_template": "..."
  }
}
```

**Solution:** Create a custom connector that extracts special fields from context items by description:

```typescript
export class PERAgentConnector extends BaseConnector {
  readonly type = 'per-agent' as const;
  readonly name = 'PER Investigation Agent';
  readonly supportsStreaming = false;

  // Map context item descriptions to payload field names
  private readonly FIELD_MAPPINGS: Record<string, string> = {
    'system_prompt': 'system_prompt',
    'planner_prompt_template': 'planner_prompt_template',
    'planner_with_history_template': 'planner_with_history_template',
    'reflect_prompt_template': 'reflect_prompt_template',
    'context': 'context',  // Main investigation context
  };

  buildPayload(request: ConnectorRequest): any {
    const { testCase } = request;
    const payload: Record<string, any> = {
      parameters: {
        question: testCase.initialPrompt,
      },
    };

    // Extract special fields from context items
    for (const item of testCase.context) {
      const fieldName = this.FIELD_MAPPINGS[item.description];
      if (fieldName) {
        payload.parameters[fieldName] = item.value;
      }
    }

    return payload;
  }

  async execute(endpoint, request, auth, onProgress, onRawEvent) {
    const payload = this.buildPayload(request);
    const headers = this.buildAuthHeaders(auth);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    onRawEvent?.(data);

    return {
      trajectory: this.parseResponse(data),
      runId: data.run_id || null,
      rawEvents: [data],
    };
  }

  parseResponse(data: any): TrajectoryStep[] {
    // Parse PER agent response format
    const steps: TrajectoryStep[] = [];

    if (data.response) {
      steps.push(this.createStep('response', data.response));
    }

    return steps;
  }
}
```

### Setting Up Test Cases for Custom Payloads

When creating test cases in the UI, use context items with descriptions matching your field mappings:

| Context Description | Mapped To |
|---------------------|-----------|
| `system_prompt` | `parameters.system_prompt` |
| `planner_prompt_template` | `parameters.planner_prompt_template` |
| `context` | `parameters.context` |

**Example Test Case Configuration:**

```json
{
  "name": "Investigation: Train Ticket Website",
  "initialPrompt": "Why the train ticket website is abnormal?",
  "context": [
    {
      "description": "context",
      "value": "# Investigation Context\n\nService: train-ticket-frontend..."
    },
    {
      "description": "system_prompt",
      "value": "# Investigation Planner Agent\n\nYou are an expert..."
    },
    {
      "description": "planner_prompt_template",
      "value": "## AVAILABLE TOOLS\n{{tools}}\n\n## TASK..."
    }
  ]
}
```

This pattern allows you to pass arbitrary agent-specific fields through the standard test case schema by using context item descriptions as field identifiers.

## Trace Correlation

So an agent's OpenTelemetry spans join the eval `test_case` trace tree (instead
of landing as a separate, orphaned trace), `BaseConnector` propagates trace
context. Configure per-agent via `connectorConfig.traceContext` in
`agent-health.config.ts`:

```typescript
{
  key: 'my-agent',
  connectorType: 'subprocess',
  connectorConfig: {
    traceContext: {
      propagateEnv: true,        // inject TRACEPARENT env (subprocess agents)
      propagateHeader: true,     // inject `traceparent` header (HTTP/SSE agents)
      serviceName: 'my-otel-service-name',  // service-name + time-window fallback
    },
  },
}
```

Three layered strategies, applied in priority order:

- **Strategy A — W3C trace context.** The eval `test_case` span is active when
  the connector runs; `buildTraceparentEnv()` / `injectTraceparentHeaders()`
  emit a W3C `traceparent` so a compliant agent adopts the eval span as parent
  and shares its `traceId` (single trace tree).
- **Strategy B — `agent_health.run.id` / `gen_ai.conversation.id`.**
  `SubprocessConnector` exports `AGENT_EVAL_RUN_ID=<runId>`; agents you
  instrument can tag spans with the run id under **either** Agent Health's own
  `agent_health.run.id` **or** the OTEL-standard `gen_ai.conversation.id` for a
  loose link. Agent Health's eval + sample-agent spans stamp both, and the
  correlation queries match either. (The legacy `gen_ai.request.id` is **not** a
  registered attribute and is no longer used.)
- **Strategy C — service-name + time window (always-on fallback).** Each
  connector declares a default `serviceName` (`claude-code-agent`, `kiro-agent`,
  `pi-agent`, `observio-sample-agent`); the run-report Traces tab unions a
  `serviceName + time-window` clause so closed-source agents still correlate.
- **Strategy D — `session.id` (precise, real-world adopted).** Agents that emit
  the OTEL `session.id` on every span (e.g. Claude Code) are correlated exactly
  on it. `ClaudeCodeConnector` captures the agent's `session_id`, persists it as
  `report.sessionId`, and the trace query matches `attributes.session.id`
  unioned with C.

See the full "Trace correlation conventions" section in
[AGENTS.md](../AGENTS.md) for the convention map and window-derivation rules.

## Unreachable Endpoints: Fast-Fail and Circuit Breaker

A connector call that fails at the **transport level** — the request never
reached the agent, or was rejected before the agent did any work — is not
something to wait on. `invokeAgent()` (`services/evaluation/index.ts`)
classifies such failures with `services/evaluation/agentReachability.ts` and
the runners treat them as final:

| Failure class                                             | Examples                                                              | Counts toward the breaker |
| --------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------- |
| connection (`ECONNREFUSED`, `ECONNRESET`, `EHOSTUNREACH`) | endpoint down, port closed, load balancer dropping the connection    | yes                       |
| DNS (`ENOTFOUND`, `EAI_AGAIN`)                            | typo in the hostname, split-horizon DNS                               | yes                       |
| TLS (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, …) | certificate problems on the agent side                              | yes                       |
| spawn failure (`ENOENT`, `EACCES`, `EPERM`)               | subprocess connector whose CLI binary is not installed / executable   | yes                       |
| gateway status (`HTTP_502` / `503` / `504`)               | `REST request failed: 503 - …` from a proxy in front of a dead agent  | yes                       |
| other rejected status (`HTTP_4xx` / `5xx`, except 408/429) | `401` from a missing API key, `404` route drift, a `500` on one prompt | **no** — case fails fast, run continues |

Only structured signals classify: an error `code` on the `cause` chain, Node's
own syscall wording at the *start* of a message (`connect ECONNREFUSED …`,
`getaddrinfo ENOTFOUND …`, `spawn … ENOENT`) or the connectors' own
`… request failed: <status>` prefix. A code quoted inside an agent's response
body never does. A failure that arrives **after** the connector has already
surfaced a step or raw event (a reset mid-stream) is a failure of that case,
not an unreachable endpoint — it is neither relabelled nor counted. Timeouts,
in-stream parse errors, hook errors and non-zero subprocess exits are **not**
transport failures either.

What happens:

1. **Per case** — the case is finalised immediately as an agent failure
   (`metricsStatus: 'error'`, `failure kind=agent_failed`, bucketed as
   *errored*, never judged). The report's reason names the failure class and
   the endpoint **host only** (never the full URL), e.g.
   `ECONNREFUSED — connection refused while calling agent endpoint
   agent.example.com:9000: fetch failed`. Trace polling is **not** started —
   before this, a `useTraces` agent whose endpoint was down still waited the
   whole `TRACE_POLL_INTERVAL_MS × TRACE_POLL_MAX_ATTEMPTS` budget (10 min by
   default) on every case before erroring it as a trace timeout.
2. **Per run** — a circuit breaker keyed by endpoint `host/path` (or the
   subprocess binary) counts *consecutive* breaker-eligible failures. After
   the threshold (default **3**) the remaining cases of that run fail at once
   with `agent endpoint unreachable — 3 consecutive connection failures
   (ECONNREFUSED, host:port); this case was not attempted`, the run doc gets
   `agentFailureSummary`, and the UI shows an **Agent unreachable** badge on
   the runs list plus a banner on the run page / inspector. A successful call
   resets the count, so a flapping endpoint is not tripped; once open the
   breaker stays open for the rest of that run (a straggler that was already
   in flight cannot re-arm it — with `concurrency > 1` up to that many cases
   may still be dialling when it opens). A new run is a fresh breaker.

Configuration (per agent wins over env; `0` disables the breaker):

```typescript
{
  key: 'my-agent',
  connectorType: 'rest',
  connectorConfig: {
    unreachableThreshold: 3,   // consecutive transport failures before fast-failing the run
  },
}
```

```bash
AGENT_UNREACHABLE_THRESHOLD=3   # default for agents that don't set connectorConfig.unreachableThreshold
```

## Examples

### Observio Sample Agent

The repository includes **Observio**, a reference ReAct agent in `observio-sample-agent/` that uses the `agui-streaming` connector. It's a great way to test connector integration end-to-end. See the [Observio README](../observio-sample-agent/README.md) for setup.

### REST API Connector

See `services/connectors/rest/RESTConnector.ts` for a complete example of a non-streaming HTTP connector.

### Subprocess Connector

See `services/connectors/subprocess/SubprocessConnector.ts` for a complete example of a CLI tool connector.

### Claude Code Connector

See `services/connectors/claude-code/ClaudeCodeConnector.ts` for a complete example extending SubprocessConnector with custom output parsing.

### Kiro Connector

See `services/connectors/kiro/KiroConnector.ts` for a `SubprocessConnector`
subclass that overrides `parseStderrChunk(chunk, trajectory, onProgress, state)` to convert Kiro's stderr-borne
`[tool] Running:` / `[tool] status:` markers into structured `action` +
`tool_result` steps. The base `SubprocessConnector` also persists `stderr` to
`rawOutput` and honors per-request `connectorConfig` overrides (`args` /
`inputMode` / `timeout`).
