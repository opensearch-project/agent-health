#!/usr/bin/env bash
# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Agent Health — One-line installer for the Docker observability stack.
# Usage: curl -fsSL https://raw.githubusercontent.com/opensearch-project/agent-health/main/scripts/install.sh | bash

set -euo pipefail

REPO_URL="https://github.com/opensearch-project/agent-health.git"
REPO_DIR="agent-health"
# Default password matches docker-compose.yml — change for non-local use
OPENSEARCH_PASSWORD="My_password_123!@#"

# --- Helpers ---
info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- Port check helper (works without lsof) ---
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -i ":${port}" >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q LISTEN
  else
    # Fallback: try connecting with bash /dev/tcp
    (echo >/dev/tcp/localhost/"${port}") 2>/dev/null
  fi
}

# --- Prerequisite checks ---
info "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop"
docker info >/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker Desktop and try again."
command -v npx >/dev/null 2>&1 || fail "Node.js / npx is not installed. Install Node.js 18+ from https://nodejs.org"
command -v git >/dev/null 2>&1 || fail "git is not installed. Install git from https://git-scm.com"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 18+ from https://nodejs.org"

# Check if ports are available
for port in 9200 4317 4318; do
  if port_in_use "${port}"; then
    fail "Port ${port} is already in use. Stop the process using it and try again."
  fi
done

ok "Prerequisites satisfied"

# --- Clone or locate repo ---
if [ -f "docker-compose.yml" ] && grep -q "agent-health-network" docker-compose.yml 2>/dev/null; then
  info "Using existing agent-health directory"
  PROJECT_DIR="$(pwd)"
elif [ -d "${REPO_DIR}" ] && [ -f "${REPO_DIR}/docker-compose.yml" ]; then
  info "Found existing ${REPO_DIR}/ directory"
  PROJECT_DIR="$(cd "${REPO_DIR}" && pwd)"
else
  info "Cloning agent-health repository..."
  git clone --depth 1 "${REPO_URL}" "${REPO_DIR}"
  PROJECT_DIR="$(cd "${REPO_DIR}" && pwd)"
fi

cd "${PROJECT_DIR}"

# --- Start Docker stack ---
info "Starting OpenSearch observability stack..."
docker compose up -d

# --- Wait for OpenSearch ---
info "Waiting for OpenSearch to be ready (this may take up to 2 minutes)..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -s -k -u "admin:${OPENSEARCH_PASSWORD}" https://localhost:9200/_cluster/health 2>/dev/null | grep -qE '"status":"(green|yellow)"'; then
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  printf '.'
done
echo

if [ $ELAPSED -ge $MAX_WAIT ]; then
  warn "OpenSearch is still starting. It may need more time."
  warn "Check status with: docker compose ps"
  warn "You can continue once OpenSearch is healthy."
else
  ok "OpenSearch is ready"
fi

# --- Write agent-health.config.json ---
CONFIG_FILE="${PROJECT_DIR}/agent-health.config.json"
info "Writing observability config to agent-health.config.json..."

OBSERVABILITY_JSON=$(cat <<JSONEOF
{
  "endpoint": "https://localhost:9200",
  "username": "admin",
  "password": "${OPENSEARCH_PASSWORD}",
  "tlsSkipVerify": true
}
JSONEOF
)

if [ -f "${CONFIG_FILE}" ]; then
  # Use Node.js for safe JSON merge
  if node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('${CONFIG_FILE}', 'utf8'));
    if (config.observability) {
      process.stdout.write('EXISTS');
    } else {
      config.observability = ${OBSERVABILITY_JSON};
      fs.writeFileSync('${CONFIG_FILE}', JSON.stringify(config, null, 2) + '\n');
      process.stdout.write('MERGED');
    }
  " 2>/dev/null | grep -q "EXISTS"; then
    warn "agent-health.config.json already has an observability section — skipping config write"
  else
    ok "Updated existing agent-health.config.json with observability config"
  fi
else
  node -e "
    const fs = require('fs');
    const config = { observability: ${OBSERVABILITY_JSON} };
    fs.writeFileSync('${CONFIG_FILE}', JSON.stringify(config, null, 2) + '\n');
  "
  ok "Created agent-health.config.json with observability config"
fi

# --- Copy .env.docker for any remaining env-based config ---
if [ -f ".env.docker" ] && [ ! -f ".env" ]; then
  cp .env.docker .env
  ok "Copied .env.docker → .env"
elif [ -f ".env" ]; then
  info ".env already exists — skipping copy"
fi

# --- Start Agent Health ---
echo
ok "Observability stack is running!"
echo
info "Services:"
echo "  OpenSearch:         https://localhost:9200"
echo "  OTel Collector:     http://localhost:4317 (gRPC) / http://localhost:4318 (HTTP)"
echo "  Data Prepper:       http://localhost:21890"
echo
info "Starting Agent Health..."
echo
npx @opensearch-project/agent-health
