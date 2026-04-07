<!--
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
-->

# Connector Development Guide

This guide explains how to create custom connectors for Agent Health to support different agent protocols.

## Overview

Connectors are protocol adapters that handle communication with different types of AI agents. Each connector implements a standard interface that converts between Agent Health's internal request/response format and the agent's native protocol.

## Built-in Connectors

| Type | Protocol | Use Case |
|------|----------|----------|
| `agui-streaming` | AG-UI SSE | ML-Commons agents (default) |
| `rest` | HTTP POST | Non-streaming REST APIs |
| `subprocess` | CLI stdin/stdout | Command-line tools |
| `claude-code` | Claude Code CLI | Claude Code agent comparison |
| `mock` | In-memory | Demo and testing |

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
| `aws-sigv4` | AWS Signature V4 | Uses environment credentials |

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
- `mock`

**Server-only connectors** (in `services/connectors/server.ts`):
- `subprocess`
- `claude-code`

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

## Examples

### REST API Connector

See `services/connectors/rest/RESTConnector.ts` for a complete example of a non-streaming HTTP connector.

### Subprocess Connector

See `services/connectors/subprocess/SubprocessConnector.ts` for a complete example of a CLI tool connector.

### Claude Code Connector

See `services/connectors/claude-code/ClaudeCodeConnector.ts` for a complete example extending SubprocessConnector with custom output parsing.
