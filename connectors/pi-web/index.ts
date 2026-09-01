/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * agent-health connector that runs each test case in a real pi-web session.
 *
 * This file intentionally uses local structural types instead of importing
 * agent-health internals, so the config can load it from either a source
 * checkout or an installed agent-health package.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { TrajectoryStep } from "@/types";
import { ToolCallStatus } from "@/types";
import type {
  AgentConnector,
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from "@/connectors/types";

export type PiWebConnectorConfig = {
  cwd?: string;
  model?: string | { provider: string; id: string };
  token?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  settleMs?: number;
  keepSession?: boolean;
  /** Directory containing fixture envelope refs (defaults to <cwd>/fixtures). */
  fixturesDir?: string;
};

type SettlementStatus = {
  sessionId?: string;
  state?: "running" | "idle" | "unavailable";
  trackedWorkers?: Array<{
    id: string;
    state: "running" | "idle" | "unavailable";
    settled: boolean;
  }>;
  pendingWakeups?: number;
  settled?: boolean;
  [key: string]: unknown;
};

type PiWebMessage = {
  role?: string;
  text?: string;
  timestamp?: string | number;
  isError?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCalls?: Array<{
    id?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    startedAt?: string | number;
  }>;
  raw?: {
    content?: unknown;
    [key: string]: unknown;
  };
};

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SETTLE_MS = 3_000;
const API_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function timestampMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

type FixtureTreeEntry = { path: string; sha256: string };

function fixtureTree(root: string, dir = root): FixtureTreeEntry[] {
  const result: FixtureTreeEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...fixtureTree(root, path));
    } else if (entry.isFile()) {
      result.push({
        path: relative(root, path).split(sep).join("/"),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      });
    } else {
      throw new Error(`Fixture contains an unsupported non-file entry: ${path}`);
    }
  }
  return result;
}

function filesystemFixtureIntegrity(root: string): string {
  const hash = createHash("sha256");
  for (const file of fixtureTree(root)) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** A standalone, structurally typed implementation of agent-health's connector contract. */
export class PiWebConnector implements AgentConnector {
  readonly type = "pi-web" as const;
  readonly name = "pi-web Session";
  readonly supportsStreaming = false;

  buildPayload(request: ConnectorRequest): { message: string } {
    const context = Array.isArray(request.testCase.context)
      ? request.testCase.context.filter(
          item => item?.description && item?.value
            && item.disposition !== "connector"
            && item.disposition !== "documentation"
            // Backward compatibility with cases authored before dispositions.
            && item.description !== "fixture",
        )
      : [];
    if (context.length === 0) return { message: request.testCase.initialPrompt };

    const renderedContext = context
      .map(item => `### ${item.description}\n${item.value}`)
      .join("\n\n");
    return {
      message: `Context supplied by the benchmark:\n\n${renderedContext}\n\n---\n\n${request.testCase.initialPrompt}`,
    };
  }

  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback,
  ): Promise<ConnectorResponse> {
    const config = (request.connectorConfig ?? {}) as PiWebConnectorConfig;
    const token = config.token || auth.token || process.env.PI_WEB_TOKEN;
    const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const pollIntervalMs = Number(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const settleMs = Number(config.settleMs ?? DEFAULT_SETTLE_MS);
    const keepSession = config.keepSession !== false;
    const baseUrl = endpoint.replace(/\/$/, "");
    const rawEvents: unknown[] = [];
    let sessionId = "";
    let timedOut = false;
    let fixtureTempPath: string | undefined;

    const envelope = request.testCase.fixture;
    const legacyFixture = request.testCase.context?.find(
      item => item?.description === "fixture"
        && (item.disposition === "connector" || item.disposition === undefined),
    );
    const legacyManifest = request.testCase.context?.find(
      item => item.disposition === "documentation" && item.description.startsWith("Fixture manifest:"),
    );

    let fixtureRef: string | undefined;
    let fixtureIntegrity: string | undefined;
    let fixtureResolution: "envelope" | "legacy-context" | undefined;
    if (envelope) {
      if (envelope.type !== "filesystem-workspace") {
        throw new Error(`Unsupported fixture envelope type: ${envelope.type}`);
      }
      fixtureRef = envelope.ref;
      fixtureIntegrity = envelope.integrity;
      fixtureResolution = "envelope";
    } else if (legacyFixture?.value) {
      fixtureRef = legacyFixture.value;
      const digest = legacyManifest?.value.match(/Whole-fixture SHA-256:\*\* `([a-f0-9]{64})`/)?.[1];
      fixtureIntegrity = digest ? `sha256:${digest}` : undefined;
      fixtureResolution = "legacy-context";
    }

    let cwd = config.cwd || process.cwd();
    if (fixtureRef) {
      const fixturesDir = resolve(config.fixturesDir || join(process.cwd(), "fixtures"));
      const fixtureSource = resolve(fixturesDir, fixtureRef);
      if (!fixtureSource.startsWith(`${fixturesDir}${sep}`)) {
        throw new Error(`Fixture resolves outside fixtures directory: ${fixtureRef}`);
      }

      if (fixtureResolution === "envelope") {
        if (!fixtureIntegrity?.startsWith("sha256:")) {
          throw new Error(`Unsupported fixture integrity: ${fixtureIntegrity || "missing"}`);
        }
        const actualIntegrity = filesystemFixtureIntegrity(fixtureSource);
        if (actualIntegrity !== fixtureIntegrity) {
          throw new Error(
            `Fixture integrity mismatch for ${fixtureRef}: expected ${fixtureIntegrity}, got ${actualIntegrity}`,
          );
        }
      }

      console.info(`[pi-web connector] fixture via ${fixtureResolution}: ${fixtureSource}`);
      fixtureTempPath = mkdtempSync(join(tmpdir(), "pi-web-benchmark-"));
      cpSync(fixtureSource, fixtureTempPath, { recursive: true, dereference: true });
      cwd = fixtureTempPath;
    } else {
      console.info("[pi-web connector] no fixture configured");
    }

    const record = (kind: string, data: unknown): void => {
      const event = { kind, timestamp: new Date().toISOString(), data };
      rawEvents.push(event);
      onRawEvent?.(event);
    };

    const api = async (method: string, path: string, body?: unknown): Promise<any> => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      const text = await response.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { text };
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(
          `${method} ${path} failed (${response.status}): ${data?.error || text || response.statusText}`,
        );
      }
      const eventData = path === "/api/session-ui-state"
        ? {
            ok: data?.ok,
            sessionOriginCount: Array.isArray(data?.sessionUiState?.sessionOrigins)
              ? data.sessionUiState.sessionOrigins.length
              : 0,
          }
        : data;
      record(`${method} ${path.split("?")[0]}`, eventData);
      return data;
    };

    const created = await api("POST", "/api/new-chat", { cwd });
    sessionId = String(created.sessionId || "");
    if (!sessionId) throw new Error("POST /api/new-chat did not return a sessionId");

    const sessionName = truncate(`bench: ${request.testCase.name}`, 80);
    await api("POST", "/api/session/name", { sessionId, name: sessionName });

    if (config.model) {
      const available = await api("GET", `/api/models?sessionId=${encodeURIComponent(sessionId)}`);
      const models = Array.isArray(available.models) ? available.models : [];
      const requestedModel = config.model;
      const selected = typeof requestedModel === "string"
        ? models.find((model: any) =>
            model?.id === requestedModel || `${model?.provider}:${model?.id}` === requestedModel,
          )
        : models.find((model: any) =>
            model?.provider === requestedModel.provider && model?.id === requestedModel.id,
          );
      if (!selected) {
        throw new Error(`Configured pi-web model was not found: ${contentText(config.model)}`);
      }
      await api("POST", "/api/model", {
        sessionId,
        provider: selected.provider,
        id: selected.id,
      });
    }

    const payload = this.buildPayload(request);
    await api("POST", "/api/prompt", { sessionId, message: payload.message });

    // The parent status is recursively settled only after it is idle, every
    // tracked worker is settled, and every worker wakeup has been delivered.
    // This is the server's authoritative harvest boundary; polling individual
    // runtimes can observe a transient parent idle before its follow-up turn.
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + Math.max(1, timeoutMs);
    let settlementStatus: SettlementStatus | undefined;
    let settled = false;

    while (Date.now() < deadline) {
      settlementStatus = await api(
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/status`,
      ) as SettlementStatus;
      if (settlementStatus.settled === true) {
        settled = true;
        break;
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }

    if (!settled) timedOut = true;
    if (settled && settleMs > 0) {
      await delay(Math.max(0, settleMs));
      settlementStatus = await api(
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/status`,
      ) as SettlementStatus;
    }
    const settledAfterMs = Date.now() - waitStartedAt;
    const childSessionIds = Array.isArray(settlementStatus?.trackedWorkers)
      ? settlementStatus.trackedWorkers.map(worker => worker.id)
      : [];

    // Harvest only after recursive settlement (or the overall timeout). This
    // intentionally refetches after the grace period so the trajectory is the
    // newest transcript available at the authoritative settlement boundary.
    const transcript = await api(
      "GET",
      `/api/messages?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
    const trajectory = this.parseResponse({ messages });
    trajectory.forEach(step => onProgress?.(step));

    if (!keepSession) {
      await api("POST", "/api/sessions/delete", { sessionId });
    }

    return {
      trajectory,
      runId: sessionId,
      rawEvents,
      metadata: {
        sessionId,
        sessionName,
        timedOut,
        keepSession,
        workspaceDir: cwd,
        childSessions: childSessionIds,
        settledAfterMs,
        settledTimeout: timedOut,
        settlementStatus,
        ...(fixtureTempPath ? { fixtureTempPath } : {}),
        ...(fixtureIntegrity ? { fixtureIntegrity } : {}),
        ...(fixtureResolution ? { fixtureResolution } : {}),
        ...(timedOut
          ? { note: `pi-web did not report recursive settlement within ${timeoutMs}ms; trajectory may be partial` }
          : {}),
      },
    };
  }

  parseResponse(rawResponse: any): TrajectoryStep[] {
    const messages: PiWebMessage[] = Array.isArray(rawResponse)
      ? rawResponse
      : Array.isArray(rawResponse?.messages)
        ? rawResponse.messages
        : [];
    let finalAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && Boolean(message.text?.trim())) {
        finalAssistantIndex = index;
        break;
      }
    }
    const steps: TrajectoryStep[] = [];
    let sequence = 0;
    const fallbackStart = Date.now();

    const add = (
      type: TrajectoryStep["type"],
      content: string,
      message: PiWebMessage,
      extra: Partial<TrajectoryStep> = {},
      explicitTimestamp?: unknown,
    ): void => {
      if (!content.trim() && type !== "action") return;
      sequence += 1;
      steps.push({
        id: `pi-web-step-${sequence}`,
        timestamp: timestampMs(explicitTimestamp ?? message.timestamp, fallbackStart + sequence),
        type,
        content,
        ...extra,
      });
    };

    messages.forEach((message, messageIndex) => {
      if (!message || typeof message !== "object") return;

      if (message.role === "assistant") {
        const rawContent = message.raw?.content;
        const parts = Array.isArray(rawContent) ? rawContent : [];

        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const block = part as Record<string, any>;
          if (block.type === "thinking") {
            add("thinking", contentText(block.thinking ?? block.text), message);
          } else if (block.type === "toolCall") {
            const toolName = String(block.toolName || block.name || "tool");
            add("action", `Calling ${toolName}...`, message, {
              toolName,
              toolArgs: (block.arguments || block.args || {}) as Record<string, unknown>,
            }, block.startedAt);
          }
        }

        // The simplified transcript's text is the authoritative visible text;
        // its raw content is used above only for hidden thinking and tool calls.
        if (message.text?.trim()) {
          add(
            messageIndex === finalAssistantIndex ? "response" : "assistant",
            message.text.trim(),
            message,
          );
        }

        // Older transcripts may not retain raw content. Fall back to the DTO's
        // projected toolCalls, but do not duplicate calls already mapped above.
        if (parts.every((part: any) => part?.type !== "toolCall")) {
          for (const call of message.toolCalls || []) {
            const toolName = String(call.toolName || "tool");
            add("action", `Calling ${toolName}...`, message, {
              toolName,
              toolArgs: call.args || {},
            }, call.startedAt);
          }
        }
      } else if (message.role === "toolResult") {
        const output = message.text || "";
        add("tool_result", output, message, {
          toolName: message.toolName,
          toolArgs: message.toolArgs,
          toolOutput: output,
          status: message.isError ? ToolCallStatus.FAILURE : ToolCallStatus.SUCCESS,
        });
      }
    });

    return steps;
  }
}

export const piWebConnector = new PiWebConnector();

export default PiWebConnector;
