<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# CHANGELOG

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

### Added
- Cross-page user preferences are now stored under a single shared `agent-health:prefs:*` namespace, so picking a value once is reflected on every other page that exposes the same control. Shared keys:
  - `prefs:timeRange` — Benchmarks / Test Cases / Evaluation Runs / Agent Traces (Agent Traces converts the shared `'1h' | '6h' | '1d' | '7d' | '30d' | 'all'` enum to its internal minute-based query cutoff).
  - `prefs:agentFilter` — Benchmarks and Evaluation Runs filter dropdowns (default `'all'`). Not Agent Traces — its dropdown options are telemetry service names which live in a different value space than the eval pages' agent-config keys.
  - `prefs:benchmarkFilter` — Test Cases benchmark filter (default `'all'`).
  - `prefs:viewMode` — Test Cases / Evaluation Runs (`'flat' | 'grouped'`).
  - `prefs:agentKey` and `prefs:modelId` — run-config selection (QuickRunModal, NewRunPage; BenchmarkRunsPage and BenchmarkEditor read the same keys).
  - The storage layout is intentionally flat — each preference is its own JSON-encoded localStorage entry under `agent-health:prefs:*`, so the bundle is portable. `lib/preferences.ts` exports `getPreferencesSnapshot()`, `applyPreferencesSnapshot()` and `clearPreferences()` for one-call dump / restore / reset, which is the natural shape to send to a server-side preference store later.
  - Page-specific values that don't share semantics across pages stay under their per-page keys: Dashboard's narrower (`7d`/`30d`/`all`) time range, Agent Traces' page-specific agent filter (telemetry service name space), all sort orders, all advanced filters, all search inputs, collapsed groups, EvalRuns benchmark/model filter sets and pass-rate range.
  - Coverage: 14 unit tests in `tests/unit/lib/preferences.test.ts` for the shared API (snapshot / apply / clear, time-range conversion, forward-compat for unknown keys, quota-exceeded resilience), 9 unit tests for `usePersistedSet`, 4 e2e tests for the QuickRunModal default-agent behaviour, and 19 e2e tests in `tests/e2e/sidebar-persisted-preferences.spec.ts` (including a cross-page sync test that walks Eval Runs → Benchmarks → Test Cases → Agent Traces and verifies `prefs:timeRange` stays consistent, plus a UI-position test confirming the view-toggle is in the page header with Grouped listed first).

### Changed
- Test Cases and Evaluation Runs pages: the flat / grouped view toggle now lives in the page header (next to search and filters) rather than in a separate row below the title — matches the Benchmarks layout for a consistent feel. **Grouped is listed first** in both pages.
- Agent Traces page: time-range options unified with the eval list pages (`Last 1h`, `Last 6h`, `Last 1d`, `Last 7d`, `Last 30d`, `All time`) so the shared `prefs:timeRange` carries cleanly across them. The previous minute-granularity options (15m, 3h, 6h, 12h, 3d) are no longer offered; `'all'` is treated as a 90-day cutoff at query time.
- Persist input preferences across all sidebar pages so filters, sorts, search queries and view modes survive reloads and SPA navigation. Newly-persisted state, all under the unified `agent-health:` localStorage namespace and powered by `usePersistedState` (and the new `usePersistedSet` helper for `Set<string>`-shaped state):
    - **Dashboard `/`** — `dashboard:timeRange`, `dashboard:selectedMetric`, `dashboard:filters`.
    - **Benchmarks `/evaluations/benchmarks`** — `benchmarks:search` (already had `timeRange`, `selectedAgent`, `sort`).
    - **Test Cases `/evaluations/test-cases`** — `test-cases:search`, `test-cases:collapsedGroups` (already had `viewMode`, `timeRange`, `selectedBenchmark`, `sort`).
    - **Evaluation Runs `/evaluations/runs`** — `eval-runs:search`, `eval-runs:filterBenchmarks`, `eval-runs:filterModels`, `eval-runs:filterPassRateMin`, `eval-runs:filterPassRateMax`, `eval-runs:collapsedGroups` (already had `timeRange`, `selectedAgent`, `viewMode`, `sort`, `showRegressionsOnly`, `filterStatus`).
    - **Agent Traces `/agent-traces`** — `agent-traces:selectedAgent` (page-specific because its options are telemetry service names, not agent-config keys), `agent-traces:textSearch`, `agent-traces:filters` (advanced filter object). Time range is shared via `prefs:timeRange` (see above). Legacy `agentTraces.*` raw keys are no longer migrated; users keep their picks by re-selecting once — the storage shape is portable so future preference syncing won't need bespoke migration code.
    - **AI Dev Tools `/coding-agents`** — `coding-agents:activeTab` (URL `?tab=` still wins on first navigation), `coding-agents:rangePreset`, `coding-agents:sessions:agentFilter`, `coding-agents:sessions:completedFilter`, `coding-agents:sessions:projectFilter`, `coding-agents:workspace:agentTab`, `coding-agents:workspace:section`.
  - New `usePersistedSet<T>(key, defaultValue?)` hook persists `Set<string>` (and other `Set<T>`) state as a JSON array under `agent-health:<key>` while exposing a `Set` API to call sites; covered by 9 unit tests in `tests/unit/hooks/usePersistedSet.test.ts`.
  - New e2e suite `tests/e2e/sidebar-persisted-preferences.spec.ts` covers seeded round-trip and UI round-trip for every persisted key on every sidebar page (16 tests).
- QuickRunModal (test case popup): pre-populate a sensible default agent (preferring Observio Sample Agent) so users can run a test case without first picking an agent. The selection persists per-user via the shared `agent-health:prefs:agentKey` localStorage key, so subsequent opens — and the agent dropdowns on NewRunPage / BenchmarkRunsPage / BenchmarkEditor — reuse the last-used agent. The selected built-in agent is now always rendered in the agent dropdown (even when the "Built-in" group is collapsed) so the trigger label is always populated. New e2e suite: `tests/e2e/quick-run-agent-preference.spec.ts`.
- Pi.dev coding agent connector and judge provider for CLI-based agent evaluation ([#205](https://github.com/opensearch-project/agent-health/pull/205))
- Unified EvaluationRun architecture with composable test case sources (benchmark, test-case-ids, label-filter, file-import, directory-import) ([#205](https://github.com/opensearch-project/agent-health/pull/205))
- Pi package for Agent Health instrumentation assistance ([#205](https://github.com/opensearch-project/agent-health/pull/205))
- Persist user preferences across sessions with usePersistedState hook ([#205](https://github.com/opensearch-project/agent-health/pull/205))
- Observio sample agent: port auto-increment when default port 3001 is in use (up to 10 attempts)
- Observio sample agent: configurable `REACT_MAX_ITERATIONS` via environment variable (default: 100)
- Parent server dynamically detects observio agent's actual bound port and patches `/api/agents` endpoint
- Agentic judge provider: evaluate trajectories using an agent with tool access (Claude Code or custom endpoint)
- Shared `JudgeModelSelect` component: groups judge models by provider (Bedrock, Agentic, Claude Code, OpenAI-compatible, LiteLLM, Demo)
- Informational banner in "Create Test Case" flow explaining required fields
- SSE disconnect recovery for ad-hoc evaluations: server pre-persists a placeholder run and emits its `reportId` in the `started` event; clients fall back to polling `GET /api/storage/runs/:id` if the stream drops mid-evaluation. Applies to both CLI (`agent-health run`) and UI (`QuickRunModal`). The QuickRunModal now shows a "reconnecting…" hint while polling. ([#197](https://github.com/opensearch-project/agent-health/pull/197))
- 15-second SSE heartbeat events to keep long-running evaluation connections alive through TCP idle timeouts.

### Changed
- Rewrite First Run Experience as a narrative landing: promise-driven hero with two primary CTAs, four-step horizontal journey (Explore → Connect → Evaluate → Improve & scale), four outcome-framed value cards, and a subtle scale moment with Docker and CloudFormation install commands. Replaces the previous two-card "How it works" + "Getting Started" layout. Preserves all existing CTAs, install commands, optional coding agents banner, and `data-testid="first-run-experience"`.
- Hide sample data by default when customer has real evaluation data; add "Show sample data" toggle
- Collapse built-in agents when custom agents exist; group agent dropdowns (Your Agents / Built-in)
- Default agent filter to "All Agents" on benchmarks and runs pages instead of first enabled agent

### Fixed
- Test Cases / Evaluation Runs / Benchmarks search filters no longer crash with `TypeError: Cannot read properties of undefined (reading 'toLowerCase')` when a record has a missing `name`/`id`. The filters now treat missing string fields as empty.

### Security
- Fix Dependabot vulnerabilities: add npm overrides for hono (>=4.12.18), fast-uri (>=3.1.2), and ip-address (>=10.1.1)
- Fix Mend dependency vulnerabilities: bump `ws` to `>=8.20.1` to address CVE-2026-45736 (uninitialized memory disclosure in `websocket.close()`); add npm override for `@babel/runtime` (>=7.26.10) for CVE-2025-27789. Affects root `package.json` ([#162](https://github.com/opensearch-project/agent-health/issues/162), [#202](https://github.com/opensearch-project/agent-health/issues/202))
- Fix Mend dependency vulnerabilities in `observio-sample-agent`: bump direct `ws` dep to `^8.20.1` (CVE-2026-45736); bump `langsmith` override to `>=0.6.0` for CVE-2026-45134 (High 7.1); add `protobufjs` override (>=8.2.0) covering CVE-2026-44288/289/290/291/292/293/294 and CVE-2026-45740 (highest 8.8) ([#163](https://github.com/opensearch-project/agent-health/issues/163), [#201](https://github.com/opensearch-project/agent-health/issues/201), [#203](https://github.com/opensearch-project/agent-health/issues/203), [#208](https://github.com/opensearch-project/agent-health/issues/208))

### Fixed
- Guard testCaseIds accesses in evals3 pages to prevent crash on undefined ([#205](https://github.com/opensearch-project/agent-health/pull/205))
- Prevent duplicate observio instances by starting agent before server ([#205](https://github.com/opensearch-project/agent-health/pull/205))
- DocType discriminator for shared storage and PATCH sanitization in evaluation runs ([#205](https://github.com/opensearch-project/agent-health/pull/205))
- Connector type drift: use single source of truth (`CONNECTOR_TYPE_INFO`) in server validation and Settings UI instead of hardcoded arrays ([#176](https://github.com/opensearch-project/agent-health/pull/176))
- `useTraces: true` causes benchmark judge to never evaluate — runs permanently show 0% pass rate. Benchmark runner now awaits trace polling completion before reporting results ([#184](https://github.com/opensearch-project/agent-health/issues/184))

## [0.4.0] - 2025-05-05

### Fixed
- Extra spacing in Timeline view by removing container padding ([#73](https://github.com/opensearch-project/agent-health/issues/73))
- Pre-existing test failures: add missing `fast-check` dev dependency and fix incomplete mocks in `app.test.ts` ([#153](https://github.com/opensearch-project/agent-health/pull/153))

### Added
- Responsive UX pass for the AI Dev Tools page (`/coding-agents`): responsive page shell + `xl`/`2xl` breakpoint scaling on per-agent and chart grids, shared primitives (`SectionHeader`, `FilterBar`, `DataTable`, `CompactBadge`, `EmptyState`), sticky tab bar, keyboard focus rings on clickable stat cards, a11y landmarks (skip link, `<main>`, `aria-sort`, `aria-label`, table captions)
- Amazon Strands connector for Bedrock Agent Runtime integration (`services/connectors/strands/`)
- LangGraph REST connector for non-AG-UI LangGraph instances (`services/connectors/langgraph/`)
- Dashboard homepage gradient background, stats summary bar, and chart area gradient fills ([#153](https://github.com/opensearch-project/agent-health/pull/153))
- Pluggable evaluator architecture with 5 built-in system evaluators (RCA Default, Factuality, Tool Usage Efficiency, Reasoning Depth, Safety)
- Evaluator management UI: create, edit, duplicate, and delete custom evaluators with versioning support
- Evaluator selection in benchmark runs, Quick Run modal, and CLI (`--evaluator` flag)
- REST API for evaluator CRUD at `/api/storage/evaluators` with system evaluator protection
- Dynamic metrics extraction based on evaluator scoring config in judge services
- Auto-increment server port on EADDRINUSE — if port 4001 is in use, tries 4002, 4003, etc. up to 10 attempts
- GitHub Actions workflow for AI-powered PR code diff analysis and review via AWS Bedrock
- Kiro CLI SQLite reader with progressive warmup, non-blocking cache, and phase-aware loading UX
- Coding Agent Analytics: unified dashboard for Claude Code, Kiro, and Codex CLI usage data
- Plugin-based reader system for ingesting local session data from ~/.claude/, ~/.kiro/, and ~/.codex/
- API routes for coding agent stats, sessions, costs, activity patterns, and tool usage (/api/coding-agents/*)
- Evaluations section with Benchmarks, Test Cases, Eval Runs, and Run Inspector pages
- Compare page with blank state, single-run support, and N-run table compare
- RunPairSelector component for trajectory comparison gating
- Dashboard workflow navigator and first-run experience
- Observio sample agent: built-in ReAct agent that auto-starts with the server, with `kill` CLI command ([#156](https://github.com/opensearch-project/agent-health/pull/156))
- Progressive onboarding: FirstRunExperience redesigned with 4-step Getting Started flow ([#156](https://github.com/opensearch-project/agent-health/pull/156))
- One-click Docker Compose installer (`scripts/install.sh`) with auto-config generation ([#156](https://github.com/opensearch-project/agent-health/pull/156))
- AWS CloudFormation template for managed OpenSearch + OSIS trace/log pipelines ([#156](https://github.com/opensearch-project/agent-health/pull/156))
- CLI `configure --from-stack` command to import observability config from CloudFormation stack outputs ([#156](https://github.com/opensearch-project/agent-health/pull/156))

### Changed
- Move metrics to right side of title on Benchmarks and Eval Runs pages
- Restructure compare toolbar into clean two-row layout
- Rename compare sections to Compare Summary and Table Compare
- Remove old Evals menu from sidebar, keep only Evaluations
- Remove evaluator visibility toggle from comparison page (backend not built yet)
- Allow compare diff with any number of runs
- Make Compare button always clickable from Eval Runs page
- Frontend page with Overview, Sessions, Projects, Costs, Activity, Efficiency, Tools, Advanced, and Workspace tabs at /coding-agents
- Pricing engine covering Claude, Bedrock, and OpenAI models for cost estimation
- Unified tool categorization across all three coding agents
- Insights engine generating actionable recommendations from session data
- In-memory session cache with directory-level invalidation and background refresh
- Feature toggle to disable Coding Agent Analytics (AGENT_HEALTH_DISABLE_CODING_ANALYTICS=true or codingAgentAnalytics: false in config)
- Graceful shutdown handler (SIGTERM/SIGINT) for stopping background timers and draining connections
- Health endpoint now returns feature flags for frontend conditional rendering
- RFC 001 documenting Coding Agent Analytics design
- Remote server aggregation for multi-machine coding agent monitoring
- Settings UI for remote server management with connectivity testing
- CLI commands for remote server configuration (`agent-health remote add|remove|list|test`)
- API key authentication middleware for headless remote mode

## [0.2.0]

### Added
- Opt-in OTel span emission for benchmark evaluation data using semantic conventions (`lib/telemetry/`) ([#134](https://github.com/opensearch-project/agent-health/pull/134))
- Bulk batch metrics computation (`computeBatchMetrics`) with `_source` projection for efficient run listing ([#134](https://github.com/opensearch-project/agent-health/pull/134))

### Fixed
- Release workflow using `build` instead of `build:all`, causing CLI tests to fail ([#123](https://github.com/opensearch-project/agent-health/pull/123))
- Add `@testing-library/dom` peer dependency required by `@testing-library/react` v16 ([#134](https://github.com/opensearch-project/agent-health/pull/134))
- Integration test cleanup to prevent leftover test data from failed runs ([#134](https://github.com/opensearch-project/agent-health/pull/134))

### Changed
- Increase release workflow approval timeout from 6 hours (default) to 24 hours
- Allow workflow initiator to count as one of the required release approvers
- Bump version to 0.2.0

### Added
- Observio sample agent — a reference ReAct agent for practicing agent health improvements, based on [osd-agents](https://github.com/opensearch-project/OpenSearch-Dashboards/tree/main/packages/osd-agents)
- Docker configuration files for local development stack with OpenSearch and OTEL pipeline ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Collapsible section for built-in agents and debug settings to SettingsPage ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- AWS Bedrock model discovery endpoint and updated model pricing ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- LiteLLM / OpenAI-compatible connector for LiteLLM, Ollama, vLLM integration ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Storage drift detection with runtime state surfaced in Settings UI ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Markdown output format for CLI commands ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Documentation for SigV4 auth for OpenSearch ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Getting-started blog and introductory blog ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Category distribution mini-bar visualization in Agent Traces table rows ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Filter popover with chip-based filtering for Agent Traces ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Compact number formatting (`formatCompact`) for metrics display ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Minimap toggle and resizable panel layout for trace flyout ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Light mode color support with improved contrast across all components ([#108](https://github.com/opensearch-project/agent-health/pull/108))

### Changed
- Enhanced CLI help output with grouped sections and examples ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Centralized connector type metadata into single source of truth (`CONNECTOR_TYPE_INFO`) ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Rename 'Testing' to 'Evals' in collapsible section and tooltips ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Reduce global sidebar width and refactor header layout for better space utilization ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Improve metrics overview with sparkline charts and reordered layout ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Remove drop shadows from non-floating UI components (Card, Button, Badge, Input, etc.) for cleaner visual style ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Align metrics chart columns at the bottom with consistent heights ([#108](https://github.com/opensearch-project/agent-health/pull/108))

### Removed
- `models` property from agent configurations and related functions ([#115](https://github.com/opensearch-project/agent-health/pull/115))

### Fixed
- Error filter bypass: sorting useEffect and data fetches directly set displayedTraces, ignoring active filters ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Relative import regression in AgentTracesPage (`../Layout` → `@/components/Layout`) ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- selectedAgent localStorage persistence asymmetry — writes but never reads on init ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Remove auto-generated documentation files and `.kiro/specs/` directory from PR #108 ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Add missing `formatCompact` unit tests and E2E tests for error filter regression ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Storage adapter for test case lookup in benchmark runner ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Flaky E2E tests: replaced `waitForTimeout` with proper element waits in comparison tests ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Debug mode E2E test race condition ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- E2E test data cleanup in test-cases and benchmarks specs ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- `fast-xml-parser` override to 5.5.6 for CVE-2026-26278 ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Resolved high/critical npm audit vulnerabilities (path-to-regexp, picomatch) ([#115](https://github.com/opensearch-project/agent-health/pull/115))
- Fullscreen trace flyout click-outside detection closing flyout unexpectedly ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Benchmark traces tab layout and default view mode ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Sidebar spacing and Evals menu interaction behavior ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- TypeScript compilation errors from merge conflict resolution ([#108](https://github.com/opensearch-project/agent-health/pull/108))
- Claude Code as agent evaluator: new `'claude-code'` judge provider that spawns `claude` CLI to evaluate trajectories with full tool access and AGENT_HEALTH.md skill context
- AI Assistant floating popup: `AssistantModalPrimitive`-based "?" button on every page with streaming chat powered by Claude Code CLI
- AI Assistant full chat page at `/assistant` route with welcome screen, suggested prompts, and `ThreadPrimitive`-based conversation interface
- Assistant backend service with in-memory session management, 30-min TTL, NDJSON stream parsing, and Bedrock/LiteLLM fallback
- SSE streaming endpoints: `POST /api/assistant/chat`, `DELETE /api/assistant/session/:sessionId`, `GET /api/assistant/health`
- Client-side assistant API (`assistantApi.ts`) with SSE stream consumption and chunk buffering
- `useAssistantRuntime` hook implementing `ChatModelAdapter` with queue-based async generator for real-time streaming
- `AssistantProvider` component wrapping app in `AssistantRuntimeProvider` for shared runtime context
- Unit, integration, and Playwright E2E tests for all new assistant and Claude Code judge components
- AWS SigV4 authentication support for OpenSearch clusters with `ClusterAuthType` (`none` | `basic` | `sigv4`) ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- OpenSearch client factory (`opensearchClientFactory.ts`) for centralized client creation with basic, none, or SigV4 auth ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Mapping validation service to detect incompatible field types in OpenSearch indexes ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Mapping fixer service with reindex pipeline to auto-fix incompatible index mappings ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Migration lock service for per-index write locks during reindex operations ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Auth type selector in Settings UI for storage and observability clusters with contextual form fields ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Unit tests for client factory, mapping validator, mapping fixer, and migration lock ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Claude Opus 4.6, Sonnet 4.6, Haiku 4.5, Opus 4.5, Opus 4.1, and Opus 4 judge models with pricing ([#81](https://github.com/opensearch-project/agent-health/pull/81))
- Dynamic Bedrock model discovery via `GET /api/judge/bedrock-models` using `ListInferenceProfiles` API ([#81](https://github.com/opensearch-project/agent-health/pull/81))
- Bedrock refresh button in QuickRunModal for discovering available models at runtime ([#81](https://github.com/opensearch-project/agent-health/pull/81))
- Jason Hoang Nguyen (@jasonlhamazon) as maintainer and code owner ([#69](https://github.com/opensearch-project/agent-health/pull/69))
- Parallel execution with configurable concurrency for benchmark runs ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Performance metrics tracking (duration, concurrency, judge attempts) for benchmark runs and evaluations ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Pagination for trace loading with `loadMoreTraces` support ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Auto-select single test case in RunDetailsPage when only one is available ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Admin routes for index mapping updates and reindexing with error handling ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Unit tests for file-based storage modules ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Ollama models (`deepseek-r1:8b`, `gemma3:12b`) to built-in model presets for OpenAI-compatible provider ([#68](https://github.com/opensearch-project/agent-health/pull/68))
- Add `afterResponse` and `buildTrajectory` hook for PER agent support ([#70](https://github.com/opensearch-project/agent-health/pull/70))
- Minimap toggle control for trace visualization with persistent state ([#44](https://github.com/opensearch-project/agent-health/pull/44))
- Resizable flyout panels with drag-to-resize functionality and responsive layout ([#44](https://github.com/opensearch-project/agent-health/pull/44))
- Add release trusted publisher to agent-health repository and rename dashboards-traces ([#45](https://github.com/opensearch-project/agent-health/pull/45))
- Trace flyout UI improvements: resizable panel, redesigned tabs, agent map DAG view, dark mode support ([#40](https://github.com/opensearch-project/agent-health/pull/40))
- Trace timeline chart with span categorization and enhanced metrics overview ([#40](https://github.com/opensearch-project/agent-health/pull/40))
- OTel GenAI semantic convention support for span input/output extraction including `gen_ai.input.messages`, `gen_ai.output.messages`, and span events ([#40](https://github.com/opensearch-project/agent-health/pull/40))
- Light and dark mode theme support with dynamic switching and OUI font integration
- Universal debug logging system with `lib/debug.ts` supporting both browser (localStorage) and Node.js (in-memory flag) environments
- `GET/POST /api/debug` endpoint for runtime toggle of server-side verbose logging
- Settings page debug toggle now syncs to both browser console and server terminal output
- `DEBUG` environment variable for server-side debug initialization
- Converted `console.log` to structured `debug()` calls across 30+ server routes, services, and connectors
- Unit, integration, and E2E tests for debug logging system
- Pagination and total count support for benchmarks, test case runs, and reports ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- Lazy backfill for benchmark run stats and `migrate` CLI command for denormalized `RunStats` ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- Benchmark export to JSON format for sharing and reproducibility ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- JSON import for test cases with schema validation and error handling ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- File-backed storage for custom agent endpoints with persistence ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- `BeforeRequestContext` and `AgentHooks` hook type exports in public API ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- Integration tests for run storage, benchmark versioning, and benchmark import ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- CLI commands (`run`, `list`, `benchmark`, `doctor`, `init`) for headless agent evaluation ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Pluggable connector architecture supporting AG-UI, REST, subprocess, and Claude Code agents ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- TypeScript configuration file support with `defineConfig()` helper ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Server lifecycle management with Playwright-style auto-start for CLI ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- CLI documentation (`docs/CLI.md`, `docs/CONFIGURATION.md`, `docs/CONNECTORS.md`) ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Delete operation feedback UI with success/error messages ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- CLI-only agent badges and disabled state in QuickRunModal ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Comprehensive unit tests for connectors (AG-UI, REST, subprocess, Claude Code, mock) ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- TLS skip verify option for OpenSearch connections (`OPENSEARCH_STORAGE_TLS_SKIP_VERIFY`, `OPENSEARCH_LOGS_TLS_SKIP_VERIFY`)
- Full evaluation flow E2E tests using Demo Agent and Demo Model for CI-friendly testing
- Enhanced CI workflow with integration test coverage reporting and badge generation
- Test summary job in CI that aggregates results from unit, integration, and E2E tests
- CI artifacts for coverage reports and badge data (unit-coverage, e2e-tests badges)
- Comprehensive Playwright E2E tests for all UI flows ([#24](https://github.com/opensearch-project/agent-health/pull/24))
- E2E test fixtures and data-testid attributes for reliable test selectors ([#24](https://github.com/opensearch-project/agent-health/pull/24))
- Testing documentation in README with CI pipeline information ([#24](https://github.com/opensearch-project/agent-health/pull/24))
- Agent Traces page with table-based trace view for browsing and filtering traces ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- LatencyHistogram component for visualizing trace duration distribution ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- SpanInputOutput component displaying span I/O per OTEL semantic conventions ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- TraceFlyoutContent for detailed trace inspection with dedicated tabs ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- Unit tests for LatencyHistogram, SpanInputOutput, and TraceFlyoutContent components ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- AgentTrendChart and MetricsTable components for dashboard visualization ([#23](https://github.com/opensearch-project/agent-health/pull/23))
- Benchmark run cancellation hook with state management ([#23](https://github.com/opensearch-project/agent-health/pull/23))
- js-yaml dependency for YAML support ([#23](https://github.com/opensearch-project/agent-health/pull/23))
- JSON import functionality for test cases with automatic benchmark creation ([#20](https://github.com/opensearch-project/agent-health/pull/20))
- Benchmark run cancellation with state management and status transitions ([#20](https://github.com/opensearch-project/agent-health/pull/20))
- Integration tests for benchmark cancellation and JSON import workflows ([#20](https://github.com/opensearch-project/agent-health/pull/20))
- Collapsible "Evals" section in sidebar navigation ([#20](https://github.com/opensearch-project/agent-health/pull/20))
- NPX usage instructions in documentation ([#20](https://github.com/opensearch-project/agent-health/pull/20))
- Request-scoped storage client middleware for dynamic data source configuration
- Comprehensive unit tests for flow transformation and trace polling
- Unit tests for trace statistics, utility functions, and trajectory diff service
- Tests for opensearchClient storage module
- Enhanced storage route tests with additional coverage

### Changed
- Rename `litellm` provider/connector to `openai-compatible` throughout codebase — env vars `LITELLM_*` → `OPENAI_COMPATIBLE_*`, config provider `"litellm"` → `"openai-compatible"`, connector type `"litellm"` → `"openai-compatible"`, API endpoint `/api/judge/litellm-models` → `/api/judge/openai-compatible-models`
- Optimize Dashboard data loading: parallelize benchmark/report fetches, defer metrics to non-blocking phase, request only needed fields ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Improve AgentTrendChart performance with O(1) Map lookups instead of O(n) `find()` per data point ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Skip dashboard data loading when First Run Experience will be shown ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Deep copy env in `ClaudeCodeConnector` config save/restore to prevent config pollution between benchmark runs ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Add single-instance limitation documentation to `migrationLock.ts` ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Clarify concurrent counter safety documentation in `benchmarkRunner.ts` ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Enhance startup index-failure logging in `server/app.ts` with per-index error details ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Add SPDX license header to `public/test-first-run-improved.html` ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Refactor `logsService` and `tracesService` to accept injected OpenSearch clients for better testability ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Refactor `TestCaseEditor` layout and enhance required field indicators ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Refactor storage admin routes to use mapping fixer and validator services ([#85](https://github.com/opensearch-project/agent-health/pull/85))
- Improved benchmark traces tab with default view mode and layout fixes ([#44](https://github.com/opensearch-project/agent-health/pull/44))
- Enhanced fullscreen trace flyout behavior with better state management ([#44](https://github.com/opensearch-project/agent-health/pull/44))
- Integrated custom agents from JSON-backed store into benchmark execution ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- Updated observability agent benchmark scenarios for OTEL demo ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- Optimized run statistics calculations to avoid expensive per-request aggregation ([#35](https://github.com/opensearch-project/agent-health/pull/35))
- Enhanced Playwright configuration for CI/local development environments ([#24](https://github.com/opensearch-project/agent-health/pull/24))
- Updated navigation to distinguish "Agent Traces" (table view) from "Live Traces" (real-time) ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- Enhanced CORS middleware setup for better cross-origin support ([#20](https://github.com/opensearch-project/agent-health/pull/20))
- Refactored routing and layout structure for improved navigation ([#20](https://github.com/opensearch-project/agent-health/pull/20))
- Renamed Experiment to Benchmark throughout the codebase for clearer terminology
- Enhanced benchmark and run storage with improved sorting and field limits
- Simplified CLI by removing demo and configure commands
- Updated setup script with improved AWS profile handling and service shutdown logic
- Refactored agentService to use mock:// endpoint prefix for demo mode
- Updated judge routes to use demo-model provider detection

### Fixed
- Navigation links in FirstRunExperience using non-existent routes (`/settings/clusters`) — now use correct paths (`/agent-traces`, `/benchmarks`, `/settings#storage`) ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- FirstRunExperience workflow items (Trace, Evaluate, Improve) are now clickable links with hover states ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- URL hash scrolling on Settings page for deep-linking to sections (e.g., `/settings#storage`) ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Support `?tab=` query parameter in RunDetailsContent for deep-linking to specific tabs ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Unsafe reindex recovery in `mappingFixer.ts`: wrap post-delete recovery in try-catch with CRITICAL error naming temp index for manual recovery ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Empty trajectory accepted by judge: strengthen validation to reject empty arrays and non-array values in `/api/judge` ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Empty trajectory overwriting SSE-captured trajectory in `tracePoller.ts`: guard assignment to preserve existing trajectory ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Stale `needsReindex` flag in admin routes: derive from fix results so successful fixes report `needsReindex: false` ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Password in plaintext cache key in `opensearchClientFactory.ts`: hash credentials with SHA-256 ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Throttle race condition in `benchmarkRunner.ts`: add exponential backoff for consecutive rate-limit errors ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Missing error handling for `afterResponse` hook in evaluation service: catch hook failures and continue with pre-hook result ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Cancellation progress edge case in `benchmarkRunner.ts`: use consistent indexing for cancelled progress events ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- `SettingsPage` and `RunDetailsContent` component tests failing with `TextEncoder is not defined` — add jsdom polyfill and missing `react-router-dom` mocks ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Preserve cluster credentials on Save and pre-fill username in Settings ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Password handling in SettingsPage using sentinel value for stored passwords ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Error handling in CLI run and benchmark commands with streaming progress updates ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Debug logging cleanup: replace console logs with structured debug statements across SettingsPage and API services ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Enforce test case name requirement on creation and update with improved error handling ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Dark mode color contrast for status icons (running, pending, cancelled, failed) across RunDetailsPage, RunSummaryPanel, and WorkflowNavigator ([#67](https://github.com/opensearch-project/agent-health/pull/67))
- Type mismatch in `BulkCreateTestCasesResponse.errors` field from `boolean` to `number` ([#67](https://github.com/opensearch-project/agent-health/pull/67))
- Remove unused minimap toggle from TraceVisualization component ([#67](https://github.com/opensearch-project/agent-health/pull/67))
- Security vulnerabilities in `basic-ftp` (critical) and `rollup` (high) dependencies ([#67](https://github.com/opensearch-project/agent-health/pull/67))
- `process is not defined` error in env config when running in browser context ([#68](https://github.com/opensearch-project/agent-health/pull/68))
- QuickRunModal closing during evaluation causing run visibility lag ([#68](https://github.com/opensearch-project/agent-health/pull/68))
- Broken documentation links: raw GitHub URL for `AGENT_HEALTH.md` and old repo name in `GETTING_STARTED.md` ([#68](https://github.com/opensearch-project/agent-health/pull/68))
- Update `RunSummaryTable` unit tests to match dark-mode-aware color classes (`text-green-700 dark:text-green-400`) introduced in a previous PR ([#51](https://github.com/opensearch-project/agent-health/pull/51))
- Replace ambiguous `text=Import Failed` Playwright locator (matched 2 elements, causing strict mode rejection) with `getByRole('alertdialog')` in benchmark import e2e test ([#51](https://github.com/opensearch-project/agent-health/pull/51))
- Update version to 0.1.1 and remove CI badges from README ([#58](https://github.com/opensearch-project/agent-health/pull/58))
- Update agent-health CLI references to use opensearch-project ([#58](https://github.com/opensearch-project/agent-health/pull/58))
- Click-outside detection for trace flyout to prevent unintended closures ([#44](https://github.com/opensearch-project/agent-health/pull/44))
- Data loading race condition in BenchmarkRunsPage ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Memory leak in benchmark timeout handling with try-finally pattern ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Config loading race condition in server startup ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Runtime environment variable evaluation in connector config ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- E2E test routing (hash routing to direct routing) ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Excessive debug logging reduced to essential warnings only ([#33](https://github.com/opensearch-project/agent-health/pull/33))
- Support for nested OTel attribute format in trace data (backwards compatible with flattened format)
- Fixed server default port to 4001 to match documentation ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- Fixed Span interface to make attributes optional, matching actual API data ([#25](https://github.com/opensearch-project/agent-health/pull/25))
- Fixed broken documentation links in GETTING_STARTED.md
- Fixed high severity ReDoS vulnerability in @modelcontextprotocol/sdk

### Security
- Update `express-rate-limit` to fix IPv4-mapped IPv6 address bypass vulnerability (GHSA-46wh-pxpv-q5gq) ([#86](https://github.com/opensearch-project/agent-health/pull/86))
- Update `minimatch` override to `^10.2.4` to fix ReDoS vulnerabilities (GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74) ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Add `fast-xml-parser` override `5.4.1` to fix DoS vulnerability ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Bump `@aws-sdk/client-bedrock-runtime` and `@aws-sdk/credential-providers` from `^3.936.0` to `^3.999.0` ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Bump `hono` to `4.12.5` and `@hono/node-server` to `1.19.11` to fix authorization bypass (GHSA-wc8c-qw6v-h7f6), cookie injection (GHSA-5pq2-9x2x-5p6w), SSE injection (GHSA-p6xx-57qc-3wxr), and arbitrary file access (GHSA-q5qw-h33p-qvwr) ([#77](https://github.com/opensearch-project/agent-health/pull/77))
- Bump `@aws-sdk/credential-providers` from `^3.999.0` to `^3.1000.0`
- Updated ajv from 8.17.1 to 8.18.0 to fix GHSA-2g4f-4pwh-qvx6 ReDoS vulnerability ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated fast-xml-parser from 5.3.4 to 5.3.6 to fix GHSA-jmr7-xgp7-cmfj DoS vulnerability ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated qs from 6.14.1 to 6.15.0 to fix GHSA-w7fw-mjwx-w883 arrayLimit bypass vulnerability ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated @aws-sdk/xml-builder from 3.972.4 to 3.972.5 (transitive dependency fix) ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated @modelcontextprotocol/sdk to address GHSA-8r9q-7v3j-jr4g
- Updated lodash from 4.17.21 to 4.17.23 to fix CVE-2025-13465 prototype pollution vulnerability
- Updated lycheeverse/lychee-action from v1 to v2.0.2 in CI workflow

### Removed
- Stale Kiro spec files and sample test case data from `agent-health-data/` ([#67](https://github.com/opensearch-project/agent-health/pull/67))
