/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A local CloudWatch Logs API stub — a REAL HTTP server speaking the service's
 * JSON 1.1 wire protocol, so an unmodified `@aws-sdk/client-cloudwatch-logs`
 * in ANOTHER PROCESS (the agent-health server a CLI test boots) talks to it
 * through `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS` with static test credentials.
 * Nothing in the server is mocked: the SDK signs the request, the reader's
 * FilterLogEvents / StartQuery / GetQueryResults / DescribeLogGroups commands
 * hit this server, and the responses are decoded by the SDK.
 *
 * It holds one `aws/spans`-shaped log group in memory. Like CloudWatch it
 * HONOURS TIME BOUNDS on both read paths (event time = the span's end time, as
 * Transaction Search stamps it) — the bugs this stub exists to pin (#640) are
 * precisely about asking for the wrong bounds — and matches FilterLogEvents
 * term patterns (`"id"` / `?"a" ?"b"`) and the quoted literals of a Logs
 * Insights `filter` clause as substrings of the record.
 *
 * It does NOT evaluate the Insights query language (fields, and/or,
 * parentheses): it is deliberately MORE permissive than the service, so it can
 * only ever hand the module extra records — which the module's in-memory
 * `matchesQuery` then drops — and it can never hide a record the real service
 * would return. Query construction itself is pinned by the module's unit tests
 * (`buildTracesInsightsQuery`); this stub is about bounds and transport.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CloudWatchSpanRecordInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'SERVER' | 'CLIENT' | 'INTERNAL' | 'PRODUCER' | 'CONSUMER';
  serviceName: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, unknown>;
  status?: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string };
}

export interface RecordedCall {
  target: string;
  input: any;
  /** Scheme of the request's `Authorization` header (`AWS4-HMAC-SHA256` when the real SDK signed it). */
  authScheme?: string;
}

export interface CloudWatchLogsStub {
  /** `http://127.0.0.1:<port>` — value for `AWS_ENDPOINT_URL_CLOUDWATCH_LOGS`. */
  url: string;
  /** Log group the spans live in (default `aws/spans`). */
  logGroup: string;
  /** Every API call received, in order. */
  calls: RecordedCall[];
  /** Append one span record to the log group. */
  putSpan(span: CloudWatchSpanRecordInput): void;
  /** Number of span records held. */
  size(): number;
  close(): Promise<void>;
}

/** Transaction Search record shape (see tests/fixtures/cloudwatch/aws-spans-trace.json). */
export function toAwsSpansRecord(span: CloudWatchSpanRecordInput): Record<string, unknown> {
  return {
    resource: {
      attributes: {
        'service.name': span.serviceName,
        'deployment.environment.name': 'test',
        'cloud.provider': 'aws',
        'cloud.region': 'us-east-1',
        'telemetry.sdk.language': 'nodejs',
        'telemetry.sdk.name': 'opentelemetry',
      },
    },
    scope: { name: 'demo_agent', version: '' },
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    flags: 768,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: `${span.startMs}000000`,
    endTimeUnixNano: `${span.endMs}000000`,
    durationNano: `${(span.endMs - span.startMs) * 1_000_000}`,
    attributes: { ...span.attributes, 'aws.local.service': span.serviceName, 'aws.span.kind': span.kind },
    status: span.status ?? { code: 'OK' },
  };
}

interface StoredRecord {
  message: string;
  /** Event timestamp (ms) — the span's END time, as `aws/spans` stamps it. */
  timestamp: number;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Quoted literals of a FilterLogEvents term pattern or an Insights query, unescaped. */
export function quotedLiterals(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
}

export async function startCloudWatchLogsStub(options: { logGroup?: string } = {}): Promise<CloudWatchLogsStub> {
  const logGroup = options.logGroup ?? 'aws/spans';
  const records: StoredRecord[] = [];
  const calls: RecordedCall[] = [];
  const queries = new Map<string, { startMs: number; endMs: number; queryString: string }>();

  const inBounds = (startMs: number | undefined, endMs: number | undefined) => (r: StoredRecord) =>
    (startMs === undefined || r.timestamp >= startMs) && (endMs === undefined || r.timestamp <= endMs);
  const matchesAnyLiteral = (literals: string[]) => (r: StoredRecord) =>
    literals.length === 0 || literals.some((l) => r.message.includes(l));

  const respond = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': `stub-${calls.length}` });
    res.end(JSON.stringify(body));
  };
  const awsError = (res: ServerResponse, type: string, message: string) => respond(res, 400, { __type: type, message });

  const server: Server = createServer(async (req, res) => {
    const target = String(req.headers['x-amz-target'] ?? '');
    const op = target.replace(/^Logs_20140328\./, '');
    let input: any;
    try {
      input = await readJson(req);
    } catch {
      return awsError(res, 'SerializationException', 'malformed JSON body');
    }
    const authorization = String(req.headers.authorization ?? '');
    calls.push({ target: op, input, authScheme: authorization.split(' ')[0] || undefined });

    switch (op) {
      case 'DescribeLogGroups': {
        const prefix = String(input.logGroupNamePrefix ?? '');
        return respond(res, 200, {
          logGroups: [logGroup].filter((g) => g.startsWith(prefix)).map((g) => ({ logGroupName: g, arn: `arn:aws:logs:us-east-1:000000000000:log-group:${g}:*` })),
        });
      }
      case 'FilterLogEvents': {
        if (input.logGroupName !== logGroup) return awsError(res, 'ResourceNotFoundException', 'The specified log group does not exist.');
        const terms = quotedLiterals(input.filterPattern);
        const events = records
          .filter(inBounds(input.startTime, input.endTime))
          .filter(matchesAnyLiteral(terms))
          .slice(0, Math.max(1, Number(input.limit) || 10_000))
          .map((r, i) => ({ message: r.message, timestamp: r.timestamp, ingestionTime: r.timestamp + 1_000, logStreamName: 'default', eventId: `evt-${i}` }));
        return respond(res, 200, { events, searchedLogStreams: [] });
      }
      case 'StartQuery': {
        const groups: string[] = input.logGroupNames ?? (input.logGroupName ? [input.logGroupName] : []);
        if (!groups.includes(logGroup)) return awsError(res, 'ResourceNotFoundException', 'Log group does not exist.');
        const queryId = `q-${queries.size + 1}`;
        queries.set(queryId, { startMs: Number(input.startTime) * 1000, endMs: Number(input.endTime) * 1000, queryString: String(input.queryString ?? '') });
        return respond(res, 200, { queryId });
      }
      case 'GetQueryResults': {
        const q = queries.get(String(input.queryId));
        if (!q) return awsError(res, 'ResourceNotFoundException', 'Unknown query id');
        // Only the `filter` clause carries literals (the `fields`/`sort`/`limit` clauses carry none).
        const filterClause = q.queryString.split('|').find((p) => p.trim().startsWith('filter'));
        const results = records
          .filter(inBounds(q.startMs, q.endMs))
          .filter(matchesAnyLiteral(quotedLiterals(filterClause)))
          .map((r) => [{ field: '@message', value: r.message }]);
        return respond(res, 200, { status: 'Complete', results, statistics: { recordsMatched: results.length, recordsScanned: records.length, bytesScanned: 0 } });
      }
      case 'StopQuery':
        return respond(res, 200, { success: true });
      default:
        return awsError(res, 'UnknownOperationException', `unsupported operation ${target}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    logGroup,
    calls,
    putSpan(span) {
      records.push({ message: JSON.stringify(toAwsSpansRecord(span)), timestamp: span.endMs });
    },
    size: () => records.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
