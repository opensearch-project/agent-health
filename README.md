# Agent Health

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE.txt)
[![npm version](https://img.shields.io/npm/v/@opensearch-project/agent-health.svg)](https://www.npmjs.com/package/@opensearch-project/agent-health)
[![Documentation](https://img.shields.io/badge/View_Documentation-blue?logo=readthedocs&logoColor=white)](https://observability.opensearch.org/docs/agent-health/)

## What is Agent Health?

Agent Health is an evaluation and observability framework for AI agents. It helps you measure agent performance through "Golden Path" trajectory comparison — where an LLM judge evaluates agent actions against expected outcomes — and provides deep observability into agent execution via OpenTelemetry traces.

It also includes a **Coding Agent Analytics** dashboard for monitoring Claude Code, Kiro, and Codex CLI usage on your local machine.

**Who uses Agent Health:**
- AI teams building autonomous agents (RCA, customer support, data analysis)
- QA engineers testing agent behavior across scenarios
- Platform teams monitoring agent performance in production
- Developers using AI coding agents who want visibility into usage, costs, and productivity

**Key capabilities:**
- Real-time agent execution streaming and visualization
- LLM-based evaluation with pass/fail scoring
- Batch experiments comparing agents and models
- OpenTelemetry trace integration for performance analysis
- Pluggable connectors for different agent types (REST, SSE, CLI)
- Coding agent analytics with cost estimation, tool usage, and session drill-downs

## Quick Start

```bash
# Start Agent Health with demo data (no configuration needed)
npx @opensearch-project/agent-health
```

Opens http://localhost:4001 with pre-loaded sample data for exploration.

**Next steps:**
- [Getting Started Guide](./GETTING_STARTED.md) - Step-by-step walkthrough
- [Connect Your Agent](./docs/CONFIGURATION.md) - Configure your own agent

## Features

### Agent Evaluation & Observability

- **Evals**: Real-time agent evaluation with trajectory streaming
- **Experiments**: Batch evaluation runs with configurable parameters
- **Compare**: Side-by-side trace comparison with aligned and merged views
- **Agent Traces**: Table-based trace view with latency histogram, filtering, and detailed flyout with input/output display
- **Live Traces**: Real-time trace monitoring with auto-refresh and filtering
- **Trace Views**: Timeline and Flow visualizations for debugging
- **Reports**: Evaluation reports with LLM judge reasoning
- **Connectors**: Pluggable protocol adapters for different agent types

### Coding Agent Analytics

A unified dashboard for monitoring AI coding agent usage across **Claude Code**, **Kiro**, and **Codex CLI**. Zero configuration — just run `agent-health` and it auto-detects installed agents.

- **Multi-agent dashboard**: Session history, cost estimation, tool usage, activity patterns, and efficiency metrics across all three agents
- **9 analytics tabs**: Overview, Sessions, Projects, Costs, Activity, Efficiency, Tools, Advanced, and Workspace management
- **Interactive drill-downs**: Click any chart, card, or metric to drill into filtered session views
- **Workspace management**: View and edit Claude Code memory files, plans, tasks; browse Kiro MCP servers, agents, and extensions
- **Privacy-first**: All data stays local — reads directly from `~/.claude/`, `~/.kiro/`, `~/.codex/`

[Full documentation](./docs/CODING_AGENT_ANALYTICS.md)

### Supported Connectors

| Connector | Protocol | Description |
|-----------|----------|-------------|
| `agui-streaming` | AG-UI SSE | ML-Commons agents (default) |
| `rest` | HTTP POST | Non-streaming REST APIs |
| `subprocess` | CLI | Command-line tools |
| `claude-code` | Claude CLI | Claude Code agent comparison |
| `mock` | In-memory | Demo and testing |

For creating custom connectors, see [docs/CONNECTORS.md](./docs/CONNECTORS.md).

---

## Architecture

![Agent Health Architecture](docs/diagrams/architecture.png)

Agent Health uses a client-server architecture where all clients (UI, CLI) access OpenSearch through a unified HTTP API. The server handles agent communication via pluggable connectors and proxies LLM judge calls to AWS Bedrock.

For detailed architecture documentation, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## CLI Commands

```bash
# Start server (default action)
npx @opensearch-project/agent-health

# Initialize a new project (creates agent-health.config.ts and .env.example)
npx @opensearch-project/agent-health init

# Check configuration and connectivity
npx @opensearch-project/agent-health doctor

# List resources (agents, connectors, models, test-cases, benchmarks)
npx @opensearch-project/agent-health list agents
npx @opensearch-project/agent-health list connectors

# Run a single test case against an agent
npx @opensearch-project/agent-health run -t demo-otel-001 -a demo

# Run a benchmark (batch of test cases)
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -a my-agent
npx @opensearch-project/agent-health benchmark -n "My Benchmark" -a my-agent --export results.json

# Export benchmark test cases as JSON
npx @opensearch-project/agent-health export -b "My Benchmark" -o test-cases.json

# Generate reports (HTML, PDF, JSON)
npx @opensearch-project/agent-health report -b "My Benchmark"
npx @opensearch-project/agent-health report -b "My Benchmark" -f pdf -o report.pdf

# One-time migration for existing benchmark runs
npx @opensearch-project/agent-health migrate --dry-run
```

For full CLI documentation, see [docs/CLI.md](./docs/CLI.md).




## Configuration

Agent Health works out-of-the-box with demo data. Configure when you're ready to connect your own agent.

### Config File: `agent-health.config.ts`

This is the primary way to configure custom agents, models, and hooks. Create it in your working directory (the directory you run `npx` or `agent-health` from):

```bash
# Generate a config file with examples
npx @opensearch-project/agent-health init
```

Or create it manually:

```typescript
// agent-health.config.ts
export default {
  agents: [
    {
      key: "my-agent",
      name: "My Agent",
      endpoint: "http://localhost:8000/agent",
      connectorType: "rest",  // or "agui-streaming", "subprocess"
      models: ["claude-sonnet-4"],
      useTraces: true,        // Enable OpenTelemetry trace collection
    }
  ],
};
```

The config file is auto-detected from the current working directory. Supported file names (in priority order): `agent-health.config.ts`, `agent-health.config.js`, `agent-health.config.mjs`. See [`agent-health.config.example.ts`](./agent-health.config.example.ts) for all available options including authentication hooks.

> **Tip:** Run `npx @opensearch-project/agent-health doctor` to verify your configuration is loaded correctly.

### Environment Variables (Optional)

**For LLM Judge evaluation** (uses AWS Bedrock):
```bash
# Create .env file
cp .env.example .env

# Add AWS credentials
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
```

**Full configuration guide:** [CONFIGURATION.md](./docs/CONFIGURATION.md)

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
| `npm run test:e2e` | Run E2E tests with Playwright |
| `npm run test:e2e:ui` | Run E2E tests with Playwright UI |
| `npm run test:all` | Run all tests (unit + integration + e2e) |
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

## Testing

AgentEval uses a comprehensive test suite with three layers:

### Test Types

| Type | Location | Command | Description |
|------|----------|---------|-------------|
| **Unit** | `tests/unit/` | `npm run test:unit` | Fast, isolated function tests |
| **Integration** | `tests/integration/` | `npm run test:integration` | Tests with real backend server |
| **E2E** | `tests/e2e/` | `npm run test:e2e` | Browser-based UI tests with Playwright |

### Running Tests

```bash
# All tests
npm test                        # Unit + integration
npm run test:all                # Unit + integration + E2E

# By type
npm run test:unit               # Unit tests only
npm run test:integration        # Integration tests (starts server)
npm run test:e2e                # E2E tests (starts servers)
npm run test:e2e:ui             # E2E with Playwright UI for debugging

# With coverage
npm run test:unit -- --coverage

# Specific file
npm test -- path/to/file.test.ts
npx playwright test tests/e2e/dashboard.spec.ts
```

### E2E Testing with Playwright

E2E tests use [Playwright](https://playwright.dev/) to test the UI in a real browser.

```bash
# First time: install browsers
npx playwright install

# Run all E2E tests
npm run test:e2e

# Interactive UI mode (recommended for debugging)
npm run test:e2e:ui

# View test report
npm run test:e2e:report
```

**Writing E2E Tests:**
- Place tests in `tests/e2e/*.spec.ts`
- Use `data-testid` attributes for reliable selectors
- Handle empty states gracefully (check if data exists before asserting)
- See existing tests for patterns

### CI Pipeline

All PRs must pass these CI checks:

| Job | What it checks |
|-----|----------------|
| `build-and-test` | Build + unit tests + 90% coverage |
| `lint-and-typecheck` | TypeScript compilation |
| `license-check` | SPDX headers on all source files |
| `integration-tests` | Backend integration tests with coverage |
| `e2e-tests` | Playwright browser tests with pass/fail tracking |
| `security-scan` | npm audit for vulnerabilities |
| `test-summary` | Consolidated test results summary |

### Coverage Thresholds

| Test Type | Metric | Threshold |
|-----------|--------|-----------|
| Unit | Lines | ≥ 90% |
| Unit | Branches | ≥ 80% |
| Unit | Functions | ≥ 80% |
| Unit | Statements | ≥ 90% |
| Integration | Lines | Informational (no threshold) |
| E2E | Pass Rate | 100% |

### CI Artifacts

Each CI run produces these artifacts (downloadable from Actions tab):

| Artifact | Contents |
|----------|----------|
| `coverage-report` | Unit test coverage (HTML, LCOV) |
| `integration-coverage-report` | Integration test coverage |
| `playwright-report` | E2E test report with screenshots/traces |
| `test-badges` | Badge data JSON for coverage visualization |

### Full Evaluation Flow E2E Tests

The E2E test suite includes tests for the complete evaluation flow using mock modes:
- **Demo Agent** (`mock://demo`) - Simulated AG-UI streaming responses
- **Demo Model** (`provider: "demo"`) - Simulated LLM judge evaluation

This allows testing the full Create Test Case → Create Benchmark → Run Evaluation → View Results flow without requiring AWS credentials or a live agent in CI.

---

## Agent Setup

Agent Health supports multiple agent types:

| Agent | Endpoint Variable | Setup |
|-------|-------------------|-------|
| **Observio** (sample) | `localhost:3001` | Included — see [observio-sample-agent/](./observio-sample-agent/) |
| Langgraph | `LANGGRAPH_ENDPOINT` | Simple localhost agent |
| HolmesGPT | `HOLMESGPT_ENDPOINT` | AG-UI compatible RCA agent |
| ML-Commons | `MLCOMMONS_ENDPOINT` | See [ML-Commons Setup](./docs/ML-COMMONS-SETUP.md) |

### Observio Sample Agent

Agent Health includes **Observio**, a reference ReAct agent you can use as a practice target for evaluating and improving agent performance. It's a great starting point if you don't have your own agent yet.

```bash
# Start Observio
cd observio-sample-agent && npm install && npm run start:ag-ui

# Evaluate it with Agent Health
npx @opensearch-project/agent-health run -t demo-otel-001 -a observio
```

See the [Observio README](./observio-sample-agent/README.md) for setup details and improvement areas.


---

## Debugging

Enable verbose debug logging to diagnose issues:

```bash
# Via environment variable
DEBUG=true npx @opensearch-project/agent-health

# Or toggle at runtime via API
curl -X POST http://localhost:4001/api/debug -H 'Content-Type: application/json' -d '{"enabled":true}'
```

Debug logging can also be toggled from the **Settings** page using the "Verbose Logging" switch, which syncs to both the browser console and server terminal.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Cannot connect to backend | Run `npm run dev:server`, check `curl http://localhost:4001/health` |
| AWS credentials expired | Refresh credentials in `.env` |
| Storage/Traces not working | Check OpenSearch endpoint and credentials in `.env` |
| Need verbose logs | Set `DEBUG=true` in `.env` or toggle in Settings page |

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

### User Guides
- [Getting Started](./GETTING_STARTED.md) - Step-by-step walkthrough from install to first evaluation
- [Configuration](./docs/CONFIGURATION.md) - Connect your agent and configure the environment
- [CLI Reference](./docs/CLI.md) - Command-line interface documentation
- [Observio Sample Agent](./observio-sample-agent/) - Reference agent for practicing agent health improvements

### Developer Guides
- [Development Guide](./CLAUDE.md) - Architecture, coding conventions, and contributing
- [Connectors Guide](./docs/CONNECTORS.md) - Create custom connectors for your agent type
- [ML-Commons Setup](./docs/ML-COMMONS-SETUP.md) - OpenSearch ML-Commons integration
- [Architecture](./docs/ARCHITECTURE.md) - System design and patterns
