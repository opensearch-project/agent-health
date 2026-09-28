/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture REST agent that behaves like a correctly instrumented third-party
 * service: it **adopts the incoming W3C `traceparent`** (continuing the
 * caller's trace), emits a small OTel span tree (`invoke_agent` → `chat` →
 * `execute_tool`) via OTLP/JSON to agent-health's embedded receiver
 * (`POST /v1/traces`), and answers with a hook-style `{ id, answer, … }` body
 * — `RESTConnector` reads `data.id` as the report's `runId`.
 *
 * Used by the legacy-runner integration test and the CLI e2e harness to prove
 * per-test-case trace isolation end-to-end (see
 * tests/integration/services/legacyRunnerTracePerCase.integration.test.ts and
 * tests/e2e/cli/benchmark-named.spec.ts). Zero dependencies beyond node:http so
 * it runs the same way under jest and Playwright.
 */

import * as http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';

export interface RecordedInvocation {
  /** Conversation id returned to the caller as `id` (→ report.runId). */
  conversationId: string;
  /** Raw `traceparent` header received, if any. */
  traceparent?: string;
  /** Trace id the agent emitted its spans under (adopted or self-minted). */
  traceId: string;
  /** Span id of the caller's span (from traceparent), if any. */
  parentSpanId?: string;
  prompt: string;
}

export interface TraceparentRestAgentOptions {
  /** Where to POST OTLP/JSON spans — agent-health's `/v1/traces` receiver. */
  otlpEndpoint: string;
  /** OTel resource `service.name` (default: `retrieval-agent`). */
  serviceName?: string;
  /** Adopt the incoming `traceparent` (default: true — standards-compliant). */
  adoptTraceparent?: boolean;
  /** Also stamp `agent_health.run.id` (Strategy B) on the root span (default: false). */
  stampRunIdAttribute?: boolean;
  /** Optional per-request response delay (ms) to widen run windows. */
  delayMs?: number;
}

export interface TraceparentRestAgent {
  url: string;
  port: number;
  invocations: RecordedInvocation[];
  close(): Promise<void>;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/** Parse a W3C `traceparent` header; `null` when absent/malformed. */
export function parseTraceparent(header: string | string[] | undefined): { traceId: string; spanId: string } | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase() };
}

function hexId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function attr(key: string, value: string | number | boolean) {
  if (typeof value === 'number') return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

function nanos(ms: number): string {
  return `${Math.round(ms)}000000`;
}

/**
 * Build the OTLP/JSON ExportTraceServiceRequest for one invocation:
 * `invoke_agent` (root, parent = caller span when adopted) → `chat` + `execute_tool`.
 */
export function buildOtlpPayload(args: {
  serviceName: string;
  traceId: string;
  parentSpanId?: string;
  conversationId: string;
  prompt: string;
  startMs: number;
  stampRunIdAttribute?: boolean;
}): { resourceSpans: unknown[]; rootSpanId: string } {
  const { serviceName, traceId, parentSpanId, conversationId, prompt, startMs } = args;
  const rootSpanId = hexId(8);
  const chatSpanId = hexId(8);
  const toolSpanId = hexId(8);
  const common = [
    attr('gen_ai.conversation.id', conversationId),
    attr('gen_ai.agent.name', serviceName),
  ];
  if (args.stampRunIdAttribute) common.push(attr('agent_health.run.id', conversationId));

  const spans = [
    {
      traceId,
      spanId: rootSpanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: 'invoke_agent retrieval-agent',
      kind: 2,
      startTimeUnixNano: nanos(startMs),
      endTimeUnixNano: nanos(startMs + 30),
      attributes: [
        ...common,
        attr('gen_ai.operation.name', 'invoke_agent'),
        attr('gen_ai.request.model', 'fixture-model'),
        attr('gen_ai.prompt', prompt),
        attr('gen_ai.completion', `answer for: ${prompt}`),
      ],
      status: { code: 1 },
    },
    {
      traceId,
      spanId: chatSpanId,
      parentSpanId: rootSpanId,
      name: 'chat fixture-model',
      kind: 3,
      startTimeUnixNano: nanos(startMs + 2),
      endTimeUnixNano: nanos(startMs + 12),
      attributes: [
        ...common,
        attr('gen_ai.operation.name', 'chat'),
        attr('gen_ai.provider.name', 'fixture'),
        attr('gen_ai.request.model', 'fixture-model'),
        attr('gen_ai.usage.input_tokens', 120),
        attr('gen_ai.usage.output_tokens', 40),
      ],
      status: { code: 1 },
    },
    {
      traceId,
      spanId: toolSpanId,
      parentSpanId: rootSpanId,
      name: 'execute_tool search_products',
      kind: 1,
      startTimeUnixNano: nanos(startMs + 14),
      endTimeUnixNano: nanos(startMs + 26),
      attributes: [
        ...common,
        attr('gen_ai.operation.name', 'execute_tool'),
        attr('gen_ai.tool.name', 'search_products'),
        attr('gen_ai.tool.call.arguments', JSON.stringify({ query: prompt })),
        attr('gen_ai.tool.call.result', JSON.stringify({ hits: [{ id: 1, title: 'Home Kit' }] })),
      ],
      status: { code: 1 },
    },
  ];

  return {
    rootSpanId,
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', serviceName)] },
        scopeSpans: [{ scope: { name: 'fixture-agent' }, spans }],
      },
    ],
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Start the fixture agent on an ephemeral 127.0.0.1 port (or `port` when given).
 */
export async function startTraceparentRestAgent(
  options: TraceparentRestAgentOptions & { port?: number }
): Promise<TraceparentRestAgent> {
  const serviceName = options.serviceName ?? 'retrieval-agent';
  const adopt = options.adoptTraceparent !== false;
  const invocations: RecordedInvocation[] = [];

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    try {
      const body = await readJsonBody(req);
      const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
      const incoming = parseTraceparent(req.headers['traceparent']);
      const traceId = adopt && incoming ? incoming.traceId : hexId(16);
      const parentSpanId = adopt && incoming ? incoming.spanId : undefined;
      const conversationId = `conv-${hexId(6)}`;
      const startMs = Date.now();

      const payload = buildOtlpPayload({
        serviceName,
        traceId,
        parentSpanId,
        conversationId,
        prompt,
        startMs,
        stampRunIdAttribute: options.stampRunIdAttribute,
      });
      // Export BEFORE answering so the spans are queryable by the time the
      // caller's trace poller makes its first attempt.
      const exportRes = await fetch(options.otlpEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceSpans: payload.resourceSpans }),
      });
      if (!exportRes.ok) {
        const text = await exportRes.text().catch(() => '');
        throw new Error(`OTLP export failed: ${exportRes.status} ${text}`);
      }

      invocations.push({
        conversationId,
        traceparent: Array.isArray(req.headers['traceparent']) ? req.headers['traceparent'][0] : req.headers['traceparent'],
        traceId,
        parentSpanId,
        prompt,
      });

      if (options.delayMs) await new Promise(r => setTimeout(r, options.delayMs));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: conversationId,
        answer: `answer for: ${prompt}`,
        toolCalls: [
          { name: 'search_products', args: { query: prompt }, result: { hits: [{ id: 1, title: 'Home Kit' }] } },
        ],
        steps: [{ n: 1, tool: 'search_products', args: { query: prompt }, output: '{"hits":1}' }],
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/invoke`,
    port,
    invocations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
