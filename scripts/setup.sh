#!/bin/bash

# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0

# AgentEval Setup Script
# Automates the complete setup of AgentEval environment with ML-Commons AG-UI agent
#
# Prerequisites:
#   - ML-Commons must be running on port 9200
#   - AWS_PROFILE must be set (in .env or environment) for Bedrock authentication
#
# Usage:
#   ./scripts/setup.sh           # Quick start: register agent, update .env, start servers
#   ./scripts/setup.sh --stop    # Stop all running services
#   ./scripts/setup.sh --status  # Check which services are running

set -e

# ============================================================================
# CONFIGURATION
# ============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values (can be overridden by environment variables)
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/agenteval-workspace}"
AWS_REGION="${AWS_REGION:-us-east-1}"
BEDROCK_MODEL="${BEDROCK_MODEL:-us.anthropic.claude-sonnet-4-20250514-v1:0}"
MCP_SERVER_PORT="${MCP_SERVER_PORT:-3030}"
MLCOMMONS_PORT=9200
SERVER_PORT="${SERVER_PORT:-4001}"  # Unified server port (serves both API and UI)

# Script directory (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Note: We use port-based cleanup instead of PID files for reliability

# ============================================================================
# LOAD ENVIRONMENT FILE
# ============================================================================

load_env_file() {
    if [ -f "$PROJECT_ROOT/.env" ]; then
        log_info "Loading configuration from .env file..."
        # Only export lines that are valid KEY=VALUE assignments (not comments or malformed lines)
        while IFS= read -r line || [ -n "$line" ]; do
            # Skip empty lines, comments, and lines without '='
            if [[ -n "$line" && ! "$line" =~ ^[[:space:]]*# && "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
                export "$line"
            fi
        done < "$PROJECT_ROOT/.env"
    fi
}

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "\n${GREEN}========================================${NC}"
    echo -e "${GREEN}STEP $1: $2${NC}"
    echo -e "${GREEN}========================================${NC}\n"
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is not installed"
        return 1
    fi
    return 0
}

wait_for_service() {
    local url=$1
    local max_attempts=${2:-60}
    local attempt=1

    log_info "Waiting for $url to be ready..."
    while [ $attempt -le $max_attempts ]; do
        if curl -s "$url" > /dev/null 2>&1; then
            log_success "$url is ready"
            return 0
        fi
        echo -n "."
        sleep 2
        attempt=$((attempt + 1))
    done
    echo ""
    log_error "Timeout waiting for $url"
    return 1
}


cleanup_ports() {
    log_info "Cleaning up existing processes on ports..."
    for port in $MCP_SERVER_PORT $SERVER_PORT; do
        local pid=$(lsof -ti:$port 2>/dev/null || true)
        if [ -n "$pid" ]; then
            log_info "Killing existing process on port $port (PID: $pid)..."
            kill $pid 2>/dev/null || true
            sleep 1
        fi
    done
}

cleanup_on_exit() {
    echo ""
    log_info "Shutting down AgentEval services (MCP + server)..."

    # Kill MCP server (port 3030) - only python/uvx processes
    for pid in $(lsof -ti:$MCP_SERVER_PORT 2>/dev/null || true); do
        local cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
        if [[ "$cmd" == *"python"* ]] || [[ "$cmd" == *"uvx"* ]] || [[ "$cmd" == *"uvicorn"* ]]; then
            log_info "Stopping MCP server (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
        fi
    done

    # Kill AgentEval server (port 4001) - only node processes
    for pid in $(lsof -ti:$SERVER_PORT 2>/dev/null || true); do
        local cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
        if [[ "$cmd" == *"node"* ]]; then
            log_info "Stopping AgentEval server (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
        fi
    done

    log_success "AgentEval services stopped"
}

# Only run cleanup on interrupt (Ctrl+C) or terminate signal, not on normal exit
trap cleanup_on_exit INT TERM

# ============================================================================
# COMMAND HANDLERS
# ============================================================================

show_status() {
    log_info "Checking service status..."

    echo -e "\n${BLUE}Service Status:${NC}"
    echo "----------------------------------------"

    # Check ML-Commons
    if curl -s "http://localhost:$MLCOMMONS_PORT" > /dev/null 2>&1; then
        echo -e "ML-Commons (port $MLCOMMONS_PORT):     ${GREEN}RUNNING${NC}"
    else
        echo -e "ML-Commons (port $MLCOMMONS_PORT):     ${RED}NOT RUNNING${NC}"
    fi

    # Check MCP Server
    if curl -s "http://localhost:$MCP_SERVER_PORT/health" > /dev/null 2>&1; then
        echo -e "MCP Server (port $MCP_SERVER_PORT):      ${GREEN}RUNNING${NC}"
    else
        echo -e "MCP Server (port $MCP_SERVER_PORT):      ${RED}NOT RUNNING${NC}"
    fi

    # Check Unified Server (Backend + Frontend)
    if curl -s "http://localhost:$SERVER_PORT/health" > /dev/null 2>&1; then
        echo -e "Unified Server (port $SERVER_PORT):    ${GREEN}RUNNING${NC}"
        echo -e "  UI available at: http://localhost:$SERVER_PORT"
    else
        echo -e "Unified Server (port $SERVER_PORT):    ${RED}NOT RUNNING${NC}"
    fi

    echo "----------------------------------------"
}

stop_services() {
    log_info "Stopping AgentEval services (not ML-Commons)..."

    for port in $MCP_SERVER_PORT $SERVER_PORT; do
        # Get PIDs and handle each one separately (lsof can return multiple)
        local pids=$(lsof -ti:$port 2>/dev/null || true)
        if [ -n "$pids" ]; then
            for pid in $pids; do
                log_info "Stopping process on port $port (PID: $pid)..."
                kill "$pid" 2>/dev/null || true
            done
        fi
    done

    log_success "AgentEval services stopped (ML-Commons still running)"
}

# ============================================================================
# PREREQUISITES CHECK
# ============================================================================

check_prerequisites() {
    log_step "1" "Checking Prerequisites"

    local all_ok=true

    # Check Java
    if check_command java; then
        local java_version=$(java -version 2>&1 | head -1 | cut -d'"' -f2 | cut -d'.' -f1)
        if [ "$java_version" -ge 11 ] 2>/dev/null; then
            log_success "Java $java_version found"
        else
            log_error "Java 11+ required, found version $java_version"
            all_ok=false
        fi
    else
        all_ok=false
    fi

    # Check Node.js
    if check_command node; then
        local node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$node_version" -ge 18 ] 2>/dev/null; then
            log_success "Node.js v$node_version found"
        else
            log_error "Node.js 18+ required, found v$node_version"
            all_ok=false
        fi
    else
        all_ok=false
    fi

    # Check Python/uvx
    if check_command uvx; then
        log_success "uvx found"
    else
        log_warn "uvx not found - install with: pip install uvx"
        all_ok=false
    fi

    # Check git
    if check_command git; then
        log_success "git found"
    else
        all_ok=false
    fi

    # Check curl
    if check_command curl; then
        log_success "curl found"
    else
        all_ok=false
    fi

    # Check AWS CLI (required for profile-based authentication)
    if check_command aws; then
        log_success "AWS CLI found"
    else
        log_error "AWS CLI not found - required for profile-based authentication"
        all_ok=false
    fi

    if [ "$all_ok" = false ]; then
        log_error "Prerequisites check failed. Please install missing dependencies."
        exit 1
    fi

    log_success "All prerequisites satisfied"
}


# ============================================================================
# START MCP SERVER
# ============================================================================

start_mcp_server() {
    log_step "2" "Starting MCP Server"

    # Load MCP config from .env if available
    if [ -f "$PROJECT_ROOT/.env" ]; then
        export MCP_OPENSEARCH_URL=$(grep "^MCP_OPENSEARCH_URL=" "$PROJECT_ROOT/.env" | cut -d'=' -f2-)
        export MCP_OPENSEARCH_USERNAME=$(grep "^MCP_OPENSEARCH_USERNAME=" "$PROJECT_ROOT/.env" | cut -d'=' -f2-)
        export MCP_OPENSEARCH_PASSWORD=$(grep "^MCP_OPENSEARCH_PASSWORD=" "$PROJECT_ROOT/.env" | cut -d'=' -f2-)
    fi

    log_info "Starting OpenSearch MCP Server on port $MCP_SERVER_PORT..."
    log_info "Connecting to OpenSearch: $MCP_OPENSEARCH_URL"
    OPENSEARCH_URL="$MCP_OPENSEARCH_URL" \
    OPENSEARCH_USERNAME="$MCP_OPENSEARCH_USERNAME" \
    OPENSEARCH_PASSWORD="$MCP_OPENSEARCH_PASSWORD" \
    uvx opensearch-mcp-server-py@0.5.2 --transport stream --port $MCP_SERVER_PORT &
    local mcp_pid=$!

    sleep 3
    log_success "MCP Server started (PID: $mcp_pid)"
}

# ============================================================================
# AWS PROFILE CREDENTIAL HANDLING
# ============================================================================

fetch_credentials_from_profile() {
    log_info "Fetching credentials from AWS profile '$AWS_PROFILE'..."

    # Validate AWS_PROFILE is set
    if [ -z "$AWS_PROFILE" ]; then
        log_error "AWS_PROFILE not set. Set it in .env file or environment."
        log_info "Example: AWS_PROFILE=Bedrock"
        exit 1
    fi

    # Verify the profile works by calling STS
    if ! aws sts get-caller-identity --profile "$AWS_PROFILE" > /dev/null 2>&1; then
        log_error "AWS profile '$AWS_PROFILE' is not valid or credentials expired"
        log_info "Ensure your profile is configured in ~/.aws/credentials or ~/.aws/config"
        exit 1
    fi

    log_success "AWS profile '$AWS_PROFILE' is valid"

    # Export credentials from the configured profile for connector registration
    eval $(aws configure export-credentials --profile "$AWS_PROFILE" --format env 2>/dev/null)

    if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
        log_error "Failed to export credentials from profile '$AWS_PROFILE'"
        exit 1
    fi

    log_success "Credentials exported from profile '$AWS_PROFILE'"
}

# ============================================================================
# CONFIGURE ML-COMMONS (5 API Calls)
# ============================================================================

configure_mlcommons() {
    log_step "3" "Configuring ML-Commons (5 API calls)"

    local endpoint="http://localhost:$MLCOMMONS_PORT"

    # -------------------------------------------------------------------------
    # API 1: Enable streaming
    # -------------------------------------------------------------------------
    log_info "API 1: Enabling streaming settings..."

    curl -s -X PUT "$endpoint/_cluster/settings" \
        -H "Content-Type: application/json" \
        -d '{
            "persistent": {
                "plugins.ml_commons.trusted_connector_endpoints_regex": [
                    "http://localhost:3030",
                    "^https://bedrock-runtime\\..*[a-z0-9-]\\.amazonaws\\.com/.*$"
                ],
                "plugins.ml_commons.stream_enabled": true,
                "plugins.ml_commons.mcp_connector_enabled": true,
                "plugins.ml_commons.ag_ui_enabled": true,
                "plugins.ml_commons.mcp_header_passthrough_enabled": true,
                "logger.org.opensearch.ml": "DEBUG"
            }
        }' > /dev/null

    log_success "Streaming settings enabled"

    # -------------------------------------------------------------------------
    # Fetch AWS Credentials from profile (before model registration)
    # -------------------------------------------------------------------------
    fetch_credentials_from_profile

    # -------------------------------------------------------------------------
    # API 2: Register Bedrock model
    # -------------------------------------------------------------------------
    log_info "API 2: Registering Bedrock model ($BEDROCK_MODEL)..."

    local model_response=$(curl -s -X POST "$endpoint/_plugins/_ml/models/_register?deploy=true" \
        -H "Content-Type: application/json" \
        -d '{
            "name": "Claude Sonnet",
            "function_name": "remote",
            "description": "Claude Sonnet via Bedrock",
            "connector": {
                "name": "Bedrock Converse Connector",
                "description": "Bedrock Converse Connector",
                "version": 1,
                "protocol": "aws_sigv4",
                "parameters": {
                    "region": "'"$AWS_REGION"'",
                    "model": "'"$BEDROCK_MODEL"'",
                    "service_name": "bedrock"
                },
                "credential": {
                    "access_key": "'"$AWS_ACCESS_KEY_ID"'",
                    "secret_key": "'"$AWS_SECRET_ACCESS_KEY"'",
                    "session_token": "'"$AWS_SESSION_TOKEN"'"
                },
                "actions": [
                    {
                        "action_type": "predict",
                        "method": "POST",
                        "url": "https://bedrock-runtime.${parameters.region}.amazonaws.com/model/${parameters.model}/converse",
                        "request_body": "{\"messages\": [${parameters._chat_history:-}{\"role\":\"user\",\"content\":[{\"text\":\"${parameters.prompt}\"}]}${parameters._interactions:-}]${parameters.tool_configs:-}}"
                    }
                ]
            }
        }')

    MODEL_ID=$(echo "$model_response" | grep -o '"model_id":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$MODEL_ID" ]; then
        log_error "Failed to register model. Response: $model_response"
        exit 1
    fi

    log_success "Model registered: $MODEL_ID"

    # -------------------------------------------------------------------------
    # API 3: Create MCP connector
    # -------------------------------------------------------------------------
    log_info "API 3: Creating MCP connector..."

    local connector_response=$(curl -s -X POST "$endpoint/_plugins/_ml/connectors/_create" \
        -H "Content-Type: application/json" \
        -d '{
            "name": "OpenSearch MCP Server",
            "description": "OpenSearch MCP Server",
            "version": 1,
            "protocol": "mcp_streamable_http",
            "url": "http://localhost:'"$MCP_SERVER_PORT"'",
            "parameters": {
                "endpoint": "/mcp/"
            }
        }')

    MCP_CONNECTOR_ID=$(echo "$connector_response" | grep -o '"connector_id":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$MCP_CONNECTOR_ID" ]; then
        log_error "Failed to create MCP connector. Response: $connector_response"
        exit 1
    fi

    log_success "MCP Connector created: $MCP_CONNECTOR_ID"

    # -------------------------------------------------------------------------
    # API 4: Register AG-UI agent
    # -------------------------------------------------------------------------
    log_info "API 4: Registering AG-UI agent..."

    local agent_response=$(curl -s -X POST "$endpoint/_plugins/_ml/agents/_register" \
        -H "Content-Type: application/json" \
        -d '{
            "name": "AG-UI chat agent",
            "type": "AG_UI",
            "description": "AgentEval AG-UI agent",
            "llm": {
                "model_id": "'"$MODEL_ID"'",
                "parameters": {
                    "max_iteration": 50,
                    "system_prompt": "You are a helpful assistant.",
                    "prompt": "Context:${parameters.context}\nQuestion:${parameters.question}"
                }
            },
            "parameters": {
                "_llm_interface": "bedrock/converse/claude",
                "mcp_connectors": [
                    {
                        "mcp_connector_id": "'"$MCP_CONNECTOR_ID"'"
                    }
                ]
            },
            "tools": []
        }')

    AGENT_ID=$(echo "$agent_response" | grep -o '"agent_id":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$AGENT_ID" ]; then
        log_error "Failed to register agent. Response: $agent_response"
        exit 1
    fi

    log_success "Agent registered: $AGENT_ID"

    # -------------------------------------------------------------------------
    # API 5: Test execute agent (MANDATORY verification)
    # -------------------------------------------------------------------------
    log_info "API 5: Testing agent execution..."

    local test_response=$(curl -s -X POST "$endpoint/_plugins/_ml/agents/$AGENT_ID/_execute/stream" \
        -H "Content-Type: application/json" \
        -d '{
            "threadId": "test-thread-setup",
            "runId": "test-run-setup",
            "messages": [
                {
                    "id": "test-msg-setup",
                    "role": "user",
                    "content": "hello"
                }
            ],
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {}
        }')

    if echo "$test_response" | grep -q "RUN_STARTED"; then
        log_success "Agent test successful - RUN_STARTED event received"
    else
        log_warn "Agent test response may not contain expected events"
        log_info "Response preview: ${test_response:0:200}..."
    fi

    # Export for .env update
    export AGENT_ID
    export MODEL_ID
    export MCP_CONNECTOR_ID
}

# ============================================================================
# UPDATE .ENV FILE
# ============================================================================

update_env_file() {
    log_step "4" "Updating .env file"

    cd "$PROJECT_ROOT"

    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            log_info "Creating .env from .env.example..."
            cp .env.example .env
        else
            log_error ".env file not found and no .env.example available"
            exit 1
        fi
    fi

    # Backup existing .env
    local backup_file=".env.backup.$(date +%Y%m%d_%H%M%S)"
    cp .env "$backup_file"
    log_info "Backed up .env to $backup_file"

    # Update MLCOMMONS_ENDPOINT
    if grep -q "^MLCOMMONS_ENDPOINT=" .env; then
        sed -i '' "s|^MLCOMMONS_ENDPOINT=.*|MLCOMMONS_ENDPOINT=http://localhost:$MLCOMMONS_PORT/_plugins/_ml/agents/$AGENT_ID/_execute/stream|" .env
    else
        echo "MLCOMMONS_ENDPOINT=http://localhost:$MLCOMMONS_PORT/_plugins/_ml/agents/$AGENT_ID/_execute/stream" >> .env
    fi

    # Update AWS_REGION
    if grep -q "^AWS_REGION=" .env; then
        sed -i '' "s|^AWS_REGION=.*|AWS_REGION=$AWS_REGION|" .env
    else
        echo "AWS_REGION=$AWS_REGION" >> .env
    fi

    # Ensure AWS_PROFILE is set
    if ! grep -q "^AWS_PROFILE=" .env; then
        echo "AWS_PROFILE=$AWS_PROFILE" >> .env
    fi

    # Export the new MLCOMMONS_ENDPOINT to environment so child processes get the updated value
    export MLCOMMONS_ENDPOINT="http://localhost:$MLCOMMONS_PORT/_plugins/_ml/agents/$AGENT_ID/_execute/stream"
    log_info "Exported MLCOMMONS_ENDPOINT with new agent ID: $AGENT_ID"

    # Add setup comment at top of file
    local temp_file=$(mktemp)
    echo "# Auto-configured by setup.sh on $(date)" > "$temp_file"
    echo "# Agent ID: $AGENT_ID" >> "$temp_file"
    echo "# Model ID: $MODEL_ID" >> "$temp_file"
    echo "" >> "$temp_file"
    cat .env >> "$temp_file"
    mv "$temp_file" .env

    log_success ".env file updated with agent configuration"
}


# ============================================================================
# START AGENTEVAL SERVICES
# ============================================================================

start_agenteval_services() {
    log_step "5" "Starting AgentEval Services"

    cd "$PROJECT_ROOT"

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        log_info "Installing dependencies..."
        npm install
    fi

    # Create logs directory
    mkdir -p "$PROJECT_ROOT/logs"

    log_info "Building UI and starting unified server on port $SERVER_PORT..."
    log_info "Server logs will appear below. Press Ctrl+C to stop."
    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  Open http://localhost:$SERVER_PORT in browser${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""

    # Export port for the server to use
    export VITE_BACKEND_PORT="$SERVER_PORT"

    # Start unified server (builds UI + serves everything from one port)
    # Runs in FOREGROUND so logs are visible
    npm run server
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    echo -e "\n${GREEN}================================================${NC}"
    echo -e "${GREEN}      AgentEval Setup Script${NC}"
    echo -e "${GREEN}================================================${NC}\n"

    # Load .env file to get AWS_BEDROCK_ACCOUNT and other config
    load_env_file

    # Handle command line arguments
    case "${1:-}" in
        --stop)
            stop_services
            exit 0
            ;;
        --status)
            show_status
            exit 0
            ;;
        "")
            # Default: Quick start mode
            # Assumes ML-Commons is already running
            log_info "Quick start mode (assumes ML-Commons already running)..."
            echo ""

            cleanup_ports

            # Check if ML-Commons is running
            if ! curl -s "http://localhost:$MLCOMMONS_PORT" > /dev/null 2>&1; then
                log_error "ML-Commons not running on port $MLCOMMONS_PORT"
                log_info "Start ML-Commons first, then run this script"
                exit 1
            fi
            log_success "ML-Commons is running"

            # Check if MCP Server is running
            if ! curl -s "http://localhost:$MCP_SERVER_PORT/mcp/" > /dev/null 2>&1; then
                log_warn "MCP Server not detected on port $MCP_SERVER_PORT - starting it..."
                start_mcp_server
            else
                log_success "MCP Server is running"
            fi

            # Core quick start flow
            configure_mlcommons
            update_env_file
            start_agenteval_services
            ;;
        *)
            echo "Usage: $0 [--stop|--status]"
            echo ""
            echo "Commands:"
            echo "  (default)          Quick start: register agent, update .env, start servers"
            echo "  --stop             Stop all running services"
            echo "  --status           Check which services are running"
            exit 1
            ;;
    esac
    # Note: Summary is printed before frontend starts (in start_agenteval_services)
    # since frontend runs in foreground for live logs
}

main "$@"
