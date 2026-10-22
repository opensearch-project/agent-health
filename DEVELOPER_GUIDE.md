# Developer Guide

This guide covers development setup, testing, CI pipeline, debugging, and troubleshooting for Agent Health contributors.

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

---

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

## Agent Setup

Agent Health supports multiple agent types:

| Agent | Endpoint / Env Variable | Setup |
|-------|-------------------------|-------|
| **Observio** (sample) | `localhost:3001` | Included — see [observio-sample-agent/](./observio-sample-agent/) |
| Langgraph | `LANGGRAPH_ENDPOINT` | Simple localhost agent |
| HolmesGPT | `HOLMESGPT_ENDPOINT` | AG-UI compatible RCA agent |
| ML-Commons | `MLCOMMONS_ENDPOINT` | See [ML-Commons Setup](./docs/ML-COMMONS-SETUP.md) |

---

## Testing

Agent Health uses a comprehensive test suite with three layers:

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

### Full Evaluation Flow E2E Tests

The E2E test suite includes tests for the complete evaluation flow using mock modes:
- **Demo Agent** (`mock://demo`) - Simulated AG-UI streaming responses
- **Demo Model** (`provider: "demo"`) - Simulated LLM judge evaluation

This allows testing the full Create Test Case -> Create Benchmark -> Run Evaluation -> View Results flow without requiring AWS credentials or a live agent in CI.

---

## CI Pipeline

All PRs must pass these CI checks:

| Job | What it checks |
|-----|----------------|
| `build-and-test` | Build + unit tests + the unit line-coverage baseline (70%) |
| `lint-and-typecheck` | TypeScript compilation |
| `license-check` | SPDX headers on all source files |
| `integration-tests` | Backend integration tests with coverage, plus real-process coverage for `cli/**` |
| `e2e-tests` | Playwright browser tests with pass/fail tracking |
| `security-scan` | npm audit for vulnerabilities |
| `test-summary` | Consolidated test results summary |

### Coverage

[![codecov](https://codecov.io/gh/opensearch-project/agent-health/branch/main/graph/badge.svg)](https://codecov.io/gh/opensearch-project/agent-health)

Where to look on a PR, closest to the code first:

| Surface | What it shows | Where |
|---------|---------------|-------|
| Diff annotations | Each added/changed line that no test executed, inline in the diff | PR → **Files changed** (press `a` to toggle). Codecov GitHub Checks, `github_checks.annotations` in `codecov.yml`. Codecov has announced this feature is deprecated; their browser extension is the successor. |
| `codecov/patch` status | % of the PR's new/changed lines covered by **any** suite (unit + integration + e2e + cli), target 80% | PR checks list. Making it a *required* check is a repo-ruleset change that needs an org/repo admin. |
| `codecov/project` status | Whole-repo coverage vs the base commit; may not drop more than 1% | PR checks list |
| Codecov PR comment | Totals, per-flag numbers (`unit`, `integration`, `e2e`, `cli`) and per-file patch coverage | PR conversation |
| Changed-files table | Lines %, branches % and the exact **uncovered line ranges** for every source file the PR touched, per suite | Actions run → job **Summary** of `build-and-test` (unit) and `integration-tests` (integration + cli). Generated by `scripts/coverage-diff-summary.mjs`. |

Thresholds enforced in CI (`jest.config.cjs` + `.github/workflows/ci.yml`):

| Test Type | Metric | Threshold |
|-----------|--------|-----------|
| Unit | Lines / Statements | >= 70% |
| Unit | Functions | >= 65% |
| Unit | Branches | >= 60% |
| Patch (all flags) | Lines on new/changed code | >= 80% (`codecov/patch`) |
| Project (all flags) | Lines | no drop > 1% vs base (`codecov/project`) |
| Integration / E2E / CLI | Lines | Informational (per-flag, no threshold) |
| E2E | Pass Rate | 100% |

#### How `cli/**` coverage is measured

Jest instruments only code it loads in-process. The CLI is tested the way users
run it — the integration suites spawn the real `cli/dist/index.js` — so jest sees
none of it, and `cli/**` used to be excluded from Codecov altogether (a CLI-only
PR showed "all modified lines covered" with nothing measured behind it). Now:

1. `npm run build:cli` emits `cli/dist/index.js.map` (esbuild `--sourcemap`;
   the map is excluded from the npm package by `files`, so package size is
   unchanged).
2. The `integration-tests` job sets `AH_CLI_V8_COVERAGE_DIR`. Every test that
   spawns the CLI wraps the child's env in `withCliCoverage()`
   (`tests/helpers/cliCoverage.ts`), which adds `NODE_V8_COVERAGE=<dir>` to the
   **child** only — Node then writes a raw V8 coverage dump for that process.
   The jest processes themselves are not started with `NODE_V8_COVERAGE`.
3. `npm run coverage:cli` runs `c8 report --config .c8rc.json`, which maps the
   dumps through the source map back onto `cli/**/*.ts` and writes
   `coverage-cli/lcov.info`; CI uploads it to Codecov under the `cli` flag.

Locally:

```bash
npm run build:cli
AH_CLI_V8_COVERAGE_DIR=$PWD/coverage-cli/v8 AH_PORT=4001 npm run test:integration -- tests/integration/cli
npm run coverage:cli            # table on stdout, lcov + HTML in coverage-cli/
```

Known limits: c8 counts **physical** lines (blank, comment and data-literal
lines included) where istanbul counts statements, so a file measured by both
flags shows more lines on Codecov than jest alone reports; files for which the
bundle carries no executable code — re-export-only barrels
(`cli/commands/index.ts`), type-only modules, and files the CLI never loads
(`cli/demo/*`) — do not appear in the `cli` report at all and keep their
unit-flag numbers.
`.c8rc.json` explains why its `include` pattern is `**/cli/**` (a
`c8 --exclude-after-remap` path-matching quirk otherwise reports a bogus 100%).
`tests/integration/cli/cliCoverage.integration.test.ts` runs the whole pipeline
with the real tools and fails if the numbers come back fake.

### CI Artifacts

Each CI run produces these artifacts (downloadable from Actions tab):

| Artifact | Contents |
|----------|----------|
| `coverage-report` | Unit test coverage (HTML, LCOV) |
| `integration-coverage-report` | Integration test coverage |
| `coverage-cli` (in Codecov, flag `cli`) | Coverage of `cli/**` from real CLI processes |
| `playwright-report` | E2E test report with screenshots/traces |
| `test-badges` | Badge data JSON for coverage visualization |

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

## AI Agent Skills (maintainer note)

Agent Health ships skill files that teach AI coding agents how to work with the
project. They live in **three mirrored locations** and must be kept in sync:

| Location | Audience | Contents |
|----------|----------|----------|
| `.claude/skills/<name>/SKILL.md` | Claude Code (auto-discovered) | `add-connector`, `config-auth`, `create-pr`, `instrument-otel`, `write-test`, `agent-health` |
| `.kiro/steering/<name>.md` | Kiro (auto-loaded steering) | `add-connector`, `create-pr`, `write-test`, `agent-health` |
| `docs/skills/` | Source of truth + docs site | the shared skills above, plus the canonical `AGENT_HEALTH.md` |

- For the five **contributor** skills (`add-connector`, `config-auth`, `create-pr`,
  `instrument-otel`, `write-test`), `.claude/skills/<name>/SKILL.md` and
  `docs/skills/<name>/SKILL.md` are expected to be **byte-identical**. When you
  edit one, edit the other (and the `.kiro/steering/` copy where it exists).
- The **`agent-health`** skill ("evaluate / improve *my* agent with agent-health")
  has a single source of truth: **`docs/skills/AGENT_HEALTH.md`**. The mirrors are
  generated from it — `.claude/skills/agent-health/SKILL.md` is `frontmatter +
  AGENT_HEALTH.md body`, and `.kiro/steering/agent-health.md` is the body verbatim.
  Regenerate both copies whenever you edit `AGENT_HEALTH.md`.
- **`docs/skills/AGENT_HEALTH.md` is loaded into the live AI-assistant system
  prompt at runtime** (`server/services/assistantService.ts`) and into the
  Claude-Code judge (`server/services/claudeCodeJudgeService.ts`). Treat stale
  content here as a product bug, not just a docs gap — and keep the filename
  stable (the loaders resolve it by path).

## Development Workflow

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Create a feature branch: `git checkout -b feature/your-feature`
4. Make changes and add tests
5. Run tests: `npm test`
6. Commit with DCO signoff: `git commit -s -m "feat: your message"`
7. Push and create a Pull Request

All commits require DCO signoff and all PRs must pass CI checks (tests, coverage, linting).
