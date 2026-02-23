# Quick Start: AI-Assisted Agent Improvement

Get your AI coding assistant to evaluate and improve your agent in 5 minutes.

---

## Prerequisites

- Your agent code open in IDE
- Node.js installed
- Agent endpoint running (or mock mode)

---

## Setup by IDE

### Claude Code

```bash
# From your agent's project root:
mkdir -p .claude/skills
curl -o .claude/skills/agent-health.md \
  https://raw.githubusercontent.com/opensearch-project/agent-health/main/AGENT_HEALTH.md
```

Done. Claude Code auto-discovers skills.

### Kiro

```bash
# From your agent's project root:
mkdir -p .kiro/steering
curl -o .kiro/steering/agent-health.md \
  https://raw.githubusercontent.com/opensearch-project/agent-health/main/AGENT_HEALTH.md
```

Done. Kiro auto-loads steering files.

### Other IDEs (Cursor, Windsurf, etc.)

```bash
# Download to project root:
curl -o AGENT_HEALTH.md \
  https://raw.githubusercontent.com/opensearch-project/agent-health/main/AGENT_HEALTH.md
```

Then tell your assistant: "Read AGENT_HEALTH.md and follow it"

---

## Usage

Once setup, just ask your AI assistant:

```
"Evaluate my agent using agent-health and fix any failures"
```

Or step by step:

```
"Run agent-health benchmark against my agent"
"What failed and why?"
"Fix the high-priority issues"
"Re-run to verify"
```

---

## What Happens

```
┌─────────────────────────────────────────────────┐
│  1. AI runs: npx agent-health benchmark ...     │
│                        ↓                        │
│  2. Gets JSON with failures + judge feedback    │
│                        ↓                        │
│  3. Reads your agent code                       │
│                        ↓                        │
│  4. Makes fixes based on improvement strategies │
│                        ↓                        │
│  5. Re-runs benchmark to verify                 │
└─────────────────────────────────────────────────┘
```

---

## Troubleshooting

**"npx agent-health not found"**
```bash
npm install -g @opensearch-project/agent-health
```

**"No agents configured"**
```bash
npx agent-health init  # Creates config with sample agents
```

**"Server not running"**
```bash
npx agent-health doctor  # Check configuration
```
