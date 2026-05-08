---
name: config-auth
description: Use when working on config loading, authentication, AWS profiles, or data source resolution. Explains the two config systems (TS vs JSON), auth priority, and multi-profile setup.
---

## Config & Auth Architecture

Agent Health uses **two separate config systems** for different purposes. Understanding when each applies prevents auth confusion when users have multiple AWS profiles.

### Two Config Systems

| System | File | Format | Purpose | Managed By |
|--------|------|--------|---------|------------|
| **Agent/Model Config** | `agent-health.config.ts` | TS/JS/MJS | Agents, models, connectors, hooks, judge | User edits manually |
| **Data Source Config** | `agent-health.config.json` | JSON only | OpenSearch credentials (storage + observability) | CLI `setup-telemetry` / Settings UI |

**Priority for TS/JS config loading** (`lib/config/loader.ts`):
1. `agent-health.config.ts` (highest)
2. `agent-health.config.js`
3. `agent-health.config.mjs`
4. Built-in defaults (if `extends: false` is NOT set)

**Why two systems?**
- TS config can contain executable code (hooks, dynamic values, custom connectors)
- JSON config stores credentials that the server persists and the Settings UI manages
- Browser never sees JSON credentials — only metadata (endpoint, authType, hasPassword)

---

### Auth Resolution Per Service

#### OpenSearch (Storage & Observability)

**Resolution order** (`server/middleware/dataSourceConfig.ts`):
1. **`agent-health.config.json`** (file) — highest priority
2. **Environment variables** (`OPENSEARCH_STORAGE_*` / `OPENSEARCH_LOGS_*`) — fallback
3. **null** — features degrade gracefully

**JSON config structure:**
```json
{
  "storage": {
    "endpoint": "https://search-....es.amazonaws.com",
    "authType": "sigv4",
    "awsProfile": "default",
    "awsRegion": "us-west-2",
    "awsService": "es"
  },
  "observability": {
    "endpoint": "https://search-....es.amazonaws.com",
    "authType": "sigv4",
    "awsProfile": "default",
    "awsRegion": "us-west-2",
    "awsService": "es",
    "tracesIndex": "otel-v1-apm-span-*"
  }
}
```

**Observability config** is where Agent Health reads OTel traces from. This is configured by:
1. `npx @opensearch-project/agent-health setup-telemetry` (writes to JSON automatically)
2. Manual edit of `agent-health.config.json` (add `observability` block with endpoint + auth)

The `tracesIndex` field defaults to `otel-v1-apm-span-*` if omitted. See `/instrument-otel` skill for the full instrumentation flow.

**Auth types** (`server/services/opensearchClientFactory.ts`):

| authType | Fields needed | How it works |
|----------|--------------|--------------|
| `none` | endpoint only | No auth headers |
| `basic` | endpoint, username, password | HTTP Basic Auth |
| `sigv4` | endpoint, awsRegion, awsService, awsProfile (optional) | AWS SigV4 credential chain |

**SigV4 credential resolution:**
```typescript
// If awsProfile specified → use that profile
// If omitted → use default AWS credential chain
const provider = fromNodeProviderChain({
  ...(config.awsProfile && { profile: config.awsProfile })
});
```

#### Bedrock Judge (LLM Evaluation)

**Resolution** (`server/services/bedrockService.ts`):
- Uses AWS SDK **default credential chain** — picks up whatever `AWS_PROFILE` is set in the server's environment
- Region: `process.env.AWS_REGION || 'us-west-2'`
- Model: `process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'`
- No explicit `awsProfile` field — relies on environment

#### Claude Code Agent (Subprocess)

**Resolution** (`agent-health.config.ts` → agent `connectorConfig.env`):
```typescript
{
  key: "claude-code",
  connectorConfig: {
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "Bedrock",     // ← explicit profile for Claude subprocess
      AWS_REGION: "us-west-2",
    },
  },
}
```
These env vars are set **inside the spawned Claude Code process** — isolated from the server's own credentials.

---

### Multi-Profile Setup Pattern

A user with separate profiles for separate concerns:

| Purpose | AWS Profile | Account | Used By |
|---------|-------------|---------|---------|
| OpenSearch reads | `default` | 651304888251 | Server → `agent-health.config.json` (awsProfile: "default") |
| Bedrock judge | `Bedrock` | 070785328308 | Server env: `AWS_PROFILE=Bedrock` |
| Claude Code agent | `Bedrock` | 070785328308 | TS config: `connectorConfig.env.AWS_PROFILE` |
| Telemetry sending | (none needed) | — | API Gateway is public (no SigV4 on client) |

**Problem:** The server process can only have ONE `AWS_PROFILE` env var. If Bedrock judge needs profile "Bedrock" but OpenSearch needs profile "default", you must:

1. Set `AWS_PROFILE=Bedrock` for the server (judge uses default chain)
2. Set `"awsProfile": "default"` in `agent-health.config.json` for OpenSearch (explicit override via `fromNodeProviderChain({ profile })`)

This works because OpenSearch SigV4 uses **explicit profile from config**, while Bedrock uses **ambient credentials from environment**.

---

### Key Files

| File | Purpose |
|------|---------|
| `lib/config/loader.ts` | Load + merge TS/JS config with defaults |
| `lib/config/types.ts` | `AgentHealthConfig`, `UserAgentConfig`, `UserModelConfig` |
| `server/middleware/dataSourceConfig.ts` | Resolve OpenSearch config (file → env → null) |
| `server/services/configService.ts` | Read/write `agent-health.config.json` |
| `server/services/opensearchClientFactory.ts` | Build OpenSearch client with correct auth |
| `server/services/bedrockService.ts` | Bedrock client init (uses ambient AWS creds) |
| `server/config/index.ts` | Server environment variable defaults |
| `agent-health.config.example.ts` | Reference TS config |

---

### Environment Variables Reference

**OpenSearch Storage (fallback when not in JSON):**
```bash
OPENSEARCH_STORAGE_ENDPOINT=https://...
OPENSEARCH_STORAGE_AUTH_TYPE=sigv4|basic|none
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=secret
OPENSEARCH_STORAGE_AWS_REGION=us-west-2
OPENSEARCH_STORAGE_AWS_PROFILE=default
OPENSEARCH_STORAGE_AWS_SERVICE=es|aoss
```

**OpenSearch Observability (fallback when not in JSON):**
```bash
OPENSEARCH_LOGS_ENDPOINT=https://...
OPENSEARCH_LOGS_AUTH_TYPE=sigv4|basic|none
OPENSEARCH_LOGS_AWS_REGION=us-west-2
OPENSEARCH_LOGS_AWS_PROFILE=default
OPENSEARCH_LOGS_AWS_SERVICE=es|aoss
```

**Bedrock Judge:**
```bash
AWS_PROFILE=Bedrock          # Profile with Bedrock access
AWS_REGION=us-west-2         # Bedrock region
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

**Telemetry (Client-side, in shell RC):**
```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_EXPORTER_OTLP_ENDPOINT=https://<api-gw>.execute-api.<region>.amazonaws.com
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_TRACES_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
```

---

### Design Principles

1. **JSON for credentials, TS for behavior** — never put secrets in TS config (it's committed to git)
2. **Explicit profile wins** — `awsProfile` in JSON config overrides ambient `AWS_PROFILE`
3. **Each service resolves independently** — OpenSearch can use profile A while Bedrock uses profile B
4. **Degrade gracefully** — missing config means features are unavailable, not errors
5. **Browser never sees secrets** — server proxies all authenticated requests
6. **`setup-telemetry` writes JSON** — it's the only automated way to populate credentials
