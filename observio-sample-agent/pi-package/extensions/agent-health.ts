/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Health extension for Pi.dev
 *
 * Provides tools for:
 * 1. Validating OTel instrumentation against Gen AI semantic conventions
 * 2. Checking project compliance (SPDX headers, DCO, changelog)
 * 3. Running build/test validation
 * 4. Finding relevant code in the Agent Health architecture
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  // --- Tool: validate-spans ---
  pi.registerTool({
    name: "validate_spans",
    label: "Validate OTel Spans",
    description:
      "Checks if a codebase follows OpenTelemetry Gen AI semantic conventions for agent instrumentation. Scans for span attributes, naming, and hierarchy issues.",
    promptSnippet: "Validate OTel span instrumentation against Gen AI conventions",
    promptGuidelines: [
      "Use validate_spans when the user asks if their instrumentation is correct",
      "Use validate_spans after generating instrumentation code to verify it",
      "Use validate_spans when debugging why traces don't appear in Agent Health",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to scan (file or directory)" }),
      check: StringEnum([
        "all",
        "attributes",
        "naming",
        "hierarchy",
        "events",
      ] as const),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { path, check } = params;

      // Required Gen AI attributes per span type
      const requirements = {
        agent: [
          "gen_ai.operation.name",
          "gen_ai.system",
          "gen_ai.agent.name",
        ],
        llm: [
          "gen_ai.operation.name",
          "gen_ai.system",
          "gen_ai.request.model",
          "gen_ai.usage.input_tokens",
          "gen_ai.usage.output_tokens",
        ],
        tool: ["gen_ai.operation.name", "gen_ai.tool.name"],
      };

      // Required span events
      const requiredEvents = {
        llm: ["gen_ai.content.prompt", "gen_ai.content.completion"],
        tool: ["gen_ai.tool.input", "gen_ai.tool.output"],
      };

      // Expected operation names
      const validOps = ["invoke_agent", "chat", "execute_tool"];

      // Expected span naming: "<operation> <system/tool>"
      const namingPattern = /^(invoke_agent|chat|execute_tool)\s+\S+/;

      const report = {
        path,
        check,
        requirements,
        requiredEvents,
        validOps,
        namingPattern: namingPattern.source,
        instructions: [
          `Scan files at '${path}' for OpenTelemetry span creation calls`,
          "Check startSpan() calls for required attributes based on span type",
          "Verify span names follow '<operation> <system>' pattern",
          "Check for addEvent() calls with required event names",
          "Verify parent-child hierarchy: agent → llm/tool spans",
          "Report any missing attributes, bad naming, or hierarchy issues",
        ],
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  });

  // --- Tool: check-compliance ---
  pi.registerTool({
    name: "check_compliance",
    label: "Check PR Compliance",
    description:
      "Validates Agent Health project compliance: SPDX license headers, DCO signoff, CHANGELOG entries, and build status.",
    promptSnippet: "Check PR compliance (SPDX, DCO, changelog, build)",
    promptGuidelines: [
      "Use check_compliance before creating a PR to catch issues early",
      "Use check_compliance when the user asks about PR requirements",
    ],
    parameters: Type.Object({
      check: StringEnum([
        "all",
        "spdx",
        "dco",
        "changelog",
        "build",
      ] as const),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const checks: Record<string, object> = {};

      if (params.check === "all" || params.check === "spdx") {
        checks.spdx = {
          description: "All source files need SPDX Apache-2.0 header",
          header:
            "/* Copyright OpenSearch Contributors\n SPDX-License-Identifier: Apache-2.0 */",
          check: "grep -rL 'SPDX-License-Identifier' src/ --include='*.ts'",
        };
      }

      if (params.check === "all" || params.check === "dco") {
        checks.dco = {
          description: "All commits need DCO signoff",
          check: "git log --no-merges --format='%H %s' | head -5",
          fix: "git commit -s -m 'message'",
          note: "Use -s flag, never --no-verify",
        };
      }

      if (params.check === "all" || params.check === "changelog") {
        checks.changelog = {
          description: "CHANGELOG.md must be updated for PRs",
          check: "git diff main -- CHANGELOG.md",
          format: "- Description of change ([#PR](link)) by @author",
        };
      }

      if (params.check === "all" || params.check === "build") {
        checks.build = {
          description: "Build and all tests must pass",
          command: "npm run build:all && npm run test:all",
          note: "Never use --no-verify to skip hooks",
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(checks, null, 2),
          },
        ],
      };
    },
  });

  // --- Tool: find-architecture ---
  pi.registerTool({
    name: "find_architecture",
    label: "Find Relevant Code",
    description:
      "Routes a query to the correct layer in Agent Health's architecture. Knows where services, routes, storage, CLI commands, types, and UI components live.",
    promptSnippet: "Find relevant code in Agent Health's architecture",
    promptGuidelines: [
      "Use find_architecture when implementing a feature to find the right files",
      "Use find_architecture when the user asks where something is implemented",
    ],
    parameters: Type.Object({
      area: StringEnum([
        "agent-streaming",
        "evaluation",
        "storage",
        "traces",
        "cli",
        "routes",
        "types",
        "config",
        "ui-components",
        "connectors",
      ] as const),
      query: Type.Optional(
        Type.String({ description: "What specifically to find" })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const map: Record<string, object> = {
        "agent-streaming": {
          dir: "services/agent/",
          key_files: ["sseHandler.ts", "agUiConverter.ts"],
          patterns: ["SSE streaming", "AG-UI protocol", "event-stream headers"],
        },
        evaluation: {
          dir: "services/evaluation/",
          routes: "server/routes/judge.ts",
          key_files: ["judge.ts", "mockEvaluator.ts"],
          patterns: ["Bedrock judge", "passFailStatus", "accuracy"],
        },
        storage: {
          dir: "services/storage/",
          adapter: "server/adapters/opensearch/StorageModule.ts",
          key_files: [
            "asyncTestCaseStorage.ts",
            "asyncBenchmarkStorage.ts",
            "asyncRunStorage.ts",
          ],
          patterns: [
            "toAppFormat/toStorageFormat",
            "CRUD wrappers",
            "OpenSearch client",
          ],
        },
        traces: {
          dir: "services/traces/",
          key_files: [
            "spanCategorization.ts",
            "metrics.ts",
            "tracePoller.ts",
          ],
          patterns: [
            "Gen AI semantic conventions",
            "token/cost calculation",
            "background polling",
          ],
        },
        cli: {
          dir: "cli/",
          key_files: [
            "commands/run.ts",
            "commands/benchmark.ts",
            "commands/export.ts",
            "utils/serverLifecycle.ts",
            "utils/apiClient.ts",
          ],
          patterns: [
            "ensureServer()",
            "server auto-start",
            "typed HTTP client",
          ],
        },
        routes: {
          dir: "server/routes/",
          patterns: [
            "validateX(): string | null",
            "return 400 with { error }",
            "early return for 404",
          ],
        },
        types: {
          file: "types/index.ts",
          key_types: [
            "TestCase",
            "BenchmarkRun",
            "TrajectoryStep",
            "AgentConfig",
          ],
          patterns: [
            "string unions not enums",
            "discriminated unions with type field",
          ],
        },
        config: {
          dir: "lib/",
          key_files: [
            "config/loader.ts",
            "config/types.ts",
            "constants.ts",
            "hooks.ts",
          ],
          patterns: [
            "agent-health.config.ts",
            "UserAgentConfig",
            "beforeRequest hook",
          ],
        },
        "ui-components": {
          dir: "components/",
          patterns: ["shadcn/ui", "React hooks in hooks/"],
        },
        connectors: {
          dir: "connectors/",
          patterns: [
            "ConnectorType",
            "agui-streaming",
            "custom connector template",
          ],
          skill: "/add-connector for full guide",
        },
      };

      const result = map[params.area] || { error: "Unknown area" };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { area: params.area, query: params.query, ...result },
              null,
              2
            ),
          },
        ],
      };
    },
  });

  // --- Tool: run-validation ---
  pi.registerTool({
    name: "run_validation",
    label: "Run Build & Tests",
    description:
      "Runs the Agent Health build and test suite. Use before creating PRs.",
    promptSnippet: "Run npm build:all && test:all for Agent Health",
    promptGuidelines: [
      "Use run_validation after implementing changes to verify nothing is broken",
      "Use run_validation before creating a PR",
    ],
    parameters: Type.Object({
      scope: StringEnum([
        "all",
        "build",
        "unit",
        "integration",
        "e2e",
      ] as const),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const commands: Record<string, string> = {
        all: "npm run build:all && npm run test:all",
        build: "npm run build:all",
        unit: "npm run test:unit",
        integration: "npm run test:integration",
        e2e: "npm run test:e2e",
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              command: commands[params.scope],
              note: "Run this in the agent-health project root",
              coverage_thresholds: {
                lines: "90%",
                statements: "90%",
                functions: "80%",
                branches: "80%",
              },
            }),
          },
        ],
      };
    },
  });
}
