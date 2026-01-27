# Agent Health

[![CI](https://github.com/opensearch-project/dashboards-traces/actions/workflows/ci.yml/badge.svg)](https://github.com/opensearch-project/dashboards-traces/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE.txt)
[![Coverage](https://img.shields.io/badge/coverage->90%25-brightgreen.svg)](https://github.com/opensearch-project/dashboards-traces/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@opensearch-project/agent-health.svg)](https://www.npmjs.com/package/@opensearch-project/agent-health)

An evaluation and observability framework for AI agents. Features real-time trace visualization, "Golden Path" trajectory comparison, and LLM-based evaluation scoring.

## Features

- **Evals**: Real-time agent evaluation with trajectory streaming
- **Experiments**: Batch evaluation runs with configurable parameters
- **Compare**: Side-by-side trace comparison with aligned and merged views
- **Live Traces**: Real-time trace monitoring with auto-refresh and filtering
- **Trace Views**: Timeline and Flow visualizations for debugging
- **Reports**: Evaluation reports with LLM judge reasoning

For a detailed walkthrough, see [Getting Started](./GETTING_STARTED.md).

---

## Quick Start

```bash
# Install dependencies
npm install

# Option 1: Production mode (single server)
npm run server   # Builds frontend + starts server on port 4001

# Option 2: Development mode (two terminals)
# Terminal 1 - Backend server (port 4001)
npm run dev:server

# Terminal 2 - Frontend dev server (port 4000)
npm run dev
```

Open http://localhost:4000

---

## Authentication (Required)

AWS credentials are required for the Bedrock LLM Judge to score evaluations.

Create a `.env` file:
```bash
cp .env.example .env
```

Add your AWS credentials:
```bash
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_SESSION_TOKEN=your_session_token  # if using temporary credentials
```

---

## Configuration (Optional)

All optional settings have sensible defaults. Configure only what you need.

### Agent Endpoints

Agent endpoints default to localhost. Override if your agent runs elsewhere:

```bash
LANGGRAPH_ENDPOINT=http://localhost:3000
HOLMESGPT_ENDPOINT=http://localhost:5050/api/agui/chat
MLCOMMONS_ENDPOINT=http://localhost:9200/_plugins/_ml/agents/{agent_id}/_execute/stream
```

### Storage (Persistence)

For persisting test cases, experiments, and runs. Features gracefully degrade if not configured.

```bash
OPENSEARCH_STORAGE_ENDPOINT=https://your-cluster.opensearch.amazonaws.com
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=your_password
```

### Traces (Observability)

For agent execution traces. Features gracefully degrade if not configured.

```bash
OPENSEARCH_LOGS_ENDPOINT=https://your-logs-cluster.opensearch.amazonaws.com
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=your_password
```

See `.env.example` for all available options.

---

## Development Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run dev` | Start frontend dev server (port 4000) |
| `npm run dev:server` | Start backend server (port 4001) |
| `npm run build` | TypeScript compile + Vite production build |
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests only |
| `npm test -- --coverage` | Run tests with coverage report |
| `npm run build:all` | Build UI + server + CLI |
| `npm run build:cli` | Build CLI only |

### Production Mode

```bash
npm run server  # Build UI + start single server on port 4001
```

Open http://localhost:4001

### NPX Usage

After publishing, run directly with npx:

```bash
npx @opensearch-project/agent-health           # Start server on port 4001
npx @opensearch-project/agent-health --port 8080
npx @opensearch-project/agent-health --env-file .env
```

### Ports Summary

| Mode | Command | Port(s) |
|------|---------|---------|
| **Dev (frontend)** | `npm run dev` | 4000 |
| **Dev (backend)** | `npm run dev:server` | 4001 |
| **Production** | `npm run server` | 4001 |
| **NPX** | `npx @opensearch-project/agent-health` | 4001 (default) |

In development, the Vite dev server (4000) proxies `/api` requests to the backend (4001).

---

## Agent Setup

Agent Health supports multiple agent types:

| Agent | Endpoint Variable | Setup |
|-------|-------------------|-------|
| Langgraph | `LANGGRAPH_ENDPOINT` | Simple localhost agent |
| HolmesGPT | `HOLMESGPT_ENDPOINT` | AG-UI compatible RCA agent |
| ML-Commons | `MLCOMMONS_ENDPOINT` | See [ML-Commons Setup](./docs/ML-COMMONS-SETUP.md) |

---

## Architecture

```
Browser (React UI)
       |
       v
Backend Server (4001) --> Bedrock LLM Judge
       |
       v
Agent Endpoint --> Tools --> OpenSearch Data
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Cannot connect to backend | Run `npm run dev:server`, check `curl http://localhost:4001/health` |
| AWS credentials expired | Refresh credentials in `.env` |
| Storage/Traces not working | Check OpenSearch endpoint and credentials in `.env` |

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

### Development Workflow

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Create a feature branch: `git checkout -b feature/your-feature`
4. Make changes and add tests
5. Run tests: `npm test`
6. Commit with DCO signoff: `git commit -s -m "feat: your message"`
7. Push and create a Pull Request

All commits require DCO signoff and all PRs must pass CI checks (tests, coverage, linting).

---

## Documentation

- [Getting Started](./GETTING_STARTED.md) - Installation, demo mode, and usage walkthrough
- [ML-Commons Agent Setup](./docs/ML-COMMONS-SETUP.md) - Configure ML-Commons agent
- [Development Guide](./CLAUDE.md) - Architecture and coding conventions
- [AG-UI Protocol](https://docs.ag-ui.com/sdk/js/core/types#runagentinput)
