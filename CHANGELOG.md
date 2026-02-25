<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# CHANGELOG

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

### Added
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
- Updated ajv from 8.17.1 to 8.18.0 to fix GHSA-2g4f-4pwh-qvx6 ReDoS vulnerability ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated fast-xml-parser from 5.3.4 to 5.3.6 to fix GHSA-jmr7-xgp7-cmfj DoS vulnerability ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated qs from 6.14.1 to 6.15.0 to fix GHSA-w7fw-mjwx-w883 arrayLimit bypass vulnerability ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated @aws-sdk/xml-builder from 3.972.4 to 3.972.5 (transitive dependency fix) ([#39](https://github.com/opensearch-project/agent-health/pull/39))
- Updated @modelcontextprotocol/sdk to address GHSA-8r9q-7v3j-jr4g
- Updated lodash from 4.17.21 to 4.17.23 to fix CVE-2025-13465 prototype pollution vulnerability
- Updated lycheeverse/lychee-action from v1 to v2.0.2 in CI workflow
