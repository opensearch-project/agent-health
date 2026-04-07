# Agent Evaluation Framework - UI PRD

## 1. Purpose

A framework for testing AI agents that perform multi-step tasks using tools. Users define test cases with expected outcomes, run agents against them, and receive evaluations from an LLM judge.

## 2. Core Principle

**Make creating, running, and evaluating agents intuitive.**

The user's mental model is simple:
```
Define what you want → Run the agent → See if it worked
```

The complexity of trajectory capture, LLM judging, and metrics should be invisible unless the user wants to dig deeper.

---

## 3. Goals

### 3.1 Primary Goals

| Goal | Description |
|------|-------------|
| **Easy test creation** | Users should define test cases by describing what they want, not by understanding framework internals |
| **Flexible success criteria** | Support multiple ways to define "correct" behavior (trajectory, output, natural language) |
| **Clear feedback** | Pass/fail should be obvious; reasoning should be human-readable |
| **Comparison capability** | Users need to compare agent performance across configurations and over time |
| **Iterative workflow** | Quick re-run with modifications, not start-from-scratch each time |

### 3.2 User Personas

**Agent Developer**: Building/improving an AI agent. Needs to test changes, identify regressions, understand why agent fails.

**QA/Evaluator**: Running systematic tests across agent versions. Needs batch execution, comparison, reporting.

**Product Owner**: Wants to understand agent quality without technical depth. Needs clear pass/fail, trends.

### 3.3 Success Metrics

| Metric | Target |
|--------|--------|
| Time to create first test case | < 5 minutes |
| Time to run first evaluation | < 1 minute after setup |
| Understand pass/fail reason | Without technical knowledge |

---

## 4. Data Model

### 4.1 TestCase

A test scenario defining what to test and how to measure success.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | auto | Unique identifier |
| name | string | yes | Human-readable name |
| description | string | no | Longer explanation of what this tests |
| category | string | yes | Grouping (e.g., "Query Generation", "Error Handling") |
| subcategory | string | no | Further grouping within category |
| difficulty | enum | yes | "Easy", "Medium", "Hard" |
| initialPrompt | string | yes | The question/task to send to the agent |
| context | AgentContextItem[] | no | Data provided to the agent |
| tools | AgentToolDefinition[] | no | Tools available to the agent |
| expectedOutcomes | ExpectedOutcome[] | yes | How to measure success (see 4.2) |
| isPromoted | boolean | no | Available for experiments (default: false) |
| currentVersion | number | auto | Latest version number |
| versions | TestCaseVersion[] | auto | Immutable history of all versions |
| createdAt | timestamp | auto | Creation time |
| updatedAt | timestamp | auto | Last modification time |

**Versioning behavior**: Each save creates a new immutable version. Previous versions are preserved for comparison and audit.

### 4.2 ExpectedOutcome

Flexible definition of success. A test case can have one or more expected outcomes of different types.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | enum | yes | "trajectory", "output", "criteria" |
| weight | number | no | Relative importance for scoring (default: 1.0) |

**Type: trajectory** — The agent should follow a specific sequence of steps

| Field | Type | Description |
|-------|------|-------------|
| steps | TrajectoryExpectation[] | Ordered list of expected steps |

Each step:
| Field | Type | Description |
|-------|------|-------------|
| step | number | Order in sequence (1, 2, 3...) |
| description | string | What should happen at this step |
| requiredTools | string[] | Tool(s) that must be called |
| optional | boolean | If true, step can be skipped without penalty |

**Type: output** — The agent should produce a specific verifiable result

| Field | Type | Description |
|-------|------|-------------|
| field | string | What to check (e.g., "pplQuery", "finalAnswer") |
| operator | enum | "equals", "contains", "matches" (regex), "exists" |
| value | string | Expected value or pattern |

**Type: criteria** — Natural language description evaluated by LLM judge

| Field | Type | Description |
|-------|------|-------------|
| description | string | What success looks like in plain language |

### 4.3 AgentContextItem

Context data passed to the agent at runtime.

| Field | Type | Description |
|-------|------|-------------|
| description | string | Human-readable label for what this context represents |
| value | string | The context data (JSON-stringified if complex) |

### 4.4 AgentToolDefinition

Tool available to the agent during execution.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Tool identifier |
| description | string | What the tool does |
| parameters | object | JSON Schema defining the tool's parameters |

### 4.5 Agent (Optional)

Configuration for an agent endpoint. **Agent management is optional.**

In the simplest case, the user has a single agent endpoint that evolves as they develop. The endpoint URL stays the same, but the agent's behavior changes. In more complex setups, users may have multiple agent instances (different versions, A/B testing, etc.).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | string | yes | Unique identifier (used internally) |
| name | string | yes | Display name |
| endpoint | string | yes | URL to call |
| description | string | no | What this agent does |
| enabled | boolean | no | Can be selected for runs (default: true) |
| models | string[] | yes | Model IDs this agent supports |
| headers | Record<string, string> | no | Custom headers for requests (e.g., auth tokens) |

**Note:** If only one agent is configured, the UI should streamline the experience (e.g., skip agent selection step).

### 4.6 Model

LLM model configuration.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Model identifier (e.g., "claude-3-sonnet") |
| displayName | string | Human-readable name |
| contextWindow | number | Maximum input tokens |
| maxOutputTokens | number | Maximum output tokens |

### 4.7 TestCaseRun

Result of running a single test case against an agent.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| timestamp | timestamp | When the run started |
| testCaseId | string | Reference to TestCase |
| testCaseVersion | number | Which version of the test case was run |
| agentKey | string | Which agent was used |
| modelId | string | Which model was used |
| status | enum | "running", "completed", "failed" |
| passFailStatus | enum | "passed", "failed" — determined by LLM judge |
| trajectory | TrajectoryStep[] | Actual steps the agent took |
| metrics | EvaluationMetrics | Scores from the judge |
| llmJudgeReasoning | string | Human-readable explanation of the evaluation |
| improvementStrategies | ImprovementStrategy[] | Actionable suggestions |
| logs | OpenSearchLog[] | Debug logs (if available) |
| rawEvents | any[] | Raw agent protocol events |

### 4.8 TrajectoryStep

A single action captured during agent execution.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| timestamp | number | When the step occurred (ms since epoch) |
| type | enum | "tool_result", "thought", "action", "response" |
| content | string | Human-readable description of the step |
| toolName | string | Tool that was called (if type involves tools) |
| toolArgs | object | Arguments passed to the tool |
| toolOutput | any | Result returned by the tool |
| status | enum | "SUCCESS", "FAILURE" |
| latencyMs | number | How long this step took |

### 4.9 EvaluationMetrics

Scores produced by the LLM judge.

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| accuracy | number | 0-100 | Did the agent get the correct result? |
| faithfulness | number | 0-100 | Did the agent follow instructions/context? |
| latency_score | number | 0-100 | Was the agent efficient? |
| trajectory_alignment_score | number | 0-100 | Did the agent follow the expected path? |

### 4.10 ImprovementStrategy

Actionable suggestion from the judge.

| Field | Type | Description |
|-------|------|-------------|
| category | string | Area of improvement (e.g., "tool_usage", "reasoning") |
| issue | string | What went wrong |
| recommendation | string | How to fix it |
| priority | enum | "high", "medium", "low" |

### 4.11 Experiment

A batch of test cases run together for systematic evaluation.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Display name (e.g., "v2.0 Release Validation") |
| description | string | What this experiment is testing |
| useCaseIds | string[] | Which test cases are included |
| runs | ExperimentRun[] | Execution snapshots |
| createdAt | timestamp | When created |
| updatedAt | timestamp | Last modified |

### 4.12 ExperimentRun

A single execution of an experiment. **This is a snapshot in time.**

When an experiment run is created, it captures the agent configuration and environment at that moment. Even if the agent changes later (same endpoint, different behavior), the run record preserves what was tested.

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| name | string | Label (e.g., "Baseline", "With Fix v2", "Claude 4 Test") |
| description | string | What makes this run different |
| createdAt | timestamp | When executed |
| results | Record<string, RunResult> | testCaseId → result mapping |

**Snapshot fields** (captured at run time):
| Field | Type | Description |
|-------|------|-------------|
| agentKey | string | Agent identifier at time of run |
| agentEndpoint | string | Actual endpoint URL used |
| agentHeaders | Record<string, string> | Headers used (sanitized) |
| modelId | string | Model used |
| environmentNotes | string | Optional: user can note environment state (e.g., "commit abc123", "prod config") |

### 4.13 RunResult

Status of a single test case within an experiment run.

| Field | Type | Description |
|-------|------|-------------|
| reportId | string | Reference to TestCaseRun.id |
| status | enum | "pending", "running", "completed", "failed" |

---

## 5. User Capabilities

The UI must enable users to perform these actions. How these are organized into screens/flows is flexible.

### 5.1 Test Case Management

| Capability | Description |
|------------|-------------|
| **Create test case** | Define a new test with prompt, context, tools, and expected outcomes |
| **Edit test case** | Modify an existing test case (creates new version) |
| **View test case** | See all details of a test case including its definition and history |
| **Delete test case** | Remove a test case |
| **Browse test cases** | Find test cases by category, difficulty, search, or other filters |
| **View version history** | See how a test case changed over time, compare versions |
| **Promote/demote** | Control whether a test case appears in experiment selection |

### 5.2 Agent Management (Optional)

Agent management is optional. In the simplest workflow, the user provides an endpoint at run time.

| Capability | Description |
|------------|-------------|
| **Quick run with endpoint** | User can enter an endpoint URL directly without saving an agent config |
| **Add agent** | Save an agent configuration for reuse |
| **Edit agent** | Modify agent configuration |
| **Delete agent** | Remove an agent |
| **Enable/disable agent** | Control whether agent appears in run selection |
| **Test connection** | Verify agent endpoint is reachable |

**Streamlined mode:** When only one agent exists (or none saved), skip agent selection UI and use the available/provided endpoint directly.

### 5.3 Evaluation Execution

| Capability | Description |
|------------|-------------|
| **Run single evaluation** | Execute one test case against one agent/model |
| **See live progress** | Watch trajectory steps appear in real-time during execution |
| **Cancel running evaluation** | Stop an in-progress run |
| **Re-run with same config** | Quickly repeat an evaluation |
| **Re-run with different config** | Run same test case with different agent/model |

### 5.4 Results & Reporting

| Capability | Description |
|------------|-------------|
| **View run results** | See verdict, metrics, reasoning, trajectory for any run |
| **Browse run history** | Find past runs with filters (date, agent, model, pass/fail, test case) |
| **Drill into details** | Expand trajectory steps, view raw events, see logs |
| **Export results** | Download results in standard format (CSV, JSON) |

### 5.5 Experiments & Comparison

Experiments enable systematic comparison. Each run is a **snapshot** — it captures the agent config and environment at that moment, so comparisons remain valid even as the agent evolves.

| Capability | Description |
|------------|-------------|
| **Create experiment** | Define a batch of test cases to run together |
| **Add run to experiment** | Execute the experiment with a new configuration (captures snapshot) |
| **Note environment** | Optionally record environment state (commit hash, config notes, etc.) |
| **View experiment results** | See aggregate pass/fail and metrics per run |
| **Compare runs** | Side-by-side comparison of two or more runs |
| **Identify regressions** | See which test cases got worse between runs |
| **Identify improvements** | See which test cases got better between runs |

### 5.6 Configuration

| Capability | Description |
|------------|-------------|
| **Configure judge** | Set Bedrock model, endpoint for LLM evaluation |
| **Configure logging** | Set OpenSearch connection for debug logs |
| **Set preferences** | Default filters, display options |

---

## 6. Constraints & Requirements

### 6.1 Technical Constraints

- Agent communication uses AG-UI protocol (SSE streaming)
- LLM Judge runs via AWS Bedrock (backend proxy required)
- Data persisted to localStorage (no backend database)
- Must handle long-running evaluations (seconds to minutes)

### 6.2 UX Requirements

| Requirement | Rationale |
|-------------|-----------|
| Pass/fail must be immediately visible | Primary user question is "did it work?" |
| Progressive disclosure | Simple view first, details on demand |
| Live streaming during runs | Users need to know something is happening |
| Human-readable judge output | Non-technical users must understand failures |
| Non-destructive editing | Never lose test case history |

### 6.3 Performance Expectations

| Operation | Expected Duration |
|-----------|-------------------|
| Load test case list | < 1 second |
| Single evaluation | 10-60 seconds (agent + judge) |
| Experiment run (10 cases) | 2-10 minutes |

---

## 7. Out of Scope

- User authentication / multi-tenancy
- Backend database (uses localStorage)
- Real-time collaboration
- Scheduled/automated runs
- CI/CD integration
