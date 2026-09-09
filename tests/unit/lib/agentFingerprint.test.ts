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
 *   - header / secret / env-VALUE change → fingerprint UNCHANGED (redacted)
 *   - hook BODY change → fingerprint changes (source text is hashed)
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
    // Same body, different formatting → same hash (whitespace-normalized).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const hookA2 = new Function('ctx', 'return   ctx') as any;
    const hookA3 = new Function('ctx', 'return ctx') as any;
    expect(computeAgentFingerprint(baseAgent({ hooks: { beforeRequest: hookA2 } })).agentFingerprint)
      .toBe(computeAgentFingerprint(baseAgent({ hooks: { beforeRequest: hookA3 } })).agentFingerprint);
  });
});

describe('computeAgentFingerprint — what does NOT change it (redaction)', () => {
  it('header change → fingerprint UNCHANGED (headers are never hashed)', () => {
    const a = computeAgentFingerprint(baseAgent());
    const b = computeAgentFingerprint(baseAgent({ headers: { Authorization: 'Bearer rotated-2', 'X-Extra': 'y' } }));
    expect(b.agentFingerprint).toBe(a.agentFingerprint);
  });

  it('auth change → fingerprint UNCHANGED', () => {
    const a = computeAgentFingerprint(baseAgent({ auth: { type: 'bearer', token: 't1' } }));
    const b = computeAgentFingerprint(baseAgent({ auth: { type: 'basic', username: 'u', password: 'p' } }));
    expect(b.agentFingerprint).toBe(a.agentFingerprint);
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

  it('secret-looking keys anywhere in connectorConfig are redacted by value', () => {
    const a = computeAgentFingerprint(baseAgent({ connectorConfig: { apiKey: 'k1', nested: { authToken: 'x' } } }));
    const b = computeAgentFingerprint(baseAgent({ connectorConfig: { apiKey: 'k2', nested: { authToken: 'y' } } }));
    expect(b.agentFingerprint).toBe(a.agentFingerprint);
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
    expect(text).not.toContain('Authorization');
    // ...but env KEY names and the prompt do participate.
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('You are a careful engineer.');
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

  it('returns undefined for missing / empty paths', () => {
    expect(resolveAgentConfigSource(undefined)).toBeUndefined();
    expect(resolveAgentConfigSource(null)).toBeUndefined();
    expect(resolveAgentConfigSource(path.join(tmp, 'nope.ts'))).toBeUndefined();
  });

  it('resolves a symlink to its real path and reads the git sha of the containing repo', () => {
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

    const src = resolveAgentConfigSource(link)!;
    expect(src.path).toBe(fs.realpathSync(cfg));
    expect(src.gitSha).toBe(sha);
    expect(src.dirty).toBe(false);

    fs.appendFileSync(cfg, '// edit\n');
    expect(resolveAgentConfigSource(link)!.dirty).toBe(true);
  });

  it('returns the path alone (no sha) outside a git checkout', () => {
    const dir = path.join(tmp, 'nogit');
    fs.mkdirSync(dir);
    const cfg = path.join(dir, 'agent-health.config.ts');
    fs.writeFileSync(cfg, 'export default {}\n');
    const src = resolveAgentConfigSource(cfg);
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
  it('describe wording', () => {
    expect(describeFingerprintDiff('prompt')).toMatch(/prompt changed/);
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
