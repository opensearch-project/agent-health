#!/usr/bin/env bash
#
# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Cross-surface parity probe — run a single tiny demo evaluation through each
# of the three surfaces (HTTP API, CLI, UI-equivalent /api/evaluate) and print
# a pass/fail table for the four customer-feedback parity properties:
#
#   1. Persisted TestCaseRun has run-level evaluatorId set.
#   2. (Implicit) Run-details UI can resolve evaluator + rubric (depends on 1).
#   3. An in-progress `status: running` row is visible in the runs list
#      AFTER the SSE `started`/`progress` events but BEFORE `completed`.
#   4. Test cases with NO expectedOutcomes / expectedTrajectory are accepted
#      by the storage API.
#
# Usage:
#   bash scripts/cross-surface-parity-probe.sh
#   AGENT_HEALTH_PORT=4001 bash scripts/cross-surface-parity-probe.sh
#
# Requires: bash, curl, jq, an `agent-health` server on AGENT_HEALTH_PORT
# (default 4001) with the `demo` agent and `system-tool-usage` evaluator.
#
# All test fixtures (test cases, runs, eval-runs) are deleted at the end —
# but ONLY by id, never by wildcard. If the script is interrupted, fixtures
# may persist; their IDs are printed up front so a human can clean up.

set -euo pipefail

PORT="${AGENT_HEALTH_PORT:-4001}"
BASE="http://localhost:${PORT}"
EVAL_ID="system-tool-usage"

# All IDs we create — printed up front for manual cleanup if the script
# dies before its trap runs.
HTTP_TC_ID=""
HTTP_REPORT_ID=""
HTTP_EVAL_RUN_ID=""
CLI_TC_ID=""
CLI_REPORT_ID=""
CLI_EVAL_RUN_ID=""
UI_TC_ID=""
UI_REPORT_ID=""

cleanup() {
  echo ""
  echo "=== cleanup ==="
  for id in "$HTTP_REPORT_ID" "$CLI_REPORT_ID" "$UI_REPORT_ID"; do
    [ -n "$id" ] && curl -s -X DELETE "$BASE/api/storage/runs/$id" -o /dev/null -w "  del run $id: %{http_code}\n" || true
  done
  for id in "$HTTP_EVAL_RUN_ID" "$CLI_EVAL_RUN_ID"; do
    [ -n "$id" ] && curl -s -X DELETE "$BASE/api/storage/evaluation-runs/$id" -o /dev/null -w "  del eval-run $id: %{http_code}\n" || true
  done
  for id in "$HTTP_TC_ID" "$CLI_TC_ID" "$UI_TC_ID"; do
    [ -n "$id" ] && curl -s -X DELETE "$BASE/api/storage/test-cases/$id" -o /dev/null -w "  del tc $id: %{http_code}\n" || true
  done
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

# create_tc_no_outcomes <name> → echoes the new test case id
# Property #4: must work without expectedOutcomes / expectedTrajectory.
create_tc_no_outcomes() {
  local name="$1"
  curl -s -X POST "$BASE/api/storage/test-cases" \
    -H 'Content-Type: application/json' \
    -d "{
      \"name\":\"$name\",
      \"description\":\"cross-surface parity probe — no expectedOutcomes/expectedTrajectory\",
      \"category\":\"Smoke\",
      \"difficulty\":\"Easy\",
      \"initialPrompt\":\"Say hello.\",
      \"context\":[]
    }" | jq -r '.id // empty'
}

# probe_running <testCaseId> <ssePidFile> → sets `SAW_RUNNING` to "yes"/"no"
# and `RUNNING_EVAL_ID` to whatever evaluatorId the running row carried.
# Polls for up to 10 seconds or until the SSE log shows completion.
probe_running() {
  local tc="$1"
  local sse_log="$2"
  SAW_RUNNING="no"
  RUNNING_EVAL_ID=""
  for i in $(seq 1 100); do
    if grep -q -E '("type":"completed"|^event: completed)' "$sse_log" 2>/dev/null; then
      break
    fi
    local row
    row=$(curl -s "$BASE/api/storage/runs/by-test-case/$(printf '%s' "$tc" | jq -sRr @uri)?size=10" 2>/dev/null \
      | jq -r '.runs // .items // [] | map(select(.status=="running")) | .[0] // empty | "\(.id // "")\u0001\(.evaluatorId // "")"')
    if [ -n "$row" ] && [ "$row" != $'\x01' ]; then
      SAW_RUNNING="yes"
      RUNNING_EVAL_ID="${row#*$'\x01'}"
      break
    fi
    sleep 0.1
  done
}

# verdict <name> <expected> <actual> → prints a row + tracks failures
declare -i FAILS=0
verdict() {
  local label="$1" expected="$2" actual="$3"
  local mark
  if [ "$expected" = "$actual" ]; then mark="✓"
  else mark="✗"; FAILS=$((FAILS+1))
  fi
  printf "  %s  %-58s  expected=%-20s  actual=%s\n" "$mark" "$label" "$expected" "$actual"
}

# ─────────────────────────────────────────────────────────────────────────────
# Surface 1: HTTP API
#   POST /api/storage/evaluation-runs (the path CLI uses internally too)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Surface 1: HTTP API  —  POST /api/storage/evaluation-runs"
echo "============================================================"

HTTP_TC_ID=$(create_tc_no_outcomes "parity-http-$(date +%s)")
echo "  test-case:       $HTTP_TC_ID  (no expectedOutcomes/expectedTrajectory)"

SSE_LOG="$(mktemp)"
(
  curl -sN -X POST "$BASE/api/storage/evaluation-runs" \
    -H 'Content-Type: application/json' \
    -d "{
      \"name\":\"parity-http\",
      \"sources\":[{\"type\":\"test-case-ids\",\"ids\":[\"$HTTP_TC_ID\"]}],
      \"agentKey\":\"demo\",
      \"modelId\":\"demo-model\",
      \"evaluatorId\":\"$EVAL_ID\",
      \"trigger\":\"parity-probe\"
    }" > "$SSE_LOG" 2>&1
) &
SSE_PID=$!

probe_running "$HTTP_TC_ID" "$SSE_LOG"
wait $SSE_PID 2>/dev/null

HTTP_EVAL_RUN_ID=$(grep -oE '"runId":"[^"]+' "$SSE_LOG" | head -1 | sed 's/"runId":"//')
HTTP_REPORT_ID=$(grep -oE '"reportId":"[^"]+' "$SSE_LOG" | head -1 | sed 's/"reportId":"//')
FINAL=$(curl -s "$BASE/api/storage/runs/$HTTP_REPORT_ID")
FINAL_EVAL=$(echo "$FINAL" | jq -r '.evaluatorId // "null"')

echo "  eval-run:        $HTTP_EVAL_RUN_ID"
echo "  report:          $HTTP_REPORT_ID"
echo ""
verdict "[issue 4] tc accepted without expectedOutcomes"      "yes"           "${HTTP_TC_ID:+yes}"
verdict "[issue 3] in-progress 'running' row was visible"     "yes"           "$SAW_RUNNING"
verdict "[issue 1+2] running placeholder carried evaluatorId" "$EVAL_ID"      "$RUNNING_EVAL_ID"
verdict "[issue 1+2] final report carries evaluatorId"        "$EVAL_ID"      "$FINAL_EVAL"
rm -f "$SSE_LOG"

# ─────────────────────────────────────────────────────────────────────────────
# Surface 2: CLI
#   `npx agent-health benchmark` — internally posts the same SSE endpoint
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Surface 2: CLI                                           "
echo "============================================================"

CLI_TC_ID=$(create_tc_no_outcomes "parity-cli-$(date +%s)")
echo "  test-case:       $CLI_TC_ID  (no expectedOutcomes/expectedTrajectory)"

# We exercise the same code path the CLI uses (POST /api/storage/evaluation-runs
# with `trigger: "cli"`). The CLI binary itself wraps this same fetch — see
# cli/commands/benchmark.ts. Doing the curl here keeps the probe hermetic;
# the actual CLI command is documented at the bottom of this file.
SSE_LOG="$(mktemp)"
(
  curl -sN -X POST "$BASE/api/storage/evaluation-runs" \
    -H 'Content-Type: application/json' \
    -d "{
      \"name\":\"CLI Run - demo - parity-cli\",
      \"sources\":[{\"type\":\"test-case-ids\",\"ids\":[\"$CLI_TC_ID\"]}],
      \"agentKey\":\"demo\",
      \"modelId\":\"demo-model\",
      \"evaluatorId\":\"$EVAL_ID\",
      \"trigger\":\"cli\"
    }" > "$SSE_LOG" 2>&1
) &
SSE_PID=$!

probe_running "$CLI_TC_ID" "$SSE_LOG"
wait $SSE_PID 2>/dev/null

CLI_EVAL_RUN_ID=$(grep -oE '"runId":"[^"]+' "$SSE_LOG" | head -1 | sed 's/"runId":"//')
CLI_REPORT_ID=$(grep -oE '"reportId":"[^"]+' "$SSE_LOG" | head -1 | sed 's/"reportId":"//')
FINAL=$(curl -s "$BASE/api/storage/runs/$CLI_REPORT_ID")
FINAL_EVAL=$(echo "$FINAL" | jq -r '.evaluatorId // "null"')

echo "  eval-run:        $CLI_EVAL_RUN_ID"
echo "  report:          $CLI_REPORT_ID"
echo ""
verdict "[issue 4] tc accepted without expectedOutcomes"      "yes"           "${CLI_TC_ID:+yes}"
verdict "[issue 3] in-progress 'running' row was visible"     "yes"           "$SAW_RUNNING"
verdict "[issue 1+2] running placeholder carried evaluatorId" "$EVAL_ID"      "$RUNNING_EVAL_ID"
verdict "[issue 1+2] final report carries evaluatorId"        "$EVAL_ID"      "$FINAL_EVAL"
rm -f "$SSE_LOG"

# ─────────────────────────────────────────────────────────────────────────────
# Surface 3: UI (the path QuickRunModal hits internally)
#   POST /api/evaluate  —  pre-persists a placeholder; this fix brought
#   /api/storage/evaluation-runs into parity with this baseline.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Surface 3: UI baseline  —  POST /api/evaluate            "
echo "============================================================"

UI_TC_ID=$(create_tc_no_outcomes "parity-ui-$(date +%s)")
echo "  test-case:       $UI_TC_ID  (no expectedOutcomes/expectedTrajectory)"

SSE_LOG="$(mktemp)"
(
  curl -sN -X POST "$BASE/api/evaluate" \
    -H 'Content-Type: application/json' \
    -d "{
      \"testCaseId\":\"$UI_TC_ID\",
      \"agentKey\":\"demo\",
      \"modelId\":\"demo-model\",
      \"evaluatorId\":\"$EVAL_ID\",
      \"runName\":\"parity-ui\"
    }" > "$SSE_LOG" 2>&1
) &
SSE_PID=$!

probe_running "$UI_TC_ID" "$SSE_LOG"
wait $SSE_PID 2>/dev/null

UI_REPORT_ID=$(grep -oE '"reportId":"[^"]+' "$SSE_LOG" | head -1 | sed 's/"reportId":"//')
FINAL=$(curl -s "$BASE/api/storage/runs/$UI_REPORT_ID")
FINAL_EVAL=$(echo "$FINAL" | jq -r '.evaluatorId // "null"')

echo "  report:          $UI_REPORT_ID"
echo ""
verdict "[issue 4] tc accepted without expectedOutcomes"      "yes"           "${UI_TC_ID:+yes}"
verdict "[issue 3] in-progress 'running' row was visible"     "yes"           "$SAW_RUNNING"
verdict "[issue 1+2] running placeholder carried evaluatorId" "$EVAL_ID"      "$RUNNING_EVAL_ID"
verdict "[issue 1+2] final report carries evaluatorId"        "$EVAL_ID"      "$FINAL_EVAL"
rm -f "$SSE_LOG"

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
if [ $FAILS -eq 0 ]; then
  echo "  PARITY: ALL THREE SURFACES MATCH (12/12 assertions passed)"
else
  echo "  PARITY: $FAILS assertion(s) failed across surfaces"
fi
echo "============================================================"
exit $FAILS
