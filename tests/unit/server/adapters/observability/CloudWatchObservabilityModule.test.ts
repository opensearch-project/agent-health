/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CloudWatchObservabilityModule,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_LOGS_LOOKBACK_MS,
  FRESH_SCAN_MS,
  FRESH_SCAN_PAGES,
  FRESH_SCAN_PARTITION_MS,
  dedupeSources,
  DEFAULT_MAX_WINDOW_MS,
  buildTracesInsightsQuery,
  idTermsFilterPattern,
  exactCorrelatorIds,
  q,
} from '@/server/adapters/observability/CloudWatchObservabilityModule';
import type { ICloudWatchReader, FilterEventsResult, InsightsResult, LogGroupsResult } from '@/server/adapters/observability/cloudwatch/CloudWatchReader';
import { classifyCloudWatchError } from '@/server/adapters/observability/cloudwatch/CloudWatchReader';
import {
  cloudWatchSpanToSource,
  cloudWatchLogToEntry,
  nanosToIso,
  statusCodeToNumber,
  parseSpanRecord,
  resolveLogGroupTemplate,
  logGroupTemplatePrefix,
  type CloudWatchSpanRecord,
} from '@/server/adapters/observability/cloudwatch/recordMappers';
import { transformSpan } from '@/server/services/tracesService';
import { categorizeSpan } from '@/services/traces/spanCategorization';
import type { Span } from '@/types';
import spanFixture from '../../../../fixtures/cloudwatch/aws-spans-trace.json';
import logFixture from '../../../../fixtures/cloudwatch/otel-logs.json';

const TRACE = 'a54f35c518ca4fe4b86b07f10aeea457';
const SERVICE = 'demo-retrieval-agent';
const RUN = 'cw-run-2';
const records = spanFixture as unknown as CloudWatchSpanRecord[];
const spanMessages = records.map((r) => JSON.stringify(r));
const logMessages = (logFixture as unknown[]).map((r) => JSON.stringify(r));
const T0_MS = Math.floor(Number(records[0].startTimeUnixNano) / 1e6);
/** Start time of a span record in ms (undefined for log records, which the fakes do not time-filter). */
function recordMs(message: string): number | undefined {
  try {
    const n = JSON.parse(message)?.startTimeUnixNano;
    return n === undefined ? undefined : Math.floor(Number(n) / 1e6);
  } catch {
    return undefined;
  }
}

/** In-memory stand-in for CloudWatch Logs: both read paths see the same records. */
class FakeReader implements ICloudWatchReader {
  calls: { filter: any[]; insights: any[]; describe: string[] } = { filter: [], insights: [], describe: [] };
  groups: Record<string, string[]> = { 'aws/spans': spanMessages, [`/agent-health/${SERVICE}`]: logMessages };
  /** Pretend the window was not fully scanned (nextToken left over). */
  incompleteFilter = false;
  failFilter?: Error;
  failInsights?: Error;
  insightsTruncated = false;
  groupsTruncated = false;

  async filterEvents(opts: { logGroup: string; pattern: string; startMs: number; endMs: number; limit: number }): Promise<FilterEventsResult> {
    this.calls.filter.push(opts);
    if (this.failFilter) throw this.failFilter;
    const msgs = this.groups[opts.logGroup];
    if (!msgs) {
      const err: any = new Error('The specified log group does not exist.');
      err.name = 'ResourceNotFoundException';
      throw err;
    }
    if (this.incompleteFilter) return { events: [], complete: false, pages: 1 };
    // Emulate the JSON metric-filter `{ $.traceId = "X" }` and quoted-term patterns (`"a"`, `?"a" ?"b"`),
    // and CloudWatch's time bounds (span records are placed by startTimeUnixNano).
    const m = /\{ \$\.traceId = "([0-9a-f]+)" \}/.exec(opts.pattern);
    const terms = !m && opts.pattern ? [...opts.pattern.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`)) : [];
    const events = msgs
      .filter((s) => (m ? JSON.parse(s).traceId === m[1] : terms.length ? terms.some((t) => s.includes(t)) : true))
      .filter((s) => { const t = recordMs(s); return t === undefined || (t >= opts.startMs && t <= opts.endMs); })
      .map((s) => ({ message: s, timestamp: recordMs(s) ?? T0_MS }));
    return { events: events.slice(0, opts.limit), complete: true, pages: 1 };
  }

  /** Records newer than this are not yet indexed by Insights (ingestion lag). */
  insightsLagMs = 0;

  async insights(opts: { logGroups: string[]; query: string; startMs: number; endMs: number }): Promise<InsightsResult> {
    this.calls.insights.push(opts);
    if (this.failInsights) throw this.failInsights;
    // The fake returns the whole group (minus the lag); the module's in-memory predicate must do the filtering.
    const cutoff = Date.now() - this.insightsLagMs;
    const rows = opts.logGroups.flatMap((g) => (this.groups[g] || []).filter((m) => (recordMs(m) ?? 0) <= cutoff).map((m) => ({ '@message': m })));
    return { rows, truncated: this.insightsTruncated };
  }

  async describeLogGroups(prefix: string): Promise<LogGroupsResult> {
    this.calls.describe.push(prefix);
    return { names: Object.keys(this.groups).filter((g) => g.startsWith(prefix)), truncated: this.groupsTruncated };
  }
}

/** FilterLogEvents calls against the spans group (the fresh slice is read in newest-first partitions). */
const spanScans = (r: FakeReader) => r.calls.filter.filter((c) => c.logGroup === 'aws/spans');
const scanSpan = (calls: any[]) => ({ startMs: Math.min(...calls.map((c) => c.startMs)), endMs: Math.max(...calls.map((c) => c.endMs)) });

function mod(reader: FakeReader, logGroups?: { traces?: string; logs?: string }) {
  return new CloudWatchObservabilityModule({ region: 'us-east-1', profile: 'default', logGroups }, reader);
}

describe('recordMappers', () => {
  it('maps an aws/spans record to the plain-raw shape transformSpan understands', () => {
    const root = records.find((r) => r.name === 'POST /invoke')!;
    const src = cloudWatchSpanToSource(root);
    expect(src).toMatchObject({
      traceId: TRACE,
      spanId: 'aaad0bc29275b362',
      parentSpanId: 'b7ad6b7169203331',
      name: 'POST /invoke',
      kind: 'SERVER',
      serviceName: SERVICE,
      durationInNanos: 11442 * 1e6,
      status: { code: 1 },
    });
    expect(src.startTime).toBe(nanosToIso(root.startTimeUnixNano));
    expect(src.attributes!['service.name']).toBe(SERVICE);
    expect(src.instrumentationScope).toEqual({ name: 'demo_agent', version: '' });

    const n = transformSpan(src);
    expect(n.status).toBe('OK');
    expect(n.duration).toBe(11442);
    expect(n.attributes['service.name']).toBe(SERVICE);
    expect(n.attributes['spanKind']).toBe('SERVER');
    expect(n.attributes['agent_health.run.id']).toBe(RUN);
  });

  it('categorizes the mapped tree with the shared rules (AGENT / LLM / TOOL)', () => {
    const byName = (name: string) => categorizeSpan(transformSpan(cloudWatchSpanToSource(records.find((r) => r.name === name)!)) as unknown as Span).category;
    expect(byName('invoke_agent demo-retrieval-agent')).toBe('AGENT');
    expect(byName('chat')).toBe('LLM');
    expect(byName('execute_tool run_query')).toBe('TOOL');
  });

  it('handles nanos as strings, string status codes, and missing fields', () => {
    expect(nanosToIso('1788467284282849057')).toBe('2026-09-03T20:28:04.282Z');
    expect(nanosToIso(undefined)).toBeUndefined();
    expect(nanosToIso('abc')).toBeUndefined();
    expect(statusCodeToNumber('ERROR')).toBe(2);
    expect(statusCodeToNumber('OK')).toBe(1);
    expect(statusCodeToNumber('UNSET')).toBe(0);
    expect(statusCodeToNumber(2)).toBe(2);
    expect(statusCodeToNumber(undefined)).toBe(0);
    const bare = cloudWatchSpanToSource({ traceId: TRACE, spanId: 'x', startTimeUnixNano: '1788467284282849057', endTimeUnixNano: '1788467284283849057' });
    expect(bare.durationInNanos).toBe(1_000_000);
    expect(bare.parentSpanId).toBeUndefined();
    expect(bare.events).toEqual([]);
  });

  it('parseSpanRecord rejects non-span JSON and garbage', () => {
    expect(parseSpanRecord('not json')).toBeNull();
    expect(parseSpanRecord('{"traceId":"x"}')).toBeNull();
    expect(parseSpanRecord(spanMessages[0])).not.toBeNull();
  });

  it('maps an OTel log record and a plain-text line', () => {
    const e = cloudWatchLogToEntry(logMessages[1], T0_MS, `/agent-health/${SERVICE}`);
    expect(e).toMatchObject({
      message: 'search ok datasource=ds-demo index=demo-kb hits=1 total=1 took_ms=2',
      level: 'info',
      source: SERVICE,
      traceId: TRACE,
      spanId: 'b93daa8692261d13',
      index: `/agent-health/${SERVICE}`,
    });
    expect(Date.parse(e.timestamp)).toBe(T0_MS + 8000);
    const plain = cloudWatchLogToEntry('hello world', 1700000000000, 'g');
    expect(plain).toMatchObject({ message: 'hello world', level: 'info', timestamp: '2023-11-14T22:13:20.000Z' });
  });

  it('maps an application-logger JSON record (snake_case trace_id / severity / ISO timestamp)', () => {
    const line = JSON.stringify({ timestamp: '2026-10-23T01:47:54.473+00:00', severity: 'INFO', body: 'tool call: name=search_index', logger: 'agent.api.app', service: 'demo-agent', stage: 'prod', trace_id: 'f'.repeat(32), span_id: 'a1b2c3d4e5f60718' });
    const e = cloudWatchLogToEntry(line, undefined, 'g');
    expect(e).toMatchObject({ message: 'tool call: name=search_index', level: 'info', source: 'demo-agent', traceId: 'f'.repeat(32), spanId: 'a1b2c3d4e5f60718', timestamp: '2026-10-23T01:47:54.473Z' });
    const log4j = cloudWatchLogToEntry(JSON.stringify({ timestamp: '2026-10-23T02:07:19,042', level: 'WARN', message: 'refresh failed' }), undefined, 'g');
    expect(log4j).toMatchObject({ level: 'warn', message: 'refresh failed', timestamp: '2026-10-23T02:07:19.042Z' }); // no zone → UTC, never host-local
    // numeric timestamps: unit inferred by magnitude; garbage falls back to the CloudWatch event time
    expect(cloudWatchLogToEntry(JSON.stringify({ timestamp: 1792102039, message: 's' }), 1, 'g').timestamp).toBe('2026-10-15T22:07:19.000Z');
    expect(cloudWatchLogToEntry(JSON.stringify({ timestamp: 1792102039042, message: 'ms' }), 1, 'g').timestamp).toBe('2026-10-15T22:07:19.042Z');
    expect(cloudWatchLogToEntry(JSON.stringify({ timestamp: 1792102039042000000, message: 'ns' }), 1, 'g').timestamp).toMatch(/^2026-10-15T22:07:19\.04[12]Z$/); // float precision at 1e18
    expect(cloudWatchLogToEntry(JSON.stringify({ timestamp: 1e300, message: 'junk' }), 1000, 'g').timestamp).toBe('1970-01-01T00:00:01.000Z');
  });

  it('resolves the per-service log-group template', () => {
    expect(resolveLogGroupTemplate('/agent-health/{service.name}', 'svc')).toBe('/agent-health/svc');
    expect(resolveLogGroupTemplate('/agent-health/{service.name}', undefined)).toBeNull();
    expect(resolveLogGroupTemplate('/fixed/group', undefined)).toBe('/fixed/group');
    expect(logGroupTemplatePrefix('/agent-health/{service.name}')).toBe('/agent-health/');
    expect(logGroupTemplatePrefix('/fixed')).toBe('/fixed');
  });
});

describe('Logs Insights query builder', () => {
  it('quotes and escapes string literals', () => {
    expect(q('plain')).toBe('"plain"');
    expect(q('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('mirrors the OpenSearch DSL: A/B/C/D clauses, union vs intersection, must-filters', () => {
    const query = buildTracesInsightsQuery(
      {
        traceId: TRACE,
        runIds: ['r1', '', 'r2'],
        agents: [{ serviceName: SERVICE, startedAt: 1000, endedAt: 2000, sessionId: 'sess-1' }],
        sessionId: 'sess-2',
        startTime: 500,
        endTime: 3000,
        serviceName: 'svc-x',
        textSearch: 'needle (1)',
      },
      true
    );
    expect(query).toContain('fields @message');
    expect(query).toContain(`traceId = "${TRACE}"`);
    expect(query).toContain('`attributes.agent_health.run.id` in ["r1", "r2"]');
    expect(query).toContain('`attributes.gen_ai.conversation.id` in ["r1", "r2"]');
    expect(query).toContain('`resource.attributes.service.name` = "demo-retrieval-agent"');
    expect(query).toContain('startTimeUnixNano >= 1000000000 and startTimeUnixNano <= 2000000000');
    expect(query).toContain('`attributes.session.id` = "sess-1"');
    expect(query).toContain('`attributes.session.id` = "sess-2"');
    expect(query).toContain(' or ');
    expect(query).toContain('startTimeUnixNano >= 500000000');
    expect(query).toContain('startTimeUnixNano <= 3000000000');
    expect(query).toContain('`attributes.gen_ai.agent.name` = "svc-x"');
    expect(query).toContain('@message like /(?i)needle \\(1\\)/');
    expect(query).toMatch(/sort startTimeUnixNano desc \| limit 10000$/);

    const intersect = buildTracesInsightsQuery({ traceId: TRACE, runIds: ['r1'] }, false);
    expect(intersect).toContain(' and (`attributes.agent_health.run.id`');
    expect(intersect).not.toContain(' or (`attributes.agent_health.run.id`');
  });

  it('batch metrics: several trace ids and session ids in one query', () => {
    const q = buildTracesInsightsQuery({ runIds: [RUN], traceIds: ['a'.repeat(32), 'b'.repeat(32)], sessionIds: ['s1', 's2'] }, true);
    expect(q).toContain(`traceId in ["${'a'.repeat(32)}", "${'b'.repeat(32)}"]`);
    expect(q).toContain('`attributes.session.id` in ["s1", "s2"]');
  });

  it('dedupes on (traceId, spanId), not spanId alone', () => {
    const a = { traceId: 'a'.repeat(32), spanId: 's1' } as any;
    const b = { traceId: 'b'.repeat(32), spanId: 's1' } as any;
    expect(dedupeSources([a, b, { ...a }, { spanId: undefined } as any])).toHaveLength(3);
  });

  it('builds a time-only browse query', () => {
    const browse = buildTracesInsightsQuery({ startTime: 1000, endTime: 2000 }, false);
    expect(browse).toBe('fields @message | filter startTimeUnixNano >= 1000000000 and startTimeUnixNano <= 2000000000 | sort startTimeUnixNano desc | limit 10000');
  });

  it('builds FilterLogEvents term patterns from every exact correlator and rejects unsafe ids', () => {
    expect(idTermsFilterPattern(['a'])).toBe('"a"');
    expect(idTermsFilterPattern(['a', 'b', 'a'])).toBe('?"a" ?"b"');
    expect(idTermsFilterPattern(['has space', 'has"quote', ''])).toBeNull();
    expect(exactCorrelatorIds({ traceId: 't', runIds: ['r', ''], sessionId: 's', agents: [{ serviceName: 'x', startedAt: 0, endedAt: 1, sessionId: 'as' }] })).toEqual(['t', 'r', 's', 'as']);
    expect(exactCorrelatorIds({ startTime: 1 })).toEqual([]);
  });
});

describe('CloudWatchObservabilityModule', () => {
  let reader: FakeReader;
  beforeEach(() => {
    reader = new FakeReader();
  });

  describe('traces', () => {
    it('requires an id filter or a time range', async () => {
      await expect(mod(reader).traces.query({})).rejects.toThrow(/traceId, runIds, sessionId, agents, or time range/);
    });

    it('traceId lookup: fresh FilterLogEvents slice and the indexed Insights query run in parallel; the (older) tree comes from Insights', async () => {
      const res = await mod(reader).traces.query({ traceId: TRACE, size: 100 });
      const scans = spanScans(reader);
      expect(scans).toHaveLength(FRESH_SCAN_MS / FRESH_SCAN_PARTITION_MS); // 4 partitions, newest first
      expect(reader.calls.insights).toHaveLength(1);
      expect(scans[0]).toMatchObject({ logGroup: 'aws/spans', pattern: `"${TRACE}"`, maxPages: FRESH_SCAN_PAGES });
      expect(scans.map((c) => c.endMs)).toEqual([...scans.map((c) => c.endMs)].sort((a, b) => b - a)); // newest partition first
      const span = scanSpan(scans);
      expect(span.endMs - span.startMs).toBe(FRESH_SCAN_MS); // the newest 20 min only
      expect(reader.calls.insights[0].query).toContain(`traceId = "${TRACE}"`);
      expect(res.total).toBe(12);
      expect(res.spans).toHaveLength(12);
      expect(res.hasMore).toBe(false);
      // newest first, every span normalized
      const times = res.spans.map((s) => Date.parse(s.startTime));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      const root = res.spans.find((s) => s.spanId === 'aaad0bc29275b362')!;
      expect(root.status).toBe('OK');
      expect(root.attributes!['service.name']).toBe(SERVICE);
      // default lookback when no bounds are given (the Insights query covers it)
      expect(reader.calls.insights[0].endMs - reader.calls.insights[0].startMs).toBe(DEFAULT_LOOKBACK_MS);
    });

    it('a span ingested seconds ago (not yet indexed by Insights) is still returned — the fresh slice covers the lag', async () => {
      reader.insightsLagMs = 5 * 60 * 1000;
      const nowNanos = `${Date.now() - 2000}000000`;
      const fresh = { ...records[0], traceId: 'c'.repeat(32), spanId: 'c0ffee0000000001', parentSpanId: undefined, startTimeUnixNano: nowNanos, endTimeUnixNano: nowNanos };
      reader.groups['aws/spans'] = [...spanMessages, JSON.stringify(fresh)];
      const res = await mod(reader).traces.query({ traceId: 'c'.repeat(32) });
      expect(res.total).toBe(1);
      expect(res.spans[0].spanId).toBe('c0ffee0000000001');
      expect(res.truncated).toBe(false);
    });

    it('a fresh scan that exhausts its page budget is reported partial (honest: the newest minutes may be unread); so is a truncated Insights result', async () => {
      reader.incompleteFilter = true; // CloudWatch keeps handing back a nextToken
      const res = await mod(reader).traces.query({ traceId: TRACE });
      expect(spanScans(reader)).toHaveLength(1); // the first (newest) partition used up the budget → stop
      expect(reader.calls.insights).toHaveLength(1);
      expect(res.total).toBe(12); // still answered from Insights
      expect(res.truncated).toBe(true);
      reader.incompleteFilter = false;
      reader.insightsTruncated = true;
      expect((await mod(reader).traces.query({ traceId: TRACE })).truncated).toBe(true);
    });

    it('one failing read path does not fail the request: the other path answers, marked partial; both failing is an error', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      reader.failFilter = Object.assign(new Error('simulated throttle'), { name: 'ThrottlingException' });
      let res = await mod(reader).traces.query({ traceId: TRACE });
      expect(res.total).toBe(12);
      expect(res.truncated).toBe(true);
      reader.failFilter = undefined;
      reader.failInsights = new Error('insights down');
      res = await mod(reader).traces.query({ traceId: TRACE });
      expect(res.truncated).toBe(true); // fresh slice alone (fixture is older than 20 min → nothing), honest flag
      reader.failFilter = new Error('both');
      await expect(mod(reader).traces.query({ traceId: TRACE })).rejects.toThrow(/insights down/);
      warn.mockRestore();
    });

    it('run-report shape (traceId + runIds + agents): one term scan for the exact ids and one Insights query carrying every clause', async () => {
      const res = await mod(reader).traces.query({
        traceId: 'f'.repeat(32), // trace id that matches nothing …
        runIds: [RUN], // … but Strategy B does
        agents: [{ serviceName: 'other-service', startedAt: 0, endedAt: 1 }],
        size: 1000,
      });
      expect(spanScans(reader).length).toBeGreaterThanOrEqual(1);
      expect(spanScans(reader)[0].pattern).toBe(`?"${'f'.repeat(32)}" ?"${RUN}"`);
      expect(reader.calls.insights).toHaveLength(1);
      expect(reader.calls.insights[0].query).toMatch(/traceId = .* or .*agent_health\.run\.id.* or .*other-service/);
      expect(res.total).toBe(12); // the agents clause for the other service matched nothing extra
    });

    it('an exact hit consisting only of Agent Health eval/judge spans does NOT suppress the window (reviewer probe)', async () => {
      // The eval `test_case` span carries the run id; the agent's own spans do not (Strategy-C-only agent).
      const evalSpan = { ...records[0], traceId: 'e'.repeat(32), spanId: 'eval000000000001', parentSpanId: undefined, name: 'test_case',
        attributes: { 'agent_health.run.id': 'run-eval-only', 'gen_ai.operation.name': 'evaluation' } };
      reader.groups['aws/spans'] = [...spanMessages, JSON.stringify(evalSpan)];
      const res = await mod(reader).traces.query({ runIds: ['run-eval-only'], agents: [{ serviceName: SERVICE, startedAt: T0_MS - 1000, endedAt: T0_MS + 60_000 }] });
      expect(reader.calls.insights).toHaveLength(1); // window still consulted
      expect(res.total).toBe(13); // eval span + the agent's 12 window spans
    });

    it('run-report shape falls through to the Insights window when the exact ids find nothing (Strategy C only agent)', async () => {
      const res = await mod(reader).traces.query({
        traceId: 'f'.repeat(32),
        runIds: ['unknown-run'],
        agents: [{ serviceName: SERVICE, startedAt: T0_MS - 1000, endedAt: T0_MS + 60_000 }],
      });
      expect(spanScans(reader).length).toBeGreaterThanOrEqual(1);
      expect(reader.calls.insights).toHaveLength(1);
      expect(reader.calls.insights[0].query).toContain(`\`resource.attributes.service.name\` = "${SERVICE}"`);
      expect(res.total).toBe(12);
    });

    it('Strategy C: service.name + window matches; outside the window nothing matches', async () => {
      const inWindow = await mod(reader).traces.query({ agents: [{ serviceName: SERVICE, startedAt: T0_MS - 1000, endedAt: T0_MS + 60_000 }] });
      expect(reader.calls.filter).toHaveLength(0); // no exact ids → Insights only
      expect(inWindow.total).toBe(12);
      const outside = await mod(reader).traces.query({ agents: [{ serviceName: SERVICE, startedAt: T0_MS + 120_000, endedAt: T0_MS + 180_000 }] });
      expect(outside.total).toBe(0);
    });

    it('Strategy B on the OTEL-standard gen_ai.conversation.id and in-memory must-filters', async () => {
      const bySession = await mod(reader).traces.query({ runIds: ['cw-sess-2'] });
      expect(bySession.total).toBe(12);
      const wrongService = await mod(reader).traces.query({ traceId: TRACE, serviceName: 'someone-else' });
      expect(wrongService.total).toBe(0);
      const text = await mod(reader).traces.query({ traceId: TRACE, textSearch: 'run_query' });
      expect(reader.calls.insights.length).toBeGreaterThan(0); // free text needs Insights
      expect(text.spans.map((s) => s.name)).toEqual(['execute_tool run_query']);
      // A pasted trace id in the search box matches the whole trace (Agent Traces page keyword search).
      const byId = await mod(reader).traces.query({ startTime: T0_MS - 60_000, endTime: T0_MS + 60_000, textSearch: TRACE.slice(0, 12) });
      expect(byId.total).toBe(12);
    });

    it('a term hit on an unrelated record is filtered out by the exact predicate', async () => {
      // A span whose tool result merely CONTAINS the run id string must not correlate.
      const decoy = { ...records[0], traceId: 'd'.repeat(32), spanId: 'decoy000decoy000', attributes: { 'gen_ai.tool.call.result': `mentions ${RUN} in text`, 'agent_health.run.id': 'someone-else' } };
      reader.groups['aws/spans'] = [...spanMessages, JSON.stringify(decoy)];
      const res = await mod(reader).traces.query({ runIds: [RUN] });
      expect(res.total).toBe(12);
      expect(res.spans.some((s) => s.spanId === 'decoy000decoy000')).toBe(false);
    });

    it('scans only the agents\' run window (±5 min) when no explicit bounds are given', async () => {
      await mod(reader).traces.query({ traceId: TRACE, agents: [{ serviceName: SERVICE, startedAt: T0_MS, endedAt: T0_MS + 12_000 }] });
      const call = reader.calls.insights[0];
      expect(call.startMs).toBe(T0_MS - 5 * 60 * 1000);
      expect(call.endMs).toBe(T0_MS + 12_000 + 5 * 60 * 1000);
      // the fresh slice is the newest 20 min of that window (here: the window is shorter, so all of it)
      expect(scanSpan(spanScans(reader))).toEqual({ startMs: call.startMs, endMs: call.endMs });
      // explicit bounds win over the agents window
      await mod(reader).traces.query({ traceId: TRACE, startTime: 1000, endTime: 2000, agents: [{ serviceName: SERVICE, startedAt: T0_MS, endedAt: T0_MS + 12_000 }] });
      expect(reader.calls.insights[1]).toMatchObject({ startMs: 1000, endMs: 2000 });
      expect(spanScans(reader).at(-1)).toMatchObject({ startMs: 1000, endMs: 2000 });
    });

    it('an over-cap explicit range is clamped to the newest 30 days AND reported truncated (never silently narrowed)', async () => {
      const now = Date.now();
      const res = await mod(reader).traces.query({ traceId: TRACE, startTime: now - 60 * 86_400_000, endTime: now });
      const scan = reader.calls.insights[0];
      expect(scan.endMs - scan.startMs).toBe(DEFAULT_MAX_WINDOW_MS);
      expect(res.truncated).toBe(true);
      // Within the cap: not flagged.
      const ok = await mod(reader).traces.query({ traceId: TRACE, startTime: now - 10 * 86_400_000, endTime: now });
      expect(ok.truncated).toBe(false);
    });

    it('paginates with an offset cursor', async () => {
      const m = mod(reader);
      const p1 = await m.traces.query({ traceId: TRACE, size: 5 });
      expect(p1.spans).toHaveLength(5);
      expect(p1.hasMore).toBe(true);
      const p2 = await m.traces.query({ traceId: TRACE, size: 5, cursor: p1.nextCursor! });
      const p3 = await m.traces.query({ traceId: TRACE, size: 5, cursor: p2.nextCursor! });
      expect(p3.spans).toHaveLength(2);
      expect(p3.hasMore).toBe(false);
      const ids = new Set([...p1.spans, ...p2.spans, ...p3.spans].map((s) => s.spanId));
      expect(ids.size).toBe(12);
    });

    it('dedupes a span delivered twice', async () => {
      reader.groups['aws/spans'] = [...spanMessages, spanMessages[0]];
      const res = await mod(reader).traces.query({ traceId: TRACE });
      expect(res.total).toBe(12);
    });

    it('getByTraceId / getByRunIds convenience wrappers', async () => {
      const m = mod(reader);
      expect(await m.traces.getByTraceId(TRACE)).toHaveLength(12);
      expect(await m.traces.getByRunIds([RUN])).toHaveLength(12);
      expect(await m.traces.getByRunIds([''])).toEqual([]);
    });

    it('honours a custom traces log group', async () => {
      reader.groups['custom/spans'] = spanMessages;
      await mod(reader, { traces: 'custom/spans' }).traces.query({ traceId: TRACE });
      expect(reader.calls.filter[0].logGroup).toBe('custom/spans');
    });
  });

  describe('logs', () => {
    it('resolves the per-service group and correlates by traceId', async () => {
      const res = await mod(reader).logs.query({ traceId: TRACE, serviceName: SERVICE });
      expect(reader.calls.filter.find((c) => c.logGroup !== 'aws/spans')).toMatchObject({ logGroup: `/agent-health/${SERVICE}`, pattern: `"${TRACE}"` });
      expect(res.total).toBe(3);
      expect(res.logs.map((l) => l.spanId)).toContain('b93daa8692261d13');
      // newest first
      expect(res.logs[0].message).toMatch(/planner request ok/);
    });

    it('without a serviceName, searches every group under the template prefix', async () => {
      reader.groups['/agent-health/other-agent'] = [];
      const res = await mod(reader).logs.query({ traceId: TRACE });
      expect(reader.calls.describe).toEqual(['/agent-health/']);
      expect(reader.calls.filter.map((c) => c.logGroup).filter((g) => g !== 'aws/spans').sort()).toEqual([`/agent-health/${SERVICE}`, '/agent-health/other-agent']);
      expect(res.total).toBe(3);
    });

    it('a trace-id lookup without bounds scans only the trace\'s own window (±5 min), derived from its spans', async () => {
      const res = await mod(reader).logs.query({ traceId: TRACE, serviceName: SERVICE });
      const logScan = reader.calls.filter.find((c) => c.logGroup === `/agent-health/${SERVICE}`);
      const spanStarts = records.map((r) => Number(r.startTimeUnixNano) / 1e6);
      expect(logScan.startMs).toBe(Math.floor(Math.min(...spanStarts)) - 5 * 60 * 1000);
      expect(logScan.endMs - logScan.startMs).toBeLessThan(2 * 60 * 60 * 1000);
      expect(res.total).toBe(3);
      // An unknown trace falls back to the logs lookback.
      await mod(reader).logs.query({ traceId: 'e'.repeat(32), serviceName: SERVICE });
      const fallback = reader.calls.filter.at(-1);
      expect(fallback.endMs - fallback.startMs).toBe(DEFAULT_LOGS_LOOKBACK_MS);
    });

    it('a missing per-service group is empty, not an error', async () => {
      const res = await mod(reader).logs.query({ traceId: TRACE, serviceName: 'never-logged' });
      expect(res).toMatchObject({ logs: [], total: 0 });
      expect(res.truncated).toBeFalsy();
    });

    it('runId and free-text use quoted-term patterns; text narrows an id lookup in memory', async () => {
      const m = mod(reader);
      await m.logs.query({ runId: 'cw-sess-2', serviceName: SERVICE });
      expect(reader.calls.filter.at(-1).pattern).toBe('"cw-sess-2"');
      await m.logs.query({ query: 'search ok', serviceName: SERVICE, startTime: 1, endTime: 2 });
      expect(reader.calls.filter.at(-1)).toMatchObject({ pattern: '"search ok"', startMs: 1, endMs: 2 });
      const narrowed = await m.logs.query({ traceId: TRACE, serviceName: SERVICE, query: 'hits=1' });
      expect(narrowed.total).toBe(1);
    });

    it('logs: an over-cap explicit range is clamped and the result marked truncated', async () => {
      const now = Date.now();
      const res = await mod(reader).logs.query({ traceId: TRACE, serviceName: SERVICE, startTime: now - 90 * 86_400_000, endTime: now });
      expect(reader.calls.filter[0].endMs - reader.calls.filter[0].startMs).toBe(DEFAULT_MAX_WINDOW_MS);
      expect(res.truncated).toBe(true);
    });

    it('browsing without ids defaults to the last hour; a run-id lookup to the logs lookback', async () => {
      const m = mod(reader);
      await m.logs.query({ serviceName: SERVICE });
      const browse = reader.calls.filter.at(-1);
      expect(browse.endMs - browse.startMs).toBe(60 * 60 * 1000);
      await m.logs.query({ serviceName: SERVICE, runId: RUN });
      const byId = reader.calls.filter.at(-1);
      expect(byId.endMs - byId.startMs).toBe(DEFAULT_LOGS_LOOKBACK_MS); // application log groups: 24 h, not the span lookback
    });
  });

  describe('metrics', () => {
    it('forRun fetches the run spans (fresh term scan ∥ indexed Insights) and applies the shared math', async () => {
      const m = await mod(reader).metrics.forRun(RUN);
      expect(reader.calls.filter[0].pattern).toBe(`"${RUN}"`);
      expect(reader.calls.insights).toHaveLength(1);
      expect(reader.calls.insights[0].query).toContain(`"${RUN}"`);
      expect(m).toMatchObject({ runId: RUN, traceId: TRACE, inputTokens: 42952, outputTokens: 1686, llmCalls: 4, toolCalls: 3, status: 'success' });
      expect(m.partial).toBeUndefined();
    });

    it('forRun threads upstream hints (traceId / agents) and stamps correlatedBy', async () => {
      const m = await mod(reader).metrics.forRun('report-key', { traceId: TRACE, agents: [{ serviceName: SERVICE, startedAt: T0_MS - 1000, endedAt: T0_MS + 60_000 }] });
      expect(m.inputTokens).toBe(42952);
      expect(m.correlatedBy).toBe('ids'); // traceId is an id correlator
      expect(m.hasSpans).toBe(true);
      expect(reader.calls.insights).toHaveLength(1); // phase 1 (ids) found the agent → no phase-2 window query
      expect(reader.calls.insights[0].query).toContain(`traceId = "${TRACE}"`);
      expect(reader.calls.insights[0].query).not.toContain(SERVICE);
    });

    it('an exact hit that is ONLY the eval span does not suppress the window: the agent is found via Strategy C (reviewer probe)', async () => {
      const evalSpan = { ...records[0], traceId: 'e'.repeat(32), spanId: 'eval000000000001', parentSpanId: undefined, name: 'test_case',
        attributes: { 'agent_health.run.id': 'run-eval-only', 'gen_ai.operation.name': 'evaluation' } };
      const agentOnly = records.map((r) => ({ ...r, attributes: { ...r.attributes, 'agent_health.run.id': undefined, 'gen_ai.conversation.id': undefined } }));
      reader.groups['aws/spans'] = [JSON.stringify(evalSpan), ...agentOnly.map((r) => JSON.stringify(r))];
      // Same shape as the reviewer's probe: the eval span IS found by exact id (traceId)…
      const m = await mod(reader).metrics.forRun('run-eval-only', { traceId: 'e'.repeat(32), agents: [{ serviceName: SERVICE, startedAt: T0_MS - 1000, endedAt: T0_MS + 60_000 }] });
      expect(reader.calls.filter[0].pattern).toContain('e'.repeat(32));
      // …but, being eval-only, must not suppress the window (phase 2 runs for that key).
      expect(reader.calls.insights).toHaveLength(2);
      expect(reader.calls.insights[1].query).toContain(SERVICE);
      expect(m.inputTokens).toBe(42952);
      expect(m.llmCalls).toBe(4);
      expect(m.correlatedBy).toBe('window'); // precise-first: the agent was found ONLY by the window (the eval span by id does not count as an agent hit)
    });

    it('one key\'s id hit does not suppress a sibling key\'s window fallback (per-key decision)', async () => {
      const flip = (id: string) => id.split('').reverse().join('');
      const other = records.map((r) => ({ ...r, traceId: 'b'.repeat(32), spanId: flip(r.spanId!), parentSpanId: r.parentSpanId ? flip(r.parentSpanId) : undefined,
        attributes: { ...r.attributes, 'agent_health.run.id': undefined, 'gen_ai.conversation.id': undefined } }));
      reader.groups['aws/spans'] = [...spanMessages, ...other.map((r) => JSON.stringify(r))];
      const [byId, byWindow] = await mod(reader).metrics.forRuns([RUN, 'report-xyz'], {
        agentsByRunId: { 'report-xyz': [{ serviceName: SERVICE, startedAt: T0_MS - 1000, endedAt: T0_MS + 60_000 }] },
      });
      expect(reader.calls.insights).toHaveLength(2); // ids for both keys, then the window ONLY for the key the ids missed
      expect(reader.calls.insights[1].query).not.toContain(RUN);
      expect(byId).toMatchObject({ runId: RUN, inputTokens: 42952, correlatedBy: 'ids' });
      expect(byWindow).toMatchObject({ runId: 'report-xyz', correlatedBy: 'window' });
      expect(byWindow.inputTokens).toBeGreaterThan(0);
    });

    it('forRuns does not let one key\'s window hint hide an older id-only key (id scan covers the lookback)', async () => {
      const [, real] = await mod(reader).metrics.forRuns(['report-xyz', RUN], {
        agentsByRunId: { 'report-xyz': [{ serviceName: 'some-other-service', startedAt: T0_MS + 10 * 86_400_000, endedAt: T0_MS + 10 * 86_400_000 + 60_000 }] },
      });
      const idScan = reader.calls.insights[0];
      expect(idScan.endMs - idScan.startMs).toBe(DEFAULT_LOOKBACK_MS);
      const fresh = scanSpan(spanScans(reader));
      expect(fresh.endMs - fresh.startMs).toBe(FRESH_SCAN_MS);
      // the other key's hint (fixture time + 10 days, still older than the lookback) gets its own window query, outside the lookback
      expect(reader.calls.insights[1].startMs).toBeLessThan(idScan.startMs);
      expect(reader.calls.insights[1]).toMatchObject({ startMs: T0_MS + 10 * 86_400_000 - 5 * 60 * 1000 });
      expect(real).toMatchObject({ runId: RUN, inputTokens: 42952, correlatedBy: 'ids' });
    });

    it('a truncated Insights result, or a fresh scan that ran out of pages, marks every key of the chunk partial', async () => {
      reader.incompleteFilter = true;
      expect((await mod(reader).metrics.forRun(RUN)).partial).toBe(true);
      reader.incompleteFilter = false;
      reader.insightsTruncated = true;
      const m = await mod(reader).metrics.forRun(RUN);
      expect(m.partial).toBe(true);
    });

    it('a trace-store failure yields status error (unknown), never "no spans" (reviewer probe); one failing path → success marked partial', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      reader.failFilter = Object.assign(new Error('simulated throttle'), { name: 'ThrottlingException' });
      reader.failInsights = Object.assign(new Error('simulated throttle'), { name: 'ThrottlingException' });
      const [m] = await mod(reader).metrics.forRuns([RUN]);
      expect(m.status).toBe('error');
      expect(m.error).toMatch(/simulated throttle/);
      expect(m.hasSpans).toBeUndefined();
      expect(m.totalTokens).toBe(0);
      // Only the fresh scan failing: Insights still answers, flagged partial.
      reader.failInsights = undefined;
      const [p] = await mod(reader).metrics.forRuns([RUN]);
      expect(p).toMatchObject({ status: 'success', inputTokens: 42952, partial: true });
      warn.mockRestore();
    });

    it('a failing chunk does not poison a successful one', async () => {
      const ids = Array.from({ length: 51 }, (_, i) => (i === 50 ? RUN : `k${i}`)); // RUN lands alone in chunk 2
      let n = 0;
      const orig = reader.insights.bind(reader);
      reader.insights = async (o) => { if (n++ === 0) throw new Error('boom'); return orig(o); };
      reader.failFilter = new Error('boom'); // both paths down for chunk 1; chunk 2's Insights works
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await mod(reader).metrics.forRuns(ids);
      expect(res.slice(0, 50).every((m) => m.status === 'error')).toBe(true);
      expect(res[50]).toMatchObject({ runId: RUN, inputTokens: 42952, status: 'success', partial: true });
      warn.mockRestore();
    });
  });

  describe('health / describe', () => {
    it('is healthy when the traces log group exists', async () => {
      await expect(mod(reader).health()).resolves.toEqual({ status: 'ok', index: 'aws/spans' });
      expect(mod(reader).describe()).toEqual({ type: 'cloudwatch', target: 'aws/spans', region: 'us-east-1' });
      expect(mod(reader).isConfigured()).toBe(true);
    });

    it('reports a missing traces group as index_not_found with the Transaction Search hint', async () => {
      delete reader.groups['aws/spans'];
      const h = await mod(reader).health();
      expect(h.status).toBe('error');
      expect(h.errorCategory).toBe('index_not_found');
      expect(h.suggestion).toMatch(/Transaction Search/);
    });

    it('classifies AWS SDK errors for the health contract', async () => {
      const err = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
      expect(classifyCloudWatchError(err('ExpiredTokenException')).category).toBe('auth');
      expect(classifyCloudWatchError(err('AccessDeniedException', 403)).category).toBe('auth');
      expect(classifyCloudWatchError(err('ResourceNotFoundException')).category).toBe('index_not_found');
      expect(classifyCloudWatchError(new Error('getaddrinfo ENOTFOUND logs.us-east-1.amazonaws.com')).category).toBe('connection');
      expect(classifyCloudWatchError(err('SomethingElse')).category).toBe('unknown');
      reader.describeLogGroups = async () => { throw err('ExpiredTokenException', 403); };
      const h = await mod(reader).health();
      expect(h).toMatchObject({ status: 'error', errorCategory: 'auth' });
    });

    it('lists log groups under the logs template prefix', async () => {
      await expect(mod(reader).listLogGroups()).resolves.toEqual([`/agent-health/${SERVICE}`]);
    });
  });
});
