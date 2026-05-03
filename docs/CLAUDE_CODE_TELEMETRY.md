<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Claude Code Telemetry → Agent Health

Route Claude Code's native OpenTelemetry telemetry (traces, logs, metrics) into the same OpenSearch cluster used by Agent Health, so you can view Claude Code sessions alongside your other agent traces.

## Quick Setup (Recommended)

If you deployed the Agent Health Observability CloudFormation stack, it includes an API Gateway with a Lambda SigV4 proxy. Claude Code can send telemetry directly to it — no Docker or local collector needed.

### 1. Get Your API Gateway URL

From CloudFormation stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name AgentHealthObservability \
  --query "Stacks[0].Outputs[?OutputKey=='OTLPIngestEndpoint'].OutputValue" \
  --output text
```

### 2. Configure Claude Code

Add to your `~/.zshrc` (or `~/.bashrc`):

```bash
# --- Claude Code OpenTelemetry ---
export CLAUDE_CODE_ENABLE_TELEMETRY=1

# Exporters (all three signals)
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp

# Point at API Gateway (Lambda proxies to OSIS with SigV4)
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://<YOUR-API-GATEWAY-URL>
```

Then reload and start a new Claude Code session:

```bash
source ~/.zshrc
claude
```

Telemetry begins flowing automatically. No restart of the API Gateway or OSIS needed.

### 3. View in Agent Health

Open Agent Health → **Agent Traces** tab. Claude Code appears as service `claude-code`. Expand the time range filter if recent sessions don't appear immediately (OSIS ingestion has a short delay).

Each Claude Code conversation becomes a trace with spans for:
- `interaction` — top-level user turn
- `llm_request` — model API calls (with token counts and cost)
- `tool` / `tool.execution` — tool invocations and results

## Privacy Note

Even with default settings (no opt-in flags), Claude Code telemetry includes `session.id`, `user.account_uuid`, and `organization.id` in every span. These are account-level identifiers, not conversation content.

To include prompt and tool content in spans (useful for debugging, but sends conversation data to OpenSearch):

```bash
# Optional — has privacy implications
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_LOG_TOOL_CONTENT=1
```

## What Data Lands in OpenSearch

| Signal | Data | Index Pattern |
|--------|------|---------------|
| **Traces** | Span hierarchy: `interaction` → `llm_request` / `tool` → `tool.execution` | `otel-v1-apm-span-*` |
| **Logs/Events** | `user_prompt`, `api_request`, `tool_result`, `tool_decision`, `compaction` events | `otel-logs-*` |
| **Metrics** | `claude_code.cost.usage`, `claude_code.token.usage`, `claude_code.session.count`, etc. | Not supported by OSIS (no OTLP metrics receiver) |

### Key Span Attributes

Every span includes `service.name: claude-code`, `session.id`, `user.account_uuid`, and `organization.id`. LLM request spans add `model`, `input_tokens`, `output_tokens`, `cost_usd`, `duration_ms`. Tool spans add `tool_name`, `result_tokens`.

See the [Claude Code monitoring docs](https://code.claude.com/docs/en/monitoring-usage) for the full attribute reference.

## Verification

### Check OpenSearch for Claude Code spans

```bash
curl -s "https://<opensearch-endpoint>/otel-v1-apm-span-*/_search" \
  -H 'Content-Type: application/json' \
  -d '{
    "size": 5,
    "query": { "match": { "serviceName": "claude-code" } },
    "sort": [{ "startTime": "desc" }]
  }' | jq '.hits.hits[]._source.spanId'
```

Or open Agent Health → Agent Traces and filter by service name `claude-code`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No spans in Agent Traces | Time range too narrow | Expand to "Last 7d"; OSIS ingestion can have a short delay |
| `HTTP 403` from API Gateway | IAM credentials expired or wrong account | Refresh credentials; Lambda assumes a role in the stack's account |
| Traces arrive but no logs | OSIS has no logs pipeline | Deploy the full CFN stack which includes `otel_logs_source` pipeline |
| Spans arrive but no service map | Service map processor not in OSIS | The Agent Health CFN template includes `otel-service-map-pipeline` by default |

## Advanced: Local ADOT Collector

If you can't use the API Gateway (e.g., air-gapped environment, custom processing), you can run a local ADOT collector that signs requests with SigV4 and forwards to OSIS directly.

<details>
<summary>ADOT Collector setup</summary>

### Architecture

```
Claude Code ──OTLP (gRPC, localhost)──▶ ADOT Collector (Docker)
                                            │
                              SigV4-signed HTTPS
                                            │
                          ┌─────────────────┼─────────────────┐
                          ▼                 ▼                 ▼
                   OSIS Traces        OSIS Logs         (metrics via
                   Pipeline           Pipeline           logs pipeline)
                          │                 │
                          ▼                 ▼
                      OpenSearch (otel-v1-apm-span-* / otel-logs-*)
```

### Prerequisites

- Docker installed and running
- AWS credentials with `osis:Ingest` permission on your pipelines

### Get Your OSIS Endpoints

```bash
# Traces endpoint
aws cloudformation describe-stacks \
  --stack-name AgentHealthObservability \
  --query "Stacks[0].Outputs[?OutputKey=='OSISTraceIngestEndpoint'].OutputValue" \
  --output text

# Logs endpoint
aws cloudformation describe-stacks \
  --stack-name AgentHealthObservability \
  --query "Stacks[0].Outputs[?OutputKey=='OSISLogsIngestEndpoint'].OutputValue" \
  --output text
```

### Collector Config

Create `~/.claude/otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 10s
    send_batch_size: 512

exporters:
  otlphttp/traces:
    endpoint: "https://<YOUR-OSIS-TRACES-ENDPOINT>"
    encoding: json          # REQUIRED: OSIS rejects protobuf with HTTP 500
    compression: none       # Avoid gzip issues with SigV4 body signing
    auth:
      authenticator: sigv4auth

  otlphttp/logs:
    endpoint: "https://<YOUR-OSIS-LOGS-ENDPOINT>"
    encoding: json
    compression: none
    auth:
      authenticator: sigv4auth

extensions:
  sigv4auth:
    region: "us-west-2"      # ← your OSIS pipeline region
    service: "osis"

service:
  extensions: [sigv4auth]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/traces]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/logs]
```

> **Important:** `encoding: json` and `compression: none` are **required**. OSIS rejects OTLP protobuf payloads with HTTP 500.

### Docker Compose

Create `~/.claude/docker-compose-otel.yaml`:

```yaml
services:
  adot-collector:
    image: public.ecr.aws/aws-observability/aws-otel-collector:latest
    command: ["--config", "/opt/config.yaml"]
    ports:
      - "4317:4317"
      - "4318:4318"
    volumes:
      - ./otel-collector-config.yaml:/opt/config.yaml:ro
    env_file:
      - .adot.env    # AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
    environment:
      - AWS_REGION=${AWS_REGION:-us-west-2}
    restart: unless-stopped
```

Create `~/.claude/.adot.env` with your AWS credentials:

```bash
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...    # if using temporary credentials
```

### Start / Stop

```bash
cd ~/.claude
docker compose -f docker-compose-otel.yaml up -d
docker compose -f docker-compose-otel.yaml logs --tail 20
# Look for: "Everything is ready. Begin running and processing data."
```

When using the ADOT path, configure Claude Code with gRPC instead of HTTP:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

To stop:

```bash
docker compose -f ~/.claude/docker-compose-otel.yaml down
```

### ADOT-Specific Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `HTTP 500` from OSIS | Protobuf encoding (default) | Add `encoding: json` and `compression: none` to all `otlphttp` exporters |
| `HTTP 401` / "Missing Authentication Token" | SigV4 credentials expired | Refresh `.adot.env` with fresh credentials |
| `EOF` or connection drops | OSIS pipeline cold-start | Stop and start the OSIS pipeline |
| `connection refused` | ADOT not listening on 4317 | Check `docker ps`; ensure ports aren't taken |

</details>

## Disabling Telemetry

Unset `CLAUDE_CODE_ENABLE_TELEMETRY` or set it to `0`. No other changes needed.
