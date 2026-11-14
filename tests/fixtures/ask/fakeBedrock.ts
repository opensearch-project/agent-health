/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local HTTP server that speaks Bedrock's ConverseStream wire protocol
 * (`application/vnd.amazon.eventstream`), scripted per request, so the REAL pi
 * SDK + REAL AWS SDK can be driven deterministically: text answers, tool
 * calls, HTTP errors, a stream that dies mid-answer, a response that is held
 * until the test releases it. Records what each request was signed with and
 * which tools the model was offered.
 *
 * Point pi at it with `PI_CODING_AGENT_DIR/models.json`:
 *   { "providers": { "amazon-bedrock": { "baseUrl": "<url>" } } }
 * and set `AWS_BEDROCK_FORCE_HTTP1=1` (the Bedrock runtime client defaults to
 * HTTP/2, which a plain `http.Server` does not speak).
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';

export type BedrockScript =
  | { kind: 'text'; text: string }
  /** One tool call, or a BATCH (`calls`) the model requests in one response — pi executes a batch in parallel. `preludeText` = text before the call(s). */
  | { kind: 'toolUse'; name: string; input: Record<string, unknown>; toolUseId?: string; calls?: Array<{ name: string; input: Record<string, unknown> }>; preludeText?: string }
  | { kind: 'http400'; message: string }
  | { kind: 'partialThenDrop'; text: string }
  | { kind: 'hold' };

export interface BedrockRequest {
  /** Access key id the request was signed with (`Credential=<id>/…`). */
  accessKeyId: string | null;
  sessionToken: string | null;
  modelId: string;
  toolNames: string[];
  /** The conversation pi sent (Bedrock `messages`). */
  messages: any[];
  system: string;
}

export interface FakeBedrock {
  url: string;
  requests: BedrockRequest[];
  /** Decide the response for the NEXT request(s); may be a function of the request. */
  script: (next: BedrockScript | ((req: BedrockRequest) => BedrockScript)) => void;
  /** Release every response currently held by `{ kind: 'hold' }` with the given script. */
  releaseHeld: (as: BedrockScript) => void;
  heldCount: () => number;
  close: () => Promise<void>;
}

const codec = new EventStreamCodec(toUtf8, fromUtf8);

function event(type: string, payload: unknown): Buffer {
  return Buffer.from(
    codec.encode({
      headers: {
        ':message-type': { type: 'string', value: 'event' },
        ':event-type': { type: 'string', value: type },
        ':content-type': { type: 'string', value: 'application/json' },
      },
      body: fromUtf8(JSON.stringify(payload)),
    })
  );
}

function writeScript(res: http.ServerResponse, s: Exclude<BedrockScript, { kind: 'hold' }>): void {
  if (s.kind === 'http400') {
    res.writeHead(400, { 'content-type': 'application/json', 'x-amzn-requestid': 'fake-req', 'x-amzn-errortype': 'ValidationException' });
    res.end(JSON.stringify({ message: s.message }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'fake-req' });
  res.write(event('messageStart', { role: 'assistant' }));
  if (s.kind === 'text' || s.kind === 'partialThenDrop') {
    res.write(event('contentBlockStart', { contentBlockIndex: 0, start: {} }));
    for (const word of s.text.split(/(?<= )/)) res.write(event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: word } }));
    if (s.kind === 'partialThenDrop') { res.destroy(); return; }
    res.write(event('contentBlockStop', { contentBlockIndex: 0 }));
    res.write(event('messageStop', { stopReason: 'end_turn' }));
  } else {
    let index = 0;
    if (s.preludeText) {
      res.write(event('contentBlockStart', { contentBlockIndex: index, start: {} }));
      res.write(event('contentBlockDelta', { contentBlockIndex: index, delta: { text: s.preludeText } }));
      res.write(event('contentBlockStop', { contentBlockIndex: index }));
      index += 1;
    }
    const calls = s.calls ?? [{ name: s.name, input: s.input }];
    for (const call of calls) {
      res.write(event('contentBlockStart', { contentBlockIndex: index, start: { toolUse: { toolUseId: s.toolUseId && calls.length === 1 ? s.toolUseId : `tu-${Date.now().toString(36)}-${index}`, name: call.name } } }));
      res.write(event('contentBlockDelta', { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify(call.input) } } }));
      res.write(event('contentBlockStop', { contentBlockIndex: index }));
      index += 1;
    }
    res.write(event('messageStop', { stopReason: 'tool_use' }));
  }
  res.write(event('metadata', { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } }));
  res.end();
}

export async function startFakeBedrock(): Promise<FakeBedrock> {
  const requests: BedrockRequest[] = [];
  let current: BedrockScript | ((req: BedrockRequest) => BedrockScript) = { kind: 'text', text: 'ok' };
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const m = /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ''));
      const modelId = decodeURIComponent((/^\/model\/([^/]+)\//.exec(req.url ?? '') ?? [])[1] ?? '');
      const record: BedrockRequest = {
        accessKeyId: m?.[1] ?? null,
        sessionToken: (req.headers['x-amz-security-token'] as string | undefined) ?? null,
        modelId,
        toolNames: (body.toolConfig?.tools ?? []).map((t: any) => t.toolSpec?.name).filter(Boolean),
        messages: body.messages ?? [],
        system: (body.system ?? []).map((s: any) => s.text ?? '').join('\n'),
      };
      requests.push(record);
      const s = typeof current === 'function' ? current(record) : current;
      if (s.kind === 'hold') { held.push(res); return; }
      writeScript(res, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    script: (next) => { current = next; },
    releaseHeld: (as) => { if (as.kind === 'hold') return; for (const res of held.splice(0)) writeScript(res, as); },
    heldCount: () => held.length,
    close: () => new Promise<void>((r) => { for (const res of held.splice(0)) res.destroy(); server.close(() => r()); }),
  };
}
