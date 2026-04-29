<!--
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
-->

# Plan: Non-AG-UI Agent Support in AgentEval

> **Status: Implemented** via the connector system (not the separate adapter pattern originally proposed here).
> See `services/connectors/strands/` and `services/connectors/langgraph/` for the Strands and LangGraph implementations.

## Problem Statement

Currently, AgentEval only supports agents that emit AG-UI protocol SSE events. This excludes:
- **Claude Code** - CLI tool with its own execution model
- **LangGraph non-AG-UI instances** - LangGraph without AG-UI endpoints
- **Amazon Strands Agents** - AWS agent framework

## Key Insight

OTEL traces alone are insufficient for evaluation - they typically capture metadata (timing, spans) but not the **actual content** (full responses, tool outputs) needed for LLM judge evaluation.

Reference implementations:
- **Strands Evals**: Direct execution captures output, OTEL supplements with trajectory
- **LangSmith**: Rich tracing with full content at every step

## Solution Approach

**Unified Agent Adapter Pattern** - One interface that works for API, CLI, and streaming agents:

```typescript
interface AgentAdapter {
  execute(prompt: string, context?: any): Promise<AgentResult>;
}

interface AgentResult {
  output: string;                    // The actual response (required)
  trajectory?: TrajectoryStep[];     // Execution steps (optional)
  metadata?: Record<string, any>;    // Agent-specific data
}
```

Each agent type has an adapter that:
1. **Executes the agent** (CLI, API, or SSE)
2. **Captures the actual output** directly
3. **Optionally captures trajectory** from output parsing or OTEL
4. **Returns unified result** for evaluation

---

## Architecture Overview

```
                         ┌──────────────────────┐
                         │      AgentEval       │
                         │   (Experiment Runner)│
                         └──────────┬───────────┘
                                    │ calls adapter.execute()
                         ┌──────────▼───────────┐
                         │   Agent Adapter      │
                         │   Registry           │
                         └──────────┬───────────┘
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
     ┌──────▼──────┐        ┌──────▼──────┐        ┌──────▼──────┐
     │ Claude Code │        │   Strands   │        │  LangGraph  │
     │   Adapter   │        │   Adapter   │        │   Adapter   │
     │    (CLI)    │        │   (API)     │        │  (AG-UI)    │
     └──────┬──────┘        └──────┬──────┘        └──────┬──────┘
            │                      │                      │
            │ exec CLI             │ AWS SDK              │ SSE stream
            ▼                      ▼                      ▼
     ┌─────────────┐        ┌─────────────┐        ┌─────────────┐
     │ claude CLI  │        │ Strands API │        │ LangGraph   │
     └─────────────┘        └─────────────┘        └─────────────┘
            │                      │                      │
            └──────────────────────┼──────────────────────┘
                                   │
                         ┌─────────▼─────────┐
                         │   AgentResult     │
                         │ {output, trajectory}│
                         └─────────┬─────────┘
                                   │
                         ┌─────────▼─────────┐
                         │    LLM Judge      │
                         │   (unchanged)     │
                         └───────────────────┘
```

---

## Phase 1: Agent Adapter Framework (Foundation)

### 1.1 Core Types

**File: `types/index.ts`** - Add:
```typescript
// Adapter types
export type AdapterType = 'ag-ui' | 'cli' | 'api' | 'custom';

export interface AgentResult {
  output: string;                    // Required: the actual response
  trajectory?: TrajectoryStep[];     // Optional: execution steps
  metadata?: {
    executionTime?: number;
    tokenCount?: number;
    traceId?: string;
    [key: string]: any;
  };
}

export interface AgentAdapter {
  type: AdapterType;
  execute(
    prompt: string,
    context?: { tools?: any[]; history?: any[] }
  ): Promise<AgentResult>;

  // Optional streaming support
  executeStream?(
    prompt: string,
    context?: any,
    onChunk?: (chunk: string) => void
  ): Promise<AgentResult>;
}

// Extended AgentConfig
export interface AgentConfig {
  // ... existing fields ...
  adapterType: AdapterType;          // Required: which adapter to use
  adapterConfig?: {
    command?: string;                // For CLI adapters
    apiEndpoint?: string;            // For API adapters
    timeout?: number;
    [key: string]: any;
  };
}
```

### 1.2 Adapter Registry

**New file: `services/adapters/index.ts`**
```typescript
import { AgentAdapter, AgentConfig } from '@/types';

// Registry of available adapters
const adapters: Record<string, new (config: AgentConfig) => AgentAdapter> = {};

export function registerAdapter(
  type: string,
  adapterClass: new (config: AgentConfig) => AgentAdapter
): void;

export function getAdapter(config: AgentConfig): AgentAdapter;

export function listAdapters(): string[];
```

### 1.3 Base Adapter Class

**New file: `services/adapters/baseAdapter.ts`**
```typescript
export abstract class BaseAdapter implements AgentAdapter {
  protected config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  abstract execute(prompt: string, context?: any): Promise<AgentResult>;

  // Helper to build trajectory from raw output
  protected parseTrajectory(output: string): TrajectoryStep[] {
    // Default implementation - can be overridden
  }
}
```

---

## Phase 2: Built-in Adapters

### 2.1 AG-UI Adapter (Existing Flow)

**New file: `services/adapters/aguiAdapter.ts`**
```typescript
/**
 * Wraps existing AG-UI flow as an adapter
 * Uses SSEClient + AGUIToTrajectoryConverter internally
 */
export class AGUIAdapter extends BaseAdapter {
  type = 'ag-ui' as const;

  async execute(prompt: string, context?: any): Promise<AgentResult> {
    // Use existing AG-UI streaming flow
    const trajectory = await streamAgentExecution(
      this.config.endpoint,
      buildPayload(prompt, context),
      this.config.headers
    );

    return {
      output: extractFinalResponse(trajectory),
      trajectory,
    };
  }

  async executeStream(prompt, context, onChunk): Promise<AgentResult> {
    // Real-time streaming with callbacks
  }
}
```

### 2.2 Claude Code Adapter (CLI)

**New file: `services/adapters/claudeCodeAdapter.ts`**
```typescript
import { spawn } from 'child_process';

export class ClaudeCodeAdapter extends BaseAdapter {
  type = 'cli' as const;

  async execute(prompt: string, context?: any): Promise<AgentResult> {
    const { command = 'claude', timeout = 300000 } = this.config.adapterConfig || {};

    // Execute: claude --print "prompt" --output-format json
    const result = await this.runCLI(command, [
      '--print', prompt,
      '--output-format', 'stream-json',  // Get structured output
    ], timeout);

    return {
      output: result.finalResponse,
      trajectory: this.parseClaudeCodeOutput(result.events),
      metadata: { executionTime: result.duration },
    };
  }

  private parseClaudeCodeOutput(events: any[]): TrajectoryStep[] {
    // Parse Claude Code's JSON output format
    // Maps: assistant → response, tool_use → action, tool_result → tool_result
  }
}
```

### 2.3 Strands Adapter (AWS API)

**New file: `services/adapters/strandsAdapter.ts`**
```typescript
import { BedrockAgentRuntimeClient, InvokeAgentCommand } from '@aws-sdk/client-bedrock-agent-runtime';

export class StrandsAdapter extends BaseAdapter {
  type = 'api' as const;
  private client: BedrockAgentRuntimeClient;

  async execute(prompt: string, context?: any): Promise<AgentResult> {
    const { agentId, agentAliasId, region } = this.config.adapterConfig || {};

    const response = await this.client.send(new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId: context?.sessionId || generateSessionId(),
      inputText: prompt,
    }));

    return {
      output: await this.extractCompletion(response),
      trajectory: this.parseStrandsTrace(response.trace),
      metadata: { sessionId: response.sessionId },
    };
  }

  private parseStrandsTrace(trace: any): TrajectoryStep[] {
    // Parse Strands trace format to TrajectoryStep[]
  }
}
```

### 2.4 LangGraph Adapter (Non-AG-UI)

**New file: `services/adapters/langgraphAdapter.ts`**
```typescript
export class LangGraphAdapter extends BaseAdapter {
  type = 'api' as const;

  async execute(prompt: string, context?: any): Promise<AgentResult> {
    const { apiEndpoint } = this.config.adapterConfig || {};

    // Call LangGraph API directly (not AG-UI SSE)
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: prompt, ...context }),
    });

    const data = await response.json();

    return {
      output: data.output,
      trajectory: this.parseLangGraphOutput(data),
    };
  }
}
```

### 2.5 Custom Adapter (User-Provided)

**New file: `services/adapters/customAdapter.ts`**
```typescript
/**
 * Allows users to provide a task function (like Strands Evals pattern)
 */
export class CustomAdapter extends BaseAdapter {
  type = 'custom' as const;
  private taskFunction: (prompt: string, context?: any) => Promise<AgentResult>;

  setTaskFunction(fn: typeof this.taskFunction): void {
    this.taskFunction = fn;
  }

  async execute(prompt: string, context?: any): Promise<AgentResult> {
    if (!this.taskFunction) {
      throw new Error('Custom adapter requires a task function');
    }
    return this.taskFunction(prompt, context);
  }
}
```

---

## Phase 3: Integration & UI

### 3.1 Update Experiment Runner

**File: `services/experimentRunner.ts`** - Refactor:
```typescript
import { getAdapter } from './adapters';

async function executeTestCase(run, testCase) {
  const agent = getAgentConfig(run.agentKey);
  const adapter = getAdapter(agent);

  // Unified execution through adapter
  const result = await adapter.execute(
    testCase.initialPrompt,
    { tools: testCase.tools, history: [] }
  );

  // Evaluate with judge (same for all adapters)
  return await evaluateResult(result, testCase);
}
```

### 3.2 Update Agent Configuration UI

**File: `components/ConfigEditor.tsx`** - Add:
- Adapter type selector dropdown
- Adapter-specific configuration fields
- Test connection button

### 3.3 Update QuickRunModal

**File: `components/QuickRunModal.tsx`**
- Show adapter type indicator
- Streaming output for adapters that support it
- Progress indication for non-streaming adapters

### 3.4 Add Agent Configuration

**File: `lib/constants.ts`** - Add new agents:
```typescript
{
  key: "claude-code",
  name: "Claude Code",
  adapterType: "cli",
  adapterConfig: {
    command: "claude",
    timeout: 300000,
  },
  models: ["claude-sonnet-4", "claude-opus-4"],
  description: "Anthropic's Claude Code CLI agent",
},
{
  key: "strands",
  name: "Amazon Strands",
  adapterType: "api",
  adapterConfig: {
    agentId: "${STRANDS_AGENT_ID}",
    agentAliasId: "${STRANDS_ALIAS_ID}",
    region: "us-east-1",
  },
  models: ["claude-sonnet-4", "amazon-nova"],
  description: "Amazon Strands agent framework",
},
{
  key: "langgraph-api",
  name: "LangGraph (API)",
  adapterType: "api",
  adapterConfig: {
    apiEndpoint: "${LANGGRAPH_API_ENDPOINT}",
  },
  models: ["claude-sonnet-4.5"],
  description: "LangGraph agent via direct API",
}
```

---

## Phase 4: OTEL Trace Enrichment (Optional)

For agents that emit OTEL traces, add optional trace fetching to enrich trajectory:

### 4.1 Trace Enrichment Service

**New file: `services/adapters/traceEnrichment.ts`**
```typescript
/**
 * Optionally fetch OTEL traces to enrich trajectory with timing/metadata
 */
export async function enrichWithTraces(
  result: AgentResult,
  traceConfig: { serviceName: string; traceId?: string }
): Promise<AgentResult> {
  if (!result.metadata?.traceId) return result;

  const spans = await fetchTraces(traceConfig);

  return {
    ...result,
    trajectory: mergeTrajectoryWithSpans(result.trajectory, spans),
  };
}
```

---

## Files Summary

### New Files
| File | Purpose |
|------|---------|
| `services/adapters/index.ts` | Adapter registry and factory |
| `services/adapters/baseAdapter.ts` | Base adapter class |
| `services/adapters/aguiAdapter.ts` | AG-UI adapter (wraps existing) |
| `services/adapters/claudeCodeAdapter.ts` | Claude Code CLI adapter |
| `services/adapters/strandsAdapter.ts` | Amazon Strands API adapter |
| `services/adapters/langgraphAdapter.ts` | LangGraph API adapter |
| `services/adapters/customAdapter.ts` | User-provided task function |
| `services/adapters/traceEnrichment.ts` | Optional OTEL trace enrichment |

### Modified Files
| File | Changes |
|------|---------|
| `types/index.ts` | Add `AdapterType`, `AgentResult`, `AgentAdapter` |
| `lib/constants.ts` | Add Claude Code, Strands, LangGraph configs |
| `services/experimentRunner.ts` | Use adapter pattern for execution |
| `components/QuickRunModal.tsx` | Adapter-aware UI |
| `components/ConfigEditor.tsx` | Adapter configuration UI |

---

## Implementation Order

1. **Phase 1** - Adapter Framework
   - Core types (`AgentResult`, `AgentAdapter`)
   - Adapter registry
   - Base adapter class

2. **Phase 2** - Built-in Adapters
   - AG-UI adapter (wrap existing)
   - Claude Code adapter (CLI)
   - Strands adapter (AWS API)
   - LangGraph adapter (API)

3. **Phase 3** - Integration & UI
   - Update experiment runner
   - Configuration UI
   - Quick run modal updates

4. **Phase 4** - OTEL Enrichment (Optional)
   - Trace enrichment service
   - Merge spans with trajectory

---

## Environment Variables

```bash
# Claude Code
CLAUDE_CODE_COMMAND=claude
CLAUDE_CODE_TIMEOUT=300000

# Amazon Strands
STRANDS_AGENT_ID=your-agent-id
STRANDS_ALIAS_ID=your-alias-id
AWS_REGION=us-east-1

# LangGraph (non-AG-UI)
LANGGRAPH_API_ENDPOINT=http://localhost:8000/invoke

# Optional: OTEL for trace enrichment
OTEL_TRACE_ENDPOINT=http://localhost:16686
```

---

## Verification Plan

1. **Unit tests**:
   - Each adapter's output parsing
   - Adapter registry functionality
   - AgentResult validation

2. **Integration tests**:
   - Claude Code adapter with mock CLI
   - Strands adapter with mock AWS SDK
   - AG-UI adapter (existing flow)

3. **E2E tests**:
   - Mixed-adapter experiment (AG-UI + CLI)
   - Comparison view with different adapters

4. **Manual testing**:
   - Run Claude Code via adapter, evaluate
   - Compare Claude Code vs AG-UI agent on same test case
