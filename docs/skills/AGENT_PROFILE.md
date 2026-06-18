<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Agent Profiling — improve an agent from its own sessions

**Agent profiling** is to an AI agent what a CPU/JVM profiler is to a running
program: you attach to a *real session*, sample its execution (OpenTelemetry
traces), and get back a report of where the agent went wrong and what to fix —
in the agent's **own codebase**. Instead of profiling for performance hotspots,
it profiles for *behavioral* problems, scored against an evaluator you choose as
the rubric.

No synthetic test cases. The session you just ran is the input, and the
corrections you made while steering it are part of the signal. Because it reads
**traces**, not chat logs, it works for non-chat agents too.

It reuses the same pluggable `Evaluator` definitions and the same
`improvementStrategies[]` shape as the batch eval pipeline — it just points them
at a live session's traces.

---

## Setup (once per project)

```bash
# 1. Install the agent-profiling hook + skill into Claude Code.
#    - a PreToolUse hook that records the current session id to
#      .claude/agent-health/current-session (deterministic — no mtime guessing)
#    - the /agent-health:profile slash command
#    - the curated customer skills (agent-health-profile, agent-health-assistant,
#      instrument-otel)
npx @opensearch-project/agent-health setup

# 2. Stream Claude Code telemetry into Agent Health's OpenSearch.
npx @opensearch-project/agent-health setup-telemetry
```

`setup` is idempotent — re-running won't duplicate the hook, and won't overwrite
skill/command files unless you pass `--force`. For **Kiro**, drop
`docs/skills/AGENT_PROFILE.md` under `.kiro/steering/`; for other tools, tell the
assistant "read AGENT_PROFILE.md and follow it".

---

## Usage

Use your agent normally and steer it as you like. When the session is done:

```bash
# From inside the coding session (slash command):
/agent-health:profile -e <evaluator-id>

# …or directly, optionally with upfront feedback to steer the analysis:
npx @opensearch-project/agent-health profile -e <evaluator-id> --feedback "focus on routing; it ignored the SOP"
```

If `-e` is omitted it defaults to `system-rca-default`. `--feedback "<text>"` is
optional upfront human steering — context the traces can't capture; the reasoner
weights it above the deterministic signals. List evaluators with
`agent-health list` (or the `/api/storage/evaluators` API).

---

## How it works

```
your session  ──OTel spans──▶ Agent Health (OpenSearch)
                                   │
agent-health profile -e <id>       │  resolves: evaluator rubric (by id)
                                   ▼  samples:  this session's spans → trajectory
                          { evaluator, trajectory, signals }   + a deterministic signal scan
                                   │
        the coding agent adds: the live chat + the codebase it's sitting in
                                   ▼
                 prioritized edits → applied on a branch → you review
```

`profile` supplies only the half the agent can't see — the **traces** and the
**rubric**. The agent already has the conversation and the code, so it does the
reasoning and the edits. (For a headless context the JSON profile can be fed to
any reasoner.)

### What the profile contains (`--output json`)

```jsonc
{
  "session":   { "sessionId", "serviceName", "traceIds", "spanCount", "trajectorySteps", "durationMs", "tokens" },
  "evaluator": { "id", "name", "systemPrompt", "metrics", "passThreshold" },
  "signals":   [ { "id", "title", "severity", "count", "evidence" } ],
  "userFeedback": "<your --feedback text, if given>",
  "trajectory":[ /* TrajectoryStep[] reconstructed from spans */ ],
  "instructions": "Using the rubric + feedback, review trajectory + signals + chat + codebase; propose edits…"
}
```

It is also written to `.agent-health/data/profiles/<sessionId>/profile.json`.

### Signals scanned (deterministic, pre-LLM)

| id | meaning |
|---|---|
| `user_rejection` | you rejected/aborted a tool the agent proposed (Claude Code permission denial — always available, no prompt logging needed) |
| `user_redirect` | you corrected/redirected the agent mid-session (requires `OTEL_LOG_USER_PROMPTS=1`) |
| `tool_error_retry` | a tool failed, then was retried — tool-usage / description gap |
| `repeated_tool_calls` | identical tool+args invoked more than once — loop / distrust |
| `long_session` | unusually many interactions — confusion or scope creep |
| `write_before_read` | mutated state before reading — safety / grounding gap |

Signals are evidence handed to the rubric, not the verdict — the evaluator's
`systemPrompt` decides what to improve. The adapter reads real Claude Code
telemetry (attribute-based `claude_code.*` spans) and falls back to generic OTel
GenAI event-based spans for other agents.

---

## Session identification

`profile` resolves the session id in priority order:
1. `--session <id>` if you pass it,
2. `.claude/agent-health/current-session` (written by the setup hook — exact),
3. newest Claude Code transcript for this cwd (heuristic fallback).

Every Claude Code span carries `session.id`, so once resolved the fetch is exact
(`fetchTracesBySessionId`).

---

## The loop

```
profile → read findings → fix on a branch → merge → next session → re-profile
```

Run it after any session, or on a schedule (cron) over production sessions to
get a continuous improvement signal at production distribution.

---

## Guardrails

- `profile` is read-only — it never edits code; it produces the profile + a plan.
- Apply edits on a **branch**, never the working tree, and keep them minimal and
  generalizable.
- The rubric is the customer's evaluator, so improvements track *their*
  definition of good.

---

## Prerequisites

`profile` reads traces from, and the judge scores against, the same backend the
rest of Agent Health uses:
- **OpenSearch** for traces (`OPENSEARCH_LOGS_*` or `agent-health.config.json`
  → `observability`) — the *same* cluster your telemetry is exported to.
- **AWS Bedrock** credentials for the LLM judge (`AWS_PROFILE` / `AWS_REGION`).

Verify with `agent-health doctor`. Litmus test: if your session shows up in the
**Traces** tab, `profile` will find it.
