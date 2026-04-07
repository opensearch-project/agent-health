<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Coding Agent Analytics

A unified analytics dashboard for AI coding agents. Reads local session data from **Claude Code**, **Kiro**, and **Codex CLI** and provides cross-agent usage metrics, cost estimation, activity patterns, tool analytics, and workspace management — all without sending data anywhere.

## Quick Start

```bash
# Start the server (includes the analytics dashboard)
npm run dev:server    # Backend on port 4001
npm run dev           # Frontend on port 4000 (separate terminal)

# Or production mode (single process)
npm run server
```

Open `http://localhost:4000` (dev) or `http://localhost:4001` (prod) and click the **Coding Agents** tab. The dashboard auto-detects installed agents and shows data immediately.

## Supported Agents

| Agent | Data Location | What's Parsed | Cost Estimation |
|-------|--------------|---------------|-----------------|
| **Claude Code** | `~/.claude/projects/<slug>/*.jsonl` | Messages, tool calls, token usage, cache metrics, MCP usage | Full (input/output/cache tokens) |
| **Kiro** | `~/.kiro/sessions/cli/*.jsonl` + IDE workspace | Messages, tool calls, partial token counts, session metadata | Partial (Bedrock pricing) |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Messages, tool calls, session metadata | None (tokens not persisted) |

No configuration required. If the agent's data directory exists, it's detected automatically.

## Dashboard Tabs

### Overview
Top-level stats across all agents: total sessions, estimated cost, tool success rate, cost per completion, wasted cost (incomplete sessions), and detected agents. Includes daily activity chart, agent distribution pie chart, and auto-generated insights with actionable recommendations.

### Sessions
Filterable, sortable session list with search. Click any session to open a resizable detail panel showing the full conversation with syntax highlighting. Supports filtering by agent, completion status, and project. Search highlights matches with prev/next navigation.

### Projects
Per-project analytics cards showing session count, completion rate, cost, and tool errors. Click any project to drill into its sessions.

### Costs
Cost breakdown by model and project with daily cost trend chart. Includes cache savings calculation. Click chart bars to drill into sessions or projects.

### Activity
GitHub-style activity heatmap (last 90 days), sessions by hour and day of week, current/longest streaks, and active days. Click any element to explore related sessions.

### Efficiency
Cross-agent comparison of tool success rate, completion rate, and cost per completion. Per-agent cards with detailed metrics. Click agent cards to view their sessions.

### Tools
Tool usage analytics with category breakdown (file-io, shell, agent, web, planning, mcp, etc.). Click category bars to filter the tools table. Click tool rows to see sessions using that tool. Includes error rates and success percentages.

### Advanced
MCP server analytics, hourly effectiveness (completion rate by hour), session duration distribution, conversation depth analysis, and recurring failure patterns. All elements are clickable for drill-down navigation.

### Workspace
Agent-specific workspace management:
- **Claude Code**: Active sessions, memory files (view/edit), plans, tasks, and settings
- **Kiro**: MCP servers, agents, powers, extensions, and settings

## Architecture

```
Browser (React)
  → Express API (/api/coding-agents/*)
    → SessionCacheManager (in-memory, <1ms responses)
      → ReaderCache (per-agent, directory signature invalidation)
        → [ClaudeCodeReader, KiroReader, CodexReader]
          → Local filesystem (~/.claude/, ~/.kiro/, ~/.codex/)
```

### In-Memory Cache

Session data is cached in memory with a two-tier invalidation strategy:

1. **Directory signature** — `"latestMtime:fileCount"` fingerprint detects new/deleted sessions without re-parsing
2. **Active session refresh** — Background interval (30s) checks file mtime for non-completed sessions only

First request after startup: ~30ms (cache warmup). Subsequent requests: <3ms.

### Key Files

```
server/services/codingAgents/
├── index.ts              # Barrel exports
├── types.ts              # Unified type definitions (AgentSession, CombinedStats, etc.)
├── registry.ts           # Core registry — merges data from all readers
├── cache.ts              # Two-tier session cache with directory invalidation
├── pricing.ts            # Multi-vendor pricing (Claude, Bedrock, OpenAI)
├── toolCategories.ts     # Unified tool categorization across agents
├── insights.ts           # Auto-generated actionable insights
└── readers/
    ├── claudeCode.ts     # Claude Code JSONL parser
    ├── claudeCodeWorkspace.ts  # Claude Code workspace (memory, plans, tasks)
    ├── kiro.ts           # Kiro CLI + IDE session parser
    ├── kiroWorkspace.ts  # Kiro workspace (MCP, agents, powers)
    └── codex.ts          # Codex CLI rollout parser

server/routes/
├── codingAgents.ts       # Analytics API endpoints (12 routes)
└── claudeCodeWorkspace.ts # Workspace management endpoints (6 routes)

components/codingAgents/
└── CodingAgentsPage.tsx  # React dashboard (9 tabs, ~2600 LOC)
```

## API Reference

All endpoints support optional `from` and `to` query parameters for date range filtering (ISO 8601 format).

| Endpoint | Description |
|----------|-------------|
| `GET /api/coding-agents/available` | List detected agents |
| `GET /api/coding-agents/stats` | Combined stats across all agents |
| `GET /api/coding-agents/sessions` | Paginated session list (supports `agent`, `completed`, `project`, `search`, `limit`, `offset`) |
| `GET /api/coding-agents/sessions/:agent/:sessionId` | Session detail with full conversation |
| `GET /api/coding-agents/costs` | Cost breakdown by model and project |
| `GET /api/coding-agents/activity` | Activity patterns (streaks, hourly, daily, heatmap) |
| `GET /api/coding-agents/tools` | Tool usage analytics with categories |
| `GET /api/coding-agents/efficiency` | Per-agent efficiency metrics |
| `GET /api/coding-agents/projects` | Per-project analytics |
| `GET /api/coding-agents/advanced` | MCP, duration, conversation depth, hourly effectiveness |
| `GET /api/coding-agents/failure-patterns` | Recurring tool failure patterns |
| `GET /api/coding-agents/export` | Export all data as JSON or CSV (`format=json|csv`) |

### Remote Server Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/remote-servers` | List configured remote servers (API keys masked) |
| `POST /api/remote-servers` | Add a remote server (`{ name, url, apiKey? }`) |
| `DELETE /api/remote-servers/:name` | Remove a remote server |
| `POST /api/remote-servers/:name/test` | Test connectivity to a remote server |

### Workspace Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/coding-agents/claude-code/memory` | Claude Code memory files by project |
| `GET /api/coding-agents/claude-code/plans` | Active plans |
| `GET /api/coding-agents/claude-code/tasks` | Task lists |
| `GET /api/coding-agents/claude-code/settings` | Claude Code settings |
| `GET /api/coding-agents/claude-code/active-sessions` | Currently active sessions |
| `GET /api/coding-agents/kiro/workspace` | Kiro workspace (MCP servers, agents, powers, extensions) |

## Adding a New Agent Reader

To add support for a new coding agent:

1. **Create a reader** in `server/services/codingAgents/readers/`:

```typescript
import type { CodingAgentReader, AgentSession, AgentStats, SessionDetail } from '../types';

export class MyAgentReader implements CodingAgentReader {
  readonly agentName = 'my-agent' as const;
  readonly displayName = 'My Agent';

  async isAvailable(): Promise<boolean> {
    // Check if the agent's data directory exists
  }

  async getSessions(): Promise<AgentSession[]> {
    // Parse session files and return normalized AgentSession[]
  }

  async getStats(): Promise<AgentStats> {
    // Aggregate stats from sessions
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    // Return full conversation for a session
  }
}
```

2. **Register the reader** in `server/services/codingAgents/registry.ts`:

```typescript
import { MyAgentReader } from './readers/myAgent';

// Add to the readers array
private readers: CodingAgentReader[] = [
  new ClaudeCodeReader(),
  new KiroReader(),
  new CodexReader(),
  new MyAgentReader(),  // ← add here
];
```

3. **Add pricing** (if available) in `server/services/codingAgents/pricing.ts`

4. **Add tool categories** in `server/services/codingAgents/toolCategories.ts`

5. **Add cache signature** in `server/services/codingAgents/cache.ts` under `DIR_SIGNATURE_FNS`

6. **Add colors/labels** in `components/codingAgents/CodingAgentsPage.tsx`:
```typescript
const AGENT_COLORS = { ..., 'my-agent': '#your-color' };
const AGENT_LABELS = { ..., 'my-agent': 'My Agent' };
```

## Remote Build Server Monitoring

Monitor coding agents running on remote EC2 instances, build servers, or cloud dev environments from a single local dashboard.

### How It Works

Each remote machine runs `agent-health` in **headless mode** (API only, no frontend). Your local dashboard aggregates data from all remotes transparently — the frontend code is unchanged, always talking to its own local server.

```
[Remote EC2-A]  agent-health serve --headless --api-key sk-abc  → :4001
[Remote EC2-B]  agent-health serve --headless --api-key sk-xyz  → :4001

[Local machine]
  Browser → localhost:4001 → Local server merges local + remote data
```

### Setup

**On each remote machine:**

```bash
npx @opensearch-project/agent-health serve --headless --api-key sk-my-secret
```

**On your local machine:**

```bash
# Add remote servers
agent-health remote add --name ec2-build-1 --url http://10.0.1.50:4001 --api-key sk-my-secret
agent-health remote add --name ec2-build-2 --url http://10.0.1.51:4001 --api-key sk-other

# Test connectivity
agent-health remote test

# Start the dashboard — automatically aggregates from all servers
agent-health
```

Or use the **Settings UI** — go to Settings > Remote Servers to add, test, and remove servers from the browser.

Or configure via `agent-health.config.json`:

```json
{
  "remoteServers": [
    { "name": "ec2-build-1", "url": "http://10.0.1.50:4001", "apiKey": "sk-my-secret" },
    { "name": "ec2-build-2", "url": "http://10.0.1.51:4001", "apiKey": "sk-other" }
  ]
}
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `agent-health remote add --name <n> --url <u> [--api-key <k>]` | Add a remote server |
| `agent-health remote remove <name>` | Remove a remote server |
| `agent-health remote list` | List configured remotes |
| `agent-health remote test` | Test connectivity to all remotes |

### Key Behaviors

- **Graceful degradation**: If a remote is unreachable, the dashboard still shows data from available sources
- **30-second cache**: Remote session data is cached locally to avoid excessive network calls
- **10-second timeout**: Slow remotes don't block the entire dashboard
- **Server badges**: Sessions from remote servers show a colored badge with the server name
- **Transparent aggregation**: All analytics (stats, costs, activity, tools, etc.) automatically include remote data

## Feature Toggle

Coding Agent Analytics can be disabled entirely without affecting the core evaluation features:

```bash
# Via environment variable
AGENT_HEALTH_DISABLE_CODING_ANALYTICS=true npx @opensearch-project/agent-health
```

Or in `agent-health.config.json`:
```json
{
  "codingAgentAnalytics": false
}
```

When disabled: no routes are mounted, no background timers run, and the "Coding Agents" nav tab is hidden. All evaluation features continue to work normally.

## Privacy

All data stays local. The dashboard reads session files directly from your filesystem (`~/.claude/`, `~/.kiro/`, `~/.codex/`). No data is sent to any external service. The `_filePath` internal field used for caching is stripped from all API responses.

## Design Document

See [RFC 001: Coding Agent Analytics](rfcs/001-coding-agent-analytics.md) for the full design specification including motivation, architecture decisions, data flow diagrams, and planned future phases.
