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
import { render, screen } from '@testing-library/react';
import { AgentFingerprintChip, AgentConfigChangedBadge } from '@/components/evals3/AgentFingerprintChip';

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

  it('compact mode drops the "config" label', () => {
    render(React.createElement(AgentFingerprintChip, { run: { agentFingerprint: FP_A }, compact: true }));
    expect(screen.getByTestId('agent-fingerprint-chip').textContent).not.toContain('config');
    render(React.createElement(AgentFingerprintChip, { run: { agentFingerprint: FP_A }, 'data-testid': 'full' }));
    expect(screen.getByTestId('full').textContent).toContain('config');
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

  it('same agent, prompt changed → amber badge with "config changed between runs · prompt" and a diff-able tooltip', () => {
    render(React.createElement(AgentConfigChangedBadge, {
      a: { agentKey: 'x', agentFingerprint: FP_A, agentPromptHash: PH_1 },
      b: { agentKey: 'x', agentFingerprint: FP_B, agentPromptHash: PH_2 },
    }));
    const badge = screen.getByTestId('agent-config-changed-badge');
    expect(badge.textContent).toContain('config changed between runs');
    expect(badge.textContent).toContain('prompt');
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
