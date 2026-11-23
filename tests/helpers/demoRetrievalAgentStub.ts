/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A synthetic REST retrieval agent for CLI/e2e suites: a REAL local HTTP server
 * the agent-health REST connector calls, which "emits" OpenTelemetry spans for
 * each invocation into a {@link CloudWatchLogsStub} (the way an instrumented
 * agent's spans land in Transaction Search's `aws/spans`) and answers with its
 * own `runId` / `sessionId` — the ids it also stamps on every span as
 * `gen_ai.conversation.id` (Strategy B) and `session.id` (Strategy D).
 *
 * Prompt tags steer the fixture (the prompt is the only input a test case
 * controls):
 *   `[tool-error]` — the first `execute_tool` span fails (OTel status ERROR)
 *                    and is retried; the run itself still succeeds (#599).
 *   `[no-answer]`  — the agent answers without the expected citation, so an
 *                    `expect(...).to.include(...)` in the eval body fails.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { CloudWatchSpanRecordInput } from './cloudWatchLogsStub';

/**
 * Where the agent's spans go. `CloudWatchLogsStub` satisfies this as-is; an
 * OpenSearch-backed sink (tests/helpers/openSearchSpanSink.ts) indexes
 * asynchronously and exposes `flush` so the agent answers only once its spans
 * are searchable — a real agent's exporter would have shipped them by then too.
 */
export interface SpanSink {
  putSpan(span: CloudWatchSpanRecordInput): void;
  flush?(): Promise<void>;
}

export const DEMO_AGENT_MODEL = 'demo-provider.demo-model-v1';
/** Tokens the fixture reports per invocation across its two `chat` spans. */
export const DEMO_AGENT_TOKENS = { input: 1200 + 2400, output: 300 + 150 };
/** Cost the fixture REPORTS on its chat spans (`gen_ai.usage.cost_usd`), summed. */
export const DEMO_AGENT_COST_USD = 0.0045 + 0.0066;
export const DEMO_AGENT_LLM_CALLS = 2;
export const DEMO_AGENT_TOOL = 'search_documents';
/** Spans per invocation: root + 2 chat + 1 tool (+1 failed tool attempt with `[tool-error]`). */
export const DEMO_AGENT_SPANS = { normal: 4, withToolError: 5 };
export const DEMO_AGENT_CITATION = 'Billing FAQ';

export interface DemoAgentInvocation {
  prompt: string;
  runId: string;
  sessionId: string;
  traceId: string;
  startedAt: number;
  endedAt: number;
  spanCount: number;
}

export interface DemoRetrievalAgent {
  /** Endpoint for the agent's `agent-health.config` entry. */
  url: string;
  serviceName: string;
  invocations: DemoAgentInvocation[];
  close(): Promise<void>;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

export async function startDemoRetrievalAgent(cloudWatch: SpanSink, options: { serviceName: string }): Promise<DemoRetrievalAgent> {
  const { serviceName } = options;
  const invocations: DemoAgentInvocation[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', async () => {
      // The REST connector's contract: POST, JSON body, `prompt` string. Anything else is a 400, never a span.
      let prompt: unknown;
      try {
        prompt = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt : undefined;
      } catch {
        prompt = undefined;
      }
      if (typeof prompt !== 'string') {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'expected POST with a JSON body carrying a string `prompt`' }));
        return;
      }
      const n = invocations.length + 1;
      // Not `demo-…`: the metrics routes treat `demo-*` run ids as the bundled sample data.
      const runId = `agent-run-${n}-${hex(4)}`;
      const sessionId = `agent-session-${n}-${hex(4)}`;
      const traceId = hex(16);
      const toolError = prompt.includes('[tool-error]');
      const noAnswer = prompt.includes('[no-answer]');

      // The invocation's own wall clock: it started ~1.4 s ago and ends now.
      const endedAt = Date.now();
      const startedAt = endedAt - 1_400;
      const base = { traceId, serviceName } as const;
      const common = { 'gen_ai.conversation.id': runId, 'session.id': sessionId };
      const rootId = hex(8);
      let spanCount = 0;
      const put = (span: Parameters<CloudWatchLogsStub['putSpan']>[0]) => {
        cloudWatch.putSpan(span);
        spanCount++;
      };

      put({
        ...base, spanId: rootId, name: 'POST /invoke', kind: 'SERVER', startMs: startedAt, endMs: endedAt,
        attributes: { ...common, 'http.request.method': 'POST', 'http.route': '/invoke', 'http.response.status_code': 200 },
      });
      put({
        ...base, spanId: hex(8), parentSpanId: rootId, name: `chat ${DEMO_AGENT_MODEL}`, kind: 'CLIENT', startMs: startedAt + 50, endMs: startedAt + 450,
        attributes: { ...common, 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'demo-provider', 'gen_ai.request.model': DEMO_AGENT_MODEL, 'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 300, 'gen_ai.usage.cost_usd': 0.0045 },
      });
      if (toolError) {
        put({
          ...base, spanId: hex(8), parentSpanId: rootId, name: `execute_tool ${DEMO_AGENT_TOOL}`, kind: 'INTERNAL', startMs: startedAt + 500, endMs: startedAt + 700,
          attributes: { ...common, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': DEMO_AGENT_TOOL, 'error.type': 'upstream_timeout' },
          status: { code: 'ERROR', message: 'search index timed out after 200 ms' },
        });
      }
      put({
        ...base, spanId: hex(8), parentSpanId: rootId, name: `execute_tool ${DEMO_AGENT_TOOL}`, kind: 'INTERNAL', startMs: startedAt + 750, endMs: startedAt + 950,
        attributes: { ...common, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': DEMO_AGENT_TOOL, 'retrieval.document_count': 3 },
      });
      put({
        ...base, spanId: hex(8), parentSpanId: rootId, name: `chat ${DEMO_AGENT_MODEL}`, kind: 'CLIENT', startMs: startedAt + 1_000, endMs: endedAt - 20,
        attributes: { ...common, 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'demo-provider', 'gen_ai.request.model': DEMO_AGENT_MODEL, 'gen_ai.usage.input_tokens': 2400, 'gen_ai.usage.output_tokens': 150, 'gen_ai.usage.cost_usd': 0.0066 },
      });

      invocations.push({ prompt: prompt as string, runId, sessionId, traceId, startedAt, endedAt, spanCount });
      // Spans are searchable before the answer leaves (an exporter would have shipped them by now).
      await cloudWatch.flush?.();
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          runId,
          sessionId,
          toolCalls: [{ name: DEMO_AGENT_TOOL, args: { query: prompt.replace(/\[[a-z-]+\]/g, '').trim() }, result: { documents: 3 } }],
          response: noAnswer
            ? 'I could not find a relevant article for that question.'
            : `Found 3 documents; the answer is in the "${DEMO_AGENT_CITATION}" article: refunds post within 5 business days.`,
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/invoke`,
    serviceName,
    invocations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
