/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `agent-health fingerprint <agentKey>` (cli/commands/fingerprint.ts).
 *
 * The config LOADER is mocked (it is the same loader every other CLI test
 * mocks); the hashing is the REAL lib/agentFingerprint.ts, so what the
 * command prints is pinned to what a run gets stamped with.
 */

jest.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalkMock = { bold: identity, gray: identity, cyan: identity, red: identity, green: identity, yellow: identity };
  return { default: chalkMock, ...chalkMock };
});

jest.mock('@/lib/config/index', () => ({
  loadConfig: jest.fn(),
  getConfigFileInfo: jest.fn(() => null),
}));

import { runFingerprintCommand, createFingerprintCommand } from '@/cli/commands/fingerprint';
import { loadConfig } from '@/lib/config/index';
import { computeAgentFingerprint } from '@/lib/agentFingerprint';
import type { AgentConfig } from '@/types';

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

const agent: AgentConfig = {
  key: 'my-agent',
  name: 'My Agent',
  endpoint: 'http://localhost:9999/agent',
  connectorType: 'rest',
  headers: { Authorization: 'Bearer SECRET-1' },
  connectorConfig: { systemPrompt: 'You are helpful.', env: { OPENAI_API_KEY: 'sk-secret', ANTHROPIC_MODEL: 'claude-x' } },
} as AgentConfig;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadConfig.mockResolvedValue({ agents: [agent] } as any);
});

describe('agent-health fingerprint', () => {
  it('prints the SAME fingerprint a run of this agent would be stamped with, with the short (chip) form and the prompt hash', async () => {
    const expected = computeAgentFingerprint(agent);
    const { out, io: o } = io();
    const code = await runFingerprintCommand('my-agent', {}, o);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(expected.agentFingerprint);
    expect(text).toContain(`(chip: ${expected.agentFingerprintShort})`);
    expect(text).toContain(expected.agentPromptHash!);
    expect(text).toContain('not a git commit');
    // What was hashed, from the shared catalogue.
    expect(text).toMatch(/Hashed inputs: .*connector config.*hooks/);
  });

  it('--json --payload prints the exact redacted inputs, never a secret value', async () => {
    const { out, io: o } = io();
    await runFingerprintCommand('my-agent', { json: true, payload: true }, o);
    const doc = JSON.parse(out.join('\n'));
    expect(doc.agentKey).toBe('my-agent');
    expect(doc.agentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.agentFingerprintShort).toBe(doc.agentFingerprint.slice(0, 12));
    expect(doc.payload.key).toBe('my-agent');
    expect(doc.payload.connectorConfig.systemPrompt).toBe('You are helpful.');
    expect(doc.payload.connectorConfig.env).toEqual({ ANTHROPIC_MODEL: 'claude-x', OPENAI_API_KEY: '[redacted]' });
    expect(doc.payload.headerKeys).toEqual(['Authorization']);
    expect(doc.payload.model).toBe('claude-x');
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('SECRET-1');
    expect(serialized).not.toContain('sk-secret');
  });

  it('--compare accepts the 12-hex chip form: exit 0 on match, exit 2 (and says what moved) on mismatch', async () => {
    const expected = computeAgentFingerprint(agent);
    const same = io();
    expect(await runFingerprintCommand('my-agent', { compare: expected.agentFingerprintShort }, same.io)).toBe(0);
    expect(same.out.join('\n')).toContain(`✓ ${expected.agentFingerprintShort} matches the current config`);

    const diff = io();
    expect(await runFingerprintCommand('my-agent', { compare: 'b8692d59c93a' }, diff.io)).toBe(2);
    expect(diff.out.join('\n')).toContain('does NOT match the current config');
    expect(diff.out.join('\n')).toContain(expected.agentFingerprintShort);
  });

  it('a prompt edit moves BOTH the fingerprint and the prompt hash; an Authorization header rotation moves NEITHER', async () => {
    const base = computeAgentFingerprint(agent);
    const promptEdited = { ...agent, connectorConfig: { ...agent.connectorConfig, systemPrompt: 'You are VERY helpful.' } } as AgentConfig;
    const rotated = { ...agent, headers: { Authorization: 'Bearer SECRET-2' } } as AgentConfig;

    mockLoadConfig.mockResolvedValue({ agents: [promptEdited] } as any);
    const a = io();
    await runFingerprintCommand('my-agent', { json: true }, a.io);
    const edited = JSON.parse(a.out.join('\n'));
    expect(edited.agentFingerprint).not.toBe(base.agentFingerprint);
    expect(edited.agentPromptHash).not.toBe(base.agentPromptHash);

    mockLoadConfig.mockResolvedValue({ agents: [rotated] } as any);
    const b = io();
    await runFingerprintCommand('my-agent', { json: true }, b.io);
    const rot = JSON.parse(b.out.join('\n'));
    expect(rot.agentFingerprint).toBe(base.agentFingerprint);
    expect(rot.agentPromptHash).toBe(base.agentPromptHash);
  });

  it('--endpoint mirrors a run-level endpoint override (it participates in the hash)', async () => {
    const base = computeAgentFingerprint(agent);
    const { out, io: o } = io();
    await runFingerprintCommand('my-agent', { json: true, endpoint: 'http://other:1/agent' }, o);
    const doc = JSON.parse(out.join('\n'));
    expect(doc.agentFingerprint).not.toBe(base.agentFingerprint);
    expect(doc.agentFingerprint).toBe(computeAgentFingerprint(agent, { agentEndpoint: 'http://other:1/agent' }).agentFingerprint);
  });

  it('unknown agent → exit 1 and lists the configured keys', async () => {
    const { err, io: o } = io();
    expect(await runFingerprintCommand('nope', {}, o)).toBe(1);
    expect(err.join('\n')).toContain('Unknown agent: nope');
    expect(err.join('\n')).toContain('my-agent');
  });

  it('is registered as `fingerprint <agentKey>` with --json/--payload/--compare/--endpoint', () => {
    const cmd = createFingerprintCommand();
    expect(cmd.name()).toBe('fingerprint');
    const opts = cmd.options.map(o => o.long);
    expect(opts).toEqual(expect.arrayContaining(['--json', '--payload', '--compare', '--endpoint']));
  });
});
