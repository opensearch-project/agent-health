/*
   * Copyright OpenSearch Contributors
   * SPDX-License-Identifier: Apache-2.0
   */

  export default {
    agents: [
      {
        key: "per",
        name: "PER Agent",
        endpoint: process.env.PER_ENDPOINT || "http://localhost:9200/_plugins/_ml/agents/{agent_id}/_execute",
        connectorType: "rest",
        models: ["claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-3.5"],
        useTraces: false,  // Set to false if PER doesn't write OTel traces
        headers: {
          // Add any required authentication headers
          // "Authorization": `Bearer ${process.env.PER_API_KEY}`,
          // "X-API-Key": process.env.PER_API_KEY,
        },
      },
    ],

    // Extend default agents (true = PER is added alongside demo, langgraph, etc.)
    // Set to false to ONLY use agents defined above
    extends: true,
  };