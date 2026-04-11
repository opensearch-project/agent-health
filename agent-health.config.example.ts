/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Health Configuration
 *
 * Copy this file to `agent-health.config.ts` and customize for your environment.
 * The config file is automatically detected in the current working directory.
 *
 * By default, user-defined agents and models are merged with the built-in defaults.
 * Set `extends: false` to use only your agents and models.
 *
 * Supported config file names (in priority order):
 *   - agent-health.config.ts
 *   - agent-health.config.js
 *   - agent-health.config.mjs
 */

export default {
  // Custom agents are merged with built-in agents by default.
  // Each agent `key` must be unique — if it matches a built-in key,
  // it will override that built-in agent.
  agents: [
    // Example 1: REST connector (synchronous JSON response)
    {
      key: "my-rest-agent",
      name: "My REST Agent",
      endpoint: "http://localhost:8000/api/agent",
      connectorType: "rest",
      useTraces: true,           // Enable OpenTelemetry trace collection
    },

    // Example 2: Streaming connector (Server-Sent Events)
    {
      key: "my-streaming-agent",
      name: "My Streaming Agent",
      endpoint: "http://localhost:9000/agent/stream",
      connectorType: "agui-streaming",
      useTraces: false,
    },

    // Example 3: CLI tool connector
    // {
    //   key: "my-cli-agent",
    //   name: "My CLI Agent",
    //   endpoint: "/usr/local/bin/my-agent",
    //   connectorType: "subprocess",
    //   useTraces: false,
    // },

    // Example 4: Agent with authentication hook
    // {
    //   key: "authenticated-agent",
    //   name: "Authenticated Agent",
    //   endpoint: "https://api.example.com/agent",
    //   connectorType: "rest",
    //   useTraces: true,
    //   hooks: {
    //     beforeRequest: async ({ endpoint, payload, headers }) => {
    //       return {
    //         endpoint,
    //         payload,
    //         headers: {
    //           ...headers,
    //           'Authorization': `Bearer ${process.env.API_TOKEN}`,
    //         },
    //       };
    //     },
    //   },
    // },

    // Example 5: Claude Code with MCP servers (competitive evaluation)
    // Uses a standard MCP config JSON file (same format as ~/.claude.json mcpServers)
    // {
    //   key: "claude-code-eval",
    //   name: "Claude Code (Eval)",
    //   endpoint: "claude",
    //   connectorType: "claude-code",
    //   useTraces: true,
    //   connectorConfig: {
    //     dangerouslySkipPermissions: true,
    //     appendSystemPrompt: "You are an observability agent...",
    //     allowedTools: ["mcp__aws-prometheus__*", "mcp__aws-cloudwatch__*", "Bash"],
    //     mcpConfigPath: "./mcp-config.json",  // standard MCP config file
    //     strictMcpConfig: true,
    //     env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "Bedrock" },
    //   },
    // },
  ],

  // Custom models (merged with built-in models by default)
  // models: [
  //   {
  //     key: "my-model",
  //     model_id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  //     display_name: "My Model",
  //     provider: "bedrock",       // "bedrock" | "openai-compatible" | "demo"
  //     context_window: 200000,
  //     max_output_tokens: 4096,
  //   },
  // ],

  // Set to false to ignore all built-in agents and models
  // extends: false,
};
