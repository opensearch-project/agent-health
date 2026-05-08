<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Instrument Your Agent with OpenTelemetry

This guide is a prompt you can give to a coding agent (Claude Code, Cursor, Copilot, etc.) to instrument your application with OpenTelemetry and route telemetry to the Agent Health observability stack.

---

## Quick Start: Give This Prompt to Your Coding Agent

Copy the prompt below and paste it into your coding agent. It will instrument your application with the correct OTel attributes that Agent Health expects.

---

## The Prompt

````markdown
# Task: Instrument this application with OpenTelemetry

Add OpenTelemetry instrumentation to this application following the GenAI semantic conventions so that traces are compatible with the Agent Health observability dashboard.

## Requirements

### 1. Install Dependencies

For Python:
```bash
pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-http opentelemetry-semantic-conventions
```

For TypeScript/Node.js:
```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/semantic-conventions
```

### 2. Initialize the Tracer

Configure an OTLP exporter that sends traces to the endpoint specified by `OTEL_EXPORTER_OTLP_ENDPOINT`. Use `http/protobuf` protocol.

**Python:**
```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
import os

resource = Resource.create({
    "service.name": os.getenv("OTEL_SERVICE_NAME", "my-agent"),
})

provider = TracerProvider(resource=resource)
exporter = OTLPSpanExporter(
    endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318") + "/v1/traces",
)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("my-agent")
```

**TypeScript:**
```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';

const sdk = new NodeSDK({
  resource: new Resource({
    'service.name': process.env.OTEL_SERVICE_NAME || 'my-agent',
  }),
  traceExporter: new OTLPTraceExporter({
    url: (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318') + '/v1/traces',
  }),
});
sdk.start();

import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('my-agent');
```

### 3. Span Structure (Required)

Create spans in this hierarchy:

```
Root span: agent invocation (gen_ai.operation.name = "invoke_agent")
├── LLM call (gen_ai.operation.name = "chat")
├── Tool execution (gen_ai.operation.name = "execute_tool")
├── LLM call (gen_ai.operation.name = "chat")
└── ...
```

### 4. Required Span Attributes

These attributes MUST be set on spans for Agent Health to correctly categorize and compute metrics.

#### Agent Spans (root span)

| Attribute | Value | Example |
|-----------|-------|---------|
| `gen_ai.operation.name` | `"invoke_agent"` or `"create_agent"` | `"invoke_agent"` |
| `gen_ai.agent.name` | Your agent's name | `"rca-agent"` |
| `gen_ai.system` | Provider identifier | `"aws.bedrock"`, `"openai"`, `"anthropic"` |
| `gen_ai.request.id` | Unique run/session ID | `"run-abc123"` |

#### LLM Call Spans

| Attribute | Value | Example |
|-----------|-------|---------|
| `gen_ai.operation.name` | `"chat"`, `"text_completion"`, or `"generate_content"` | `"chat"` |
| `gen_ai.request.model` | Full model identifier | `"anthropic.claude-sonnet-4-20250514-v1:0"` |
| `gen_ai.system` | Provider identifier | `"aws.bedrock"` |
| `gen_ai.usage.input_tokens` | Integer token count | `1234` |
| `gen_ai.usage.output_tokens` | Integer token count | `567` |
| `gen_ai.request.temperature` | Float (optional) | `0.7` |

#### Tool Execution Spans

| Attribute | Value | Example |
|-----------|-------|---------|
| `gen_ai.operation.name` | `"execute_tool"` | `"execute_tool"` |
| `gen_ai.tool.name` | Name of the tool invoked | `"search_logs"` |
| `gen_ai.tool.call_id` | Unique tool call ID (optional) | `"call_abc123"` |

### 5. Implementation Pattern

**Python example — wrapping an agent loop:**

```python
from opentelemetry import trace
from opentelemetry.trace import StatusCode
import uuid

tracer = trace.get_tracer("my-agent")

def run_agent(prompt: str, run_id: str = None):
    run_id = run_id or str(uuid.uuid4())

    with tracer.start_as_current_span("invoke_agent") as agent_span:
        agent_span.set_attribute("gen_ai.operation.name", "invoke_agent")
        agent_span.set_attribute("gen_ai.agent.name", "my-rca-agent")
        agent_span.set_attribute("gen_ai.system", "aws.bedrock")
        agent_span.set_attribute("gen_ai.request.id", run_id)

        # LLM call
        with tracer.start_as_current_span("chat") as llm_span:
            llm_span.set_attribute("gen_ai.operation.name", "chat")
            llm_span.set_attribute("gen_ai.request.model", "anthropic.claude-sonnet-4-20250514-v1:0")
            llm_span.set_attribute("gen_ai.system", "aws.bedrock")

            response = call_llm(prompt)

            llm_span.set_attribute("gen_ai.usage.input_tokens", response.input_tokens)
            llm_span.set_attribute("gen_ai.usage.output_tokens", response.output_tokens)

        # Tool execution (if the LLM requested a tool call)
        if response.tool_calls:
            for tool_call in response.tool_calls:
                with tracer.start_as_current_span("execute_tool") as tool_span:
                    tool_span.set_attribute("gen_ai.operation.name", "execute_tool")
                    tool_span.set_attribute("gen_ai.tool.name", tool_call.name)
                    tool_span.set_attribute("gen_ai.tool.call_id", tool_call.id)

                    result = execute_tool(tool_call)

                    if result.error:
                        tool_span.set_status(StatusCode.ERROR, result.error)

    return response
```

**TypeScript example:**

```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { v4 as uuid } from 'uuid';

const tracer = trace.getTracer('my-agent');

async function runAgent(prompt: string, runId?: string) {
  runId = runId || uuid();

  return tracer.startActiveSpan('invoke_agent', async (agentSpan) => {
    agentSpan.setAttribute('gen_ai.operation.name', 'invoke_agent');
    agentSpan.setAttribute('gen_ai.agent.name', 'my-rca-agent');
    agentSpan.setAttribute('gen_ai.system', 'aws.bedrock');
    agentSpan.setAttribute('gen_ai.request.id', runId);

    try {
      // LLM call
      const response = await tracer.startActiveSpan('chat', async (llmSpan) => {
        llmSpan.setAttribute('gen_ai.operation.name', 'chat');
        llmSpan.setAttribute('gen_ai.request.model', 'anthropic.claude-sonnet-4-20250514-v1:0');
        llmSpan.setAttribute('gen_ai.system', 'aws.bedrock');

        const resp = await callLLM(prompt);

        llmSpan.setAttribute('gen_ai.usage.input_tokens', resp.inputTokens);
        llmSpan.setAttribute('gen_ai.usage.output_tokens', resp.outputTokens);
        llmSpan.end();
        return resp;
      });

      // Tool execution
      for (const toolCall of response.toolCalls || []) {
        await tracer.startActiveSpan('execute_tool', async (toolSpan) => {
          toolSpan.setAttribute('gen_ai.operation.name', 'execute_tool');
          toolSpan.setAttribute('gen_ai.tool.name', toolCall.name);
          toolSpan.setAttribute('gen_ai.tool.call_id', toolCall.id);

          const result = await executeTool(toolCall);
          if (result.error) {
            toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
          }
          toolSpan.end();
        });
      }

      agentSpan.end();
      return response;
    } catch (err) {
      agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      agentSpan.end();
      throw err;
    }
  });
}
```

### 6. Configure Telemetry Export and Agent Health

#### A. Set environment variables to emit traces

Set these in your shell or `.env` file to route telemetry from your agent to the OTLP endpoint:

```bash
# Required: enable OTLP export
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=<YOUR_OTLP_ENDPOINT>

# Recommended: identify your service
export OTEL_SERVICE_NAME=my-agent

# Optional: also export logs and metrics
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
```

Replace `<YOUR_OTLP_ENDPOINT>` with one of:
- **Agent Health API Gateway**: `https://<api-gateway-id>.execute-api.<region>.amazonaws.com/prod` (from CloudFormation stack)
- **Local ADOT collector**: `http://localhost:4318`
- **Direct OSIS pipeline**: `https://<osis-endpoint>.osis.<region>.amazonaws.com`

#### B. Configure Agent Health to read traces from OpenSearch

After traces are flowing into your OpenSearch domain, configure Agent Health to access them.

**Option 1: CLI setup (recommended)**

Run the setup command to configure everything interactively:

```bash
npx @opensearch-project/agent-health setup-telemetry
```

This deploys the telemetry stack and writes the observability config to `agent-health.config.json` automatically.

**Option 2: JSON config file (manual)**

In your `agent-health.config.json`:

```json
{
  "observability": {
    "endpoint": "https://search-my-domain.us-west-2.es.amazonaws.com",
    "authType": "sigv4",
    "awsRegion": "us-west-2",
    "awsService": "es",
    "tracesIndex": "otel-v1-apm-span-*"
  }
}
```

For basic auth:

```json
{
  "observability": {
    "endpoint": "https://search-my-domain.us-west-2.es.amazonaws.com",
    "authType": "basic",
    "username": "admin",
    "password": "your-password",
    "tracesIndex": "otel-v1-apm-span-*"
  }
}
```

#### C. Verify the connection

```bash
npx @opensearch-project/agent-health doctor
```

Confirm that the "Observability" check shows a connected OpenSearch domain with the correct traces index.

### 7. Validation Checklist

After instrumenting, verify your spans include:

- [ ] Root span has `gen_ai.operation.name` = `"invoke_agent"` and `gen_ai.agent.name`
- [ ] LLM spans have `gen_ai.operation.name` = `"chat"` and `gen_ai.request.model`
- [ ] LLM spans report `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`
- [ ] Tool spans have `gen_ai.operation.name` = `"execute_tool"` and `gen_ai.tool.name`
- [ ] All spans share the same trace ID (automatic if using `start_as_current_span`)
- [ ] `gen_ai.request.id` on the root span matches the run ID used in Agent Health
- [ ] Failed operations set span status to ERROR

### 8. What Agent Health Does With Your Traces

Agent Health uses these attributes to:
- **Categorize spans**: `gen_ai.operation.name` determines if a span is AGENT, LLM, TOOL, or OTHER
- **Calculate cost**: `gen_ai.usage.input_tokens` + `gen_ai.usage.output_tokens` + `gen_ai.request.model` → USD cost
- **Track tool usage**: `gen_ai.tool.name` populates tool call counts and tool lists
- **Correlate runs**: `gen_ai.request.id` links traces to benchmark runs
- **Measure duration**: Span start/end times compute total and per-step latency
- **Detect errors**: Span status ERROR is surfaced in the trace viewer

### 9. Common Mistakes

- **Missing `gen_ai.operation.name`**: Spans without this attribute fall into "OTHER" category and won't be counted as LLM/Tool calls
- **Token counts as strings**: Must be integers, not strings like `"1234"`
- **Not ending spans**: Always call `span.end()` (or use context manager in Python) — unended spans are never exported
- **Wrong model ID format**: Use the full model identifier (e.g., `anthropic.claude-sonnet-4-20250514-v1:0`), not just `claude-sonnet`
````

---

## Deploying the Telemetry Backend

If you haven't set up the observability stack yet, use the Agent Health CLI:

```bash
npx @opensearch-project/agent-health setup-telemetry --deploy
```

This deploys a CloudFormation stack with:
- API Gateway (OTLP endpoint with Lambda SigV4 proxy)
- OSIS pipelines (traces + logs)
- OpenSearch domain (stores spans at `otel-v1-apm-span-*`)

After deployment, the CLI prints the `OTEL_EXPORTER_OTLP_ENDPOINT` value to use.

## Using as a Claude Code Skill

To make this available as a slash command in Claude Code, add to your project's `.claude/skills/instrument-otel.md`:

```markdown
---
description: Instrument the current application with OpenTelemetry for Agent Health
---

[paste the prompt section above]
```

Then invoke with `/instrument-otel` in any Claude Code session.

## Using as an MCP Resource

If you run an MCP server, expose this document as a resource at `agent-health://instrumentation-guide` so any connected coding agent can retrieve it on demand.

## Reference

- [OTel GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OTel GenAI Agent Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- [Agent Health Telemetry Setup](./CLAUDE_CODE_TELEMETRY.md)
