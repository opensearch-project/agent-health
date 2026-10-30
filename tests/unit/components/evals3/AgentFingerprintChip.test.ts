/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL tests for components/evals3/AgentFingerprintChip.tsx — the mono
 * provenance chip and the "config changed" mismatch badge. Real DOM output,
 * not source grep: the branches under test (legacy run → nothing; same
 * fingerprint → nothing; different agents → nothing; prompt vs other diff
 * wording) are exactly the ones a reviewer would want pinned.
 */

import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentFingerprintChip, AgentConfigChangedBadge } from '@/components/evals3/AgentFingerprintChip';
import { FINGERPRINT_INPUT_FIELDS } from '@/lib/agentFingerprintDiff';

jest.mock('@/lib/config', () => ({ ENV_CONFIG: { backendUrl: 'http://test-backend' } }));

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const PH_1 = '1'.repeat(64);
const PH_2 = '2'.repeat(64);

describe('AgentFingerprintChip', () => {
  it('renders nothing for a legacy run without a fingerprint', () => {
    const { container } = render(React.createElement(AgentFingerprintChip, { run: {} }));
    expect(container.innerHTML).toBe('');
  });

  it('renders the 12-char short form in mono with the full hash + prompt hash + config sha in the tooltip', () => {
    render(React.createElement(AgentFingerprintChip, {
      run: {
        agentFingerprint: FP_A,
        agentFingerprintShort: 'aaaaaaaaaaaa',
        agentPromptHash: PH_1,
        agentConfigSource: { path: '/repo/agent-health.config.ts', gitSha: 'deadbeefcafe0000', dirty: true },
      },
    }));
    const chip = screen.getByTestId('agent-fingerprint-chip');
    expect(chip.textContent).toContain('aaaaaaaaaaaa');
    expect(chip.className).toContain('font-mono');
    expect(chip.getAttribute('data-fingerprint')).toBe(FP_A);
    const title = chip.getAttribute('title')!;
    expect(title).toContain(FP_A);
    expect(title).toContain(PH_1);
    expect(title).toContain('/repo/agent-health.config.ts @ deadbeefcafe (uncommitted edits)');
  });

  it('falls back to slicing the full hash when the short form is missing, and says so when no prompt was recorded', () => {
    render(React.createElement(AgentFingerprintChip, { run: { agentFingerprint: FP_B } }));
    const chip = screen.getByTestId('agent-fingerprint-chip');
    expect(chip.textContent).toContain('bbbbbbbbbbbb');
    expect(chip.getAttribute('title')).toContain('no system prompt recorded');
  });

  it('ALWAYS shows the "config" label next to the hash (owner 2026-10-22 read the bare hex as a commit SHA)', () => {
    render(React.createElement(AgentFingerprintChip, { run: { agentFingerprint: FP_A } }));
    const chip = screen.getByTestId('agent-fingerprint-chip');
    expect(chip.textContent).toContain('config');
    expect(chip.textContent).toContain('aaaaaaaaaaaa');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('title')).toContain('Click for what this hash covers');
  });

  it('renders nothing for a legacy run by default, and an explicit "config · not recorded" chip with showMissing', () => {
    const { container } = render(React.createElement(AgentFingerprintChip, { run: { agentKey: 'x' } }));
    expect(container.innerHTML).toBe('');
    render(React.createElement(AgentFingerprintChip, { run: { agentKey: 'x' }, showMissing: true, 'data-testid': 'hdr' }));
    const missing = screen.getByTestId('hdr-missing');
    expect(missing.textContent).toContain('config');
    expect(missing.textContent).toContain('not recorded');
    expect(missing.getAttribute('title')).toMatch(/created before/i);
  });

  describe('details popover (click)', () => {
    const run = {
      agentFingerprint: FP_A,
      agentFingerprintShort: 'aaaaaaaaaaaa',
      agentPromptHash: PH_1,
      agentKey: 'coding-agent',
      modelId: 'claude-sonnet-4',
      agentConfigSource: { path: '/repo/agent-health.config.ts', gitSha: 'deadbeefcafe0000deadbeefcafe0000deadbeef', dirty: true },
    };

    it('explains the hash is NOT a git commit, lists every hashed input, shows the recorded config file + repo commit, and the CLI/API to recompute it', () => {
      render(React.createElement(AgentFingerprintChip, { run }));
      fireEvent.click(screen.getByTestId('agent-fingerprint-chip'));
      const details = screen.getByTestId('agent-fingerprint-chip-details');
      expect(details.textContent).toMatch(/SHA-256 of this agent.s configuration/);
      expect(details.textContent).toContain('not a git commit');
      expect(screen.getByTestId('agent-fingerprint-chip-details-fingerprint').textContent).toContain(FP_A);
      expect(screen.getByTestId('agent-fingerprint-chip-details-prompt-hash').textContent).toContain(PH_1);
      expect(screen.getByTestId('agent-fingerprint-chip-details-agent-key').textContent).toBe('coding-agent');
      expect(screen.getByTestId('agent-fingerprint-chip-details-config-path').textContent).toBe('/repo/agent-health.config.ts');
      const sha = screen.getByTestId('agent-fingerprint-chip-details-config-sha');
      expect(sha.textContent).toContain('deadbeefcafe0000deadbeefcafe0000deadbeef');
      expect(sha.textContent).toContain('uncommitted edits');
      // Every documented input (minus the version marker) is listed, from the shared catalogue.
      const items = screen.getByTestId('agent-fingerprint-chip-details-inputs').querySelectorAll('li');
      const listedKeys = Array.from(items).map(li => li.getAttribute('data-input-key'));
      expect(listedKeys).toEqual(FINGERPRINT_INPUT_FIELDS.filter(f => f.key !== 'v').map(f => f.key));
      expect(listedKeys).toEqual(expect.arrayContaining(['connectorConfig', 'model', 'endpoint', 'hooks', 'headerKeys', 'auth']));
      // Honest about what is NOT stored.
      expect(details.textContent).toContain('The inputs themselves are not stored on the run');
      // How to find it in your code.
      expect(screen.getByTestId('agent-fingerprint-chip-details-cli').textContent).toContain('npx @opensearch-project/agent-health fingerprint coding-agent');
      expect(details.textContent).toContain('GET /api/agents/coding-agent/fingerprint');
    });

    it('"Compare with current config" calls GET /api/agents/:key/fingerprint and reports same / differs / unknown agent', async () => {
      const fetchMock = jest.fn();
      (global as any).fetch = fetchMock;
      render(React.createElement(AgentFingerprintChip, { run }));
      fireEvent.click(screen.getByTestId('agent-fingerprint-chip'));

      // same
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ agentKey: 'coding-agent', agentFingerprint: FP_A, agentFingerprintShort: 'aaaaaaaaaaaa', agentPromptHash: PH_1 }) });
      fireEvent.click(screen.getByTestId('agent-fingerprint-chip-details-compare'));
      await waitFor(() => expect(screen.getByTestId('agent-fingerprint-chip-details-compare-result').getAttribute('data-state')).toBe('done'));
      expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/agents\/coding-agent\/fingerprint$/);
      expect(screen.getByTestId('agent-fingerprint-chip-details-compare-result').textContent).toContain('matches the current config');

      // prompt changed
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ agentFingerprint: FP_B, agentFingerprintShort: 'bbbbbbbbbbbb', agentPromptHash: PH_2 }) });
      fireEvent.click(screen.getByTestId('agent-fingerprint-chip-details-compare'));
      await waitFor(() => expect(screen.getByTestId('agent-fingerprint-chip-details-compare-result').getAttribute('data-kind')).toBe('prompt'));
      expect(screen.getByTestId('agent-fingerprint-chip-details-compare-result').textContent).toContain('current config differs (bbbbbbbbbbbb)');
      expect(screen.getByTestId('agent-fingerprint-chip-details-compare-result').textContent).toContain('system prompt changed');

      // unknown agent on this server
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Unknown agent' }) });
      fireEvent.click(screen.getByTestId('agent-fingerprint-chip-details-compare'));
      await waitFor(() => expect(screen.getByTestId('agent-fingerprint-chip-details-compare-result').getAttribute('data-state')).toBe('unknown-agent'));
      expect(screen.getByTestId('agent-fingerprint-chip-details-compare-result').textContent).toContain('is not in this server');
    });
  });
});

describe('AgentConfigChangedBadge', () => {
  it('renders nothing when fingerprints match', () => {
    const { container } = render(React.createElement(AgentConfigChangedBadge, {
      a: { agentKey: 'x', agentFingerprint: FP_A, agentPromptHash: PH_1 },
      b: { agentKey: 'x', agentFingerprint: FP_A, agentPromptHash: PH_1 },
    }));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when either side is a legacy run (unknown is not a warning)', () => {
    const { container } = render(React.createElement(AgentConfigChangedBadge, {
      a: { agentKey: 'x', agentFingerprint: FP_A },
      b: { agentKey: 'x' },
    }));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for two DIFFERENT agents (differing configs are the comparison, not a warning)', () => {
    const { container } = render(React.createElement(AgentConfigChangedBadge, {
      a: { agentKey: 'x', agentFingerprint: FP_A, agentPromptHash: PH_1 },
      b: { agentKey: 'y', agentFingerprint: FP_B, agentPromptHash: PH_2 },
    }));
    expect(container.innerHTML).toBe('');
  });

  it('same agent, prompt changed → amber badge with "config changed between runs · incl. prompt" and a diff-able tooltip', () => {
    render(React.createElement(AgentConfigChangedBadge, {
      a: { agentKey: 'x', agentFingerprint: FP_A, agentPromptHash: PH_1 },
      b: { agentKey: 'x', agentFingerprint: FP_B, agentPromptHash: PH_2 },
    }));
    const badge = screen.getByTestId('agent-config-changed-badge');
    expect(badge.textContent).toContain('config changed between runs');
    expect(badge.textContent).toContain('incl. prompt');
    expect(badge.getAttribute('data-diff-kind')).toBe('prompt');
    const title = badge.getAttribute('title')!;
    expect(title).toContain('system prompt changed');
    expect(title).toContain(`A: ${FP_A}`);
    expect(title).toContain(`B: ${FP_B}`);
  });

  it('same agent, prompt equal but other fields differ → "other fields" wording', () => {
    render(React.createElement(AgentConfigChangedBadge, {
      a: { agentKey: 'x', agentFingerprint: FP_A, agentPromptHash: PH_1 },
      b: { agentKey: 'x', agentFingerprint: FP_B, agentPromptHash: PH_1 },
    }));
    const badge = screen.getByTestId('agent-config-changed-badge');
    expect(badge.getAttribute('data-diff-kind')).toBe('other');
    expect(badge.textContent).toContain('other fields');
    expect(badge.getAttribute('title')).toContain('connector config changed (prompt unchanged)');
  });

  it('"since-source" wording for the re-run provenance variant', () => {
    render(React.createElement(AgentConfigChangedBadge, {
      a: { agentFingerprint: FP_A, agentPromptHash: PH_1 },
      b: { agentFingerprint: FP_B, agentPromptHash: PH_2 },
      wording: 'since-source',
    }));
    expect(screen.getByTestId('agent-config-changed-badge').textContent).toContain('config changed since source run');
  });
});
