# Agent Health

[![CI](https://github.com/opensearch-project/agent-health/actions/workflows/ci.yml/badge.svg)](https://github.com/opensearch-project/agent-health/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE.txt)
[![npm version](https://img.shields.io/npm/v/@opensearch-project/agent-health.svg)](https://www.npmjs.com/package/@opensearch-project/agent-health)

[![Unit Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/opensearch-project/agent-health/badges/unit-tests.json)](https://github.com/opensearch-project/agent-health/actions/workflows/ci.yml)
[![Unit Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/opensearch-project/agent-health/badges/unit-coverage.json)](https://github.com/opensearch-project/agent-health/actions/workflows/ci.yml)
[![Integration Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/opensearch-project/agent-health/badges/integration-tests.json)](https://github.com/opensearch-project/agent-health/actions/workflows/ci.yml)
[![E2E Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/opensearch-project/agent-health/badges/e2e-tests.json)](https://github.com/opensearch-project/agent-health/actions/workflows/ci.yml)

An evaluation and observability framework for AI agents. Features real-time trace visualization, "Golden Path" trajectory comparison, and LLM-based evaluation scoring.

Try It by running:

```bash
npx @goyamegh/agent-health@latest
```

Opens http://localhost:4001 for the web UI.

### Architecture

![Agent Health Architecture](docs/diagrams/architecture.png)

## Features

- **Evals**: Real-time agent evaluation with trajectory streaming
- **Experiments**: Batch evaluation runs with configurable parameters
- **Compare**: Side-by-side trace comparison with aligned and merged views
- **Agent Traces**: Table-based trace view with latency histogram, filtering, and detailed flyout with input/output display
- **Live Traces**: Real-time trace monitoring with auto-refresh and filtering
- **Trace Views**: Timeline and Flow visualizations for debugging
- **Reports**: Evaluation reports with LLM judge reasoning
- **Connectors**: Pluggable protocol adapters for different agent types

For a detailed walkthrough, see [Getting Started](./GETTING_STARTED.md).


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



---

## Quick Start

```bash
# Start the web UI
npx @opensearch-project/agent-health

# Open http://localhost:4001
```

### CLI Commands

```bash
# Check configuration
npx @opensearch-project/agent-health doctor

# List available agents and connectors
npx @opensearch-project/agent-health list agents
npx @opensearch-project/agent-health list connectors

# Run a test case against an agent
npx @opensearch-project/agent-health run -t demo-otel-001 -a demo

# Initialize a new project
npx @opensearch-project/agent-health init
```

For full CLI documentation, see [docs/CLI.md](./docs/CLI.md).




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
OPENSEARCH_STORAGE_TLS_SKIP_VERIFY=false  # Set to true for self-signed certificates
```

### Traces (Observability)

For agent execution traces. Features gracefully degrade if not configured.

```bash
OPENSEARCH_LOGS_ENDPOINT=https://your-logs-cluster.opensearch.amazonaws.com
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=your_password
OPENSEARCH_LOGS_TLS_SKIP_VERIFY=false  # Set to true for self-signed certificates
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
| Langgraph | `LANGGRAPH_ENDPOINT` | Simple localhost agent |
| HolmesGPT | `HOLMESGPT_ENDPOINT` | AG-UI compatible RCA agent |
| ML-Commons | `MLCOMMONS_ENDPOINT` | See [ML-Commons Setup](./docs/ML-COMMONS-SETUP.md) |


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

- [Getting Started](./GETTING_STARTED.md) - Installation, demo mode, and usage walkthrough
- [ML-Commons Agent Setup](./docs/ML-COMMONS-SETUP.md) - Configure ML-Commons agent
- [Development Guide](./CLAUDE.md) - Architecture and coding conventions
- [AG-UI Protocol](https://docs.ag-ui.com/sdk/js/core/types#runagentinput)
