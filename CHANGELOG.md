<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# CHANGELOG

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

### Added
- CLI commands (`run`, `list`, `benchmark`, `doctor`, `init`) for headless agent evaluation ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Pluggable connector architecture supporting AG-UI, REST, subprocess, and Claude Code agents ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- TypeScript configuration file support with `defineConfig()` helper ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Server lifecycle management with Playwright-style auto-start for CLI ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- CLI documentation (`docs/CLI.md`, `docs/CONFIGURATION.md`, `docs/CONNECTORS.md`) ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Delete operation feedback UI with success/error messages ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- CLI-only agent badges and disabled state in QuickRunModal ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Comprehensive unit tests for connectors (AG-UI, REST, subprocess, Claude Code, mock) ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- TLS skip verify option for OpenSearch connections (`OPENSEARCH_STORAGE_TLS_SKIP_VERIFY`, `OPENSEARCH_LOGS_TLS_SKIP_VERIFY`)
- Full evaluation flow E2E tests using Demo Agent and Demo Model for CI-friendly testing
- Enhanced CI workflow with integration test coverage reporting and badge generation
- Test summary job in CI that aggregates results from unit, integration, and E2E tests
- CI artifacts for coverage reports and badge data (unit-coverage, e2e-tests badges)
- Comprehensive Playwright E2E tests for all UI flows ([#24](https://github.com/opensearch-project/dashboards-traces/pull/24))
- E2E test fixtures and data-testid attributes for reliable test selectors ([#24](https://github.com/opensearch-project/dashboards-traces/pull/24))
- Testing documentation in README with CI pipeline information ([#24](https://github.com/opensearch-project/dashboards-traces/pull/24))
- Agent Traces page with table-based trace view for browsing and filtering traces ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- LatencyHistogram component for visualizing trace duration distribution ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- SpanInputOutput component displaying span I/O per OTEL semantic conventions ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- TraceFlyoutContent for detailed trace inspection with dedicated tabs ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- Unit tests for LatencyHistogram, SpanInputOutput, and TraceFlyoutContent components ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- AgentTrendChart and MetricsTable components for dashboard visualization ([#23](https://github.com/opensearch-project/dashboards-traces/pull/23))
- Benchmark run cancellation hook with state management ([#23](https://github.com/opensearch-project/dashboards-traces/pull/23))
- js-yaml dependency for YAML support ([#23](https://github.com/opensearch-project/dashboards-traces/pull/23))
- JSON import functionality for test cases with automatic benchmark creation ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Benchmark run cancellation with state management and status transitions ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Integration tests for benchmark cancellation and JSON import workflows ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Collapsible "Evals" section in sidebar navigation ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- NPX usage instructions in documentation ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Request-scoped storage client middleware for dynamic data source configuration
- Comprehensive unit tests for flow transformation and trace polling
- Unit tests for trace statistics, utility functions, and trajectory diff service
- Tests for opensearchClient storage module
- Enhanced storage route tests with additional coverage

### Changed
- Enhanced Playwright configuration for CI/local development environments ([#24](https://github.com/opensearch-project/dashboards-traces/pull/24))
- Updated navigation to distinguish "Agent Traces" (table view) from "Live Traces" (real-time) ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- Enhanced CORS middleware setup for better cross-origin support ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Refactored routing and layout structure for improved navigation ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Renamed Experiment to Benchmark throughout the codebase for clearer terminology
- Enhanced benchmark and run storage with improved sorting and field limits
- Simplified CLI by removing demo and configure commands
- Updated setup script with improved AWS profile handling and service shutdown logic
- Refactored agentService to use mock:// endpoint prefix for demo mode
- Updated judge routes to use demo-model provider detection

### Fixed
- Data loading race condition in BenchmarkRunsPage ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Memory leak in benchmark timeout handling with try-finally pattern ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Config loading race condition in server startup ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Runtime environment variable evaluation in connector config ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- E2E test routing (hash routing to direct routing) ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Excessive debug logging reduced to essential warnings only ([#33](https://github.com/opensearch-project/dashboards-traces/pull/33))
- Support for nested OTel attribute format in trace data (backwards compatible with flattened format)
- Fixed server default port to 4001 to match documentation ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- Fixed Span interface to make attributes optional, matching actual API data ([#25](https://github.com/opensearch-project/dashboards-traces/pull/25))
- Fixed broken documentation links in GETTING_STARTED.md
- Fixed high severity ReDoS vulnerability in @modelcontextprotocol/sdk

### Security
- Updated @modelcontextprotocol/sdk to address GHSA-8r9q-7v3j-jr4g
- Updated lodash from 4.17.21 to 4.17.23 to fix CVE-2025-13465 prototype pollution vulnerability
- Updated lycheeverse/lychee-action from v1 to v2.0.2 in CI workflow
