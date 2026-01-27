<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# CHANGELOG

Inspired by [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [Unreleased]

### Added
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
- Enhanced CORS middleware setup for better cross-origin support ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Refactored routing and layout structure for improved navigation ([#20](https://github.com/opensearch-project/dashboards-traces/pull/20))
- Renamed Experiment to Benchmark throughout the codebase for clearer terminology
- Enhanced benchmark and run storage with improved sorting and field limits
- Simplified CLI by removing demo and configure commands
- Updated setup script with improved AWS profile handling and service shutdown logic
- Refactored agentService to use mock:// endpoint prefix for demo mode
- Updated judge routes to use demo-model provider detection

### Fixed
- Fixed broken documentation links in GETTING_STARTED.md
- Fixed high severity ReDoS vulnerability in @modelcontextprotocol/sdk

### Security
- Updated @modelcontextprotocol/sdk to address GHSA-8r9q-7v3j-jr4g
