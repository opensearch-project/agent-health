<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# RFC 003: Remote Server Aggregation

| Field        | Value                                      |
|--------------|--------------------------------------------|
| **Status**   | Implemented                                |
| **Author**   | Anirudha Jadhav                            |
| **Created**  | 2026-04-07                                 |
| **Depends**  | RFC 001 (Coding Agent Analytics)           |
| **Issue**    | opensearch-project/agent-health#122        |

## Summary

Extend Agent Health's Coding Agent Analytics (RFC 001) with remote server aggregation. Developers running coding agents on multiple machines (laptops, EC2 build servers, remote VMs) can aggregate session data into a single local dashboard. Each remote machine runs Agent Health in headless mode with API key authentication, and the local instance transparently merges remote data with local sessions.

## Motivation

### Problem

1. **Multi-machine development** — Developers increasingly use remote build servers, cloud dev environments, and multiple laptops. Session data is siloed per machine.
2. **Team visibility** — Engineering leads want to see aggregated usage across their team's machines without requiring each developer to manually export data.
3. **No standard aggregation** — Existing tools (cc-lens, vibedev) only read local filesystem data. There is no way to pull coding agent analytics from remote machines.

### Why Extend RFC 001

RFC 001 established the reader interface, session cache, and analytics API. Remote aggregation reuses the same `CodingAgentReader` interface and API surface — the `RemoteAggregator` extends `CodingAgentRegistry` and merges remote sessions transparently. No changes to the frontend are needed beyond server name badges on sessions.

## Design

### Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  EC2 Build  │     │  Laptop 2   │     │  Cloud Dev  │
│  Server     │     │  (headless) │     │  (headless) │
│  :4001      │     │  :4001      │     │  :4001      │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └──────────┬────────┴───────────────────┘
                  │  HTTP + API Key
           ┌──────┴──────┐
           │  Local Dev  │
           │  Dashboard  │
           │  :4001      │
           └─────────────┘
```

### Remote Server Mode

Remote machines run Agent Health in headless mode:

```bash
npx @opensearch-project/agent-health serve --headless --api-key sk-my-secret
```

- No UI served, only API endpoints
- API key required for all `/api/coding-agents/*` routes
- Responds to the same analytics endpoints as local

### RemoteAggregator

The `RemoteAggregator` class extends `CodingAgentRegistry`:

- On each API call, fetches from all configured remote servers in parallel
- Tags each remote session with `server_name` for attribution
- Uses `Promise.allSettled` for fault isolation — one slow/failing remote doesn't block local data
- 30-second cache TTL for remote data, 10-second request timeout
- Graceful degradation: if a remote is unreachable, local data still serves

### API Key Authentication

- Middleware checks `Authorization: Bearer <key>` header
- Only applied to `/api/coding-agents/*` routes when `--api-key` is set
- No-op when no API key configured (local-only mode)
- Keys stored in `agent-health.config.json` per remote server

### Configuration

Remote servers are configured via `agent-health.config.json`:

```json
{
  "remoteServers": [
    { "name": "ec2-build-1", "url": "http://10.0.1.50:4001", "apiKey": "sk-abc123" }
  ]
}
```

Or via CLI:

```bash
agent-health remote add --name ec2-build-1 --url http://10.0.1.50:4001 --api-key sk-abc
agent-health remote remove ec2-build-1
agent-health remote list
agent-health remote test
```

### Settings UI

A Settings page allows managing remote servers from the browser:
- Add/remove remote servers
- Test connectivity
- View connection status
- API keys masked in display

## API Endpoints

No new public endpoints. The existing `/api/coding-agents/*` endpoints transparently include remote data when remote servers are configured. Internal endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/remote-servers` | GET | List configured servers (keys masked) |
| `/api/remote-servers` | POST | Add server |
| `/api/remote-servers/:name` | DELETE | Remove server |
| `/api/remote-servers/:name/test` | POST | Test connectivity |

## Security Considerations

- API keys are stored in a local config file, not in environment variables
- Keys are masked in API responses (only last 4 chars shown)
- Remote connections should use HTTPS in production
- Rate limiting is recommended for exposed endpoints
- No raw conversation data is served over the remote protocol — only aggregated session metadata

## Files

| File | Purpose |
|------|---------|
| `server/services/codingAgents/remoteAggregator.ts` | RemoteAggregator class |
| `server/services/codingAgents/remoteConfig.ts` | Config file management |
| `server/middleware/apiKeyAuth.ts` | API key auth middleware |
| `server/routes/config.ts` | Remote server management routes |
| `cli/commands/remote.ts` | CLI remote commands |
| `components/SettingsPage.tsx` | Settings UI |
| `tests/unit/server/middleware/apiKeyAuth.test.ts` | Auth middleware tests |
| `tests/unit/server/services/codingAgents/remoteAggregator.test.ts` | Aggregator tests |
| `tests/unit/server/services/codingAgents/remoteConfig.test.ts` | Config tests |

## Relationship to Other RFCs

- **Depends on RFC 001**: Uses reader interface, session cache, registry pattern
- **Complements RFC 002**: Remote aggregation provides cross-machine data that the enterprise leaderboard can ingest. However, as noted in the RFC 002 review, OpenSearch sync may eventually replace machine-to-machine HTTP for enterprise use cases.
