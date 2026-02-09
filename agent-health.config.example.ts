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
  // Each agent `key` must be unique — if it matches a built-in key
  // (e.g., "langgraph", "demo"), it will override that built-in agent.
  agents: [
    {
      key: "my-agent",           // Unique identifier (used in CLI: --agent my-agent)
      name: "My Custom Agent",   // Display name shown in UI dropdowns and tables
      endpoint: "http://localhost:3000/agent",
      connectorType: "agui-streaming",  // "agui-streaming" | "rest" | "subprocess" | "claude-code" | "mock"
      models: ["claude-sonnet-4.5", "claude-sonnet-4"],
      useTraces: false,          // Set to true to fetch OTel traces for this agent
      headers: {},               // Custom headers sent with every request

      // Lifecycle hooks for custom setup/transform logic.
      // Use hooks when your agent deviates from the standard AG-UI protocol.
      // hooks: {
      //   // Called before each request. Use it to create resources, modify the
      //   // endpoint/payload/headers, or perform any async setup your agent needs.
      //   // Must return { endpoint, payload, headers }.
      //   beforeRequest: async ({ endpoint, payload, headers }) => {
      //     // Example: pre-create a thread (e.g., Pulsar's Coral backend)
      //     const baseUrl = new URL(endpoint).origin;
      //     await fetch(`${baseUrl}/api/threads`, {
      //       method: 'POST',
      //       headers: { ...headers, 'Content-Type': 'application/json' },
      //       body: JSON.stringify({
      //         id: payload.threadId,
      //         title: payload.messages?.[0]?.content?.slice(0, 100) || 'Evaluation',
      //       }),
      //     });
      //     return { endpoint, payload, headers };
      //   },
      // },
    },
  ],

  // Custom models (merged with built-in models by default)
  // models: [
  //   {
  //     key: "my-model",
  //     model_id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  //     display_name: "My Model",
  //     provider: "bedrock",       // "bedrock" | "ollama" | "openai" | "demo"
  //     context_window: 200000,
  //     max_output_tokens: 4096,
  //   },
  // ],

  // Set to false to ignore all built-in agents and models
  // extends: false,
};
