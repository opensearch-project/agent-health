/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for lib/agentFingerprint.ts — the stability contract that makes
 * the fingerprint useful as provenance:
 *
 *   - same config → same hash (deterministic, key-order independent)
 *   - prompt change → fingerprint AND promptHash change
 *   - header VALUE / secret / env-VALUE change → fingerprint UNCHANGED (redacted)
 *   - header KEY added, auth TYPE change → fingerprint changes (shape is behavior)
 *   - hook BODY change → fingerprint changes (exact source text is hashed)
 *   - non-behavioral fields (name, description, enabled) → unchanged
 *   - endpoint override → changes (it changes what the connector talks to)
 */

import {
  computeAgentFingerprint,
  buildFingerprintPayload,
  redactConnectorConfig,
  deriveAgentPromptText,
  resolveAgentConfigSource,
  canonicalStringify,
  isSecretKey,
  AGENT_FINGERPRINT_SHORT_LENGTH,
} from '@/lib/agentFingerprint';
import { classifyFingerprintDiff, describeFingerprintDiff, formatFingerprintTooltip } from '@/lib/agentFingerprintDiff';
import type { AgentConfig } from '@/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const SHA256_HEX = /^[a-f0-9]{64}$/;

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    key: 'coding-agent',
    name: 'A subprocess coding agent',
    endpoint: 'claude',
    connectorType: 'claude-code',
    useTraces: true,
    headers: { Authorization: 'Bearer secret-1' },
    connectorConfig: {
      systemPrompt: 'You are a careful engineer.',
      appendSystemPrompt: 'Always run the tests.',
      allowedTools: ['Read', 'Edit', 'Bash'],
      additionalArgs: ['--max-turns', '20'],
      env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5', ANTHROPIC_API_KEY: 'sk-live-aaa' },
      mcpServers: {
        search: { command: 'node', args: ['mcp.js'], env: { SEARCH_TOKEN: 'tok-1' } },
      },
      traceContext: { propagateEnv: true, serviceName: 'coding-agent' },
    },
    ...overrides,
  };
}

describe('computeAgentFingerprint — determinism', () => {
  it('produces a sha256 fingerprint, a 12-char short form and a prompt hash', () => {
    const fp = computeAgentFingerprint(baseAgent());
    expect(fp.agentFingerprint).toMatch(SHA256_HEX);
    expect(fp.agentFingerprintShort).toBe(fp.agentFingerprint.slice(0, AGENT_FINGERPRINT_SHORT_LENGTH));
    expect(fp.agentFingerprintShort).toHaveLength(12);
    expect(fp.agentPromptHash).toMatch(SHA256_HEX);
    expect(fp.agentPromptHash).not.toBe(fp.agentFingerprint);
  });

  it('same config → same hash, regardless of key order', () => {
    const a = computeAgentFingerprint(baseAgent());
    const reordered = baseAgent();
    reordered.connectorConfig = {
      traceContext: { serviceName: 'coding-agent', propagateEnv: true },
      mcpServers: { search: { env: { SEARCH_TOKEN: 'tok-1' }, args: ['mcp.js'], command: 'node' } },
      env: { ANTHROPIC_API_KEY: 'sk-live-aaa', ANTHROPIC_MODEL: 'claude-sonnet-4-5' },
      additionalArgs: ['--max-turns', '20'],
      allowedTools: ['Read', 'Edit', 'Bash'],
      appendSystemPrompt: 'Always run the tests.',
      systemPrompt: 'You are a careful engineer.',
    };
    const b = computeAgentFingerprint(reordered);
    expect(b).toEqual(a);
  });

  it('is pure: calling twice yields identical output', () => {
    const agent = baseAgent();
    expect(computeAgentFingerprint(agent)).toEqual(computeAgentFingerprint(agent));
  });

  it('treats `undefined` fields as absent (persisted-form equality)', () => {
    const a = computeAgentFingerprint(baseAgent());
    const b = computeAgentFingerprint(baseAgent({ description: undefined, tracePolling: undefined }));
    expect(b.agentFingerprint).toBe(a.agentFingerprint);
  });
});

describe('computeAgentFingerprint — what changes it', () => {
  it('prompt change → fingerprint AND promptHash change', () => {
    const a = computeAgentFingerprint(baseAgent());
    const b = computeAgentFingerprint(baseAgent({
      connectorConfig: { ...baseAgent().connectorConfig, systemPrompt: 'You are a reckless engineer.' },
    }));
    expect(b.agentFingerprint).not.toBe(a.agentFingerprint);
    expect(b.agentPromptHash).not.toBe(a.agentPromptHash);
  });

  it('appendSystemPrompt change alone → promptHash changes', () => {
    const a = computeAgentFingerprint(baseAgent());
    const b = computeAgentFingerprint(baseAgent({
      connectorConfig: { ...baseAgent().connectorConfig, appendSystemPrompt: 'Never run the tests.' },
    }));
    expect(b.agentPromptHash).not.toBe(a.agentPromptHash);
  });

  it('allowedTools / additionalArgs / model / mcpServers change → fingerprint changes, promptHash does NOT', () => {
    const a = computeAgentFingerprint(baseAgent());
    const variants: Array<Record<string, unknown>> = [
      { allowedTools: ['Read'] },
      { additionalArgs: ['--max-turns', '5'] },
      { env: { ANTHROPIC_MODEL: 'claude-opus-4', ANTHROPIC_API_KEY: 'sk-live-aaa' } },
      { mcpServers: { search: { command: 'node', args: ['mcp-v2.js'] } } },
      { traceContext: { propagateEnv: false } },
      { model: 'some-other-model' },
    ];
    for (const patch of variants) {
      const b = computeAgentFingerprint(baseAgent({ connectorConfig: { ...baseAgent().connectorConfig, ...patch } }));
      expect(b.agentFingerprint).not.toBe(a.agentFingerprint);
      expect(b.agentPromptHash).toBe(a.agentPromptHash);
    }
  });

  it('useTraces / connectorType / endpoint change → fingerprint changes', () => {
    const a = computeAgentFingerprint(baseAgent());
    expect(computeAgentFingerprint(baseAgent({ useTraces: false })).agentFingerprint).not.toBe(a.agentFingerprint);
    expect(computeAgentFingerprint(baseAgent({ connectorType: 'pi' })).agentFingerprint).not.toBe(a.agentFingerprint);
    expect(computeAgentFingerprint(baseAgent({ endpoint: 'claude-nightly' })).agentFingerprint).not.toBe(a.agentFingerprint);
  });

  it('run-level endpoint override participates (it changes what the connector talks to)', () => {
    const a = computeAgentFingerprint(baseAgent());
    const b = computeAgentFingerprint(baseAgent(), { agentEndpoint: 'http://other-host:9000' });
    expect(b.agentFingerprint).not.toBe(a.agentFingerprint);
    // An override equal to the configured endpoint is a no-op.
    const c = computeAgentFingerprint(baseAgent(), { agentEndpoint: 'claude' });
    expect(c.agentFingerprint).toBe(a.agentFingerprint);
  });

  it('hook BODY change → fingerprint changes (source text is hashed)', () => {
    const hookA = async (ctx: any) => ({ ...ctx, payload: { ...ctx.payload, mode: 'a' } });
    const hookB = async (ctx: any) => ({ ...ctx, payload: { ...ctx.payload, mode: 'b' } });
    const a = computeAgentFingerprint(baseAgent({ hooks: { beforeRequest: hookA } }));
    const b = computeAgentFingerprint(baseAgent({ hooks: { beforeRequest: hookB } }));
    const none = computeAgentFingerprint(baseAgent());
    expect(a.agentFingerprint).not.toBe(b.agentFingerprint);
    expect(a.agentFingerprint).not.toBe(none.agentFingerprint);
  });

  it('hook source is hashed VERBATIM: whitespace inside a string literal is behavior, so it must change the hash', () => {
    // codex_review: whitespace-normalizing the source would collapse
    // `'a  b'` and `'a b'` (and regex/template literals) into one hash.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const twoSpaces = new Function('ctx', "return 'a  b'") as any;
    const oneSpace = new Function('ctx', "return 'a b'") as any;
    expect(computeAgentFingerprint(baseAgent({ hooks: { beforeRequest: twoSpaces } })).agentFingerprint)
      .not.toBe(computeAgentFingerprint(baseAgent({ hooks: { beforeRequest: oneSpace } })).agentFingerprint);
  });
});

describe('computeAgentFingerprint — what does NOT change it (redaction)', () => {
  it('header VALUE change (credential rotation) → fingerprint UNCHANGED; header KEY added → changes', () => {
    const a = computeAgentFingerprint(baseAgent());
    const rotated = computeAgentFingerprint(baseAgent({ headers: { Authorization: 'Bearer rotated-2' } }));
    expect(rotated.agentFingerprint).toBe(a.agentFingerprint);
    // codex_review: an added API-version / tenant header IS behavior.
    const added = computeAgentFingerprint(baseAgent({ headers: { Authorization: 'Bearer secret-1', 'X-Api-Version': '2024-06' } }));
    expect(added.agentFingerprint).not.toBe(a.agentFingerprint);
    // Header values never reach the payload.
    expect(canonicalStringify(buildFingerprintPayload(baseAgent({ headers: { 'X-Api-Version': '2024-06' } })))).not.toContain('2024-06');
  });

  it('auth SECRET change → UNCHANGED; auth TYPE / region change → changes; secrets never reach the payload', () => {
    const a = computeAgentFingerprint(baseAgent({ auth: { type: 'bearer', token: 't1' } }));
    const rotated = computeAgentFingerprint(baseAgent({ auth: { type: 'bearer', token: 't2' } }));
    expect(rotated.agentFingerprint).toBe(a.agentFingerprint);
    const basic = computeAgentFingerprint(baseAgent({ auth: { type: 'basic', username: 'u', password: 'p' } }));
    expect(basic.agentFingerprint).not.toBe(a.agentFingerprint);
    const sigv4a = computeAgentFingerprint(baseAgent({ auth: { type: 'aws-sigv4', awsRegion: 'us-east-1' } }));
    const sigv4b = computeAgentFingerprint(baseAgent({ auth: { type: 'aws-sigv4', awsRegion: 'us-west-2' } }));
    expect(sigv4a.agentFingerprint).not.toBe(sigv4b.agentFingerprint);
    const text = canonicalStringify(buildFingerprintPayload(baseAgent({ auth: { type: 'basic', username: 'alice', password: 'hunter2', token: 'tok' } })));
    expect(text).not.toContain('alice');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('tok"');
  });

  it('env VALUE change (secret rotation) → UNCHANGED; env KEY added → changes', () => {
    const a = computeAgentFingerprint(baseAgent());
    const rotated = computeAgentFingerprint(baseAgent({
      connectorConfig: { ...baseAgent().connectorConfig, env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5', ANTHROPIC_API_KEY: 'sk-live-bbb' } },
    }));
    expect(rotated.agentFingerprint).toBe(a.agentFingerprint);
    const added = computeAgentFingerprint(baseAgent({
      connectorConfig: { ...baseAgent().connectorConfig, env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5', ANTHROPIC_API_KEY: 'sk-live-aaa', DEBUG: '1' } },
    }));
    expect(added.agentFingerprint).not.toBe(a.agentFingerprint);
  });

  it('MCP server env VALUE change → UNCHANGED', () => {
    const a = computeAgentFingerprint(baseAgent());
    const b = computeAgentFingerprint(baseAgent({
      connectorConfig: {
        ...baseAgent().connectorConfig,
        mcpServers: { search: { command: 'node', args: ['mcp.js'], env: { SEARCH_TOKEN: 'tok-ROTATED' } } },
      },
    }));
    expect(b.agentFingerprint).toBe(a.agentFingerprint);
  });

  it('credential-carrier keys anywhere in connectorConfig are redacted by value', () => {
    const a = computeAgentFingerprint(baseAgent({ connectorConfig: { apiKey: 'k1', nested: { authToken: 'x', 'api-key': 'z', cookie: 'c' } } }));
    const b = computeAgentFingerprint(baseAgent({ connectorConfig: { apiKey: 'k2', nested: { authToken: 'y', 'api-key': 'w', cookie: 'd' } } }));
    expect(b.agentFingerprint).toBe(a.agentFingerprint);
  });

  it('behavior fields that merely CONTAIN a secret-ish word are NOT redacted (their drift must stay visible)', () => {
    // codex_review: a substring match hid maxTokens / tokenBudget /
    // authorizationMode / privateMode changes behind the redaction marker.
    const a = computeAgentFingerprint(baseAgent({ connectorConfig: { maxTokens: 1000, tokenBudget: 5, authorizationMode: 'strict', privateMode: false, credentialSource: 'env' } }));
    for (const patch of [{ maxTokens: 2000 }, { tokenBudget: 9 }, { authorizationMode: 'lax' }, { privateMode: true }, { credentialSource: 'file' }]) {
      const b = computeAgentFingerprint(baseAgent({ connectorConfig: { maxTokens: 1000, tokenBudget: 5, authorizationMode: 'strict', privateMode: false, credentialSource: 'env', ...patch } }));
      expect(b.agentFingerprint).not.toBe(a.agentFingerprint);
    }
  });

  it('name / description / enabled / isCustom / builtIn → UNCHANGED', () => {
    const a = computeAgentFingerprint(baseAgent());
    const b = computeAgentFingerprint(baseAgent({ name: 'Renamed', description: 'new desc', enabled: false, isCustom: true, builtIn: true }));
    expect(b.agentFingerprint).toBe(a.agentFingerprint);
  });

  it('the pre-hash payload never contains a raw secret value', () => {
    const payload = buildFingerprintPayload(baseAgent());
    const text = canonicalStringify(payload);
    expect(text).not.toContain('sk-live-aaa');
    expect(text).not.toContain('tok-1');
    expect(text).not.toContain('secret-1');
    expect(text).not.toContain('Bearer');
    // ...but header/env KEY names and the prompt do participate.
    expect(text).toContain('"headerKeys":["Authorization"]');
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('You are a careful engineer.');
  });
});

describe('isSecretKey', () => {
  it('matches exact credential names in any casing / separator style', () => {
    for (const k of ['token', 'apiKey', 'api_key', 'API-KEY', 'password', 'passwd', 'secret', 'authorization', 'credentials', 'cookie', 'jwt', 'privateKey', 'aws_secret_access_key', 'AWS_SESSION_TOKEN']) {
      expect(isSecretKey(k)).toBe(true);
    }
  });
  it('matches credential-style suffixes', () => {
    for (const k of ['refreshToken', 'clientSecret', 'signingKey'.replace('Key', 'PrivateKey'), 'dbPassword', 'sessionCookie', 'proxyAuthorization', 'x-api-key']) {
      expect(isSecretKey(k)).toBe(true);
    }
  });
  it('does NOT match behavior fields that merely contain the word', () => {
    for (const k of ['maxTokens', 'max_tokens', 'tokenBudget', 'authorizationMode', 'privateMode', 'credentialSource', 'tokenizer', 'model', 'secretsManagerRegion']) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe('canonicalStringify — non-plain values are deterministic, not silently lost', () => {
  it('Map/Set are order-independent and distinct from an empty object', () => {
    const m1 = canonicalStringify({ x: new Map([['b', 2], ['a', 1]]) });
    const m2 = canonicalStringify({ x: new Map([['a', 1], ['b', 2]]) });
    expect(m1).toBe(m2);
    expect(m1).not.toBe(canonicalStringify({ x: {} }));
    expect(canonicalStringify({ x: new Set([2, 1]) })).toBe(canonicalStringify({ x: new Set([1, 2]) }));
    expect(canonicalStringify({ x: new Set([1]) })).not.toBe(canonicalStringify({ x: new Set([2]) }));
  });
  it('Date / RegExp / URL / BigInt / NaN / Infinity serialize explicitly', () => {
    expect(canonicalStringify(new Date('2024-01-02T03:04:05Z'))).toContain('2024-01-02T03:04:05.000Z');
    expect(canonicalStringify(/a+b/gi)).toContain('/a+b/gi');
    expect(canonicalStringify(new URL('https://x.example/p?q=1'))).toContain('https://x.example/p?q=1');
    expect(canonicalStringify({ n: BigInt(42) })).toContain('"42"');
    expect(canonicalStringify({ n: NaN })).toContain('NaN');
    expect(canonicalStringify({ n: Infinity })).not.toBe(canonicalStringify({ n: -Infinity }));
  });
  it('class instances carry their constructor name so two different classes with equal props differ', () => {
    class A { v = 1; }
    class B { v = 1; }
    expect(canonicalStringify(new A())).not.toBe(canonicalStringify(new B()));
    expect(canonicalStringify(new A())).toBe(canonicalStringify(new A()));
  });
  it('a circular reference throws (caller logs + stamps nothing) instead of hanging or hashing garbage', () => {
    const o: any = { a: 1 };
    o.self = o;
    expect(() => canonicalStringify(o)).toThrow(/circular/);
    // Shared (non-cyclic) references are fine.
    const shared = { k: 1 };
    expect(() => canonicalStringify({ x: shared, y: shared })).not.toThrow();
  });
  it('a BigInt / Map inside connectorConfig hashes deterministically end-to-end', () => {
    const agent = baseAgent({ connectorConfig: { limit: BigInt(10), routes: new Map([['a', 1]]) } });
    expect(computeAgentFingerprint(agent)).toEqual(computeAgentFingerprint(agent));
    const other = baseAgent({ connectorConfig: { limit: BigInt(11), routes: new Map([['a', 1]]) } });
    expect(computeAgentFingerprint(other).agentFingerprint).not.toBe(computeAgentFingerprint(agent).agentFingerprint);
  });
});

describe('redactConnectorConfig', () => {
  it('keeps non-secret model-selector env values (ANTHROPIC_MODEL) but redacts *_API_KEY / *_TOKEN', () => {
    expect(redactConnectorConfig({ env: { ANTHROPIC_MODEL: 'opus', ANTHROPIC_API_KEY: 'k', MODEL_TOKEN: 't' } }))
      .toEqual({ env: { ANTHROPIC_API_KEY: '[redacted]', ANTHROPIC_MODEL: 'opus', MODEL_TOKEN: '[redacted]' } });
  });
  it('the resolved model participates explicitly (connectorConfig.model / env.ANTHROPIC_MODEL / args --model)', () => {
    const viaArgs = (m: string) => computeAgentFingerprint(baseAgent({ connectorConfig: { args: ['--model', m] } })).agentFingerprint;
    expect(viaArgs('a')).not.toBe(viaArgs('b'));
    expect(buildFingerprintPayload(baseAgent()).model).toBe('claude-sonnet-4-5');
  });
  it('replaces env values with a marker, keeps key names sorted', () => {
    expect(redactConnectorConfig({ env: { B: '2', A: '1' } })).toEqual({ env: { A: '[redacted]', B: '[redacted]' } });
  });
  it('redacts secret-looking keys, recurses arrays and objects', () => {
    expect(redactConnectorConfig({ list: [{ token: 'x', ok: 1 }], password: 'p' }))
      .toEqual({ list: [{ token: '[redacted]', ok: 1 }], password: '[redacted]' });
  });
  it('drops undefined and passes primitives through', () => {
    expect(redactConnectorConfig({ a: undefined, b: 1, c: 'x', d: null })).toEqual({ b: 1, c: 'x', d: null });
    expect(redactConnectorConfig(5)).toBe(5);
  });
  it('hashes functions inside connectorConfig by source text', () => {
    const out = redactConnectorConfig({ fn: (x: number) => x + 1 }) as Record<string, unknown>;
    expect(typeof out.fn).toBe('string');
    expect(out.fn as string).toContain('x + 1');
  });
  it('passes Date/Map through for canonicalStringify to normalize (not flattened to {})', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    const out = redactConnectorConfig({ since: d, routes: new Map([['a', 1]]) }) as Record<string, unknown>;
    expect(out.since).toBe(d);
    expect(out.routes).toBeInstanceOf(Map);
  });
});

describe('deriveAgentPromptText', () => {
  it('returns undefined when no prompt-like field is configured', () => {
    expect(deriveAgentPromptText({ connectorConfig: { model: 'm' } })).toBeUndefined();
    expect(deriveAgentPromptText({ connectorConfig: undefined })).toBeUndefined();
    expect(deriveAgentPromptText({ connectorConfig: { systemPrompt: '' } })).toBeUndefined();
  });
  it('picks up systemPrompt, appendSystemPrompt and conventional aliases', () => {
    expect(deriveAgentPromptText({ connectorConfig: { systemPrompt: 'A' } })).toContain('A');
    expect(deriveAgentPromptText({ connectorConfig: { instructions: 'I' } })).toContain('I');
    const both = deriveAgentPromptText({ connectorConfig: { systemPrompt: 'A', appendSystemPrompt: 'B' } })!;
    expect(both).toContain('A');
    expect(both).toContain('B');
  });
  it('no prompt → computeAgentFingerprint omits agentPromptHash', () => {
    const fp = computeAgentFingerprint(baseAgent({ connectorConfig: { model: 'm' } }));
    expect(fp.agentPromptHash).toBeUndefined();
    expect(fp.agentFingerprint).toMatch(SHA256_HEX);
  });
});

describe('resolveAgentConfigSource', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fp-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns undefined for missing / empty paths', async () => {
    expect(await resolveAgentConfigSource(undefined)).toBeUndefined();
    expect(await resolveAgentConfigSource(null)).toBeUndefined();
    expect(await resolveAgentConfigSource(path.join(tmp, 'nope.ts'))).toBeUndefined();
  });

  it('resolves a symlink to its real path and reads the git sha of the containing repo', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const cfg = path.join(repo, 'agent-health.config.ts');
    fs.writeFileSync(cfg, 'export default {}\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const sha = git('rev-parse', 'HEAD');

    const linkDir = path.join(tmp, 'wt');
    fs.mkdirSync(linkDir);
    const link = path.join(linkDir, 'agent-health.config.ts');
    fs.symlinkSync(cfg, link);

    const src = (await resolveAgentConfigSource(link))!;
    expect(src.path).toBe(fs.realpathSync(cfg));
    expect(src.gitSha).toBe(sha);
    expect(src.dirty).toBe(false);

    fs.appendFileSync(cfg, '// edit\n');
    expect((await resolveAgentConfigSource(link))!.dirty).toBe(true);
  });

  it('returns the path alone (no sha) outside a git checkout', async () => {
    const dir = path.join(tmp, 'nogit');
    fs.mkdirSync(dir);
    const cfg = path.join(dir, 'agent-health.config.ts');
    fs.writeFileSync(cfg, 'export default {}\n');
    const src = await resolveAgentConfigSource(cfg);
    // The tmp dir might itself live under a git repo on some machines; only
    // assert the path when it does — the sha is then legitimately present.
    expect(src?.path).toBe(fs.realpathSync(cfg));
  });
});

describe('classifyFingerprintDiff / describe / tooltip', () => {
  const A = { agentFingerprint: 'f'.repeat(64), agentPromptHash: 'p'.repeat(64) };
  it('same', () => expect(classifyFingerprintDiff(A, { ...A })).toBe('same'));
  it('prompt', () => expect(classifyFingerprintDiff(A, { agentFingerprint: 'e'.repeat(64), agentPromptHash: 'q'.repeat(64) })).toBe('prompt'));
  it('other', () => expect(classifyFingerprintDiff(A, { agentFingerprint: 'e'.repeat(64), agentPromptHash: A.agentPromptHash })).toBe('other'));
  it('other when neither has a prompt hash', () => {
    expect(classifyFingerprintDiff({ agentFingerprint: 'a' }, { agentFingerprint: 'b' })).toBe('other');
  });
  it('unknown when a side has no fingerprint', () => {
    expect(classifyFingerprintDiff(A, {})).toBe('unknown');
    expect(classifyFingerprintDiff(null, A)).toBe('unknown');
    expect(classifyFingerprintDiff(undefined, undefined)).toBe('unknown');
  });
  it('describe wording (prompt kind admits other fields may have changed too)', () => {
    expect(describeFingerprintDiff('prompt')).toMatch(/prompt changed/);
    expect(describeFingerprintDiff('prompt')).toMatch(/may have changed too/);
    expect(describeFingerprintDiff('other')).toMatch(/prompt unchanged/);
    expect(describeFingerprintDiff('same')).toMatch(/identical/);
    expect(describeFingerprintDiff('unknown')).toMatch(/not recorded/);
  });
  it('tooltip includes full hash, prompt hash and config source with short sha + dirty marker', () => {
    const t = formatFingerprintTooltip({
      ...A,
      agentConfigSource: { path: '/x/agent-health.config.ts', gitSha: 'abcdef1234567890', dirty: true },
    });
    expect(t).toContain(A.agentFingerprint);
    expect(t).toContain(A.agentPromptHash);
    expect(t).toContain('/x/agent-health.config.ts @ abcdef123456 (uncommitted edits)');
    expect(formatFingerprintTooltip({ agentFingerprint: 'a' })).toContain('no system prompt recorded');
  });
});
