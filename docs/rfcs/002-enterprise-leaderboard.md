<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# RFC 002: Enterprise AI Usage Leaderboard

| Field        | Value                                      |
|--------------|--------------------------------------------|
| **Status**   | Draft                                      |
| **Author**   | Anirudha Jadhav                            |
| **Created**  | 2026-04-07                                 |
| **Depends**  | RFC 001 (Coding Agent Analytics), RFC 003 (Remote Aggregation) |
| **Issue**    | opensearch-project/agent-health#122        |

## Summary

Add an enterprise-grade AI usage analytics and leaderboard system to Agent Health. Local coding agent session data (from RFC 001) is synced to an OpenSearch `ai_usage_events` index on demand. Team dashboards, leaderboards, badges, and learning recommendations are computed live via OpenSearch PPL — no materialized views or rollup indexes required.

## Motivation

### Problem

1. **No team visibility** — Individual developers can see their own AI usage (RFC 001), but team leads and engineering managers have no way to understand AI adoption patterns across their organization.
2. **No cost attribution** — Enterprises paying for AI coding tools (Claude Max, Copilot Enterprise, Cursor Teams) cannot attribute costs to teams or projects.
3. **No adoption benchmarking** — There is no way to compare how different teams or individuals are leveraging AI tools, making it impossible to identify best practices or training needs.
4. **No learning from peers** — Developers cannot learn from teammates who are more effective with AI tools (e.g., which tool patterns lead to higher completion rates).

### Market Context

- **GitHub Copilot** is the only AI coding tool with mature enterprise analytics (team-level metrics API, SPACE framework). Their original Metrics API was deprecated April 2, 2026, in favor of newer endpoints — the space is actively evolving.
- **10+ fragmented tools** exist for Claude Code cost tracking alone (ccbase, Claud-ometer, ObservAgent, goccc, etc.), all single-agent, all tiny. No tool provides cross-agent team analytics.
- **Claude Code issue #33978** consolidates 10+ open issues requesting usage analytics — token usage visibility is the #1 most-requested feature category.
- **Enterprise LLM platforms** (Helicone $799/mo, Braintrust $249/mo, LangSmith enterprise) focus on production LLM apps, not coding agent usage.

### Privacy-First Design

Developer productivity tracking is controversial. GitHub removed public streak counters in 2016 due to backlash. The SPACE framework recommends team-level aggregation, never individual scoring. Our design:

- **Opt-in only** — Data only leaves the local machine when explicitly synced
- **Anonymizable** — Team admins see aggregates; individual data requires user consent
- **No content logging** — Prompts and responses never synced, only metrics
- **Team-level defaults** — Leaderboards show team rankings by default, individual opt-in
- **Configurable granularity** — Users control what is shared

## Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Local Machine (existing RFC 001)                   │
│  CodingAgentRegistry → AgentSession[] (in-memory, from filesystem)  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ POST /api/coding-agents/leaderboard/sync
                               │ (on-demand, user-initiated)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    OpenSearch (ai_usage_events index)                 │
│                                                                      │
│  Per-session documents with: user_id, team_id, agent, model,        │
│  project (hashed), tokens, cost, tool counts, duration, completion  │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │  PPL Query   │  │  PPL Query   │  │     PPL Query            │   │
│  │  Team Stats  │  │  Leaderboard │  │  Recommendations         │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────────┘   │
└─────────┼────────────────┼──────────────────────┼───────────────────┘
          │                │                      │
          ▼                ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    API Layer (Express routes)                         │
│                                                                      │
│  GET /api/coding-agents/leaderboard/team-stats                      │
│  GET /api/coding-agents/leaderboard/rankings                        │
│  GET /api/coding-agents/leaderboard/badges                          │
│  GET /api/coding-agents/leaderboard/recommendations                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Model

Single index, no materialized views. All aggregations computed live via PPL/DSL at query time.

**Index: `ai_usage_events`**

```typescript
interface UsageEvent {
  // Identity (anonymizable)
  user_id: string;        // configurable: real name, hash, or "anonymous"
  team_id: string;        // team/org identifier
  
  // Session metadata
  session_id: string;     // unique, prevents duplicate sync
  agent: AgentKind;       // claude-code | kiro | codex
  model: string;          // claude-opus-4-6, etc.
  project_hash: string;   // SHA-256 of project path (privacy)
  project_display: string; // last path segment only
  start_time: string;     // ISO 8601
  
  // Metrics
  duration_minutes: number;
  user_message_count: number;
  assistant_message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  estimated_cost: number;
  
  // Tool usage
  total_tool_calls: number;
  total_tool_errors: number;
  tool_success_rate: number;
  top_tools: string[];           // top 5 tool names used
  tool_categories: string[];     // unique categories used
  uses_mcp: boolean;
  
  // Outcome
  session_completed: boolean;
  
  // Sync metadata
  synced_at: string;      // when this event was pushed to OpenSearch
  source_server: string;  // "local" or remote server name
}
```

### Implementation Phases

#### Phase 1: OpenSearch Ingestion Pipeline

Transform `AgentSession[]` → `UsageEvent[]` and index into OpenSearch.

- New service: `server/services/codingAgents/leaderboard/ingestion.ts`
- New route: `POST /api/coding-agents/leaderboard/sync` — triggers sync
- New route: `GET /api/coding-agents/leaderboard/sync-status` — last sync time, event count
- Config: `leaderboard.userId`, `leaderboard.teamId`, `leaderboard.enabled` in `agent-health.config.json`
- Deduplication: Uses `session_id` as document ID to prevent double-sync
- Privacy: Project paths hashed, no prompt content synced

#### Phase 2: Team Dashboard

Live PPL queries against `ai_usage_events` for team-level analytics.

- New service: `server/services/codingAgents/leaderboard/teamAnalytics.ts`
- Endpoints:
  - `GET /api/coding-agents/leaderboard/team-stats` — aggregate stats by team
  - `GET /api/coding-agents/leaderboard/user-stats` — per-user stats (opt-in)
  - `GET /api/coding-agents/leaderboard/project-stats` — per-project stats
  - `GET /api/coding-agents/leaderboard/trends` — daily/weekly trends

PPL examples:
```sql
-- Team stats
source=ai_usage_events | where team_id='engineering'
  | stats count() as sessions, sum(estimated_cost) as total_cost,
          avg(tool_success_rate) as avg_success_rate,
          sum(session_completed) as completed
    by user_id
  | sort - total_cost

-- Daily trends
source=ai_usage_events | where team_id='engineering'
  | eval day=date_format(start_time, 'yyyy-MM-dd')
  | stats count() as sessions, sum(estimated_cost) as cost by day
  | sort day
```

#### Phase 3: Leaderboard + Badges

Rankings and achievement badges computed live via PPL.

- New service: `server/services/codingAgents/leaderboard/rankings.ts`
- New service: `server/services/codingAgents/leaderboard/badges.ts`
- Endpoints:
  - `GET /api/coding-agents/leaderboard/rankings` — ranked users by configurable metric
  - `GET /api/coding-agents/leaderboard/badges` — earned badges for a user
  - `GET /api/coding-agents/leaderboard/badges/definitions` — all badge definitions

**Badge Definitions:**

| Badge | Criteria | Category |
|-------|----------|----------|
| Cost Optimizer | Bottom 25th percentile cost/completion | efficiency |
| Power User | 100+ sessions | volume |
| Multi-Agent | Used 3+ different agents | diversity |
| Streak Master | 7+ day streak | consistency |
| Tool Expert | 95%+ tool success rate | quality |
| Night Owl | 50%+ sessions between 10pm-4am | pattern |
| Early Bird | 50%+ sessions between 5am-9am | pattern |
| MCP Pioneer | Used MCP tools in 10+ sessions | adoption |
| Completionist | 90%+ session completion rate (20+ sessions) | quality |
| Cache Champion | 80%+ cache hit rate | efficiency |

**Ranking metrics** (configurable via query param):
- `sessions` — total session count
- `cost` — total estimated cost
- `completion_rate` — session completion rate
- `efficiency` — cost per completed session (lower is better)
- `tool_success` — tool success rate
- `active_days` — days with at least one session

#### Phase 4: Learning Recommendations

Analyze patterns from top performers and generate actionable recommendations.

- New service: `server/services/codingAgents/leaderboard/recommendations.ts`
- Endpoint:
  - `GET /api/coding-agents/leaderboard/recommendations` — personalized recommendations
  - `GET /api/coding-agents/leaderboard/team-insights` — team-level insights

**Recommendation types:**

1. **Tool Patterns** — "Top performers use Edit 40% more than you. Try editing files directly instead of writing new ones."
2. **Model Selection** — "Your Opus usage is 3x team average. Consider Sonnet for simple tasks — teammates using Sonnet for file reads save 60%."
3. **Session Hygiene** — "Your sessions average 45 min. Teammates with <20 min sessions have 15% higher completion rates."
4. **Cache Optimization** — "Your cache hit rate is 40% vs team average 70%. Longer sessions with stable context improve caching."
5. **Agent Diversity** — "You only use Claude Code. Teammates using Kiro for IDE tasks report faster completion."

### API Reference

All leaderboard endpoints require OpenSearch storage to be configured.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/coding-agents/leaderboard/sync` | POST | Sync local sessions to OpenSearch |
| `/api/coding-agents/leaderboard/sync-status` | GET | Last sync time, total events |
| `/api/coding-agents/leaderboard/team-stats` | GET | Team aggregate stats |
| `/api/coding-agents/leaderboard/user-stats` | GET | Per-user stats (opt-in) |
| `/api/coding-agents/leaderboard/project-stats` | GET | Per-project stats |
| `/api/coding-agents/leaderboard/trends` | GET | Daily/weekly cost and usage trends |
| `/api/coding-agents/leaderboard/rankings` | GET | Ranked users by metric |
| `/api/coding-agents/leaderboard/badges` | GET | Badges earned by a user |
| `/api/coding-agents/leaderboard/badges/definitions` | GET | All badge definitions |
| `/api/coding-agents/leaderboard/recommendations` | GET | Personalized recommendations |
| `/api/coding-agents/leaderboard/team-insights` | GET | Team-level insights |

Query parameters: `team_id`, `user_id`, `from`, `to` (date range), `metric` (for rankings), `period` (daily/weekly/monthly for trends).

### Security Considerations

- **Authentication**: Leaderboard endpoints use the same storage client middleware as existing storage routes — OpenSearch auth (basic, SigV4) handles access control
- **Data minimization**: Only metrics synced, never prompt content or conversation text
- **Project privacy**: Full project paths hashed; only last path segment exposed as display name
- **User identity**: Configurable — real name, email hash, or fully anonymous
- **Index access**: OpenSearch RBAC can restrict `ai_usage_events` access per team

### Performance

- **Ingestion**: Bulk indexing with `refresh: false` — one bulk call per sync
- **Queries**: PPL queries with date range filters hit OpenSearch's inverted index efficiently
- **No rollups**: OpenSearch handles aggregation of raw events at query time — tested performant up to millions of documents
- **Caching**: Route-level caching (30s TTL) for frequently-accessed team stats

## Alternatives Considered

1. **Materialized views / daily rollup index** — Rejected. OpenSearch PPL computes aggregations live without stale data issues or sync complexity. Simpler architecture, one index.
2. **Local-only leaderboard** — Would limit to single-machine data. OpenSearch enables multi-machine aggregation for distributed teams.
3. **External analytics service** — Helicone/Braintrust could work but adds vendor dependency, cost ($79-799/mo), and requires API proxy setup. Our approach is free and self-hosted.
4. **ClickHouse backend** — Better raw query performance for analytics workloads, but adds a new dependency. OpenSearch is already in the stack.

## References

- [RFC 001: Coding Agent Analytics](001-coding-agent-analytics.md)
- [GitHub Copilot Metrics API](https://docs.github.com/en/rest/copilot/copilot-metrics)
- [SPACE Framework](https://queue.acm.org/detail.cfm?id=3454124) — Satisfaction, Performance, Activity, Communication, Efficiency
- [anthropics/claude-code#33978](https://github.com/anthropics/claude-code/issues/33978) — Consolidated usage analytics feature request
- [Pragmatic Engineer on Developer Productivity](https://newsletter.pragmaticengineer.com/p/measuring-developer-productivity)
