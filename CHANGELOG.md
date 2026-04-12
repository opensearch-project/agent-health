<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# CHANGELOG

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

### Added
- Kiro CLI SQLite reader with progressive warmup, non-blocking cache, and phase-aware loading UX
- Coding Agent Analytics: unified dashboard for Claude Code, Kiro, and Codex CLI usage data
- Plugin-based reader system for ingesting local session data from ~/.claude/, ~/.kiro/, and ~/.codex/
- API routes for coding agent stats, sessions, costs, activity patterns, and tool usage (/api/coding-agents/*)
- Frontend page with Overview, Sessions, Projects, Costs, Activity, Efficiency, Tools, Advanced, and Workspace tabs at /coding-agents
- Pricing engine covering Claude, Bedrock, and OpenAI models for cost estimation
- Unified tool categorization across all three coding agents
- Insights engine generating actionable recommendations from session data
- In-memory session cache with directory-level invalidation and background refresh
- Feature toggle to disable Coding Agent Analytics (AGENT_HEALTH_DISABLE_CODING_ANALYTICS=true or codingAgentAnalytics: false in config)
- Graceful shutdown handler (SIGTERM/SIGINT) for stopping background timers and draining connections
- Health endpoint now returns feature flags for frontend conditional rendering
- RFC 001 documenting Coding Agent Analytics design

## [0.2.0]

### Fixed
- Release workflow using `build` instead of `build:all`, causing CLI tests to fail ([#123](https://github.com/opensearch-project/agent-health/pull/123))

### Changed
- Increase release workflow approval timeout from 6 hours (default) to 24 hours
- Allow workflow initiator to count as one of the required release approvers
- Bump version to 0.2.0

### Added
- Observio sample agent — a reference ReAct agent for practicing agent health improvements (based on [osd-agents](https://github.com/opensearch-project/OpenSearch-Dashboards/tree/main/packages/osd-agents))
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
