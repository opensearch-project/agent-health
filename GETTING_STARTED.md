/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

# Getting Started

This guide walks you through using Agent Health to evaluate AI agents. The application includes a Travel Planner multi-agent demo so you can explore all features without configuring external services.

## What You'll Learn

By the end of this guide, you will:
- ✓ Start Agent Health and explore the UI
- ✓ Understand test cases, experiments, and evaluation runs
- ✓ Run your first agent evaluation
- ✓ View trajectory steps and LLM judge scores
- ✓ Configure Agent Health for your own agent

---

## Prerequisites

**Required:**
- **Node.js 18+** - [Download here](https://nodejs.org/)
- **npm** (comes with Node.js)

**Optional (for production use):**
- AWS credentials (for Bedrock LLM Judge)
- OpenSearch cluster (for persistence and traces)

**Check your versions:**
```bash
node --version  # Should be v18.0.0 or higher
npm --version   # Should be v8.0.0 or higher
```

---

## Step 1: Install & Start

**Run Agent Health with npx** (no installation needed):

```bash
npx @opensearch-project/agent-health@latest
```

**What happens:**
1. Downloads Agent Health (if first run)
2. Starts the server on port 4001
3. Opens your browser to http://localhost:4001
4. Loads sample data automatically

For frequent use:

```bash
# Install globally
npm install -g @opensearch-project/agent-health

# Run from anywhere
agent-health
```

### Method 3: Clone Repository

For development or customization:

```bash
# Clone the repository
git clone https://github.com/opensearch-project/agent-health.git
cd agent-health

# Install dependencies
npm install

# Start development server
npm run server
```

---

## Demo Agent & Judge

Agent Health includes a built-in Travel Planner multi-agent demo, along with a Demo Judge, for testing without external services. Select these in the UI when running evaluations:

### Demo Agent (Travel Planner)
- Simulates a multi-agent Travel Planner system with realistic trajectories
- Agent types: Travel Coordinator, Weather Agent, Events Agent, Booking Agent, Budget Agent
- No external endpoint required
- Select "Demo Agent" in the agent dropdown

### Demo Judge
- Provides mock evaluation scores without AWS Bedrock
- Automatically selected when using Demo Agent
- No AWS credentials required

### Sample Data

The Travel Planner demo includes pre-loaded sample data (used when file-based storage is empty or on first startup):

| Data Type | Count | Description |
|-----------|-------|-------------|
| Test Cases | 5 | Travel Planner multi-agent scenarios |
| Experiments | 2 | Demo experiments with completed runs |
| Runs | 6 | Completed evaluation results across experiments |
| Traces | 5 | OpenTelemetry trace trees for visualization |

Sample data IDs start with `demo-` prefix and are read-only.

---

## Configuration Options

### CLI Options

```
agent-health [options]

Options:
  -V, --version          Output version number
  -p, --port <number>    Server port (default: "4001")
  -e, --env-file <path>  Load environment variables from file
  --no-browser           Do not open browser automatically
  -h, --help             Display help
```

### Configuration File

Settings are saved to `agent-health.config.json` in your working directory. This is the unified config file that consolidates all settings. Priority order: file config > environment variables > defaults.

On first startup, a default config file is created automatically. If you have an existing `agent-health.yaml`, it will be auto-migrated to `agent-health.config.json`.

By default, Agent Health uses **file-based storage** (no external services required). Data is stored locally in a `.agent-health-data/` directory.

### Environment File

You can still use a `.env` file for environment-specific overrides:

```bash
# Required for AWS Bedrock Judge (not needed for Demo Judge)
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret

# Optional: OpenSearch Storage (overrides default file-based storage)
OPENSEARCH_STORAGE_ENDPOINT=https://your-cluster.opensearch.amazonaws.com
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=your_password

# Optional: Traces (reuse the same cluster for simplicity)
OPENSEARCH_LOGS_ENDPOINT=https://your-traces-cluster.opensearch.amazonaws.com
OPENSEARCH_LOGS_TRACES_INDEX=otel-v1-apm-span-*

# Optional: Debug Logging (default: false)
DEBUG=false
```

Use this for custom env file path (defaults to root folder for .env file):
```bash
npx @opensearch-project/agent-health --env-file .env
```

---

## Exploring the UI

### 1. Dashboard Overview

The main dashboard displays:
- Active experiments and their status
- Recent evaluation runs
- Quick statistics on pass/fail rates

### 2. Use Cases (Test Cases)

Navigate to **Settings > Use Cases** to see sample Travel Planner scenarios:

| Use Case | Description | Agents Involved |
|----------|-------------|-----------------|
| Weekend City Break Planning | Plan a 3-day trip to a European city | Coordinator, Weather, Events, Booking |
| Family Vacation Budget Optimization | Optimize a family trip within budget constraints | Coordinator, Booking, Budget |
| Multi-City Business Trip | Coordinate flights and hotels across 3 cities | Coordinator, Booking, Weather |
| Adventure Travel Itinerary | Plan an outdoor adventure trip with weather dependencies | Coordinator, Weather, Events |
| Group Travel Coordination | Coordinate travel for a group of 8 with varied preferences | Coordinator, Events, Budget, Booking |

Each use case includes:
- **Initial Prompt** - The travel planning request
- **Context** - Supporting data (destinations, preferences, constraints)
- **Expected Outcomes** - What the agent system should produce

### 3. Experiments

Navigate to **Experiments** to see the demo experiments:

- **Travel Planner Agent Evaluation**
  - 5 test cases covering different travel scenarios
  - Multiple completed runs across agent configurations
  - Results with trajectories and judge scores

### 4. Run Results

Click any run to view:

#### Trajectory View
Step-by-step agent execution:
- **Thinking** - Agent's internal reasoning
- **Actions** - Tool invocations
- **Tool Results** - Tool responses
- **Response** - Final conclusions

#### LLM Judge Evaluation
- **Pass/Fail Status** - Did the agent meet expected outcomes?
- **Accuracy Score** - Performance metric (0-100%)
- **Reasoning** - Judge's detailed analysis
- **Improvement Strategies** - Suggestions for better performance

### 5. Live Traces

Navigate to **Traces** for real-time trace monitoring:

- **Live Tailing** - Auto-refresh traces every 10 seconds with pause/resume controls
- **Agent Filter** - Filter traces by specific agent
- **Text Search** - Search span names and attributes

#### View Modes

Toggle between visualization modes using the view selector:

| View | Best For | Description |
|------|----------|-------------|
| **Timeline** | Detailed timing analysis | Hierarchical span tree with duration bars |
| **Flow** | DAG visualization | Graph-based view of span relationships |

#### Full Screen Mode

Click the **Maximize** button on any trace visualization to open full-screen mode with:
- Larger visualization area
- Detailed span attributes panel
- Collapsible sections for complex traces

### 6. Trace Comparison

The comparison view supports side-by-side trace analysis:

- **Aligned view** - Spans from different runs aligned by similarity
- **Merged view** - Combined flow visualization showing all traces
- **Horizontal/Vertical orientation** - Toggle layout for your preference

---

## Screenshots Walkthrough

### Dashboard

The main dashboard provides an overview of your agent evaluation status:

![Dashboard](./screenshots/dashboard.png)

**Troubleshooting:**
- **Port already in use?** Run with custom port: `npx @opensearch-project/agent-health --port 8080`
- **Browser didn't open?** Manually visit: http://localhost:4001

---

## Step 2: Explore Demo Data

Agent Health comes with pre-loaded sample data so you can explore features immediately.

### View Sample Test Cases

1. Click **Settings** in the sidebar
2. Navigate to **Use Cases** tab
3. Browse the 5 sample test cases

**What's a test case?**
A test case (displayed as "Use Case" in UI) defines an evaluation scenario:
- **Initial Prompt** - The question asked to the agent
- **Context** - Supporting data (logs, metrics, architecture diagrams)
- **Expected Outcomes** - What the agent should discover or accomplish
- **Labels** - Categorization (e.g., `category:RCA`, `difficulty:Medium`)

**✓ Verify:** You should see test cases like "Payment Service Latency Spike" and "Database Connection Pool Exhaustion".

![Test Cases](./screenshots/test-cases.png)

### Explore a Completed Experiment

1. Click **Experiments** in the sidebar
2. Click **"RCA Agent Evaluation - Demo"**
3. View the completed baseline run

**What's an experiment?**
An experiment (displayed as "Benchmark" in code) is a batch of test cases evaluated together. It can have multiple runs with different agent/model configurations.

**✓ Verify:** You should see:
- Pass rate: 80% (4/5 passed)
- Average accuracy: 88%
- Individual results for each test case

![Experiment Detail](./screenshots/experiment-detail.png)

---

## Step 3: Run Your First Evaluation

Let's run a single test case evaluation using the demo agent.

### Option A: Run from UI

1. Click **Evals** in the sidebar
2. Click **"New Evaluation"** button
3. Configure the evaluation:
   - **Agent:** Select "Demo Agent"
   - **Model:** Select "Demo Model"
   - **Test Case:** Select "Payment Service Latency Spike"
4. Click **"Run Evaluation"**

**What happens:**
- Agent streams its execution in real-time
- You'll see thinking steps, tool calls, and responses
- LLM judge evaluates the trajectory against expected outcomes

**✓ Verify:** You should see:
- Real-time trajectory steps appearing
- Final agent response
- Judge evaluation with pass/fail status and accuracy score

### Option B: Run from CLI

```bash
# List available test cases
npx @opensearch-project/agent-health list test-cases

# Run a specific test case
npx @opensearch-project/agent-health run -t demo-otel-001 -a demo

# View the results in the UI
open http://localhost:4001/runs
```

**✓ Verify:** Terminal shows:
```
Running test case: demo-otel-001
Agent: demo
Status: completed
Result: PASSED
Accuracy: 92%
```

---

## Step 4: Understand Trajectory Steps

Click on any evaluation result to view the detailed trajectory.

**Trajectory step types:**

| Step Type | Description | Example |
|-----------|-------------|---------|
| **thinking** | Agent's internal reasoning | "I need to check the logs for errors..." |
| **action** | Tool invocation | `searchLogs({ query: "ERROR", timeRange: "1h" })` |
| **tool_result** | Tool response | `{ found: 142 errors, topError: "Connection timeout" }` |
| **response** | Final conclusion | "Root cause: Database connection pool exhausted during flash sale" |

**✓ Verify:** You can expand/collapse each step and see:
- Timestamp and duration
- Tool arguments (for actions)
- Full tool output (for tool_results)
- Judge's evaluation reasoning

![Trajectory View](./screenshots/experiment-detail-full.png)

---

## Step 5: Connect Your Agent

Now that you've explored demo data, let's connect your own agent.

### Create Configuration File

Run the init command to create a config file:

```bash
npx @opensearch-project/agent-health init
```

This creates `agent-health.config.ts` in your current directory.

### Configure Your Agent

Edit `agent-health.config.ts`:

```typescript
export default {
  agents: [
    {
      key: "my-agent",              // Unique identifier
      name: "My Agent",             // Display name in UI
      endpoint: "http://localhost:8000/agent",
      connectorType: "rest",        // "rest" | "agui-streaming" | "subprocess"
      models: ["claude-sonnet-4"],
      useTraces: false,             // Set true if agent sends OTel traces
    }
  ],
};
```

**Choose the right connector type:**

| Connector | Use When | Endpoint Example |
|-----------|----------|------------------|
| `rest` | Synchronous JSON API | `http://localhost:8000/api/agent` |
| `agui-streaming` | Server-Sent Events (SSE) | `http://localhost:9000/agent/stream` |
| `subprocess` | CLI tool | `/usr/local/bin/my-agent` |

**✓ Verify:** List agents to confirm configuration loaded:

```bash
npx @opensearch-project/agent-health list agents
```

You should see your agent in the list.

### Run Against Your Agent

```bash
# CLI
npx @opensearch-project/agent-health run -t your-test-case -a my-agent

# Or use the UI: Select "My Agent" from agent dropdown
```

**✓ Verify:** You should see your agent's actual responses in the trajectory.

---

## Step 6: Create Custom Test Cases

Now create test cases for your agent's domain.

### From UI

1. Go to **Settings > Use Cases**
2. Click **"New Use Case"**
3. Fill in the form:
   - **Name:** "My Test Scenario"
   - **Initial Prompt:** The question for your agent
   - **Context:** Supporting data your agent needs
   - **Expected Outcomes:** List what the agent should accomplish
   - **Labels:** Add tags like `category:MyCategory`, `difficulty:Medium`
4. Click **"Save"**

![Create Test Case](./screenshots/create-test-case.png)

**Tips for good test cases:**
- Make prompts specific and unambiguous
- Include all necessary context data
- Define clear, measurable expected outcomes
- Start with simple cases, add complexity gradually

**✓ Verify:** Your test case appears in the list and can be selected for evaluation runs.

---

## Step 7: View Traces (Optional)

If your agent emits OpenTelemetry traces, Agent Health can visualize them.

### Enable Trace Collection

1. Set `useTraces: true` in your agent config
2. Configure OpenSearch traces endpoint in `.env`:

```bash
OPENSEARCH_LOGS_ENDPOINT=https://your-cluster.opensearch.amazonaws.com
OPENSEARCH_LOGS_TRACES_INDEX=otel-v1-apm-span-*
OPENSEARCH_LOGS_USERNAME=admin
OPENSEARCH_LOGS_PASSWORD=your_password
```

### View Traces

1. Run an evaluation with your agent
2. Click **Traces** in the sidebar
3. Select your agent from the filter
4. Click on a trace to view details

**View modes:**
- **Timeline** - Hierarchical span tree with duration bars
- **Flow** - DAG visualization of span relationships

**✓ Verify:** You should see spans from your agent execution with timing data.

![Traces View](./screenshots/traces-view.mov)

---

## Next Steps

### Production Setup

**For real LLM judge evaluation** (instead of Demo Judge):

```bash
# .env file
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
```

**For persistence** (save test cases and experiments):

```bash
# .env file
OPENSEARCH_STORAGE_ENDPOINT=https://your-cluster.opensearch.amazonaws.com
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=your_password
```

See [CONFIGURATION.md](docs/CONFIGURATION.md) for full configuration reference.

### Run Benchmarks

Run your agent against multiple test cases:

```bash
npx @opensearch-project/agent-health benchmark -b my-benchmark -a my-agent
```

### Import Test Cases from JSON

You can import test cases from a JSON file and run a benchmark in a single command using the `-f` / `--file` flag:

```bash
# Import test cases from file and benchmark against an agent
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -a my-agent

# Optionally name the benchmark
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -n "My Benchmark" -a my-agent
```

The JSON file must be an array of test case objects:

```json
[
  {
    "name": "My Test Case",
    "category": "RCA",
    "difficulty": "Medium",
    "initialPrompt": "Investigate the latency spike...",
    "expectedOutcomes": ["Identifies database as root cause"],
    "context": [
      { "description": "Error logs", "value": "..." }
    ]
  }
]
```

This format is compatible with the output of the `export` command, so you can round-trip: export test cases from one benchmark, then import them into a new one:

```bash
# Export from existing benchmark
npx @opensearch-project/agent-health export -b my-benchmark -o test-cases.json

# Import into a new benchmark run
npx @opensearch-project/agent-health benchmark -f test-cases.json -a another-agent
```

### Compare Agents

Create experiments with multiple runs using different agents or models, then view side-by-side comparison in the UI.

### Integrate CI/CD

Add Agent Health to your CI pipeline:

```bash
# .github/workflows/test.yml
- name: Run Agent Evaluation
  run: |
    npx @opensearch-project/agent-health run -t critical-tests -a ${{ matrix.agent }}
```

---

## Troubleshooting

### Port Already in Use

```bash
npx @opensearch-project/agent-health --port 8080
```

### Agent Connection Failed

This is expected when OpenSearch is not configured. File-based storage is used by default, so test cases, experiments, and runs are persisted locally. Sample Travel Planner data is displayed on first startup.

- Verify your agent endpoint is correct and running
- Check network connectivity: `curl http://localhost:8000/agent`
- Enable debug logging: `DEBUG=true npx @opensearch-project/agent-health`

### Traces Not Appearing

- Traces take 2-5 minutes to propagate after execution
- Use the refresh button to re-fetch
- Verify `OPENSEARCH_LOGS_*` configuration in `.env`

### LLM Judge Timeouts

- Check AWS credentials: `aws sts get-caller-identity`
- Verify Bedrock model access in your AWS account
- Use Demo Judge for testing without AWS

### Need Help?

- Enable verbose logging: Settings > Verbose Logging toggle
- Check server logs in the terminal
- Review [CONFIGURATION.md](./docs/CONFIGURATION.md) for detailed setup
- Open an issue: https://github.com/opensearch-project/agent-health/issues

---

## Additional Resources

- [Configuration Guide](./docs/CONFIGURATION.md) - Detailed configuration options
- [CLI Reference](./docs/CLI.md) - All CLI commands and options
- [Connectors Guide](./docs/CONNECTORS.md) - Create custom connectors
- [Development Guide](./CLAUDE.md) - Contributing and architecture
