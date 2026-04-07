# ML-Commons Agent Setup

This guide covers setting up the ML-Commons AG-UI agent for use with AgentEval.

## Architecture

```
AgentEval --> ML-Commons Agent (9200) --> MCP Server (3030) --> OpenSearch Data Cluster
                    |
              Bedrock LLM (Claude)
```

**Components:**
- **ML-Commons**: OpenSearch plugin providing AG-UI streaming agent
- **MCP Server**: Provides OpenSearch tools to the agent
- **Bedrock**: LLM backend for agent reasoning

## Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Java | 11+ | OpenSearch and ML-Commons |
| Python | 3.9+ | MCP server (`pip install uvx`) |
| AWS CLI | 2.x | Profile-based authentication |
| AWS Profile | - | Configured profile with Bedrock access |

---

## Option 1: Automated Setup

### Prerequisites
1. ML-Commons must be running on port 9200
2. `AWS_PROFILE` must be set (in `.env` or environment)

### Quick Start
```bash
# Set your AWS profile
export AWS_PROFILE=Bedrock

# Run setup
./scripts/setup.sh
```

### Script Options

| Command | Description |
|---------|-------------|
| `./scripts/setup.sh` | Register agent, update .env, start servers |
| `./scripts/setup.sh --stop` | Stop MCP server and AgentEval (not ML-Commons) |
| `./scripts/setup.sh --status` | Check which services are running |

### What the Script Does

1. Validates AWS profile and fetches credentials
2. Starts MCP server if not running (port 3030)
3. Registers Bedrock model with credentials from profile
4. Creates MCP connector pointing to localhost:3030
5. Registers AG-UI agent with the model and MCP connector
6. Tests agent execution to verify setup works
7. Updates `.env` with new agent endpoint
8. Starts AgentEval server (port 4001)

---

## Option 2: Manual Setup

### Step 1: Clone and Build OpenSearch Core

```bash
mkdir ~/agenteval-workspace && cd ~/agenteval-workspace

git clone https://github.com/opensearch-project/OpenSearch
cd OpenSearch

# Build streaming plugins
./gradlew :plugins:transport-reactor-netty4:assemble
./gradlew :plugins:arrow-flight-rpc:assemble

export OPENSEARCH_CORE_PATH=$(pwd)
```

### Step 2: Clone and Start ML-Commons

```bash
cd ~/agenteval-workspace

git clone https://github.com/jiapingzeng/ml-commons
cd ml-commons
git switch 3.4-jpz

# Start with streaming enabled (keep terminal running)
./gradlew run -Dstreaming=true
```

### Step 3: Start MCP Server

```bash
# Set credentials for the OpenSearch cluster the agent will query
OPENSEARCH_URL=https://your-opensearch-cluster.aos.us-west-2.on.aws \
OPENSEARCH_USERNAME=admin \
OPENSEARCH_PASSWORD=your_password \
uvx opensearch-mcp-server-py@0.5.2 --transport stream --port 3030
```

### Step 4: Configure ML-Commons Settings

```bash
curl -X PUT 'http://localhost:9200/_cluster/settings' \
  -H 'Content-Type: application/json' \
  -d '{
    "persistent": {
      "plugins.ml_commons.trusted_connector_endpoints_regex": [
        "http://localhost:3030",
        "^https://bedrock-runtime\\..*[a-z0-9-]\\.amazonaws\\.com/.*$"
      ],
      "plugins.ml_commons.stream_enabled": true,
      "plugins.ml_commons.mcp_connector_enabled": true,
      "plugins.ml_commons.ag_ui_enabled": true,
      "plugins.ml_commons.mcp_header_passthrough_enabled": true
    }
  }'
```

### Step 5: Register Bedrock Model

```bash
# Ensure your AWS credentials are configured (choose one method):
# Option 1: Use AWS CLI profile
export AWS_PROFILE=your-profile-name

# Option 2: Set credentials directly
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_SESSION_TOKEN=your_session_token  # if using temporary credentials

# Register model (save the model_id from response)
curl 'http://localhost:9200/_plugins/_ml/models/_register?deploy=true' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Claude Sonnet",
    "function_name": "remote",
    "connector": {
      "name": "Bedrock Converse Connector",
      "protocol": "aws_sigv4",
      "parameters": {
        "region": "us-east-1",
        "model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "service_name": "bedrock"
      },
      "credential": {
        "access_key": "YOUR_AWS_ACCESS_KEY_ID",
        "secret_key": "YOUR_AWS_SECRET_ACCESS_KEY",
        "session_token": "YOUR_AWS_SESSION_TOKEN"
      },
      "actions": [{
        "action_type": "predict",
        "method": "POST",
        "url": "https://bedrock-runtime.${parameters.region}.amazonaws.com/model/${parameters.model}/converse",
        "request_body": "{\"messages\": [${parameters._chat_history:-}{\"role\":\"user\",\"content\":[{\"text\":\"${parameters.prompt}\"}]}${parameters._interactions:-}]${parameters.tool_configs:-}}"
      }]
    }
  }'
```

### Step 6: Create MCP Connector

```bash
curl 'http://localhost:9200/_plugins/_ml/connectors/_create' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "OpenSearch MCP Server",
    "protocol": "mcp_streamable_http",
    "url": "http://localhost:3030",
    "parameters": { "endpoint": "/mcp/" }
  }'
```

### Step 7: Register AG-UI Agent

```bash
# Replace MODEL_ID and MCP_CONNECTOR_ID from previous steps
curl 'http://localhost:9200/_plugins/_ml/agents/_register' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "AG-UI chat agent",
    "type": "AG_UI",
    "llm": {
      "model_id": "MODEL_ID",
      "parameters": {
        "max_iteration": 50,
        "system_prompt": "You are a helpful assistant.",
        "prompt": "Context:${parameters.context}\nQuestion:${parameters.question}"
      }
    },
    "parameters": {
      "_llm_interface": "bedrock/converse/claude",
      "mcp_connectors": [{ "mcp_connector_id": "MCP_CONNECTOR_ID" }]
    },
    "tools": []
  }'
```

### Step 8: Configure AgentEval

Update `.env` with your agent ID:
```bash
MLCOMMONS_ENDPOINT=http://localhost:9200/_plugins/_ml/agents/{agent_id}/_execute/stream
```

---

## Environment Variables

These headers allow the ML-Commons agent to access the OpenSearch data cluster:

| Variable | Description |
|----------|-------------|
| `MLCOMMONS_ENDPOINT` | Agent streaming endpoint (includes agent_id) |
| `MLCOMMONS_HEADER_OPENSEARCH_URL` | Target OpenSearch cluster URL |
| `MLCOMMONS_HEADER_AWS_REGION` | AWS region for signing |
| `MLCOMMONS_HEADER_AWS_SERVICE_NAME` | Service name (`es` or `aoss`) |
| `MLCOMMONS_HEADER_AWS_ACCESS_KEY_ID` | AWS access key |
| `MLCOMMONS_HEADER_AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `MLCOMMONS_HEADER_AWS_SESSION_TOKEN` | AWS session token |

---

## Services Summary

| Service | Port | Command | Purpose |
|---------|------|---------|---------|
| ML-Commons | 9200 | `./gradlew run -Dstreaming=true` | AG-UI agent endpoint |
| MCP Server | 3030 | `uvx opensearch-mcp-server-py@0.5.2` | OpenSearch tools for agent |
| AgentEval | 4001 | `npm run server` | Evaluation UI and API |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Agent not responding | Check ML-Commons: `curl http://localhost:9200/_cat/health` |
| MCP server issues | Verify: `curl http://localhost:3030/health`, check MCP env vars |
| AWS profile invalid | Ensure profile exists: `aws sts get-caller-identity --profile $AWS_PROFILE` |
| Port conflicts | Use `./scripts/setup.sh --stop` to stop MCP and AgentEval services |

### Check Service Status
```bash
./scripts/setup.sh --status
```

### Stop All Services
```bash
./scripts/setup.sh --stop
```

---

## Related Documentation

- [AG-UI Protocol](https://docs.ag-ui.com/sdk/js/core/types#runagentinput)
