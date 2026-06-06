---
name: instrument-otel
description: Use when instrumenting an application with OpenTelemetry for Agent Health. Provides span structure, required attributes, and config setup for routing traces.
---

## Task: Instrument with OpenTelemetry for Agent Health

Add OpenTelemetry instrumentation following GenAI semantic conventions so traces are compatible with Agent Health.

### Steps

1. **Install OTel dependencies** for the project's language (Python: `opentelemetry-api`, `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`; Node.js: `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`)

2. **Initialize tracer** with OTLP exporter pointing to `OTEL_EXPORTER_OTLP_ENDPOINT` using `http/protobuf` protocol

3. **Create spans** in this hierarchy:
   ```
   Root: invoke_agent (gen_ai.operation.name = "invoke_agent")
   ├── chat (gen_ai.operation.name = "chat")
   ├── execute_tool (gen_ai.operation.name = "execute_tool")
   └── ...
   ```

4. **Set required attributes:**

   Agent root span:
   - `gen_ai.operation.name`: `"invoke_agent"`
   - `gen_ai.agent.name`: agent name
   - `gen_ai.system`: provider (e.g., `"aws.bedrock"`, `"openai"`, `"anthropic"`)
   - `gen_ai.request.id`: unique run/session ID

   LLM spans:
   - `gen_ai.operation.name`: `"chat"`
   - `gen_ai.request.model`: full model ID (e.g., `"anthropic.claude-sonnet-4-20250514-v1:0"`)
   - `gen_ai.usage.input_tokens`: integer
   - `gen_ai.usage.output_tokens`: integer

   Tool spans:
   - `gen_ai.operation.name`: `"execute_tool"`
   - `gen_ai.tool.name`: tool name

5. **Set environment variables** to emit traces:
   ```bash
   export OTEL_TRACES_EXPORTER=otlp
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   export OTEL_EXPORTER_OTLP_ENDPOINT=<YOUR_OTLP_ENDPOINT>
   export OTEL_SERVICE_NAME=my-agent
   ```

6. **Configure Agent Health** to read traces from the OpenSearch domain:

   **Option 1: CLI (recommended)**
   ```bash
   npx @opensearch-project/agent-health setup-telemetry
   ```
   This writes the observability config to `agent-health.config.json` automatically.

   **Option 2: Manual JSON config**
   Add to `agent-health.config.json`:
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

7. **Verify** with `npx @opensearch-project/agent-health doctor`

### Key Rules

- Token counts MUST be integers, not strings
- Always call `span.end()` (or use context manager)
- Use full model IDs (e.g., `anthropic.claude-sonnet-4-20250514-v1:0`), not short names
- Every span needs `gen_ai.operation.name` or it falls into "OTHER" category
- Set span status to ERROR on failures

### Reference

Full guide with code examples: [docs/INSTRUMENT_WITH_OTEL.md](../../../docs/INSTRUMENT_WITH_OTEL.md)
