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
import { withDefaultHeaders } from '@/lib/httpHeaders';

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
    // Fix the body first, then let the base class produce the auth headers
    // for exactly this request (adds an AWS SigV4 signature for aws-sigv4).
    const body = JSON.stringify(payload);
    const defaultHeaders = { 'Content-Type': 'application/json' };
    const { url, headers } = await this.prepareRequest(auth, {
      method: 'POST',
      url: endpoint,
      body,
      defaultHeaders,
    });
    const trajectory: TrajectoryStep[] = [];

    // Make your API call here
    const response = await fetch(url, {
      method: 'POST',
      headers: withDefaultHeaders(defaultHeaders, headers),
      body,
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

Builds HTTP headers from authentication configuration (`basic`, `bearer`,
`api-key`, plus `auth.headers`). It cannot produce an `aws-sigv4` signature —
that is a function of the whole request, see `prepareRequest`.

```typescript
const headers = this.buildAuthHeaders(auth);
// Returns: { 'Authorization': 'Bearer xxx' } or similar
```

#### `prepareRequest(auth, { method, url, body?, defaultHeaders? })` → `{ url, headers }`

What HTTP connectors call right before `fetch`, once endpoint, payload and
custom headers are final. Returns the URL to fetch and `buildAuthHeaders(auth)`
plus W3C trace context (`traceparent`) — and for `auth.type: 'aws-sigv4'` the
AWS Signature V4 headers computed over exactly this request, with the query
string of the returned `url` re-serialised in the canonical RFC 3986 form that
was signed (always fetch the returned `url`, not your input). Pass the body
string you will send and the defaults your transport adds (e.g. `Content-Type`)
so they are part of the signature; then merge with `withDefaultHeaders()` from
`lib/httpHeaders.ts` so no duplicate `Content-Type`/`content-type` pair reaches
the wire.

```typescript
const body = JSON.stringify(payload);
const defaultHeaders = { 'Content-Type': 'application/json' };
const { url, headers } = await this.prepareRequest(auth, { method: 'POST', url: endpoint, body, defaultHeaders });
await fetch(url, { method: 'POST', headers: withDefaultHeaders(defaultHeaders, headers), body });
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
| `aws-sigv4` | AWS Signature V4 (request signing) | `awsRegion`, `awsService`, optional `awsAccessKeyId`, `awsSecretAccessKey`, `awsSessionToken`, `awsProfile` |

### AWS SigV4 Authentication

AWS SigV4 is used in two contexts:

1. **OpenSearch cluster connections** (storage and observability) — handled by `opensearchClientFactory.ts` using `@opensearch-project/opensearch/aws-v3` and the AWS credential provider chain. Configure via environment variables (`OPENSEARCH_STORAGE_AUTH_TYPE=sigv4`) or the Settings UI. Set `awsService` to `es` for managed OpenSearch domains or `aoss` for OpenSearch Serverless collections.

2. **Connector-level auth** (agent endpoints) — `auth: { type: 'aws-sigv4', … }` on an agent. What happens depends on the connector family:
   - **HTTP connectors** (`rest`, `agui-streaming`, `langgraph`, `openai-compatible`) **sign every request with AWS Signature V4** (`services/connectors/base/awsSigV4.ts`, invoked through `BaseConnector.prepareRequest()`). This is what you need for agents behind API Gateway (`execute-api`), Lambda function URLs (`lambda`), Bedrock AgentCore (`bedrock-agentcore`), App Runner, or an ALB with IAM auth.
   - **Subprocess connectors** export the static keys as `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` into the child's environment (`buildAuthEnv()`); the child does its own signing.

```typescript
{
  key: "my-gateway-agent",
  name: "Agent behind API Gateway",
  endpoint: "https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/invoke",
  connectorType: "rest",
  auth: {
    type: "aws-sigv4",
    awsRegion: "us-west-2",       // required — signing region
    awsService: "execute-api",    // required — signing service name
    awsProfile: "eval",           // optional — named profile for the credential chain
    // awsAccessKeyId / awsSecretAccessKey / awsSessionToken — optional static credentials
  },
}
```

#### Credential precedence

1. **Explicit static credentials** — `awsAccessKeyId` + `awsSecretAccessKey` (+ `awsSessionToken` for temporary credentials). Both key fields must be set together. Read them from `process.env` in `agent-health.config.ts`; never commit them.
2. **AWS default credential provider chain** (`fromNodeProviderChain`) for the profile `awsProfile` → `$AWS_PROFILE` → the chain's default: environment variables, `~/.aws/credentials` / `~/.aws/config` (incl. SSO and `credential_process`), web identity, ECS/EC2 instance roles.

The provider is memoised per profile; the credentials it yields are re-resolved per request (the chain refreshes on expiry and the ini files are re-read), so rotated profile / STS credentials are picked up without restarting the server.

#### What is signed

The signature covers the request exactly as it goes over the wire:

- method and the full URL — path **and** query string (the `beforeRequest` hook's final `endpoint`). The query is parsed from the raw URL without form-decoding (`+` stays a literal plus, `%2B`/`%20` decode to `+`/space) and is re-serialised in canonical RFC 3986 form on the wire, so the bytes sent and the canonical request can never disagree — the fetched URL may therefore differ from the configured one only in percent-encoding (same parameters, same order);
- the exact body bytes: `JSON.stringify(payload)` → `x-amz-content-sha256`;
- the headers: `host`, `content-type` (and `accept` for SSE), `x-amz-date`, `x-amz-security-token` (when the credentials carry a session token), `x-amz-content-sha256`, every `auth.headers` / `agent.headers` entry and every header returned by a `beforeRequest` hook. They appear in `SignedHeaders=…` of the `Authorization: AWS4-HMAC-SHA256 …` header.

Header names are lowercase-normalised before signing and the transport applies its `Content-Type`/`Accept` defaults case-insensitively. Caller-supplied values for signer/transport-owned headers (`authorization`, `host`, `content-length`, `x-amz-date`, `x-amz-content-sha256`, `x-amz-security-token`) are dropped rather than signed. This matters: Node's `fetch` folds a `Content-Type` + `content-type` pair into one header valued `"application/json, application/json"`, which no longer matches what was signed. `host` is signed but not passed to `fetch` (the runtime sets it from the URL).

**Not signed by design:** the W3C `traceparent` / `tracestate` headers (`traceContext.propagateHeader`) are injected **after** signing and are therefore not in `SignedHeaders`. SigV4 allows unsigned extra headers, and keeping trace headers out of the signature means a proxy that rewrites them cannot cause `SignatureDoesNotMatch`.

#### Hook ordering

`beforeRequest` hooks run in `invokeAgent` **before** `connector.execute()`; signing happens inside `execute()` on the hook's final endpoint, payload and headers. A hook may therefore rewrite the URL, add query parameters, mutate the payload or add headers freely — all of it is covered by the signature. A hook must **not** set `Authorization` itself for an `aws-sigv4` agent (the signer owns that header).

#### Failure modes

A signing or credential problem never sends an unsigned request. It fails the agent step with

```
SigV4 signing failed: <reason> (profile <p> / region <r> / service <s>)
```

e.g. `auth.awsRegion is required`, `auth.awsService is required`, `awsAccessKeyId and awsSecretAccessKey must be provided together`, or the credential chain's own message (`Could not load credentials from any providers`). The report is `status: 'failed'` with that message as the reason.

#### Troubleshooting `403` from the endpoint

| Response | Meaning | Check |
|----------|---------|-------|
| `MissingAuthenticationToken` | No `Authorization` header reached the service | `auth.type` is really `aws-sigv4` (not inferred from `headers`); you are on a version with request signing (≥ 0.8.0) |
| `InvalidClientTokenId` / `UnrecognizedClientException` | Access key unknown to AWS | wrong profile / expired temporary credentials — `aws sts get-caller-identity --profile <p>` |
| `SignatureDoesNotMatch` | Signature computed over a different request than the one received | `awsService` / `awsRegion` match the endpoint (`execute-api` + the API's region, not the caller's); nothing between agent-health and AWS rewrites the path, query or body (gzip, a proxy re-encoding JSON, a hook adding `Authorization`); custom headers in `auth.headers` are not being modified by a proxy — move such headers into the `beforeRequest` hook's returned `headers` only if they are stable |
| `ExpiredTokenException` | Session token expired | refresh the profile / rotate the static token; the connector re-resolves credentials per request, no restart needed |
| `AccessDeniedException` / `User … is not authorized` | Signature accepted, IAM policy denies | the resource policy / IAM policy for `execute-api:Invoke`, `lambda:InvokeFunctionUrl`, etc. |

A quick self-check that does not need your own endpoint: point a `rest` agent at `https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15` with `awsService: 'sts'`, `awsRegion: 'us-east-1'`. A valid signature yields HTTP 200 (`GetCallerIdentityResult`); a bad one yields 403 `InvalidClientTokenId` / `SignatureDoesNotMatch`.

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
    const body = JSON.stringify(payload);
    const defaultHeaders = { 'Content-Type': 'application/json' };
    const { url, headers } = await this.prepareRequest(auth, { method: 'POST', url: endpoint, body, defaultHeaders });

    const response = await fetch(url, {
      method: 'POST',
      headers: withDefaultHeaders(defaultHeaders, headers),
      body,
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
